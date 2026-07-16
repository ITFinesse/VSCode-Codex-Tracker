import { dashboardClient } from "./dashboardClient";
import { dashboardMarkup } from "./dashboardMarkup";
import { dashboardStyles } from "./dashboardStyles";

export function professionalPanelHtml(chartScriptUri: string, webviewCspSource: string, nonce: string): string {
  return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webviewCspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none'; frame-src https://vscodecodextracker.itfinesse.co.uk; font-src ${webviewCspSource};">
  <style nonce="${nonce}">
${dashboardStyles}
  </style>
</head>
<body>
${dashboardMarkup}
  <script nonce="${nonce}" src="${chartScriptUri}"></script>
  <script nonce="${nonce}">
${dashboardClient}
  </script>
</body>
</html>`;
}
