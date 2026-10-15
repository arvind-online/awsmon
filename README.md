# AWS Monitor

A low-cost, secure, kiosk-friendly dashboard for key AWS resources (ECS, Aurora PostgreSQL, Lambda, Kinesis, ElastiCache Redis, CloudWatch alarms).
See [`docs/DESIGN.md`](docs/DESIGN.md) for the architecture, cost model and security design.

**Status: Phase 1.5.** Everything runs on simulated data (`mode: "mock"`). Real AWS collectors arrive in Phase 2. Simulation mode stays available permanently for demos, development and testing.

## Run it

Requires Node.js 22+ (a Node 24 LTS is installed at `~/.local/node` in this WSL; add `export PATH=$HOME/.local/node/bin:$PATH` to use it).

```bash
npm install
npm run init-config      # writes config.json with a random admin password (printed once)
npm run build            # builds web/dist
npm start                # http://127.0.0.1:8080
```

Development with hot reload (two terminals):

```bash
npm run dev:server       # API + WebSocket on :8080
npm run dev:web          # Vite UI on http://localhost:5173 (proxies /api and /ws)
```

Other commands: `npm test`, `npm run typecheck`, `npm run hash-password -- "<12+ chars>"`.

## Using the UI

- **Display** (`/`): live over WebSocket. Page loads and refreshes read the server cache and never call AWS.
- **Refresh** button: single-flight, with a cooldown and a daily cap (both configurable).
- **Customize** (layout icon): drag a widget header to move it, drag an edge or corner to resize it; the other widgets realign automatically. Changes are kept in this browser. Signed in as admin, **Save as default for all displays** makes it the shared layout (pushed live to the kiosk). **Reset to default** discards this browser's changes.
- **Kiosk mode:** open `/?display=kiosk`. It locks the layout, hides the admin, theme and customize controls, and auto-hides the cursor.
- **Hide** (eye-off on a widget header, on hover): hides it temporarily. A reload brings everything back. Hidden widgets appear as chips in the footer.
- **Theme**: dark, light or auto (sun/moon icon). Burn-in protection: dark default, the slowly moving ribbon background, and a few-pixel drift every couple of minutes.
- **Background**: an animated silk-ribbon of fine lines, drawn in a Web Worker so it never slows the charts. Admin can switch it to still or off, set intensity, and set **card opacity** (lower shows more of the ribbon through the cards).
- **Recent changes** (footer): the latest health transitions, e.g. `transform-fn Healthy → Warning`.
- **Dashboard cost** (footer): masked by default, click the eye to see this month's actual and projected CloudWatch API cost of running the dashboard.
- **Admin** (`/admin`, gear icon): polling schedule (working vs off hours, any whole number of minutes), adaptive escalation (off by default), manual refresh limits, thresholds, and display options (theme, display scale Desk/Wall/TV, background, card opacity, kiosk Refresh button). A live cost estimate updates as you type. Saved settings are written to `data/settings.json` and survive restarts.

## Configuration

Layering: defaults < `config.json` < environment variables (`MONITOR_PORT`, `MONITOR_HOST`, `MONITOR_MODE`, `MONITOR_REGION`, `MONITOR_ADMIN_USER`, `MONITOR_ADMIN_PASSWORD_HASH`, `MONITOR_SESSION_SECRET`, `MONITOR_DATA_DIR`, `MONITOR_CONFIG`, `MONITOR_TRUST_PROXY`).

Testing aids: `MOCK_FAIL=kinesis,redis` makes those simulated collectors fail, to see stale handling.

- `config.json` (git-ignored) holds the resource lists, credentials hash and seed settings. Resources cannot be edited from the UI by design.
- Admin edits are stored in `data/settings.json` (deliberately not in `config.json`, which holds secrets and the resource list and stays read-only to the web process). `data/` also holds the last snapshot, usage counters, the health-change log and the shared layout.
- The server refuses to listen on a non-loopback address unless `MONITOR_ALLOW_NON_LOOPBACK=true` (only set this behind authentication, e.g. on ECS).

## Layout

```
server/   Fastify API, WebSocket hub, scheduler, collectors (mock for now), settings, auth
web/      React + Vite UI (react-grid-layout, custom SVG charts)
shared/   Types and pure logic shared by both (schedule, cost model)
scripts/  init-config, hash-password, dev/cdp.ps1 (headless Edge screenshot helper for WSL)
```
