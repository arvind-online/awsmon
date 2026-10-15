# AWS Monitor: project guide for Claude

A low-cost, secure, kiosk-style dashboard for the user's key AWS resources (ECS, Aurora PostgreSQL, Lambda, Kinesis, ElastiCache Redis OSS, CloudWatch alarms). It runs locally on Windows 11 Pro for Workstations as a 24/7 kiosk, and may later be hosted on ECS.

- **Design source of truth:** `docs/DESIGN.md`. Read sections 14 (phase plan), 16 (Phase 1.5 notes) and 17 (collector framework) first.
- **Usage docs:** `README.md`.

## Current status (as of 2026-10-14)

- **Phase 1 (scaffold, mock data): done.** Committed as the baseline.
- **Phase 1.5 (UI and foundations): done, committed.** Includes:
  - silk-ribbon background (Web Worker + OffscreenCanvas)
  - admin card opacity, display scale, kiosk mode (`/?display=kiosk`), shared server-side layout
  - per-collector staleness, health-change log ("Recent changes")
  - startup-poll skip, session revocation, WebSocket limits
  - 31 server tests pass
- **Phase 2 step 1 (framework + Lambda collector): done and verified live** against ap-south-1 (matches `aws cloudwatch get-metric-statistics`). Framework: `server/src/collectors/` (`types.ts` ServiceCollector, `cloudwatch.ts` shared GetMetricStatistics reader, `live.ts` per-collector error isolation, `services/` one file per service). Live/simulated is the admin setting `dataSource` (data/settings.json); services without a real collector stay simulated and show a "simulated" pill. `npm run iam-policy` prints the policy.
- **Phase 2 step 2 (Kinesis collector): done and verified live** (DescribeStreamSummary + CloudWatch; streams `vehicle-raw-packets-stage`, `iot-parsed-data` in config.json).
- **Phase 2 step 3 (ECS collector): done and verified live** (DescribeServices in batches of 10 + CloudWatch CPU/memory; clusters `mqtt-broker` and `intellicar-frontend`, 10 services in config.json).
- **Phase 2 step 4 (databases collector): done and verified live.** The user's DBs (`lmm-intellicar`, `rds-nemo-stage`) are standalone RDS PostgreSQL, not Aurora, so the `aurora` group (UI title "PostgreSQL databases") accepts instances without a `clusterId` and role `standalone`. Memory used % = 100 - FreeableMemory / `memoryGiB` (set per instance in config; the gauge is omitted when unset). Uses DescribeDBInstances.
- **Next: remaining collectors, one per step:** Redis, alarms. Each needs the real resource names from the user and its IAM actions added to the policy. Known follow-up: the cost estimate prices requests at the GetMetricData rate; with `metricsApi: "statistics"` they are free-tier eligible, so the widget overstates cost.
- Dev AWS credentials: `~/.aws` default profile (user-approved for now; replaced by the read-only IAM user in Phase 3). Real Lambda in config.json: `java-kineis-to-Postgres-a301`.
- **Later phases:**
  - Phase 3: read-only IAM user and policy, Windows service, Assigned Access kiosk, hardening. Measure real GPU/CPU cost of the ribbon on the kiosk PC.
  - Phase 4: notification skeleton (RuleEngine fed by the health-change log; Notifier calls the user's own email-service API; no SES/SNS).
  - Phase 5: optional ECS deployment.

## Working agreements with this user

- **Plan before building.** When asked to review or plan, discuss and propose only; don't execute until they say go.
- **Cost:** be explicit about anything that costs money in AWS and let them decide. Prefer free or near-free options.
- **Security:** read-only least-privilege IAM. No arbitrary-resource input from the UI. `config.json` (secrets and resource list) stays read-only to the web process, and admin edits go to `data/settings.json`. The user asked for settings "in the config file"; this split was explained and is pending their confirmation.
- **UI quality bar:** ultra-modern, fluid, subtle animation, very professional. Verify visually via screenshots, not just by typechecking.

## Environment

- **WSL2 on Windows.** Node 24 is user-installed at `~/.local/node`, so start each shell with `export PATH=$HOME/.local/node/bin:$PATH`.
- **Run:**
  - Install and configure: `npm install`, then `npm run init-config` (only if `config.json` is missing).
  - Build: `npm run build`.
  - Dev server: `npm run dev:server` (API + WS + built UI on :8080). Optionally add `npm run dev:web` for Vite on :5173.
  - Stop old watchers first with `pkill -f "[t]sx watch"`; several instances fight over :8080.
- **Dev admin:** user `admin` with the dev password the user was given (in the Phase 1 summary). The scrypt hash is in `config.json`, which is git-ignored.
- **Screenshots and UI checks:** `scripts/dev/cdp.ps1` drives headless Windows Edge over CDP.
  - Copy it to `C:\Users\Public\awsmon-shots\` and run it with `powershell.exe -File ... -SpecPath <spec.json>`.
  - Steps: `goto`, `wait`, `eval`, `shot`, `cdp` (raw CDP, e.g. `Input.dispatchMouseEvent`), `metrics` (Performance.getMetrics).
  - It cleans up its Edge process tree. Check that no `msedge` processes with `awsmon-edge-profile` linger afterwards.
- **Git:** repo at `aws-monitor/`, branch `main`, remote `origin` = https://github.com/arvind-online/awsmon.git (GitHub auth is set up; push works). Git identity is configured globally. Only `config.sample.json` is tracked; the real `config.json` holds secrets and is git-ignored. Commit messages end with the attribution line from the system reminder.

## Code map

- `shared/`: types plus pure logic (schedule windows, cost projection), used by server and web.
- `server/src/`
  - `app.ts`: routes, CSP, auth guards, WS
  - `monitor.ts`: poll, merge, snapshot persist
  - `scheduler/`: windowed intervals, escalation, manual refresh limits
  - `collectors/`: `mock.ts`; real ones go here in Phase 2
  - `settings.ts`, `layout.ts`, `events.ts`, `auth.ts`, `hub.ts`, `usage.ts`
- `web/src/`
  - `App.tsx`: grid layout, kiosk, scale, shared layout
  - `widgets/`, `components/`: charts with morphing, `FitList`, `WaveBackground`
  - `waves/`: ribbon renderer and worker
  - `admin/`
- **Known gotchas:**
  - Display scale uses `transform: scale()` with react-grid-layout's `createScaledStrategy(scale)` **minus** its `calcDragPosition` (that function assumes the grid sits at the viewport origin).
  - In CSS, a base rule placed after a `@container` rule overrides it.
  - Never use `backdrop-filter` over the animated background.
