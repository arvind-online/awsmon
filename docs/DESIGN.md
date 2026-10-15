# AWS Monitoring Dashboard: Design Document

Status: **Draft for review.** No code written yet.
Scope: a low-cost, secure, kiosk-friendly dashboard for key AWS resources, run locally on Windows 11 Pro for Workstations now and portable to ECS later.

---

## 1. Goals and non-goals

### Goals
- Show health and key metrics for: ECS services, Aurora PostgreSQL, Lambda, Kinesis, ElastiCache (Redis OSS), and CloudWatch alarms (provisioned, enabled later).
- Run 24/7 as a locked-down kiosk on a Windows PC.
- Near-zero AWS cost. Data is cached, never "live", and page loads never trigger AWS calls.
- Updates reach the screen in realtime over WebSockets when the scheduler pulls new data.
- Secure by construction: read-only IAM, no arbitrary-resource input, minimal attack surface.
- Same code and container image run locally and on ECS; only configuration changes.
- Notifications and alerting are designed in as a placeholder, not built.

### Non-goals (for now)
- Email or other notification delivery (placeholder only).
- Cost Explorer, Logs Insights, Container Insights, Enhanced Monitoring and other paid extras.
- Multi-user accounts, RBAC or multi-account support.
- Long-term metric history (only ~3h for sparklines, rebuilt from CloudWatch).

---

## 2. Architecture overview

```
 AWS (read-only APIs)              Monitor service (single Node process / container)                  Clients
┌──────────────────────┐  poll   ┌──────────────────────────────────────────────────────┐        ┌────────────────┐
│ CloudWatch GetMetric │◄────────│ Scheduler (working / off hours, escalation)          │   WS   │ Kiosk display  │
│ CloudWatch Alarms    │         │      ↓                                               │───────►│ (React, Edge   │
│ ECS / RDS / Kinesis  │         │ Collectors (ecs, aurora, lambda, kinesis, redis,     │ push   │  kiosk mode)   │
│ ElastiCache describe │         │              alarms)                                 │        └────────────────┘
└──────────────────────┘         │      ↓                                               │        ┌────────────────┐
                                 │ SnapshotStore (memory + persisted last snapshot)     │  HTTPS │ Admin UI       │
                                 │      ↓                    ↓                          │◄──────►│ (login required)│
                                 │ WS Hub (broadcast)   RuleEngine → Notifier (stub)    │        └────────────────┘
                                 │ CostEstimator   SettingsService   Auth               │
                                 └──────────────────────────────────────────────────────┘
```

Principle: **only the Scheduler talks to AWS.** Browsers, reloads, tabs and reconnects read the cache.

### Components

| Component | Responsibility |
|---|---|
| Scheduler | Decides when to poll based on the time window (working vs off hours), manual refresh and optional escalation. |
| Collectors | One module per resource type. Each declares its metric queries and status calls and returns a normalised result. |
| SnapshotStore | Holds the latest snapshot plus ~3h of sparkline series in memory. Persists the last snapshot to disk for restart continuity (marked stale). |
| WS Hub | Pushes the full snapshot to all clients after each poll. Sends the latest cached snapshot on connect. |
| SettingsService | Layered config (see section 4). Validates, applies live and persists runtime-editable settings. |
| CostEstimator | Counts metrics requested and calls made. Shows actual month-to-date and projected monthly cost of running the dashboard. |
| RuleEngine | Evaluates snapshots into state transitions and alert events (section 10). |
| Notifier (interface) | Pluggable delivery. No-op implementation for now. |
| Auth | Basic username/password login for the admin UI only (section 11). |

---

## 3. Technology

- **Server:** Node.js + TypeScript, Fastify, `@fastify/websocket`, AWS SDK v3 (modular clients: `client-cloudwatch`, `client-ecs`, `client-rds`, `client-kinesis`, `client-elasticache`). The SDK is only used for the services we call.
- **Client:** React + TypeScript + Vite, uPlot for sparklines. Self-hosted assets only: no CDN, no third-party scripts.
- **Packaging:** a single repo, one Docker image for ECS. Locally, run natively on Windows as a service (NSSM or Task Scheduler) rather than inside WSL, for reliable start at boot.
- **Dependencies:** kept minimal, pinned with a lockfile, and checked with `npm audit` in CI. Password hashing uses Node's built-in `crypto.scrypt`, so there is no native module.

---

## 4. Configuration and settings

Two kinds of configuration, deliberately separated.

### 4.1 Static config (deploy-time, not editable in UI)
Defines **what to monitor** and where to run. Keeping it out of the UI means no one can point the app at arbitrary resources.

Sources, highest precedence last: `defaults < config.json < environment variables`.
- Locally: `config.json`.
- ECS: environment variables or task-definition secrets (e.g. `MONITOR_ADMIN_PASSWORD_HASH`, `MONITOR_REGION`), optionally with a mounted `config.json`.

Contains: region, listen host/port, resource lists, admin username and password hash, session secret, feature flags (alarms collector on/off, notifications on/off).

### 4.2 Runtime settings (editable in the Admin UI)
Schedule, escalation, thresholds, theme default, display options.

- Seeded from defaults, `config.json` and env vars.
- Admin edits are validated, applied live (no restart) and saved to `data/settings.json` through a `SettingsStore` interface.
- On ECS the container disk is ephemeral, so edits would reset on redeploy. Acceptable for now: env vars seed the desired defaults. If durable edits are ever needed, add an SSM Parameter Store or DynamoDB adapter behind the same interface. No other code changes.

### 4.3 Recommendation: JSON file + env overrides. No SQLite.
- Settings are a handful of values, so a database adds a native dependency, migrations and a volume for no benefit.
- JSON + env works identically locally and on ECS, is human-readable and diffable, and costs nothing.
- If we later want durable history or audit logs, SQLite or DynamoDB can be added behind an interface without redesign.

### 4.4 Config schema (illustrative)

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 8080 },
  "aws": { "region": "ap-south-1", "profile": "monitor-dev" },   // profile used locally only
  "resources": {
    "ecs":     [{ "cluster": "prod", "services": ["api", "worker", "web"] }],
    "aurora":  [{ "clusterId": "prod-aurora", "instances": ["prod-aurora-1", "prod-aurora-2"] }],
    "lambda":  [{ "name": "ingest-fn" }, { "name": "transform-fn" }],
    "kinesis": [{ "stream": "events" }],
    "redis":   [{ "replicationGroupId": "prod-redis", "nodes": ["prod-redis-001"] }]
  },
  "collectors": { "alarms": { "enabled": false, "namePrefix": "" } },
  "auth": { "adminUser": "admin", "adminPasswordHash": "<scrypt hash>", "sessionSecret": "<random>" },
  "settings": {                       // runtime-editable (seed values)
    "schedule": {
      "timezone": "local",            // IANA zone or "local"
      "workingDays": ["Mon","Tue","Wed","Thu","Fri"],
      "workingHours": { "start": "09:00", "end": "18:00" },
      "workingIntervalMin": 15,
      "offHoursIntervalMin": 60
    },
    "escalation": { "enabled": false, "intervalMin": 5, "reason": "any resource not OK" },
    "manualRefresh": { "cooldownSec": 60, "dailyCap": 100 },
    "thresholds": {
      "cpuWarnPct": 70, "cpuCritPct": 90,
      "memWarnPct": 80, "memCritPct": 90,
      "kinesisIteratorAgeWarnMs": 60000, "kinesisIteratorAgeCritMs": 300000
    },
    "ui": { "defaultTheme": "dark", "pixelShift": true, "showCostByDefault": false },
    "notifications": { "enabled": false }
  }
}
```

---

## 5. Scheduler

### 5.1 Rules
- Working window = `workingDays` within `workingHours` in the configured time zone. **Everything else is non-working time automatically**, including weekends.
- Interval selection: working window → `workingIntervalMin` (default **15**); otherwise → `offHoursIntervalMin` (default **60**).
- Intervals are free-text numeric inputs in the Admin UI, in whole minutes only (no hours unit). Valid range 1 to 1440. Values under 5 show a cost warning. Invalid or non-numeric input is rejected with a message.
- Implemented with a "next due" timer, not a fixed cron: after each poll compute `nextDue = lastPoll + intervalForCurrentWindow`. Re-evaluate whenever settings change or a window boundary is crossed.
- On entering working hours, poll immediately if the data is older than `workingIntervalMin`.
- On startup, poll immediately (also backfills sparklines), then follow the schedule.
- DST and time zone handled via IANA zone support (`Intl`).

### 5.2 Adaptive escalation (default **off**, toggle in Admin UI)
- When enabled and any monitored resource is WARN/CRIT (or a collector failed), the interval drops to `escalation.intervalMin` (default 5) until all resources return to OK for 2 consecutive polls, then the normal schedule resumes.
- Escalation never goes slower than the normal interval. It only tightens.
- Cost-bounded: the dashboard's cost estimate and daily cap include escalated polls.

### 5.3 Manual refresh
- "Refresh now" button in the UI sends `refresh` (WS message or `POST /api/refresh`).
- **Single-flight:** concurrent clicks collapse into one fetch.
- **Cooldown** (default 60s) returns "refreshed X seconds ago" instead of calling AWS.
- **Daily cap** (default 100 manual refreshes) as a cost guard.
- The result is broadcast to all connected clients, not just the requester.

### 5.4 Failure handling
- Each collector is isolated. One failing collector marks only its tile as `UNKNOWN` with an error badge and doesn't block the others.
- Failed polls retry with exponential backoff (capped at the normal interval) and are not counted twice in the cost estimate.
- Throttling and credential-expiry errors surface as a clear banner ("AWS access error"), not silent green tiles.

---

## 6. Data collection and metrics catalogue

All metrics are standard, free-to-publish CloudWatch metrics, read with period 300s over the last 3 hours (about 36 points per sparkline). Either way, a 3h history costs the same as a single point.

**Metrics API (decided, configurable as `aws.metricsApi`):**

| Mode | Call pattern | Billing | ~43 metrics, default schedule |
|---|---|---|---|
| `statistics` **(default)** | `GetMetricStatistics`, one request per metric, run in parallel with a concurrency limit | Counts toward the account-wide **free tier of 1M API requests/month**; per-request price after that | ~57k requests/month, so **~$0** inside the free tier |
| `data` | One batched `GetMetricData` (up to 500 queries) | **Always charged** (excluded from the free tier): $0.01 per 1,000 metrics | ~$0.58/month |

The dashboard data is identical in both modes. The free tier is shared across the whole AWS account, so `statistics` is "never more expensive, usually free". The cost widget labels it "within free tier (est.)" because the app can't see the rest of the account's API usage. Metric math (e.g. error rate) is computed in the app, so `GetMetricData`'s extra features aren't needed.

| Collector | Free status API | CloudWatch namespace / dimensions | Metrics |
|---|---|---|---|
| ECS | `DescribeServices` (running/desired, deployments, recent events) | `AWS/ECS` (ClusterName, ServiceName) | CPUUtilization, MemoryUtilization |
| Aurora PG | `DescribeDBClusters`, `DescribeDBInstances` (status, role) | `AWS/RDS` (DBInstanceIdentifier) | CPUUtilization, FreeableMemory, DatabaseConnections, AuroraReplicaLag (readers) |
| Lambda | none (metrics only, see below) | `AWS/Lambda` (FunctionName) | Invocations, Errors, Throttles, Duration (avg) |
| Kinesis | `DescribeStreamSummary` (status, shard count) | `AWS/Kinesis` (StreamName) | IncomingRecords, GetRecords.Records, GetRecords.IteratorAgeMilliseconds, WriteProvisionedThroughputExceeded |
| Redis (ElastiCache OSS) | `DescribeReplicationGroups` (status) | `AWS/ElastiCache` (CacheClusterId) | CPUUtilization, EngineCPUUtilization, DatabaseMemoryUsagePercentage, CurrConnections, Evictions |
| Alarms *(disabled)* | `DescribeAlarms` (state, optional name-prefix filter) | none | none |

Notes:
- Lambda is read through CloudWatch only (no Lambda API permission): `ListFunctions` returns function environment variables, which can contain secrets.
- Redis is observed via metrics only, never by connecting to the cache.
- Aurora memory is shown as FreeableMemory (bytes and % of instance class where the class is known).
- Status → health mapping lives in the collector (e.g. ECS running < desired = CRIT; Kinesis iterator age > threshold = WARN/CRIT; DB status ≠ available = CRIT).

### Normalised snapshot (sent to clients)

```jsonc
{
  "version": 1,
  "generatedAt": "2026-10-14T09:15:00Z",
  "poll": { "trigger": "schedule|manual|escalation|startup", "durationMs": 840, "nextDueAt": "…", "window": "working|off", "escalated": false },
  "overall": "OK|WARN|CRIT|UNKNOWN",
  "groups": [
    { "type": "ecs", "items": [
      { "id": "prod/api", "name": "api", "health": "OK",
        "status": { "running": 2, "desired": 2 },
        "metrics": { "cpu": { "latest": 41.2, "series": [[ts, v], …] }, "mem": { … } } } ] }
  ],
  "alarms": { "enabled": false, "items": [] },
  "cost": null            // only sent to clients that have toggled cost visibility; see section 8
}
```

---

## 7. Caching and WebSockets

### 7.1 Cache
- In-memory `SnapshotStore` is the source of truth for all clients.
- The last snapshot is persisted to `data/last-snapshot.json`. After a restart, clients see it flagged as stale rather than a blank screen, until the startup poll completes.
- Sparkline history is rebuilt from CloudWatch on startup (no database required).
- Page loads, reconnects, and any number of open tabs cost zero AWS calls.

### 7.2 WebSocket protocol (`/ws`)

| Direction | Message | Purpose |
|---|---|---|
| S→C | `hello` {serverVersion, settingsPublic} | On connect. The client reloads itself if the version changed. |
| S→C | `snapshot` {…} | Full snapshot after every poll, and immediately on connect. |
| S→C | `refreshing` {by} / `refresh-denied` {reason, retryAfterSec} | Manual refresh state feedback. |
| S→C | `settings` {public settings} | Pushed when an admin saves settings; displays apply them live. |
| S→C | `layout` {cells or null} | The shared default layout; pushed on connect and whenever an admin saves it. |
| S→C | `ping` | Heartbeat every 20s. |
| C→S | `refresh` | Request manual refresh (subject to cooldown and cap). |
| C→S | `pong` | Heartbeat reply. |

- A full snapshot is a few KB, so no delta protocol is needed.
- The client auto-reconnects with backoff and shows a "disconnected" banner after 30s without a heartbeat.
- **Staleness:** if `generatedAt` is older than 2 × the active interval, the header turns amber then red. A dead collector can never look like "all green".
- Origin is validated on upgrade. The display socket is read-only apart from `refresh`.
- Limits: at most `server.maxClients` (default 50) sockets, 1 KB message cap, and one refresh request per socket every 5s (extras are dropped).

---

## 8. Dashboard cost estimator

Shows what **running this dashboard** costs in AWS API charges. It is not the cost of monitored resources.

- **Hidden by default:** shown as `$ ••••` with an eye icon, and clicking reveals the figures (default configurable via `ui.showCostByDefault`). Visibility is a client-side toggle.
- **Actual (month-to-date):** the live `GetMetricStatistics` requests made so far this month, priced at $0.01 per 1,000 after the account-wide 1,000,000 free requests per month (so normally $0.00). Only live polls count; simulated polls are never recorded. The footer also shows the projected share of the free tier. A counter is persisted in `data/usage.json`, reset on month rollover. Other calls (`Describe*`, `DescribeAlarms`) are counted but priced at $0 (they are free).
- **Projected (per month):** computed from the current schedule: polls per working day and per off-hours period × weekdays/weekends in a month × metrics per poll, plus an escalation allowance when enabled.
- Both figures are cheap to implement because the poll path already knows the number of metrics requested. They are shown side by side: *Est. this month so far* and *Projected monthly*.
- The Admin UI shows the projected figure live as schedule values are edited.
- Disclaimer in the UI: "Estimate based on published CloudWatch API pricing; verify in AWS Billing."

Reference estimate with defaults (15 min working hours Mon–Fri 09:00–18:00, 60 min otherwise, ~35 metrics): about 36 working polls + 15 off-hours polls on weekdays and 24 on weekends, around $0.50 per month.

---

## 9. UI

### Display (kiosk) view
- One full-screen page with no scrolling. Responsive tile grid grouped by service type: overall status banner, then ECS, Aurora, Lambda, Kinesis, Redis and Alarms sections.
- Each tile shows a colour-coded status, key number(s) and a sparkline. Colour is never the only signal: status icon plus text as well, for accessibility.
- Header shows "Last updated", "Next refresh in", the connection state, and the **Refresh now** button (with cooldown state).
- **Themes:** light and dark. Choice persisted in `localStorage`, with the default taken from settings and an "auto" (OS preference) option. Dark is recommended for 24/7 use.
- **Burn-in mitigation:** subtle pixel shift (a few px every few minutes, imperceptible), muted dark palette, no static high-contrast elements, and an optional nightly dim.
- **Cost widget:** small `$ ••••` with an eye icon in the footer, per section 8.
- Reduced motion respected, with no flashy animation.

### Admin view (`/admin`, login required)
- Schedule: working days, start/end time, working interval (min), off-hours interval (min), time zone. Free-text numeric inputs with inline validation.
- Escalation: on/off toggle plus interval.
- Manual refresh cooldown and cap.
- Thresholds (CPU, memory, Kinesis iterator age).
- UI defaults: theme, pixel shift, show-cost default.
- Notification master switch (disabled, "coming soon").
- Live projected monthly cost shown as inputs change.
- **Not editable:** resource lists, credentials, region and listen address (static config only).

---

## 10. Notifications: placeholder architecture (not built)

```
Snapshot → RuleEngine → AlertEvent → Notifier interface → [ NoopNotifier (now) | HttpEmailNotifier (later) | Slack/webhook (future) ]
```

- **RuleEngine:** tracks per-resource health transitions (OK→WARN→CRIT→OK). Planned features:
  - debounce (N consecutive bad polls)
  - cooldown and de-duplication
  - recovery notices
  - threshold rules (from section 4) and later anomaly rules (deviation from a trailing baseline)
- **AlertEvent:** `{ id, severity, resourceType, resourceId, metric, value, threshold, state, firedAt, snapshotRef }`.
- **Notifier interface:** `send(event): Promise<void>`. The module is deliberately provider-agnostic.
- **Email:** you have a separate email service, so the future `HttpEmailNotifier` will call that service's API (URL, auth token and recipients from config or a secret). **No SES/SNS and nothing provider-specific is baked in.**
- `notifications.enabled=false` by default, and no network egress other than AWS happens until it's turned on.
- The AlertEvent log is kept in memory (and optionally on disk) so the UI can later show recent events.
- Note: a CloudWatch alarm's own action is still the most reliable "service down" signal because it works even if this app is down. This notifier complements it. The monitor also can't report its own death, so a later external heartbeat check would cover that.

---

## 11. Security

### 11.1 AWS access (least privilege)
- A dedicated read-only identity. Local dev may use the existing CLI profile; **before kiosk use, switch to a dedicated read-only IAM user, then to a task role on ECS (no stored keys).**
- Code uses the SDK default credential chain, so switching needs no code change.
- Avoided on purpose: `lambda:ListFunctions`/`GetFunction*` (leak env vars), `ecs:DescribeTaskDefinition` (env vars), any data-plane access (S3, DB, Redis, Kinesis `GetRecords`, SQS receive), any write action, and wildcard actions.
- Some actions can't be resource-scoped (`cloudwatch:GetMetricData`, `cloudwatch:DescribeAlarms`, the `Describe*` calls). They are read-only metadata.

#### Draft IAM policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "MetricsAndAlarmsRead", "Effect": "Allow",
      "Action": ["cloudwatch:GetMetricData", "cloudwatch:DescribeAlarms"], "Resource": "*" },
    { "Sid": "EcsStatusRead", "Effect": "Allow",
      "Action": ["ecs:DescribeServices"],
      "Resource": "arn:aws:ecs:<region>:<account>:service/<cluster>/*" },
    { "Sid": "AuroraStatusRead", "Effect": "Allow",
      "Action": ["rds:DescribeDBClusters", "rds:DescribeDBInstances"], "Resource": "*" },
    { "Sid": "KinesisStatusRead", "Effect": "Allow",
      "Action": ["kinesis:DescribeStreamSummary"],
      "Resource": "arn:aws:kinesis:<region>:<account>:stream/<stream>" },
    { "Sid": "RedisStatusRead", "Effect": "Allow",
      "Action": ["elasticache:DescribeReplicationGroups"], "Resource": "*" }
  ]
}
```

(Final ARNs are filled in when the resource list is known. Alarms and notifications add no extra permissions in this phase.)

### 11.2 Application
- **Local:** bind to `127.0.0.1` only.
- **Inputs:** no endpoint accepts resource names or AWS parameters from clients, so there is no SSRF or injection path to AWS. Admin-edited values are numeric or enumerated, validated server-side with a schema.
- **Admin auth (simple, as requested):** username + password from config, stored as a scrypt hash.
  - Login rate-limited with lockout/backoff.
  - Session in an `HttpOnly`, `SameSite=Strict`, `Secure` (when HTTPS) cookie.
  - CSRF protection on state-changing routes (`Origin` check + token).
  - Constant-time comparison.
  - Can later move the hash/secret to AWS Secrets Manager or SSM Parameter Store with no change to the auth logic.
- **Display route and WebSocket:** open on loopback locally. When made public on ECS, they must sit behind authentication (ALB + OIDC/Cognito or equivalent). **Public exposure without auth is not supported by this design.**
- **Headers:** strict CSP (self only), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`, HSTS when HTTPS.
- **Logging:** structured, with no credentials or tokens and with account IDs masked where appropriate. Admin changes are audit-logged.
- **Supply chain:** pinned lockfile, minimal dependencies, `npm audit` in CI, non-root container user, read-only container filesystem where possible.
- **Secrets at rest:** config file permissions restricted to the service account. Env/secret injection on ECS.

### 11.3 Windows host and kiosk hardening
- Run the monitor as a **Windows service under a dedicated service account** whose profile holds the AWS credentials. The credentials file is ACL'd to that account only.
- The kiosk session runs under a **separate standard local account** with **Assigned Access** (single-app kiosk, Edge in kiosk mode pointed at `http://127.0.0.1:8080/`), plus auto-logon.
- The existing admin AWS CLI profile must not be reachable from the kiosk account.
- Power plan set to never sleep, Windows Update active hours configured, BitLocker enabled (with a PIN if physical access is a concern), a strong admin password, and BIOS boot order locked.
- Honest limit: Assigned Access blocks normal in-session escapes, but it does not defend against someone with physical access who reboots into recovery. BitLocker, BIOS protection and physical control cover that.

---

## 12. Deployment modes

| Aspect | Local (Windows) | ECS (later) |
|---|---|---|
| Runtime | Node service via NSSM/Task Scheduler | Docker image on Fargate (1 task) |
| AWS credentials | Dedicated profile → read-only IAM user | Task role (no keys) |
| Listen | 127.0.0.1 | Container port behind ALB or private access |
| Auth in front | None (loopback) | Required (ALB OIDC/Cognito or VPN/SSO) |
| Config | `config.json` | Env vars / secrets (+ optional mounted file) |
| Settings persistence | `data/settings.json` | Ephemeral (env seeds); SSM/DynamoDB adapter optional |
| Cache | in-memory + `data/` | in-memory; desired count = 1 to avoid duplicate pollers |
| Hosting cost | $0 | ~$9/mo small Fargate task + ALB ~$16/mo (private access avoids the ALB) |

---

## 13. Risks and open items

| Item | Notes |
|---|---|
| Exact metric count | Depends on the final service/Lambda/stream list. Cost estimate refined once known. |
| ECS memory % | `MemoryUtilization` is the service-level percentage of reserved memory. Task-level detail needs Container Insights (avoided on cost grounds). |
| Poll latency vs alerting | An hour between polls off-hours delays detection; escalation (optional) and future CloudWatch alarms mitigate this. |
| Settings durability on ECS | Edits reset on redeploy unless a persistence adapter is added. |
| Public exposure | Needs auth in front before going live. Must not be skipped. |
| Dashboard self-monitoring | The app can't detect its own failure. A future external heartbeat check could cover this. |
| Alarm creation | You will create alarms later. Each standard alarm costs ~$0.10 per month. |

---

## 14. Phased build plan

1. **Scaffold + mock data** *(done)*: repo structure, config/settings layers, scheduler with a fake collector, WS hub, React display with themes/pixel shift, admin UI, cost estimator on fake counts.
1.5. **UI and foundations** *(done, see section 16)*.
2. **Collector framework + real collectors:** plugin framework first (section 17), then ECS, Aurora, Lambda, Kinesis, Redis and the alarms collector (disabled) on top of it, using `GetMetricStatistics` by default. The simulated collector stays as a permanent, switchable mode. Verify against your account and compare the cost estimate with actual API calls.
3. **Security and IAM:** finalise the least-privilege policy and create the read-only IAM user. Add Windows service setup, Assigned Access kiosk setup and hardening scripts. Retire dev credentials.
4. **Notification module skeleton:** RuleEngine, AlertEvent and Notifier interface with the no-op notifier and tests (no delivery yet).
5. **ECS readiness (optional):** Dockerfile, task definition, env-based config, auth-in-front guidance.

Each phase ends with a working, reviewable increment.

---

## 15. Phase 1 implementation notes (deviations and additions)

- **Charts:** custom SVG components (smooth area/line, threshold lines, hover crosshair and tooltip, rings, bars, sparklines) instead of uPlot. This removes a dependency and gives full control over the look.
- **Layout:** react-grid-layout (v2) provides drag, resize and automatic realignment. Row height is fitted to the screen so the default layout fills a 1080p display without scrolling. Layout is saved in the browser (`localStorage`, versioned key). Hidden widgets are deliberately not saved, so a reload restores them.
- **Responsive widgets:** CSS container queries adapt each widget's content (columns, sparklines, charts) to the size you give it.
- **Cost block:** the snapshot always carries the cost figures. Masking is purely a UI toggle (default from `ui.showCostByDefault`).
- **Redis** is shown as compact rows (CPU/memory bars plus connections and evictions) rather than gauge cards.
- **Config discovery:** `config.json` is looked up in the working directory, then its parent. Relative `dataDir` is resolved against the config file.
- **Server hardening already in place:** loopback-only by default, Origin checks on WebSocket and all state-changing routes, CSRF token on admin writes, scrypt password hashing, login lockout with backoff, signed `HttpOnly` `SameSite=Strict` session cookie, CSP and security headers, strict zod validation of all settings.
- **Dev tooling:** `scripts/dev/cdp.ps1` drives headless Windows Edge from WSL for screenshots and interaction checks.

---

## 16. Phase 1.5 implementation notes

### Background and look
- **Silk-ribbon background:** two bundles of fine lines (56 + 28) that fan out, pinch, twist and keep changing shape. The shape parameters drift continuously, so the pattern never visibly repeats. Colour flows slowly along the ribbon (blue → soft red → gray → lilac), with its own palette for each theme.
- **Rendering off the main thread:** the ribbon is drawn in a **Web Worker on an OffscreenCanvas** (main-thread fallback if unsupported), at 30 fps and 75% backing resolution, pausing when the tab is hidden. Measured in headless Edge: main-thread time is the same with the ribbon on or off, and frame pacing holds 60 fps (p95 16.7 ms). Charts, numbers and interactions can't be stalled by the background.
- **Admin settings:** background (moving / still / off), intensity (subtle / medium), status-aware tint (off by default: warms and quickens the ribbon while something is unhealthy), and **card opacity** (50–100%, default 88%, previewed live on the admin page). No backdrop blur anywhere: blurring over an animated background would be recomputed every frame.
- **Colour discipline:** OK values use neutral ink. Colour appears only on status dots/badges and on WARN/CRIT values, so a problem is the most colourful thing on screen.
- **Motion:** charts morph between snapshots (points matched by timestamp; the time window slides). Numbers ease to their new value with a quiet "settle", staggered so a poll ripples across the screen. Status dots ripple once on change. A widget's border pulses in its new status colour. Unhealthy rows glide to the top of their list (FLIP animation). Reduced-motion is honoured.

### Layout and display
- **Display scale** (Desk 100% / Wall 118% / TV 140%) uses `transform: scale()` with the grid's scaled positioning, so drag and resize stay accurate at every scale. (`createScaledStrategy`'s own drag math assumes the grid sits at the viewport origin, so it is used without that function.)
- **Never scrolls:** row height is fitted so the compacted layout fills the screen exactly (hiding a widget lets the others grow). Lists share the available height, sort unhealthy items first, and fold the healthiest overflow into "+N more · all healthy". Cards adapt to their own size with container queries (e.g. Kinesis moves lag into the card header when short).
- **Kiosk mode** (`/?display=kiosk`): hides the customize, hide, theme and admin controls, locks the layout, auto-hides the cursor and blocks the context menu. Refresh stays visible unless disabled in admin.
- **Shared default layout:** Edge kiosk mode browses InPrivate, so browser storage doesn't survive. An admin can "Save as default for all displays" from customize mode (`PUT /api/admin/layout`, validated, stored in `data/layout.json`). It is pushed live to every connected display. Non-kiosk browsers may keep a personal override until they reset it.
- **Header clock**, and an Overview widget without a title bar outside customize mode.

### Data and server
- **Per-collector staleness:** each group carries `lastSuccessAt` and `error`. A failing collector keeps its last items (dimmed, "STALE" pill, Unknown status) while the others stay live. `MOCK_FAIL=kinesis,redis` simulates failures.
- **Health-change log:** transitions between snapshots (`diffHealth`) are kept in a persisted ring buffer (`data/events.json`, last 200). They are shown as **Recent changes** in the footer, and are the input for the future notification RuleEngine.
- **Startup poll skipped** when the cached snapshot is still within its interval, so restarts don't spend AWS calls.
- **Metric labelling:** summed metrics carry their window (`per: "5 min"`), shown once in the widget header. Charts state "Last 3 h · 5-min points".
- **Security additions:**
  - logout revokes every session (persisted session epoch)
  - WebSocket connection cap and per-socket refresh throttling
  - `server.trustProxy` for ALB deployments
  - pruning of the login-lockout table
  - same-site-only `?next=` redirect after login
  - explicit `worker-src 'self'` in the CSP
- **Settings persistence:** admin edits are saved to `data/settings.json`, a JSON settings file next to the data, and survive restarts. They are deliberately **not** written back into `config.json`. That file holds the admin password hash, the session secret and the list of monitored resources, and keeping it read-only to the web process means a compromised admin session can't change what is monitored or how sign-in works. `config.json` can still seed any setting (`"settings": {...}`), and on ECS environment variables can.

### Simulation mode (permanent)
The mock collector is a first-class, permanent data source, not scaffolding: `mode: "mock"` in `config.json` or `MONITOR_MODE=mock`. It remains available after Phase 2 for demos, UI development and testing (including `MOCK_FAIL`). The UI always labels simulated data ("Simulated data" in the header, "simulated" on the cost chip). Phase 2 adds an admin switch between live and simulated sources.

---

## 17. Collector plugin framework (Phase 2 design)

Goal: adding an AWS service should be a config entry or a single file, with no UI work.

**Two ways to add a service**
1. **Config-only (no code):** for anything that is "just CloudWatch metrics" (SQS, ALB, API Gateway, DynamoDB, Step Functions, SNS…):
   ```jsonc
   "custom": [{
     "id": "orders-queue", "title": "SQS: orders", "icon": "queue",
     "namespace": "AWS/SQS", "dimensions": { "QueueName": "orders" },
     "metrics": [
       { "name": "ApproximateNumberOfMessagesVisible", "label": "Backlog", "stat": "Maximum", "warn": 1000, "crit": 5000 },
       { "name": "ApproximateAgeOfOldestMessage", "label": "Oldest msg", "stat": "Maximum", "unit": "s", "warn": 300, "crit": 900 }
     ]
   }]
   ```
   It needs no new IAM permissions, because metric reads are already allowed.
2. **Code module:** one file in `server/src/collectors/services/` for services that also need a status API. It declares:
   - `id`, title and icon
   - a zod config schema
   - declarative metric queries
   - optional `Describe*` status calls with their health mapping
   - the IAM actions it needs

   The five built-in collectors are rewritten this way and serve as the reference examples.

**What the framework provides to every collector**
- One CloudWatch layer for both `statistics` and `data` modes, with concurrency limits.
- Usage counting, so new metrics appear in the cost estimate automatically.
- Per-collector error isolation, retries and staleness.
- Threshold evaluation and health-change events.
- `npm run iam-policy`, which generates the least-privilege policy from the enabled collectors.

**UI side**
- **Generic widgets:** rendered from a view hint (`rows` / `cards` / `stats`), so a new collector needs no UI code.
- **Custom widgets:** an optional bespoke widget can be registered per collector `id`.
- **Layout:** new widgets are placed automatically at the bottom.

**Boundaries:** collectors are added in config or code only, never from the UI, so there is still no arbitrary-resource input. A code module that calls a new AWS API requires its IAM action to be added, and the generator shows the diff.
