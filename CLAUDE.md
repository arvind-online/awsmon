# AWS Monitor: project guide for Claude

A low-cost, secure, kiosk-style dashboard for the user's key AWS resources (ECS, Aurora PostgreSQL, Lambda, Kinesis, ElastiCache Redis OSS, CloudWatch alarms). It runs locally on Windows 11 Pro for Workstations as a 24/7 kiosk, and may later be hosted on ECS.

- **Design source of truth:** `docs/DESIGN.md`. Read sections 14 (phase plan), 16 (Phase 1.5 notes) and 17 (collector framework) first.
- **Usage docs:** `README.md`.

## Current status (as of 2026-10-14)

- **Phase 1 (scaffold, mock data): done.** Staged in git as the baseline (not committed, see below).
- **Phase 1.5 (UI and foundations): done, uncommitted.** Includes:
  - silk-ribbon background (Web Worker + OffscreenCanvas)
  - admin card opacity, display scale, kiosk mode (`/?display=kiosk`), shared server-side layout
  - per-collector staleness, health-change log ("Recent changes")
  - startup-poll skip, session revocation, WebSocket limits
  - 31 server tests pass
- **Next: Phase 2.** First build the collector plugin framework (DESIGN §17), then the real collectors.
  - Use `GetMetricStatistics` by default (`aws.metricsApi: "statistics" | "data"`, see DESIGN §6). It counts toward the free tier.
  - Keep the mock collector as a permanent, switchable "simulated" mode, and add an admin switch between live and simulated.
  - **Blocked on the user:** real resource names (ECS cluster/services, Aurora cluster/instances, Lambda names, Kinesis streams, Redis replication group and nodes), and the AWS region. Ask for them at the start of Phase 2.
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
- **Git:** repo at `aws-monitor/`, branch `main`, no commits yet, and no git user.name/email configured. Ask the user to set them (or for permission) before committing. Commit messages end with the attribution line from the system reminder.

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
