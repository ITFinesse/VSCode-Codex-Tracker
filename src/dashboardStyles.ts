export const dashboardStyles = String.raw`    :root{
      --accent:var(--vscode-charts-blue,#3794ff);
      --teal:var(--vscode-charts-green,#3fbca8);
      --purple:var(--vscode-charts-purple,#a45de3);
      --surface:var(--vscode-editor-background,#181818);
      --surface2:var(--vscode-sideBar-background,#202020);
      --border:var(--vscode-widget-border,#3b3b3b);
      --text:var(--vscode-foreground,#e8e8e8);
      --muted:var(--vscode-descriptionForeground,#a5a5a5);
    }
    *{box-sizing:border-box}
    body{margin:0;padding:22px;background:var(--surface);color:var(--text);font:13px/1.45 var(--vscode-font-family,Segoe UI,sans-serif)}
    button,input,select{font:inherit}
    .topbar{display:flex;align-items:center;gap:24px;margin:0 2px 18px}
    .title{font-size:26px;font-weight:700}
    .ranges,.top-actions,.quota-strip,.table-head{display:flex;align-items:center;gap:8px}
    .range,.sort{border:0;background:transparent;color:var(--muted);padding:7px 10px;border-radius:4px;cursor:pointer}
    .range.active,.sort.active{color:var(--accent);background:var(--vscode-toolbar-hoverBackground,#2b2b2b);box-shadow:inset 0 0 0 1px var(--border)}
    .quota-strip{justify-content:center;flex:1;white-space:nowrap}
    .quota-bars{display:flex;align-items:flex-end;gap:7px;height:42px;margin:0 10px}
    .quota-bar{display:grid;grid-template-rows:1fr auto;gap:2px;width:18px;height:42px;align-items:end;text-align:center;color:var(--muted);font-size:9px}
    .quota-bar i{display:block;width:100%;min-height:2px;border-radius:3px 3px 1px 1px;background:var(--accent);opacity:.8;cursor:help}
    .quota-bar.reset i{background:var(--purple)}
    .quota-pill{display:flex;gap:7px;align-items:center;padding:5px 9px;border:1px solid var(--border);border-radius:999px;background:var(--surface2);color:var(--muted)}
    .quota-pill strong{color:var(--text);font-size:18px}
    .top-actions{margin-left:auto;color:var(--muted);white-space:nowrap}
    .build-meta{display:flex;gap:12px;color:var(--muted);font-size:11px;margin:-8px 0 12px}
    .leaderboard-settings{display:grid;gap:8px;border:1px solid var(--border);margin:14px 0 0;padding:10px;border-radius:6px}.leaderboard-settings label{display:grid;gap:4px;color:var(--muted)}.leaderboard-settings input[type=checkbox]{margin-right:6px}.leaderboard-settings input[type=text],.leaderboard-settings input[type=url]{width:100%}.leaderboard-settings button{justify-self:start}.leaderboard-help{margin:0;color:var(--muted);font-size:11px}.leaderboard-status-ok{color:var(--teal)}.leaderboard-status-error{color:var(--vscode-errorForeground,#f48771)}
    .participate-toggle{display:flex!important;align-items:center;gap:8px;margin:0!important;cursor:pointer}.participate-toggle input{position:absolute;opacity:0;pointer-events:none}.participate-toggle span{position:relative;padding-left:44px;line-height:24px}.participate-toggle span::before{content:'';position:absolute;left:0;top:2px;width:34px;height:20px;border-radius:999px;background:var(--border);transition:background .15s ease}.participate-toggle span::after{content:'';position:absolute;left:3px;top:5px;width:14px;height:14px;border-radius:50%;background:var(--text);transition:transform .15s ease}.participate-toggle input:checked+span::before{background:var(--accent)}.participate-toggle input:checked+span::after{transform:translateX(14px)}.participate-toggle input:focus-visible+span::before{outline:2px solid var(--accent);outline-offset:2px}
    .icon-button{width:34px;height:34px;border:1px solid var(--border);border-radius:5px;background:var(--surface2);color:var(--text);cursor:pointer}
    .account-meta{margin:-10px 0 14px;color:var(--muted);text-align:center}
    .panel,.metric{border:1px solid var(--border);border-radius:7px;background:linear-gradient(180deg,color-mix(in srgb,var(--surface2) 42%,var(--surface)),var(--surface))}
    [data-card]{position:relative;resize:both;overflow:auto;min-width:180px;min-height:fit-content}
    #content{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}
    #content>.metrics,#content>.lower{display:contents}
    #content>.spend-panel,#content>.token-panel,#content>.table-panel{grid-column:1/-1}
    [data-card]::after{content:'↘';position:absolute;right:6px;bottom:3px;color:var(--muted);font-size:11px;pointer-events:none}
    [data-card].dragging{opacity:.55;outline:1px dashed var(--accent)}
    .spend-panel{display:grid;grid-template-columns:minmax(155px,180px) minmax(0,1fr);gap:12px;padding:18px;margin-bottom:12px}
    .eyebrow{display:flex;gap:6px;align-items:center;font-size:14px}
    .info{width:15px;height:15px;padding:0;border:1px solid var(--muted);border-radius:50%;background:transparent;color:var(--muted);font-size:9px;cursor:pointer}
    .big-value{font-size:32px;line-height:1.1;margin:18px 0 14px;font-variant-numeric:tabular-nums}
    .trend{color:var(--vscode-testing-iconPassed,#73c991);font-size:12px}
    .trend span{display:block;color:var(--muted)}
    .chart-wrap{position:relative;width:100%;height:220px;min-width:0}
    .chart-wrap canvas{display:block;width:100%!important;height:100%!important}
    .metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}
    .metric{padding:16px 17px 10px}
    .metric-value{font-size:19px;margin:5px 0 4px;font-variant-numeric:tabular-nums}
    .metric .chart-wrap{height:45px;margin-top:7px}
    .lower{display:grid;grid-template-columns:minmax(220px,.8fr) minmax(220px,.8fr) minmax(420px,1.4fr);gap:14px;margin-bottom:14px}
    .lower>.panel,.token-panel{padding:16px}
    .panel-title{font-size:17px;font-weight:700;margin:0 0 10px}
    .model-chart{height:190px}
    .model-list{display:grid;gap:10px}
    .efficiency-title{margin:18px 0 4px;color:var(--muted);font-size:12px}
    .model-row{display:grid;grid-template-columns:10px 1fr auto auto;gap:9px}
    .swatch{width:9px;height:9px;border-radius:50%;margin-top:5px}
    .pct{color:var(--muted);min-width:48px;text-align:right}
    .table-panel{overflow:hidden}
    .table-head{padding:8px 14px;border-bottom:1px solid var(--border)}
    .table-head h2{margin:0 auto 0 0;font-size:17px;font-weight:700}
    .search{width:215px;padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--vscode-input-background,#252526);color:var(--text)}
    .row-count{display:flex;align-items:center;gap:5px;color:var(--muted)}
    .row-count select,.settings select,.settings input[type=number]{padding:6px;color:var(--text);background:var(--vscode-input-background);border:1px solid var(--border);border-radius:3px}
    .table-scroll{max-height:186px;overflow:auto}
    table{width:100%;min-width:1020px;table-layout:fixed;border-collapse:collapse}
    th,td{padding:9px 14px;border-bottom:1px solid var(--border);text-align:left}
    th{color:var(--muted);font-size:11px;font-weight:500}
    th.resizable{resize:horizontal;overflow:hidden;min-width:64px}
    th[data-col=date]{width:150px}
    th[data-col=task]{width:150px}
    th[data-col=prompt]{width:350px}
    th[data-col=agent]{width:125px}
    .num{text-align:right;font-variant-numeric:tabular-nums}
    .date-cell,.session-cell{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .prompt-cell{max-width:0}
    .prompt-row{display:flex;gap:12px;min-width:0}
    .prompt-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .expand{border:0;background:transparent;color:var(--accent);cursor:pointer;flex:none}
    .prompt-full{margin-top:8px;color:var(--muted);white-space:pre-wrap}
    .empty{padding:28px;text-align:center;color:var(--muted)}
    .settings{position:fixed;z-index:100;right:22px;top:auto;bottom:auto;width:520px;max-width:calc(100vw - 28px);max-height:calc(100vh - 28px);overflow:auto;padding:16px;border:1px solid var(--border);border-radius:7px;background:var(--vscode-editorWidget-background,#252526);box-shadow:0 12px 36px #0006}
    .settings[hidden],.hidden{display:none}
    .settings h2{font-size:15px;font-weight:700;margin:0 0 15px}
    .settings label{display:grid;gap:6px;margin:11px 0}
    .visibility{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:12px 0}
    .visibility label{display:flex;align-items:center;gap:6px;margin:0;color:var(--muted)}
    .thresholds{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
    .thresholds label{font-size:11px}
    .thresholds input[type=color]{width:100%;height:30px}
    .reset-layout{width:100%;padding:8px;margin-top:12px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--text);cursor:pointer}
    .save{width:100%;padding:8px;border:0;border-radius:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
    .chart-tooltip{position:fixed;z-index:30;pointer-events:none;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--vscode-editorHoverWidget-background,#252526);box-shadow:0 4px 14px #0005;white-space:pre-line}
    .chart-tooltip[hidden]{display:none}
    .leaderboard-popup{position:fixed;z-index:110;inset:0;padding:14px;border:0;background:var(--vscode-editorWidget-background,#252526);box-shadow:0 -10px 30px #0008;transform:translateY(100%);transition:transform 2s ease}
    .leaderboard-popup.open{transform:translateY(0)}
    .leaderboard-popup[hidden]{display:none}
    .leaderboard-popup-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
    .leaderboard-popup iframe{display:block;width:100%;height:calc(100% - 92px);border:1px solid var(--border);background:var(--surface)}
    .leaderboard-popup button,.leaderboard-links a{padding:5px 10px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--text);cursor:pointer;text-decoration:none}
    .leaderboard-links{display:flex;gap:8px;margin-top:10px}
    @media(max-width:900px){.topbar{flex-wrap:wrap}.top-actions{width:100%;justify-content:flex-end}.spend-panel,.lower{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}.settings{top:auto;bottom:auto}}
    @media(max-width:900px){#content{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:540px){body{padding:14px}.metrics{grid-template-columns:1fr}.updated{display:none}.settings{left:14px;right:14px;width:auto}#content{grid-template-columns:1fr}}`;
