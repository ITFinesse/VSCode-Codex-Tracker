# VSCode Codex Tracker

VSCode Codex Tracker is a VS Code extension for monitoring local Codex usage in a
focused status bar and panel dashboard.

## Features

- Live Codex app-server quota tracking:
  - five-hour window remaining and reset time.
  - weekly window remaining and reset time.
  - account/plan info when available from the app-server payload.
- Accurate quota display:
  - missing quota windows are shown as `N/A` instead of reusing stale data.
  - no “last-known quota” fallback is used when live reads fail.
- Automatic quota refresh behavior:
  - event-driven refresh on `.jsonl` session file changes.
  - additional refresh every minute to keep quota up-to-date.
- Status-bar `5H` and `Weekly` indicators that open the tracker panel.
- Local prompt history parsing from Codex session logs:
  - input, output, and cached token totals.
  - estimated cost summaries.
- Dashboard metrics:
  - charts for token and cost trends.
  - searchable prompt list with per-row totals.
- Appearance and usability:
  - configurable warning/critical thresholds and colors.
  - chart layout persistence with global or workspace scope.
- Optional leaderboard participation using aggregate totals only.

## Recent fixes

- Fixed ENOENT startup and refresh failures caused by missing `codex` on `PATH`.
  The extension now resolves the executable using:
  - explicit `codexUsage.codexPath` (when provided),
  - detected OpenAI Codex binary in installed extension locations,
  - fallback to `codex` on `PATH`.
- Improved quota diagnostics are now written to the output channel when app-server
  reads fail or return incomplete data.
- Removed stale-value masking in the quota path; windows now report accurately and
  explicitly as `N/A` when unavailable.

## Privacy

Usage collection reads local Codex session data. Prompt text and token details
remain local to the extension dashboard.

Leaderboard participation is optional. When enabled, only a public name,
cumulative aggregate input-token total, cumulative prompt count, and update metadata
are submitted. Prompts, output text, file paths, account credentials, and raw
authentication tokens are not submitted.

Disable **Participate** in the dashboard settings at any time.

## Installation

Install the latest VSIX from the
[GitHub Releases](https://github.com/ITFinesse/VSCode-Codex-Tracker/releases)
page, then use **Extensions: Install from VSIX...** in VS Code.

The extension is also published through the
[ITFinesse Marketplace publisher](https://marketplace.visualstudio.com/manage/publishers/itfinesse).

## Settings

- `codexUsage.sessionsPath`: optional Codex session directory override.
- `codexUsage.codexPath`: optional Codex executable path override.
- `codexUsage.historyLimit`: maximum number of recent prompts to display.
- `codexUsage.outputDebug`: enable detailed internal logs for diagnostics.
- `codexUsage.warningThresholdPercent`: warning threshold for usage windows.
- `codexUsage.criticalThresholdPercent`: critical threshold for usage windows.
- `codexUsage.warningColor`: status-bar color used at warning threshold.
- `codexUsage.criticalColor`: status-bar color used at critical threshold.
- `codexUsage.belowFullColor`: status-bar color used when remaining usage is below
  100% but above warning.
- `codexUsage.chartOrganisation`: use `global` or `workspace` dashboard card layout.
- `codexUsage.leaderboardEnabled`: enable or disable aggregate submissions.
- `codexUsage.leaderboardName`: public leaderboard name.

## Development

```powershell
npm install
npm run compile
```

Open the folder in VS Code and press `F5` to launch an Extension Development
Host. Useful commands:

- **Codex Usage: Show Panel**
- **Codex Usage: Refresh**
- **Codex Usage: Show Output**

Run the full verification suite with:

```powershell
npm run verify
```

## Links

- [Repository: ITFinesse/VSCode-Codex-Tracker](https://github.com/ITFinesse/VSCode-Codex-Tracker)
- [ITFinesse website](https://itfinesse.co.uk)
- [ITFinesse Marketplace publisher](https://marketplace.visualstudio.com/manage/publishers/itfinesse)

## License

Copyright (c) 2026 Stephen Stern, ITFinesse.co.uk.

This project is licensed under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/).

Commercial use, resale, paid distribution, use in a paid product or service,
and monetisation require prior written permission from the copyright holder.
