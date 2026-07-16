const fs = require("node:fs");
const path = require("node:path");

const source = path.join(path.dirname(require.resolve("chart.js")), "chart.umd.js");
const destination = path.join(__dirname, "..", "resources", "chart.umd.js");
fs.copyFileSync(source, destination);
