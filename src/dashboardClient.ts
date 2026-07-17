export const dashboardClient = String.raw`    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let snapshot;
    const viewState = vscode.getState() || {};
    const storedRangeDays = Number(viewState.defaultRangeDays);
    let rangeDays = [0, 1, 7, 30, 90].includes(storedRangeDays) ? storedRangeDays : 1;
    let visibleRows = 4;
    let sortMode = 'latest';
    let nextRefreshAt = 0;
    let lastUpdated = '';
    let leaderboard = { enabled: false, name: 'Anonymous', code: '' };
    let cardLayout = viewState.cardLayout && typeof viewState.cardLayout === 'object' ? viewState.cardLayout : {};
    const defaultVisibility = { showSpend: true, showMetrics: true, showModels: true, showTokens: true, showPrompts: true };
    let visibility = defaultVisibility;
    try {
      const storedVisibility = viewState.visibility;
      if (storedVisibility && typeof storedVisibility === 'object' && !Array.isArray(storedVisibility)) {
        visibility = { ...defaultVisibility, ...storedVisibility };
      }
    } catch {}
    let dateFormatter = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    let timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    let axisTimeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    let dayFormatter = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit' });
    let tooltipDateFormatter = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit' });

    const number = v => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v || 0);
    const money = (v, d = 2) => '$' + Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    const updateLabel = () => {
      if (!snapshot) return;
      const seconds = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
      const remaining = seconds > 0
        ? seconds >= 60 ? Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's' : seconds + 's'
        : 'Refreshing…';
      $('updated').textContent = (seconds > 0 ? 'Update in: ' : '') + remaining + ', Last: ' + lastUpdated;
    };
    const filtered = ps => rangeDays ? ps.filter(p => p.time >= Date.now() - rangeDays * 86400000) : ps;
    const timeline = ps => [...ps].sort((a, b) => a.time - b.time);
    const setDateFormat = (locale, timeZone) => {
      const options = timeZone ? { timeZone } : undefined;
      dateFormatter = new Intl.DateTimeFormat(locale || undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', ...options });
      timeFormatter = new Intl.DateTimeFormat(locale || undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', ...options });
      axisTimeFormatter = new Intl.DateTimeFormat(locale || undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', ...options });
      dayFormatter = new Intl.DateTimeFormat(locale || undefined, { day: '2-digit', month: '2-digit', ...options });
      tooltipDateFormatter = new Intl.DateTimeFormat(locale || undefined, { day: '2-digit', month: '2-digit', ...options });
    };
    const formatLabel = (point, index, ordered) => {
      const date = new Date(point.time);
      const day = dayFormatter.format(date);
      const previous = index ? dayFormatter.format(new Date(ordered[index - 1].time)) : '';
      return !index || day !== previous ? dateFormatter.format(date) : timeFormatter.format(date);
    };

    const charts = new Map();
    const canvas = (id, height, label) => '<div class="chart-wrap" style="height:' + height + 'px"><canvas id="' + id + '" role="img" aria-label="' + esc(label) + '"></canvas></div>';
    const chartText = value => Math.abs(value) < 1 ? money(value, 2) : number(value);
    const chartTheme = () => ({ text: resolvedColor('--muted', '#a5a5a5'), grid: resolvedColor('--border', '#3b3b3b') });
    const destroyCharts = () => { charts.forEach(instance => instance.destroy()); charts.clear(); };
    const buildChart = (id, config) => {
      const target = $(id);
      if (!target || typeof Chart === 'undefined') return;
      const instance = new Chart(target, config);
      charts.set(id, instance);
    };
    const timeLabels = points => timeline(points).map((point, index, ordered) => formatLabel(point, index, ordered));
    const commonOptions = (title, compact = false, labels = []) => {
      const theme = chartTheme();
      return {
        responsive: true, maintainAspectRatio: false, normalized: true,
        animation: { duration: 420, easing: 'easeOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: !compact, labels: { color: theme.text, usePointStyle: true, boxWidth: 8, font: { size: 11 } } },
          title: { display: false, text: title },
          tooltip: { callbacks: { title: items => { const point = items[0]?.raw; return point?.timestamp ? tooltipDateFormatter.format(new Date(point.timestamp)) + ' ' + axisTimeFormatter.format(new Date(point.timestamp)) : ''; }, label: item => item.dataset.label + ': ' + (item.dataset.unit === 'money' ? money(item.parsed.y, 4) : number(item.parsed.y)) } }
        },
        scales: {
          x: { type: 'category', title: { display: false, text: 'Time', color: theme.text }, ticks: { color: theme.text, autoSkip: true, display: !compact, maxRotation: 45, minRotation: 45, callback: value => labels[value] || '' }, grid: { display: false }, border: { display: false } },
          y: { title: { display: !compact, text: 'Value', color: theme.text }, ticks: { color: theme.text, display: !compact, callback: chartText }, grid: { color: theme.grid + '66' }, border: { display: false }, beginAtZero: true }
        }
      };
    };
    const translucent = color => color.startsWith('#') ? color + '26' : color.replace(/^rgb\(/, 'rgba(').replace(/\)$/, ', 0.15)');
    const lineDataset = (label, points, key, color, fill = false, axis = 'y', compact = false, unit = 'tokens') => ({ label, data: points.map((point, index) => ({ x: index, y: Number(point[key]) || 0, timestamp: point.time })), parsing: false, yAxisID: axis, borderColor: color, backgroundColor: fill ? translucent(color) : color, fill, borderWidth: 2, tension: .35, pointRadius: compact ? 1.75 : 3, pointHoverRadius: 5, pointStyle: 'circle', pointBackgroundColor: color, pointBorderColor: resolvedColor('--surface', '#181818'), pointBorderWidth: 1.5, unit });

    const models = ps => {
      const map = new Map();
      ps.forEach(p => {
        const row = map.get(p.model || 'Codex') || { name: p.model || 'Codex', input: 0, output: 0, cached: 0, cost: 0, prompts: 0 };
        row.input += p.inputTokens || 0;
        row.output += p.outputTokens || 0;
        row.cached += p.cachedTokens || 0;
        row.cost += p.cost || 0;
        row.prompts += 1;
        map.set(row.name, row);
      });
      return [...map.values()].sort((a, b) => b.cost - a.cost);
    };

    const resolvedColor = (property, fallback) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(' + property + ', ' + fallback + ')';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color || fallback;
      probe.remove();
      return color;
    };
    const palette = [resolvedColor('--teal', '#3fbca8'), resolvedColor('--purple', '#a45de3'), resolvedColor('--accent', '#3794ff'), '#e6c43b'];

    function bindTips() {
      const tip = $('chartTooltip');
      document.querySelectorAll('circle[data-tip]').forEach(point => {
        const show = event => {
          tip.textContent = point.dataset.tip;
          tip.hidden = false;
          tip.style.left = event.clientX + 12 + 'px';
          tip.style.top = event.clientY + 12 + 'px';
        };
        point.onmouseenter = show;
        point.onmousemove = show;
        point.onmouseleave = () => tip.hidden = true;
        point.onfocus = () => {
          tip.textContent = point.dataset.tip;
          tip.hidden = false;
          const rect = point.getBoundingClientRect();
          tip.style.left = rect.left + 'px';
          tip.style.top = rect.bottom + 7 + 'px';
        };
        point.onblur = () => tip.hidden = true;
      });
      document.querySelectorAll('[data-info]').forEach(button => {
        button.onclick = event => {
          const rect = button.getBoundingClientRect();
          tip.textContent = button.dataset.info;
          tip.hidden = false;
          tip.style.left = rect.left + 'px';
          tip.style.top = rect.bottom + 7 + 'px';
          event.stopPropagation();
        };
      });
      document.onclick = event => {
        if (!event.target.closest('[data-info]')) {
          tip.hidden = true;
        }
      };
    }

    const cardId = card => {
      if (card.dataset.card) return card.dataset.card;
      if (card.classList.contains('spend-panel')) return 'spend';
      if (card.classList.contains('metric')) return 'metric-' + [...card.parentElement.children].indexOf(card);
      if (card.classList.contains('table-panel')) return 'table';
      const title = card.querySelector('h2')?.textContent || '';
      return title.includes('Model') ? 'model' : title.includes('Prompts') ? 'prompts' : 'tokens';
    };
    const bindCards = () => {
      const cards = [...document.querySelectorAll('.spend-panel,.metric,.token-panel,.lower>.panel,.table-panel')];
      cards.forEach(card => {
        const id = cardId(card);
        card.dataset.card = id;
        card.draggable = true;
        const size = vscode.getState()?.cardSizes?.[id];
        if (size?.height) card.style.height = size.height + 'px';
        card.ondragstart = () => { card.classList.add('dragging'); };
        card.ondragend = () => { card.classList.remove('dragging'); };
        card.ondragover = event => event.preventDefault();
        card.ondrop = event => {
          event.preventDefault();
          const dragging = document.querySelector('.dragging');
          if (!dragging || dragging === card) return;
          const fromParent = dragging.parentElement;
          const toParent = card.parentElement;
          toParent.insertBefore(dragging, card);
          [fromParent, toParent].forEach(parent => {
            cardLayout[parent.id || parent.className] = [...parent.children].map(item => item.dataset.card).filter(Boolean);
          });
          vscode.setState({ ...vscode.getState(), cardLayout });
        };
        card.onpointerup = () => {
          const cardSizes = { ...(vscode.getState()?.cardSizes || {}) };
          cardSizes[id] = { height: card.offsetHeight };
          vscode.setState({ ...vscode.getState(), cardSizes });
        };
      });
      Object.entries(cardLayout).forEach(([parentKey, order]) => {
        const parent = parentKey === 'content' ? $('content') : document.querySelector('.' + parentKey);
        if (!parent || !Array.isArray(order)) return;
        order.forEach(id => {
          const item = cards.find(child => child.dataset.card === id);
          if (item) parent.appendChild(item);
        });
      });
    };

    function render() {
      if (!snapshot) return;

      destroyCharts();
      setDateFormat(snapshot.locale, snapshot.timeZone);
      const prompts = filtered(snapshot.prompts);
      const points = timeline(prompts).map((point, index) => ({
        ...point,
        input: point.inputTokens || 0,
        output: point.outputTokens || 0,
        cached: point.cachedTokens || 0,
        prompts: index + 1
      }));
      const dailyPrompts = [];
      for (const point of points) {
        const day = dayFormatter.format(new Date(point.time));
        const current = dailyPrompts[dailyPrompts.length - 1];
        if (current?.day === day) {
          current.prompts += 1;
          current.time = point.time;
        } else {
          dailyPrompts.push({ day, time: point.time, prompts: 1 });
        }
      }
      const totals = prompts.reduce((acc, p) => ({
        input: acc.input + (p.inputTokens || 0),
        output: acc.output + (p.outputTokens || 0),
        cached: acc.cached + (p.cachedTokens || 0),
        cost: acc.cost + (p.cost || 0),
        requests: acc.requests + 1
      }), { input: 0, output: 0, cached: 0, cost: 0, requests: 0 });
      const metric = (name, value, key, color, info) => '<article class="metric" data-card="metric-' + key + '" draggable="true"><div class="eyebrow">' + name + ' <button class="info" data-info="' + info + '">i</button></div><div class="metric-value">' + value + '</div>' + canvas('metric-' + key, 45, name + ' trend') + '</article>';
      const group = models(prompts);
      $('fiveHour').textContent = snapshot.fiveHour.remaining;
      $('fiveReset').textContent = 'Reset ' + snapshot.fiveHour.reset;
      $('weekly').textContent = snapshot.weekly.remaining;
      $('weeklyReset').textContent = 'Reset ' + snapshot.weekly.reset;
      const quotaTip = (label, quota) => label + ' ' + quota.remaining + '. Rst ' + quota.reset;
      const bar = (id, value, tip) => { const el = $(id); if (el) { el.style.height = Math.max(2, Math.min(100, Number(value) || 0)) + '%'; el.title = tip; } };
      bar('fiveRemainingBar', parseFloat(snapshot.fiveHour.remaining), quotaTip('5H', snapshot.fiveHour));
      bar('fiveResetBar', snapshot.fiveHour.resetPercent, quotaTip('5H', snapshot.fiveHour));
      bar('weeklyRemainingBar', parseFloat(snapshot.weekly.remaining), quotaTip('Weekly', snapshot.weekly));
      bar('weeklyResetBar', snapshot.weekly.resetPercent, quotaTip('Weekly', snapshot.weekly));

      const meta = [
        snapshot.account?.plan && 'Plan: ' + snapshot.account.plan,
        snapshot.account?.credits && 'Codex Credits: ' + snapshot.account.credits,
        snapshot.account?.renewal && 'Renews: ' + snapshot.account.renewal
      ].filter(Boolean);
      $('accountMeta').textContent = meta.join(' · ');
      $('accountMeta').classList.toggle('hidden', !meta.length);

      const sorted = [...prompts];
      if (sortMode === 'agent') sorted.sort((a, b) => String(b.model || '').localeCompare(String(a.model || ''), undefined, { numeric: true }));
      if (sortMode === 'tokens') sorted.sort((a, b) => (b.inputTokens + b.outputTokens + b.cachedTokens) - (a.inputTokens + a.outputTokens + a.cachedTokens));

      const rows = sorted.map((p, i) =>
        '<tr data-row><td>' + esc(p.timestamp) + '</td><td class="session-cell" title="' + esc(p.session) + '">' + esc(p.sessionTitle || p.session) + '</td><td class="prompt-cell"><div class="prompt-row"><span class="prompt-text">' + esc(p.text) + '</span><button class="expand" data-expand="' + i + '">Expand</button></div><div class="prompt-full" hidden>' + esc(p.text) + '</div></td><td>' + esc(p.model || 'Codex') + '</td><td class="num">' + number(p.inputTokens) + '</td><td class="num">' + number(p.outputTokens) + '</td><td class="num">' + number(p.cachedTokens) + '</td><td class="num">' + money(p.cost, 4) + '</td></tr>'
      ).join('');

      $('content').innerHTML =
        (visibility.showSpend
          ? '<section class="panel spend-panel"><div><div class="eyebrow">Total Spend <button class="info" data-info="Estimated prompt spend across the selected period.">i</button></div><div class="big-value">' + money(totals.cost) + '</div><div class="trend">Current range <span>per-point timestamps</span></div></div><div>' + canvas('spend-chart', 220, 'Spend over time') + '</div></section>'
          : '') +
        (visibility.showTokens
          ? '<section class="panel token-panel"><h2 class="panel-title">Tokens Over Time <button class="info" data-info="Input and cached tokens use the left axis; output uses the right axis.">i</button></h2>' + canvas('tokens-chart', 260, 'Input, output, and cached tokens over time') + '</section>'
          : '') +
        (visibility.showMetrics
          ? '<section class="metrics">'
             + metric('Input Tokens', number(totals.input), 'input', palette[2], 'Tokens sent to Codex. The sparkline uses per-point timestamps.')
             + metric('Output Tokens', number(totals.output), 'output', palette[1], 'Tokens returned by Codex. The sparkline uses per-point timestamps.')
             + metric('Cached Tokens', number(totals.cached), 'cached', palette[0], 'Cached input tokens recorded by Codex. The sparkline uses per-point timestamps.')
             + '</section>'
          : '') +
        ((visibility.showModels || visibility.showPrompts)
          ? '<section class="lower">'
            + (visibility.showModels
               ? '<article class="panel"><h2 class="panel-title">Usage by Model &amp; Cost</h2><div class="model-chart">' + canvas('model-chart', 190, 'Usage by model and cost') + '</div><div class="model-list">' + group.map((g, i) => '<div class="model-row" data-model-index="' + i + '" role="button" tabindex="0" title="Toggle ' + esc(g.name) + '"><i class="swatch" style="background:' + palette[i % palette.length] + '"></i><span>' + esc(g.name) + '</span><span>' + money(g.cost) + '</span><span class="pct">' + (totals.cost ? (g.cost / totals.cost * 100).toFixed(1) : '0.0') + '%</span></div>').join('') + '</div></article><article class="panel"><h2 class="panel-title">Average tokens per prompt</h2>' + canvas('efficiency-chart', 170, 'Average input and output tokens per prompt by model') + '</article>'
              : '')
             + (visibility.showPrompts
               ? '<article class="panel"><h2 class="panel-title">Prompts <button class="info" data-info="Number of prompts sent each day in the selected period.">i</button></h2>' + canvas('prompts-chart', 170, 'Prompts over time') + '</article>'
               : '')
            + '</section>'
          : '') +
        (visibility.showPrompts
          ? '<section class="panel table-panel"><div class="table-head"><h2>Prompt Usage</h2><input id="search" class="search" type="search" placeholder="Search prompts…"><button class="sort ' + (sortMode === 'latest' ? 'active' : '') + '" data-sort="latest">Latest</button><button class="sort ' + (sortMode === 'agent' ? 'active' : '') + '" data-sort="agent">Agent</button><button class="sort ' + (sortMode === 'tokens' ? 'active' : '') + '" data-sort="tokens">Tokens ↓</button><label class="row-count">Rows <select id="rowCount"><option>4</option><option>10</option><option>25</option><option>100</option></select></label></div><div id="tableScroll" class="table-scroll"><table><thead><tr><th class="resizable" data-col="date">Date / Time</th><th class="resizable" data-col="task">Task</th><th class="resizable" data-col="prompt">Prompt</th><th class="resizable" data-col="agent">Agent</th><th class="resizable num">Input Tokens</th><th class="resizable num">Output Tokens</th><th class="resizable num">Cached Tokens</th><th class="resizable num">Cost</th></tr></thead><tbody>' + (rows || '<tr><td colspan="8" class="empty">No prompts in this range</td></tr>') + '</tbody></table></div></section>'
          : '');
      const noMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
       if ($('spend-chart')) buildChart('spend-chart', { type: 'line', data: { labels: timeLabels(points), datasets: [lineDataset('Spend', points, 'cost', palette[0], true, 'y', false, 'money')] }, options: commonOptions('Spend over time', false, timeLabels(points)) });
      [['input', 'Input Tokens', palette[2]], ['output', 'Output Tokens', palette[1]], ['cached', 'Cached Tokens', palette[0]]].forEach(([key, label, color]) => {
        const id = 'metric-' + key;
         if ($(id)) buildChart(id, { type: 'line', data: { labels: timeLabels(points), datasets: [lineDataset(label, points, key, color, true, 'y', true)] }, options: commonOptions(label + ' trend', true, timeLabels(points)) });
      });
      if ($('model-chart')) {
        const theme = chartTheme();
        const radarMax = ['input', 'output', 'cached', 'cost'].map(key => Math.max(1, ...group.map(g => g[key])));
        const radarKeys = ['input', 'output', 'cached', 'cost'];
        const radarLabels = ['Input', 'Output', 'Cached', 'Cost'];
        const radarDatasets = group.map((model, modelIndex) => ({ label: model.name, data: radarKeys.map((key, index) => model[key] / radarMax[index] * 100), rawValues: radarKeys.map(key => model[key]), borderColor: palette[modelIndex % palette.length], backgroundColor: translucent(palette[modelIndex % palette.length]), pointBackgroundColor: palette[modelIndex % palette.length], pointBorderColor: resolvedColor('--surface', '#181818'), pointRadius: 3, pointHoverRadius: 5, borderWidth: 2 }));
        buildChart('model-chart', { type: 'radar', data: { labels: radarLabels, datasets: radarDatasets }, options: { responsive: true, maintainAspectRatio: false, animation: { duration: noMotion ? 0 : 650, easing: 'easeOutQuart' }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: item => { const raw = item.dataset.rawValues[item.dataIndex]; return item.dataset.label + ' — ' + (item.dataIndex === 3 ? money(raw, 4) : number(raw)); } } } }, scales: { r: { beginAtZero: true, max: 100, title: { display: true, text: 'Relative usage (%)', color: theme.text }, ticks: { display: false }, grid: { color: theme.grid + '66' }, angleLines: { color: theme.grid + '66' }, pointLabels: { color: theme.text, font: { size: 10 } } } } } });
        const modelChart = charts.get('model-chart');
        document.querySelectorAll('[data-model-index]').forEach(row => {
          const toggle = () => { const index = Number(row.dataset.modelIndex); modelChart.data.datasets[index].hidden = !modelChart.data.datasets[index].hidden; row.style.opacity = modelChart.data.datasets[index].hidden ? '.45' : '1'; modelChart.update(); };
          row.onclick = toggle;
          row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } };
        });
      }
      if ($('efficiency-chart')) {
        const efficiencyLabels = group.map(model => model.name);
        const efficiencyDatasets = [
          { label: 'Avg input tokens', data: group.map(model => model.input / Math.max(1, model.prompts)), backgroundColor: translucent(palette[2]), borderColor: palette[2], borderWidth: 1, borderRadius: 3 },
          { label: 'Avg output tokens', data: group.map(model => model.output / Math.max(1, model.prompts)), backgroundColor: translucent(palette[1]), borderColor: palette[1], borderWidth: 1, borderRadius: 3 }
        ];
        buildChart('efficiency-chart', { type: 'bar', data: { labels: efficiencyLabels, datasets: efficiencyDatasets }, options: commonOptions('Average tokens per prompt', false, efficiencyLabels) });
      }
      if ($('prompts-chart')) {
        const promptLabels = timeLabels(dailyPrompts);
        buildChart('prompts-chart', { type: 'bar', data: { labels: promptLabels, datasets: [{ label: 'Prompts', data: dailyPrompts.map((point, index) => ({ x: index, y: Number(point.prompts) || 0, timestamp: point.time })), parsing: false, backgroundColor: translucent('#e6c43b'), borderColor: '#e6c43b', borderWidth: 1, borderRadius: 3, barPercentage: .8, categoryPercentage: .9, pointStyle: 'rect' }] }, options: commonOptions('Prompts over time', false, promptLabels) });
      }
      if ($('tokens-chart')) {
         const tokenLabels = timeLabels(points);
         const options = commonOptions('Tokens over time', false, tokenLabels);
        const theme = chartTheme();
        const tokenTick = value => value >= 1000000 ? (value / 1000000).toFixed(1) + 'M' : value >= 1000 ? Math.round(value / 1000) + 'k' : String(value);
        options.scales.y.title = { display: true, text: 'Input / Output', color: theme.text };
        options.scales.y.ticks = { color: theme.text, stepSize: 100000, callback: tokenTick };
        options.scales.yOutput = { position: 'right', beginAtZero: true, ticks: { color: theme.text, stepSize: 100000, callback: tokenTick }, title: { display: true, text: 'Output', color: theme.text }, grid: { drawOnChartArea: false }, border: { display: false } };
        options.scales.yCached = { position: 'right', beginAtZero: true, offset: true, ticks: { color: theme.text, stepSize: 100000, callback: tokenTick }, title: { display: true, text: 'Cached', color: theme.text }, grid: { drawOnChartArea: false }, border: { display: false } };
        if (!noMotion) options.animations = { tension: { duration: 1600, easing: 'easeInOutSine', from: .25, to: .4, loop: true } };
         const tokenDatasets = [lineDataset('Input', points, 'input', palette[2], true), lineDataset('Output', points, 'output', palette[1], true, 'yOutput'), lineDataset('Cached', points, 'cached', palette[0], true, 'yCached')].sort((a, b) => b.data.reduce((sum, point) => sum + point.y, 0) - a.data.reduce((sum, point) => sum + point.y, 0));
         buildChart('tokens-chart', { type: 'line', data: { labels: tokenLabels, datasets: tokenDatasets }, options });
      }
      const apply = () => {
        const query = $('search').value.toLowerCase();
        let matchedRows = 0;
        document.querySelectorAll('[data-row]').forEach(row => {
          const matches = row.textContent.toLowerCase().includes(query);
          row.hidden = !matches || matchedRows >= visibleRows;
          if (matches) matchedRows += 1;
        });
        $('tableScroll').style.maxHeight = (visibleRows * 38 + 34) + 'px';
      };

      if ($('search')) {
        $('search').oninput = apply;
        $('rowCount').value = visibleRows;
        $('rowCount').onchange = event => {
          visibleRows = Number(event.target.value);
          apply();
        };
        document.querySelectorAll('[data-sort]').forEach(button => {
          button.onclick = () => {
            sortMode = button.dataset.sort;
            render();
          };
        });
        apply();
      }

      bindCards();
      bindTips();
    }

    document.querySelectorAll('.range').forEach(button => {
      button.onclick = () => {
        document.querySelectorAll('.range').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        rangeDays = Number(button.dataset.days);
        render();
      };
    });
    document.querySelectorAll('.range').forEach(button => button.classList.toggle('active', Number(button.dataset.days) === rangeDays));
    const settingsToggle = $('settingsToggle');
    const settingsPanel = $('settings');
    const positionSettings = () => {
      const rect = settingsToggle.getBoundingClientRect();
      settingsPanel.style.right = Math.max(14, window.innerWidth - rect.right) + 'px';
      settingsPanel.style.bottom = 'auto';
      settingsPanel.style.top = '14px';
      const upwardTop = rect.top - settingsPanel.offsetHeight - 8;
      if (upwardTop >= 14) settingsPanel.style.top = upwardTop + 'px';
    };
    settingsToggle.onclick = () => {
      settingsPanel.hidden = !settingsPanel.hidden;
      if (!settingsPanel.hidden) positionSettings();
    };
    window.addEventListener('resize', () => { if (!settingsPanel.hidden) positionSettings(); });
    $('resetLayout').onclick = () => {
      cardLayout = {};
      const state = { ...vscode.getState() };
      delete state.cardLayout;
      delete state.cardSizes;
      vscode.setState(state);
      render();
    };
    $('leaderboardButton').onclick = () => {
      const popup = $('leaderboardPopup');
      popup.hidden = false;
      requestAnimationFrame(() => popup.classList.add('open'));
    };
    $('leaderboardClose').onclick = () => {
      const popup = $('leaderboardPopup');
      popup.classList.remove('open');
      setTimeout(() => { popup.hidden = true; }, 2000);
    };
    $('settingsForm').onsubmit = event => {
      event.preventDefault();
      ['showSpend', 'showMetrics', 'showModels', 'showTokens', 'showPrompts'].forEach(key => visibility[key] = $(key).checked);
      vscode.setState({ ...vscode.getState(), visibility });
      rangeDays = Number($('defaultRangeDays').value);
      vscode.setState({ ...vscode.getState(), defaultRangeDays: rangeDays });
      document.querySelectorAll('.range').forEach(item => item.classList.toggle('active', Number(item.dataset.days) === rangeDays));
      vscode.postMessage({
        command: 'saveAppearance',
        appearance: {
          refreshIntervalSeconds: Number($('refreshIntervalSeconds').value),
          warningThreshold: Number($('warningThreshold').value),
          criticalThreshold: Number($('criticalThreshold').value),
          belowFullColor: $('belowFullColor').value,
          warningColor: $('warningColor').value,
          criticalColor: $('criticalColor').value,
          theme: $('themeMode').value
        }
      });
      vscode.postMessage({ command: 'saveLeaderboard', leaderboard: { enabled: $('leaderboardEnabled').checked, name: $('leaderboardName').value, code: $('leaderboardCode').value } });
      $('settings').hidden = true;
      render();
    };
    $('checkLeaderboardName').onclick = () => {
      $('leaderboardNameStatus').textContent = 'Checking…';
      $('leaderboardNameStatus').className = '';
      vscode.postMessage({ command: 'checkLeaderboardName', leaderboard: { name: $('leaderboardName').value, code: $('leaderboardCode').value } });
    };
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-expand]');
      if (!button) return;
      const full = button.closest('td').querySelector('.prompt-full');
      full.hidden = !full.hidden;
      button.textContent = full.hidden ? 'Expand' : 'Collapse';
    });
    setInterval(() => {
      if (!snapshot || document.hidden) return;
      const seconds = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
      updateLabel();
    }, 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        charts.forEach(chart => chart.stop());
      } else {
        charts.forEach(chart => chart.update());
        render();
      }
    });
    window.onerror = (message, source, line, column, error) => vscode.postMessage({ command: 'webviewError', error: [message, source, line, column, error?.stack].filter(Boolean).join(' | ') });
    window.addEventListener('message', event => {
      const data = event.data;
      if (data.type === 'error') {
        $('content').textContent = data.message;
        return;
      }
      if (data.type === 'leaderboardName' || data.type === 'leaderboardError') {
        const status = $('leaderboardNameStatus');
        status.textContent = data.message || 'Could not save leaderboard settings.';
        status.className = data.available ? 'leaderboard-status-ok' : 'leaderboard-status-error';
        return;
      }
      if (data.type !== 'snapshot') return;
      snapshot = data.snapshot;
      nextRefreshAt = snapshot.nextRefreshAt;
      const metadata = data.metadata ?? snapshot.metadata;
      lastUpdated = metadata?.lastUpdate || snapshot.scannedAt;
      if (metadata) {
        $('versionMeta').textContent = metadata.version;
        $('buildTimeMeta').textContent = metadata.buildTime;
      }
      const appearance = snapshot.appearance;
      document.body.dataset.theme = appearance.theme;
      leaderboard = snapshot.leaderboard || leaderboard;
      $('leaderboardEnabled').checked = leaderboard.enabled === true;
      $('leaderboardName').value = leaderboard.name || 'Anonymous';
      $('leaderboardCode').value = leaderboard.code || '';
      ['refreshIntervalSeconds', 'warningThreshold', 'criticalThreshold', 'belowFullColor', 'warningColor', 'criticalColor', 'themeMode'].forEach(key => $(key).value = appearance[key]);
      $('defaultRangeDays').value = String(rangeDays);
      ['showSpend', 'showMetrics', 'showModels', 'showTokens', 'showPrompts'].forEach(key => $(key).checked = visibility[key] !== false);
      render();
      updateLabel();
    });
    setTimeout(() => vscode.postMessage({
      command: 'ready',
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }), 0);`;
