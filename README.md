# VSCode Codex Tracker

VSCode Codex Tracker is a VS Code extension for monitoring local Codex usage
in a focused status bar and panel dashboard.

## Features

- Live five-hour and weekly usage windows with reset times.
- Status bar indicators that open the tracker panel.
- Local prompt history with input, output, and cached token counts.
- Estimated spend and usage charts.
- Prompt, token, model, and efficiency views.
- Date-range filters, custom ranges, search, sorting, and row limits.
- Resizable and rearrangeable dashboard cards, with layout reset.
- Configurable refresh interval, thresholds, colors, and history limit.
- Account and plan details when available from the local Codex source.
- Optional community leaderboard participation.
- Anonymous leaderboard names use a generated numeric suffix so identities do
  not all share the same public name.
- Leaderboard view includes aggregate input tokens and prompt totals.
- Leaderboard popup opens from the dashboard without leaving the panel.

## Privacy

Usage collection reads local Codex session data. Prompt text and token details
remain local to the extension dashboard.

Leaderboard participation is optional. When enabled, only a public name,
cumulative aggregate input-token total, cumulative prompt count, and update
metadata are submitted. Prompts, output text, file paths, account credentials,
and raw authentication tokens are not submitted.

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
- `codexUsage.refreshIntervalSeconds`: dashboard refresh interval, from 10
  seconds to 1 hour.
- `codexUsage.historyLimit`: maximum number of recent prompts to display.
- `codexUsage.warningThresholdPercent`: warning threshold for usage windows.
- `codexUsage.criticalThresholdPercent`: critical threshold for usage windows.
- `codexUsage.warningColor`: warning status-bar color.
- `codexUsage.criticalColor`: critical status-bar color.
- `codexUsage.belowFullColor`: normal status-bar color.
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
