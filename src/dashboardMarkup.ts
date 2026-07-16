export const dashboardMarkup = String.raw`  <header class="topbar">
    <div class="title">Usage</div>
    <nav class="ranges">
      <button class="range" data-days="1">1D</button>
      <button class="range" data-days="7">7D</button>
      <button class="range" data-days="30">30D</button>
      <button class="range" data-days="90">90D</button>
      <button class="range" data-days="0">Custom</button>
    </nav>
    <div class="quota-strip">
      <span class="quota-pill">5H <strong id="fiveHour">N/A</strong><span id="fiveReset">Reset --</span></span>
      <div class="quota-bars" aria-label="Quota remaining and reset progress"><span class="quota-bar"><i id="fiveRemainingBar" style="height:2px"></i><span>5H</span></span><span class="quota-bar reset"><i id="fiveResetBar" style="height:2px"></i><span>R</span></span><span class="quota-bar"><i id="weeklyRemainingBar" style="height:2px"></i><span>W</span></span><span class="quota-bar reset"><i id="weeklyResetBar" style="height:2px"></i><span>R</span></span></div>
      <span class="quota-pill">Weekly <strong id="weekly">--%</strong><span id="weeklyReset">Reset --</span></span>
    </div>
    <div class="top-actions">
      <span><i class="live-dot"></i>Auto-refresh: On</span>
      <span id="updated">Loading…</span>
      <button id="settingsToggle" class="icon-button" title="Usage settings">⚙</button>
    </div>
  </header>
  <div id="accountMeta" class="account-meta hidden"></div>
  <aside id="settings" class="settings" hidden>
    <h2>Usage Settings</h2>
    <form id="settingsForm">
      <label>Default Filter
        <select id="defaultRangeDays">
          <option value="1">1D</option>
          <option value="7">7D</option>
          <option value="30">30D</option>
          <option value="90">90D</option>
          <option value="0">Custom / all history</option>
        </select>
      </label>
      <label>Refresh Interval
        <select id="refreshIntervalSeconds">
          <option value="10">10 seconds</option>
          <option value="30">30 seconds</option>
          <option value="60">1 minute</option>
          <option value="300">5 minutes</option>
          <option value="900">15 minutes</option>
          <option value="1800">30 minutes</option>
          <option value="3600">1 hour</option>
        </select>
      </label>
      <div class="visibility">
        <label><input id="showSpend" type="checkbox"> Spend chart</label>
        <label><input id="showMetrics" type="checkbox"> Metric charts</label>
        <label><input id="showModels" type="checkbox"> Model chart</label>
        <label><input id="showTokens" type="checkbox"> Tokens chart</label>
        <label><input id="showPrompts" type="checkbox"> Prompt usage</label>
      </div>
      <div class="thresholds">
        <label>Below 100%<input id="belowFullColor" type="color"></label>
        <label>Warning<input id="warningColor" type="color"></label>
        <label>Critical<input id="criticalColor" type="color"></label>
      </div>
      <div class="thresholds">
        <label>Warning %<input id="warningThreshold" type="number" min="0" max="100"></label>
        <label>Critical %<input id="criticalThreshold" type="number" min="0" max="100"></label>
      </div>
      <button class="save" type="submit">Save Settings</button>
    </form>
  </aside>
  <main id="content">Loading…</main>
  <div id="chartTooltip" class="chart-tooltip" hidden></div>`;
