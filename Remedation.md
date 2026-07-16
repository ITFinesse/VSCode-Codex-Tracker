P0 — [x] Add automated tests for session parsing, rate-limit responses, settings validation, and chart data aggregation.
P0 — [x] Add a strict webview Content Security Policy with nonces.
P1 — [x] Cache parsed session files by path, size, and modification time instead of rereading every JSONL file.
P1 — [x] Replace unbounded recursive directory traversal with bounded concurrency.
P1 — [x] Reuse or briefly cache Codex rate-limit results instead of spawning app-server on every refresh.
P1 — [x] Split the 460-line embedded dashboard into testable HTML, CSS, and JavaScript modules.
P1 — [x] Add dashboard browser tests covering refreshes, range switching, corrupt storage, empty data, and resize behavior.
P2 — [x] Pause countdown/chart work while the webview is hidden.
P2 — [x] Persist dashboard-only preferences through VS Code state/configuration rather than raw localStorage.
P2 — [x] Add performance instrumentation for activation, scanning, parsing, app-server response, and rendering.
P3 — [x] Add linting, formatting, CI compilation, package validation, and dependency auditing.
.