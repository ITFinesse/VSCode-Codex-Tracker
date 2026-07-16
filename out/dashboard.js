"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.professionalPanelHtml = professionalPanelHtml;
const dashboardClient_1 = require("./dashboardClient");
const dashboardMarkup_1 = require("./dashboardMarkup");
const dashboardStyles_1 = require("./dashboardStyles");
function professionalPanelHtml(chartScriptUri, webviewCspSource, nonce) {
    return String.raw `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webviewCspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none'; font-src ${webviewCspSource};">
  <style nonce="${nonce}">
${dashboardStyles_1.dashboardStyles}
  </style>
</head>
<body>
${dashboardMarkup_1.dashboardMarkup}
  <script nonce="${nonce}" src="${chartScriptUri}"></script>
  <script nonce="${nonce}">
${dashboardClient_1.dashboardClient}
  </script>
</body>
</html>`;
}
//# sourceMappingURL=dashboard.js.map