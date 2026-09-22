import { dashboardI18nJson } from "./i18n/index.js";

export function renderDashboardHtml(): string {
  const i18nJson = dashboardI18nJson();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0b1220" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Polymoney" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/icon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/icon.svg" />
  <title>Polymoney — Control Center</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0b0f14;
      --panel: #121820;
      --border: #1e2a3a;
      --text: #e8eef5;
      --muted: #8b9cb3;
      --green: #22c55e;
      --red: #ef4444;
      --yellow: #eab308;
      --blue: #3b82f6;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 1.25rem;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
      gap: 1rem;
    }
    h1 { font-size: 1.4rem; font-weight: 700; }
    .subtitle { color: var(--muted); font-size: 0.85rem; margin-top: 0.2rem; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      border: 1px solid var(--border);
      background: var(--panel);
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
    .dot.error { background: var(--red); }
    .dot.waiting { background: var(--yellow); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1rem;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1rem;
    }
    .card h2 {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 0.5rem;
    }
    .card .value { font-size: 1.6rem; font-weight: 700; }
    .card .sub { font-size: 0.8rem; color: var(--muted); margin-top: 0.25rem; }
    .positive { color: var(--green); }
    .negative { color: var(--red); }
    .charts {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 1rem;
      margin-bottom: 1rem;
    }
    .charts-balance { grid-template-columns: 1fr; margin-bottom: 1rem; }
    @media (max-width: 900px) { .charts { grid-template-columns: 1fr; } }
    .chart-wrap { height: 260px; position: relative; }
    .chart-wrap.tall { height: 220px; }
    .chart-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.75rem;
      flex-wrap: wrap;
      margin-bottom: 0.65rem;
    }
    .chart-head h2 { margin-bottom: 0; }
    .chart-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      align-items: center;
    }
    .chart-controls .sep {
      width: 1px;
      height: 1.1rem;
      background: var(--border);
      margin: 0 0.15rem;
    }
    .chip {
      appearance: none;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.25rem 0.5rem;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      line-height: 1.2;
    }
    .chip:hover { color: var(--text); border-color: #2d3f55; }
    .chip.active {
      background: rgba(59,130,246,0.18);
      border-color: rgba(59,130,246,0.55);
      color: #93c5fd;
    }
    .chip.active.bal {
      background: rgba(168,85,247,0.18);
      border-color: rgba(168,85,247,0.55);
      color: #d8b4fe;
    }
    .chart-meta {
      font-size: 0.72rem;
      color: var(--muted);
      margin-top: 0.35rem;
    }
    .panels {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 1rem;
    }
    @media (max-width: 1100px) { .panels { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 700px) { .panels { grid-template-columns: 1fr; } }
    .panel-title {
      font-size: 0.9rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border);
    }
    .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 1rem; font-size: 0.85rem; }
    .kv dt { color: var(--muted); }
    .kv dd { text-align: right; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; font-size: 0.7rem; text-transform: uppercase; }
    td.motive { max-width: 280px; overflow: hidden; text-overflow: ellipsis; color: var(--muted); font-size: 0.75rem; line-height: 1.35; white-space: normal; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .tag {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: 600;
    }
    .tag.up { background: rgba(34,197,94,0.15); color: var(--green); }
    .tag.down { background: rgba(239,68,68,0.15); color: var(--red); }
    .tag.win { background: rgba(34,197,94,0.2); color: var(--green); }
    .tag.loss { background: rgba(239,68,68,0.2); color: var(--red); }
    .tag.pending { background: rgba(234,179,8,0.15); color: var(--yellow); }
    .tag.skip { background: rgba(139,156,179,0.15); color: var(--muted); }
    .tag.failed { background: rgba(239,68,68,0.15); color: var(--red); }
    .tag.unfilled { background: rgba(139,156,179,0.2); color: var(--muted); }
    .tag.paper { background: rgba(168,85,247,0.2); color: var(--purple); }
    .paper-banner {
      display: none;
      margin-bottom: 1rem;
      padding: 0.85rem 1rem;
      border-radius: 10px;
      border: 1px solid rgba(168,85,247,0.45);
      background: rgba(168,85,247,0.12);
      font-size: 0.9rem;
      line-height: 1.5;
    }
    .paper-banner strong { color: var(--purple); }
    .badge.paper-mode { border-color: rgba(168,85,247,0.5); color: var(--purple); }
    code { font-size: 0.72rem; word-break: break-all; }
    .empty { color: var(--muted); text-align: center; padding: 2rem; font-size: 0.9rem; }
    footer { color: var(--muted); font-size: 0.75rem; text-align: center; margin-top: 1rem; }
    .ctrl-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.4rem 0.85rem;
      border-radius: 8px;
      font-size: 0.8rem;
      font-weight: 600;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      cursor: pointer;
      font-family: inherit;
    }
    .ctrl-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    .ctrl-btn.play { border-color: rgba(34,197,94,0.5); color: var(--green); }
    .ctrl-btn.stop { border-color: rgba(239,68,68,0.5); color: var(--red); }
    .ctrl-btn.notify { border-color: rgba(59,130,246,0.5); color: var(--blue); }
    .ctrl-btn.notify.on { background: rgba(59,130,246,0.15); }
    .ctrl-btn:not(:disabled):hover { filter: brightness(1.15); }
    .dot.paused { background: var(--muted); }
    .view { display: none; }
    .view.active { display: block; }
    .settings-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
      margin-bottom: 1rem;
    }
    .settings-msg {
      font-size: 0.85rem;
      color: var(--muted);
      flex: 1;
      min-width: 12rem;
    }
    .settings-msg.ok { color: var(--green); }
    .settings-msg.err { color: var(--red); }
    .settings-sections { display: grid; gap: 1rem; }
    .settings-section h3 {
      font-size: 1rem;
      margin-bottom: 0.25rem;
    }
    .settings-section .hint {
      color: var(--muted);
      font-size: 0.8rem;
      margin-bottom: 0.75rem;
    }
    .settings-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 0.75rem;
    }
    .field label {
      display: block;
      font-size: 0.75rem;
      color: var(--muted);
      margin-bottom: 0.25rem;
    }
    .field .desc {
      font-size: 0.7rem;
      color: var(--muted);
      opacity: 0.8;
      margin-top: 0.2rem;
    }
    .field input[type="text"],
    .field input[type="number"],
    .field select,
    .field textarea {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 8px;
      padding: 0.45rem 0.6rem;
      font: inherit;
      font-size: 0.9rem;
    }
    .field textarea { min-height: 9rem; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; line-height: 1.35; }
    .field.wide { grid-column: 1 / -1; }
    .field.invalid textarea { border-color: var(--red); }
    .field input[type="checkbox"] {
      width: 1.1rem;
      height: 1.1rem;
      accent-color: var(--blue);
    }
    .field.bool {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-height: 2.4rem;
    }
    .field.bool label { margin: 0; }
    .restart-tag {
      font-size: 0.65rem;
      color: var(--yellow);
      margin-left: 0.35rem;
    }
    .ctrl-btn.active-tab {
      background: rgba(59,130,246,0.2);
      border-color: rgba(59,130,246,0.6);
      color: var(--blue);
    }
    .lang-switch {
      display: inline-flex;
      gap: 0.2rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.15rem;
      background: var(--panel);
    }
    .lang-switch button {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--muted);
      font: inherit;
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.3rem 0.45rem;
      border-radius: 6px;
      cursor: pointer;
    }
    .lang-switch button.active {
      background: rgba(59,130,246,0.25);
      color: var(--blue);
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Polymoney Control Center</h1>
      <div class="subtitle" data-i18n="subtitle">BTC Up/Down 5m — live</div>
    </div>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
      <div class="lang-switch" id="lang-switch" title="Language">
        <button type="button" data-lang="en">EN</button>
        <button type="button" data-lang="es">ES</button>
      </div>
      <button type="button" class="ctrl-btn play" id="btn-play" data-i18n="play" data-i18n-title="playTitle" title="Resume betting" disabled>▶ Play</button>
      <button type="button" class="ctrl-btn stop" id="btn-stop" data-i18n="stop" data-i18n-title="stopTitle" title="Pause betting">■ Stop</button>
      <button type="button" class="ctrl-btn notify" id="btn-notify" data-i18n="notify" data-i18n-title="notifyTitle" title="Notifications">🔔 Notify</button>
      <button type="button" class="ctrl-btn" id="btn-settings" data-i18n="settings" data-i18n-title="settingsTitle" title="Configure parameters">⚙ Config</button>
      <span class="badge" id="status-badge"><span class="dot" id="status-dot"></span><span id="status-text">—</span></span>
      <span class="badge" id="mode-badge">—</span>
      <span class="badge" id="updated-at">—</span>
    </div>
  </header>

  <div id="view-dashboard" class="view active">
  <div class="paper-banner" id="paper-banner"></div>

  <div class="grid" id="stats-grid"></div>

  <div class="charts">
    <div class="card">
      <div class="chart-head">
        <h2 data-i18n="pnlCumulative">Cumulative P&L</h2>
        <div class="chart-controls" id="pnl-range-controls" data-chart="pnl"></div>
      </div>
      <div class="chart-wrap"><canvas id="pnl-chart"></canvas></div>
      <div class="chart-meta" id="pnl-chart-meta"></div>
    </div>
    <div class="card">
      <h2 data-i18n="results">Results</h2>
      <div class="chart-wrap"><canvas id="wl-chart"></canvas></div>
    </div>
  </div>

  <div class="charts charts-balance">
    <div class="card">
      <div class="chart-head">
        <h2 data-i18n="balanceUsdc">USDC balance (account)</h2>
        <div class="chart-controls" id="bal-range-controls" data-chart="bal"></div>
      </div>
      <div class="chart-wrap tall"><canvas id="balance-chart"></canvas></div>
      <div class="chart-meta" id="bal-chart-meta"></div>
    </div>
  </div>

  <div class="panels">
    <div class="card">
      <div class="panel-title" data-i18n="system">System</div>
      <dl class="kv" id="system-kv"></dl>
    </div>
    <div class="card">
      <div class="panel-title" data-i18n="wallet">Polymarket account</div>
      <dl class="kv" id="wallet-kv"></dl>
    </div>
    <div class="card">
      <div class="panel-title" data-i18n="telegram">Telegram</div>
      <dl class="kv" id="telegram-kv"></dl>
    </div>
    <div class="card">
      <div class="panel-title" data-i18n="strategyConfig">Strategy & Config</div>
      <dl class="kv" id="config-kv"></dl>
    </div>
    <div class="card">
      <div class="panel-title" data-i18n="lastAction">Last action</div>
      <dl class="kv" id="lastbet-kv"></dl>
    </div>
  </div>

  <div class="card">
    <div class="chart-head">
      <div class="panel-title" data-i18n="tradeHistory" style="margin:0">Trade history</div>
      <div class="chart-controls" id="trade-filter-controls">
        <button type="button" class="chip active" data-trade-filter="fills">Fills</button>
        <button type="button" class="chip" data-trade-filter="misses">Miss</button>
        <button type="button" class="chip" data-trade-filter="all">All</button>
      </div>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th data-i18n="colTime">Time</th>
            <th data-i18n="colMarket">Market</th>
            <th data-i18n="colSide">Side</th>
            <th data-i18n="colPrice">Price</th>
            <th data-i18n="colCost">Cost</th>
            <th data-i18n="colResult">Result</th>
            <th data-i18n="colReason">Reason</th>
            <th data-i18n="colPnl">P&L</th>
          </tr>
        </thead>
        <tbody id="trades-body"></tbody>
      </table>
    </div>
  </div>
  </div><!-- /view-dashboard -->

  <div id="view-settings" class="view">
    <div class="card">
      <div class="settings-toolbar">
        <button type="button" class="ctrl-btn play" id="btn-config-save" data-i18n="save">Save</button>
        <button type="button" class="ctrl-btn" id="btn-config-reload" data-i18n="reload">Reload</button>
        <span class="settings-msg" id="settings-msg" data-i18n="settingsHint">All bot parameters. Changes are saved to config.yaml.</span>
      </div>
      <div class="settings-sections" id="settings-sections"></div>
    </div>
  </div>

  <footer>
    <span data-i18n="footerSse">Live SSE connection</span> ·
    <a href="/api/status" style="color:var(--blue)">/api/status</a> ·
    <a href="/health" style="color:var(--blue)">/health</a>
    <span id="notify-hint" style="color:var(--muted)"></span>
  </footer>

  <script>
    const I18N = ${i18nJson};
    const LANG_KEY = 'pm.lang';
    let lang = localStorage.getItem(LANG_KEY) || (navigator.language || 'en').slice(0, 2);
    if (!I18N[lang]) lang = 'en';
    function t(key) {
      return (I18N[lang] && I18N[lang][key]) || (I18N.en && I18N.en[key]) || key;
    }
    function applyStaticI18n() {
      document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n');
        if (key) el.textContent = t(key);
      });
      document.querySelectorAll('[data-i18n-title]').forEach((el) => {
        const key = el.getAttribute('data-i18n-title');
        if (key) el.setAttribute('title', t(key));
      });
      document.querySelectorAll('#lang-switch button').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
      });
      document.documentElement.lang = lang;
    }
    document.getElementById('lang-switch').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-lang]');
      if (!btn) return;
      lang = btn.getAttribute('data-lang');
      localStorage.setItem(LANG_KEY, lang);
      applyStaticI18n();
      if (lastPayload) render(lastPayload);
      if (document.getElementById('view-settings').classList.contains('active')) {
        void loadSettings();
      }
      updateNotifyBtn();
    });
    applyStaticI18n();
    let pnlChart, wlChart, balanceChart;
    let lastPayload = null;
    let countdownTimer = null;
    let resolutionsSeeded = false;
    const NOTIFIED_KEY = 'pm.notifiedResolutions';
    const WEB_NOTIFY_KEY = 'pm.webNotify';

    function loadNotifiedSet() {
      try { return new Set(JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]')); }
      catch { return new Set(); }
    }
    function saveNotifiedSet(set) {
      localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...set].slice(-300)));
    }
    let notifiedResolutions = loadNotifiedSet();

    function resolutionKey(t) {
      return String(t.id || t.marketSlug || '') + '|' + String(t.resolvedAt || '');
    }

    function isIos() {
      return /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }
    function isStandalonePwa() {
      return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
    }

    function updateNotifyBtn() {
      const btn = document.getElementById('btn-notify');
      const hint = document.getElementById('notify-hint');
      if (!btn) return;
      const secure = window.isSecureContext === true;
      const supported = typeof Notification !== 'undefined';

      if (!secure) {
        btn.disabled = true;
        btn.textContent = '🔔 HTTPS required';
        if (hint) {
          hint.textContent = ' · open your dashboard over HTTPS to enable notifications';
        }
        return;
      }
      if (!supported) {
        btn.disabled = true;
        btn.textContent = '🔔 N/A';
        if (hint) hint.textContent = ' · notifications not supported in this browser';
        return;
      }
      if (isIos() && !isStandalonePwa()) {
        btn.disabled = false;
        btn.textContent = '🔔 iOS: Add to Home Screen';
        if (hint) {
          hint.textContent = t('iosNotifyHint');
        }
        return;
      }
      const perm = Notification.permission;
      const on = perm === 'granted' && localStorage.getItem(WEB_NOTIFY_KEY) === '1';
      btn.classList.toggle('on', on);
      btn.textContent = on ? t('notifyOn') : (perm === 'denied' ? t('notifyBlocked') : t('notify'));
      btn.disabled = perm === 'denied';
      if (hint) {
        hint.textContent = on
          ? ' · ' + t('pushActive')
          : (perm === 'denied'
            ? ''
            : '');
      }
    }

    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    }

    async function ensurePushSubscription() {
      if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        return false;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const keyRes = await fetch(apiUrl('/api/push/vapid-public-key'));
      if (!keyRes.ok) throw new Error('VAPID unavailable');
      const keyJson = await keyRes.json();
      if (!keyJson.publicKey) throw new Error('No public VAPID key');

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyJson.publicKey),
        });
      }
      const saveRes = await fetch(apiUrl('/api/push/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!saveRes.ok) {
        const err = await saveRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to register push');
      }
      return true;
    }

    async function dropPushSubscription() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      try {
        await fetch(apiUrl('/api/push/unsubscribe'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch (e) { console.warn(e); }
      await sub.unsubscribe();
    }

    function showPnlNotification(title, body, won, notificationId) {
      const icon = won === true ? '/icon-win.png' : won === false ? '/icon-loss.png' : '/icon-app.png';
      const options = {
        body,
        tag: 'polymoney-pnl-' + (notificationId || Date.now()),
        renotify: true,
        icon,
        badge: '/icon-app.png',
      };
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'notify', title, won, options });
        return;
      }
      try { new Notification(title, options); } catch (e) { console.warn(e); }
    }

    function seedResolvedNotifications(trades) {
      for (const t of trades || []) {
        if (t.resolved && t.resolvedAt) notifiedResolutions.add(resolutionKey(t));
      }
      saveNotifiedSet(notifiedResolutions);
    }

    function maybeNotifyResolutions(trades) {
      // Web Push sends background notifications; notify in foreground only if the page is visible
      // and push is not enabled yet (fallback).
      if (document.visibilityState !== 'visible') return;
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'granted') return;
      if (localStorage.getItem(WEB_NOTIFY_KEY) !== '1') return;
      if (localStorage.getItem(WEB_NOTIFY_KEY + '.push') === '1') return;
      let changed = false;
      for (const t of trades || []) {
        if (!t.resolved || t.resolvedAt == null) continue;
        if (t.won !== true && t.won !== false) continue;
        const outcome = t.outcome || '';
        if (outcome && outcome !== 'filled' && outcome !== 'paper' && outcome !== 'placed') continue;
        const key = resolutionKey(t);
        if (notifiedResolutions.has(key)) continue;
        notifiedResolutions.add(key);
        changed = true;
        const pnl = t.pnl || 0;
        const sign = pnl >= 0 ? '+' : '';
        const title = (t.won ? 'WON ' : 'LOSS ') + sign + '$' + Math.abs(pnl).toFixed(2);
        const side = (t.side || '?').toUpperCase();
        const slug = String(t.marketSlug || '').replace('btc-updown-5m-', '');
        const body = side + (slug ? ' · ' + slug : '');
        showPnlNotification(title, body, t.won, key);
      }
      if (changed) saveNotifiedSet(notifiedResolutions);
    }

    async function enableWebNotifications() {
      if (!window.isSecureContext) {
        alert('On mobile, open your dashboard over HTTPS.');
        return;
      }
      if (typeof Notification === 'undefined') {
        alert('This browser does not support web notifications.');
        return;
      }
      if (isIos() && !isStandalonePwa()) {
        alert(t('iosAddHome'));
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        localStorage.removeItem(WEB_NOTIFY_KEY);
        localStorage.removeItem(WEB_NOTIFY_KEY + '.push');
        updateNotifyBtn();
        return;
      }
      localStorage.setItem(WEB_NOTIFY_KEY, '1');
      try {
        const ok = await ensurePushSubscription();
        if (ok) localStorage.setItem(WEB_NOTIFY_KEY + '.push', '1');
        showPnlNotification(
          'Polymoney',
          ok
            ? t('pushActive')
            : 'Notifications enabled (keep the app open in the background)',
        );
      } catch (e) {
        console.warn(e);
        localStorage.removeItem(WEB_NOTIFY_KEY + '.push');
        alert('Permission granted, but push failed: ' + (e && e.message ? e.message : e) + '\\nNotifications require the app to stay open.');
        showPnlNotification('Polymoney', 'Notifications enabled (no push — app must remain open)');
      }
      updateNotifyBtn();
    }

    document.getElementById('btn-notify')?.addEventListener('click', async () => {
      if (localStorage.getItem(WEB_NOTIFY_KEY) === '1' && Notification.permission === 'granted') {
        localStorage.removeItem(WEB_NOTIFY_KEY);
        localStorage.removeItem(WEB_NOTIFY_KEY + '.push');
        await dropPushSubscription();
        updateNotifyBtn();
        return;
      }
      enableWebNotifications();
    });

    if (window.isSecureContext && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW register failed', e));
    }
    updateNotifyBtn();

    const RANGE_OPTS = [
      { id: '1h', label: '1h', ms: 3600e3 },
      { id: '6h', label: '6h', ms: 6 * 3600e3 },
      { id: '24h', label: '24h', ms: 24 * 3600e3 },
      { id: '7d', label: '7d', ms: 7 * 24 * 3600e3 },
      { id: '30d', label: '30d', ms: 30 * 24 * 3600e3 },
      { id: 'all', label: 'All', ms: null },
    ];
    const chartPrefs = {
      pnlRange: localStorage.getItem('pm.chart.pnlRange') || '24h',
      balRange: localStorage.getItem('pm.chart.balRange') || '24h',
      pnlYZero: localStorage.getItem('pm.chart.pnlYZero') === '1',
      balYZero: localStorage.getItem('pm.chart.balYZero') === '1',
      pnlRebase: localStorage.getItem('pm.chart.pnlRebase') === '1',
    };

    const authToken = (function () {
      const q = new URLSearchParams(window.location.search).get('token');
      if (q) return q;
      const m = document.cookie.match(/(?:^|;\\s*)pm_dashboard_token=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : '';
    })();
    function apiUrl(path) {
      if (!authToken) return path;
      return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(authToken);
    }

    async function fetchJson(path, options) {
      const opts = Object.assign({ method: 'GET' }, options || {});
      opts.credentials = 'same-origin';
      opts.headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
      const res = await fetch(apiUrl(path), opts);
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        throw new Error('Invalid response (' + res.status + '): ' + (text || '(empty)').slice(0, 120));
      }
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || ('HTTP ' + res.status));
      }
      return data;
    }

    // Resubscribe to push if previously enabled (after reload)
    if (
      window.isSecureContext
      && localStorage.getItem(WEB_NOTIFY_KEY) === '1'
      && typeof Notification !== 'undefined'
      && Notification.permission === 'granted'
    ) {
      ensurePushSubscription()
        .then((ok) => {
          if (ok) localStorage.setItem(WEB_NOTIFY_KEY + '.push', '1');
        })
        .catch((e) => console.warn('push resubscribe', e));
    }

    function fmtUsd(n) {
      const s = n >= 0 ? '+' : '';
      return s + '$' + Math.abs(n).toFixed(2);
    }

    function fmtTime(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleString('en-US');
    }

    function fmtUptime(s) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      if (h) return h + 'h ' + m + 'm';
      if (m) return m + 'm ' + sec + 's';
      return sec + 's';
    }

    function statusDot(status, tradingActive) {
      if (!tradingActive || status === 'paused') return 'paused';
      if (status === 'error') return 'error';
      if (status === 'waiting' || status === 'discovering' || status === 'executing') return 'waiting';
      return '';
    }

    function displayStatus(d) {
      if (!d.bot.tradingActive) return 'paused';
      return d.bot.status;
    }

    async function setTrading(active) {
      const path = active ? '/api/trading/start' : '/api/trading/stop';
      const btn = active ? document.getElementById('btn-play') : document.getElementById('btn-stop');
      if (btn) btn.disabled = true;
      try {
        const res = await fetch(apiUrl(path), { method: 'POST' });
        if (!res.ok) throw new Error(await res.text());
      } catch (e) {
        console.error('Trading control failed', e);
        if (lastPayload) updateControlButtons(lastPayload.bot.tradingActive);
      }
    }

    function updateControlButtons(tradingActive) {
      document.getElementById('btn-play').disabled = tradingActive;
      document.getElementById('btn-stop').disabled = !tradingActive;
    }

    document.getElementById('btn-play').addEventListener('click', () => setTrading(true));
    document.getElementById('btn-stop').addEventListener('click', () => setTrading(false));

    function renderStats(d) {
      const pnl = d.pnl.totalPnl;
      const pnlClass = pnl >= 0 ? 'positive' : 'negative';
      const isPaper = d.config.mode === 'paper';
      const pnlLabel = isPaper ? 'P&L Simulado' : 'P&L Total';
      const betsSub = isPaper
        ? d.pnl.totalBets + ' simulated · ' + d.pnl.pending + ' pending · ' + d.pnl.historyTotal + ' attempts'
        : d.pnl.totalBets + ' purchased · ' + (d.pnl.unfilled||0) + ' unfilled · ' + d.pnl.historyTotal + ' attempts';
      const nextBetSec = d.bot.nextBetAt
        ? Math.max(0, Math.round((new Date(d.bot.nextBetAt).getTime() - Date.now()) / 1000))
        : null;
      document.getElementById('stats-grid').innerHTML = [
        { label: pnlLabel, value: fmtUsd(pnl), cls: pnlClass, sub: betsSub },
        { label: isPaper ? 'Win Rate (sim)' : 'Win Rate', value: (d.pnl.winRate * 100).toFixed(1) + '%', sub: d.pnl.wins + ' ' + t('win') + ' / ' + d.pnl.losses + ' ' + t('loss') + (d.pnl.pending ? ' · ' + d.pnl.pending + ' ' + t('pending') : '') },
        { label: t('sessionBets'), value: d.bot.betsPlaced, sub: fmtUsd(d.bot.totalUsdSpent) + (isPaper ? ' ' + t('simulated') : ' ' + t('spent')) },
        { label: 'BTC', value: d.feed.lastPrice ? '$' + d.feed.lastPrice.toLocaleString(undefined, {maximumFractionDigits:0}) : '—', sub: d.feed.currentSource === 'binance' ? 'binance (fallback)' : (d.feed.chainlinkConnected ? 'chainlink live' : (d.feed.connected ? 'backup' : 'offline')) },
        { label: t('nextBet'), value: nextBetSec != null ? nextBetSec + 's' : '—', sub: d.bot.nextBetAt ? fmtTime(d.bot.nextBetAt) : '—', id: 'next-bet-card' },
        { label: t('uptime'), value: fmtUptime(d.uptime), sub: d.memory.rssMb + ' MB RAM' },
      ].map(c => '<div class="card"' + (c.id ? ' id="' + c.id + '"' : '') + '><h2>' + c.label + '</h2><div class="value ' + (c.cls||'') + '">' + c.value + '</div><div class="sub">' + c.sub + '</div></div>').join('');
    }

    function startCountdown(nextBetAt) {
      if (countdownTimer) clearInterval(countdownTimer);
      if (!nextBetAt) return;
      countdownTimer = setInterval(() => {
        const card = document.getElementById('next-bet-card');
        if (!card || !lastPayload) return;
        const sec = Math.max(0, Math.round((new Date(nextBetAt).getTime() - Date.now()) / 1000));
        const val = card.querySelector('.value');
        if (val) val.textContent = sec + 's';
      }, 1000);
    }

    function renderKv(id, rows) {
      document.getElementById(id).innerHTML = rows.map(([k,v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
    }

    function rangeMs(id) {
      const opt = RANGE_OPTS.find(o => o.id === id);
      return opt ? opt.ms : null;
    }

    function fmtChartLabel(iso, rangeId) {
      const d = new Date(iso);
      const long = rangeId === '7d' || rangeId === '30d' || rangeId === 'all';
      if (long) {
        return d.toLocaleString('en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }

    function filterByRange(points, getAt, rangeId) {
      const ms = rangeMs(rangeId);
      if (!ms) return points.slice();
      const cutoff = Date.now() - ms;
      const inRange = [];
      let anchor = null;
      for (const p of points) {
        const t = new Date(getAt(p)).getTime();
        if (t < cutoff) anchor = p;
        else inRange.push(p);
      }
      if (anchor && inRange.length) return [anchor, ...inRange];
      return inRange;
    }

    function downsample(points, maxN) {
      if (points.length <= maxN) return points;
      const out = [];
      const step = (points.length - 1) / (maxN - 1);
      for (let i = 0; i < maxN; i++) {
        out.push(points[Math.round(i * step)]);
      }
      return out;
    }

    function buildRangeControls(containerId, chartKey, activeClass) {
      const el = document.getElementById(containerId);
      if (!el || el.dataset.ready) return;
      el.dataset.ready = '1';
      const rangeKey = chartKey + 'Range';
      const zeroKey = chartKey + 'YZero';
      const chips = RANGE_OPTS.map(o =>
        '<button type="button" class="chip' + (chartPrefs[rangeKey] === o.id ? ' active ' + activeClass : '') + '" data-range="' + o.id + '">' + o.label + '</button>'
      ).join('');
      let extra = '<span class="sep"></span>'
        + '<button type="button" class="chip' + (chartPrefs[zeroKey] ? ' active ' + activeClass : '') + '" data-yzero="1">Eixo $0</button>';
      if (chartKey === 'pnl') {
        extra += '<button type="button" class="chip' + (chartPrefs.pnlRebase ? ' active ' + activeClass : '') + '" data-rebase="1">Rebasar</button>';
      }
      el.innerHTML = chips + extra;
      el.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button.chip');
        if (!btn) return;
        if (btn.dataset.range) {
          chartPrefs[rangeKey] = btn.dataset.range;
          localStorage.setItem('pm.chart.' + rangeKey, chartPrefs[rangeKey]);
        } else if (btn.dataset.yzero) {
          chartPrefs[zeroKey] = !chartPrefs[zeroKey];
          localStorage.setItem('pm.chart.' + zeroKey, chartPrefs[zeroKey] ? '1' : '0');
        } else if (btn.dataset.rebase) {
          chartPrefs.pnlRebase = !chartPrefs.pnlRebase;
          localStorage.setItem('pm.chart.pnlRebase', chartPrefs.pnlRebase ? '1' : '0');
        }
        refreshControlActive(el, chartKey, activeClass);
        if (lastPayload) {
          if (chartKey === 'pnl') renderCharts(lastPayload);
          else renderBalanceChart(lastPayload);
        }
      });
    }

    function refreshControlActive(el, chartKey, activeClass) {
      const rangeKey = chartKey + 'Range';
      const zeroKey = chartKey + 'YZero';
      el.querySelectorAll('[data-range]').forEach(b => {
        b.className = 'chip' + (b.dataset.range === chartPrefs[rangeKey] ? ' active ' + activeClass : '');
      });
      const z = el.querySelector('[data-yzero]');
      if (z) z.className = 'chip' + (chartPrefs[zeroKey] ? ' active ' + activeClass : '');
      const r = el.querySelector('[data-rebase]');
      if (r) r.className = 'chip' + (chartPrefs.pnlRebase ? ' active ' + activeClass : '');
    }

    function lineChartOptions(beginAtZero) {
      return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ' $' + Number(ctx.parsed.y).toFixed(2),
            },
          },
        },
        scales: {
          x: { ticks: { color: '#8b9cb3', maxTicksLimit: 8, maxRotation: 0 } },
          y: {
            beginAtZero: !!beginAtZero,
            ticks: { color: '#8b9cb3', callback: v => '$' + Number(v).toFixed(2) },
          },
        },
      };
    }

    function renderCharts(d) {
      buildRangeControls('pnl-range-controls', 'pnl', '');
      const rangeId = chartPrefs.pnlRange;
      let series = filterByRange(d.charts.cumulativePnl || [], p => p.at, rangeId);
      series = downsample(series, 400);

      let values = series.map(p => p.cumulative);
      if (chartPrefs.pnlRebase && values.length) {
        const base = values[0];
        values = values.map(v => v - base);
      }
      const labels = series.map(p => fmtChartLabel(p.at, rangeId));

      const meta = document.getElementById('pnl-chart-meta');
      if (meta) {
        if (!series.length) {
          meta.textContent = 'No resolutions in this range.';
        } else {
          const delta = values[values.length - 1] - values[0];
          meta.textContent = series.length + ' pts · range change '
            + (delta >= 0 ? '+' : '') + '$' + delta.toFixed(2)
            + (chartPrefs.pnlRebase ? ' · rebased to $0' : '');
        }
      }

      if (!pnlChart) {
        pnlChart = new Chart(document.getElementById('pnl-chart'), {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'P&L $',
              data: values,
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.1)',
              fill: true,
              tension: 0.3,
              pointRadius: series.length > 60 ? 0 : 3,
            }],
          },
          options: lineChartOptions(chartPrefs.pnlYZero),
        });
      } else {
        pnlChart.data.labels = labels;
        pnlChart.data.datasets[0].data = values;
        pnlChart.data.datasets[0].pointRadius = series.length > 60 ? 0 : 3;
        pnlChart.options.scales.y.beginAtZero = chartPrefs.pnlYZero;
        pnlChart.update('none');
      }

      const wlData = [d.charts.wins, d.charts.losses, d.charts.pending];
      if (!wlChart) {
        wlChart = new Chart(document.getElementById('wl-chart'), {
          type: 'doughnut',
          data: { labels: ['Wins', 'Losses', 'Pending'], datasets: [{ data: wlData, backgroundColor: ['#22c55e', '#ef4444', '#eab308'], borderWidth: 0 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: '#8b9cb3' } } } }
        });
      } else {
        wlChart.data.datasets[0].data = wlData;
        wlChart.update('none');
      }
    }

    function renderBalanceChart(d) {
      buildRangeControls('bal-range-controls', 'bal', 'bal');
      const bal = d.wallet.balance || {};
      const history = bal.history || [];
      const rangeId = chartPrefs.balRange;
      let series = filterByRange(history, p => p.at, rangeId);
      series = downsample(series, 500);
      const labels = series.map(p => fmtChartLabel(p.at, rangeId));
      const data = series.map(p => p.balanceUsd);

      const meta = document.getElementById('bal-chart-meta');
      if (meta) {
        if (!series.length) {
          meta.textContent = history.length
            ? 'No points in this range (total history: ' + history.length + ').'
            : 'No balance history yet — collecting every minute.';
        } else {
          const first = data[0];
          const last = data[data.length - 1];
          const delta = last - first;
          meta.textContent = series.length + ' pts · ' + fmtUsd(last)
            + ' · Δ ' + (delta >= 0 ? '+' : '') + '$' + delta.toFixed(2)
            + (bal.lastUpdated ? ' · atualizado ' + fmtTime(bal.lastUpdated) : '');
        }
      }

      if (!series.length) {
        if (balanceChart) {
          balanceChart.destroy();
          balanceChart = null;
        }
        return;
      }

      if (!balanceChart) {
        balanceChart = new Chart(document.getElementById('balance-chart'), {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'Balance $',
              data,
              borderColor: '#a855f7',
              backgroundColor: 'rgba(168,85,247,0.12)',
              fill: true,
              tension: 0.25,
              pointRadius: series.length > 40 ? 0 : 2,
            }],
          },
          options: lineChartOptions(chartPrefs.balYZero),
        });
      } else {
        balanceChart.data.labels = labels;
        balanceChart.data.datasets[0].data = data;
        balanceChart.data.datasets[0].pointRadius = series.length > 40 ? 0 : 2;
        balanceChart.options.scales.y.beginAtZero = chartPrefs.balYZero;
        balanceChart.update('none');
      }
    }

    function escHtml(s) {
      return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    }

    function lastBetLabel(lb, lastResolved, isPaper) {
      if (lb.skipped && !lb.side) return t('skipped');
      if (lb.skipped) return '<span class="negative">' + t('skipped') + '</span>';
      if (lastResolved && lastResolved.marketSlug === lb.marketSlug && lastResolved.resolved) {
        const sim = isPaper || lastResolved.paper ? ' (' + t('paper') + ')' : '';
        return lastResolved.won
          ? '<span class="positive">✓ ' + t('won') + sim + ' · ' + fmtUsd(lastResolved.pnl||0) + '</span>'
          : '<span class="negative">✗ ' + t('lost') + sim + ' · ' + fmtUsd(lastResolved.pnl||0) + '</span>';
      }
      if (lb.paper) return '<span class="tag paper">' + t('paper') + ' · ' + t('pending') + '</span>';
      if (lb.success) return '<span class="positive">OK</span>';
      if (lb.submitted) return '<span class="negative">' + t('pending') + '</span>';
      return '<span class="negative">' + t('error') + '</span>';
    }

    function resultTagForTrade(trow, outcome) {
      const sim = trow.paper || outcome === 'paper';
      if (outcome === 'filled' || outcome === 'placed' || outcome === 'paper') {
        if (trow.resolved) {
          const suffix = sim ? ' (' + t('paper') + ')' : '';
          return trow.won
            ? '<span class="tag win">✓ ' + t('won') + suffix + '</span>'
            : '<span class="tag loss">✗ ' + t('lost') + suffix + '</span>';
        }
        return sim
          ? '<span class="tag paper">' + t('paper') + ' · ' + t('pending') + '</span>'
          : '<span class="tag pending">' + t('pending') + '</span>';
      }
      if (outcome === 'unfilled') return '<span class="tag unfilled">no fill</span>';
      if (outcome === 'failed') return '<span class="tag failed">' + t('error') + '</span>';
      if (outcome === 'skipped') return '<span class="tag skip">' + t('skipped') + '</span>';
      return '<span class="tag pending">?</span>';
    }

    function tradeMotive(t, outcome) {
      if (outcome === 'failed' || outcome === 'unfilled') return t.error || '—';
      if (outcome === 'skipped') return t.strategyReason || t.error || '—';
      if (t.orderId) return (t.strategyReason || 'ok') + ' · order ' + t.orderId.slice(0, 10) + '…';
      return t.strategyReason || '—';
    }

    function tradeDetailTitle(t) {
      return [t.title, t.error, t.clobDetail, t.strategyReason].filter(Boolean).join(' · ');
    }

    const storedTradeFilter = localStorage.getItem('pm.tradeFilter');
    let tradeFilter = ['fills', 'misses', 'all'].includes(storedTradeFilter) ? storedTradeFilter : 'fills';
    let lastTrades = [];

    function renderTrades(trades) {
      if (Array.isArray(trades)) lastTrades = trades;
      const body = document.getElementById('trades-body');
      const filtered = lastTrades.filter((t) => {
        const outcome = t.outcome || 'filled';
        if (tradeFilter === 'fills') return outcome === 'filled' || outcome === 'placed' || outcome === 'paper';
        if (tradeFilter === 'misses') return outcome === 'unfilled' || outcome === 'failed';
        return true;
      }).slice(0, 80);
      if (!filtered.length) {
        body.innerHTML = '<tr><td colspan="8" class="empty">—</td></tr>';
        return;
      }
      body.innerHTML = filtered.map((trade) => {
        const outcome = trade.outcome || 'filled';
        const resultTag = resultTagForTrade(trade, outcome);
        const sideTag = trade.side
          ? '<span class="tag ' + trade.side + '">' + trade.side.toUpperCase() + '</span>'
          : '—';
        const price = trade.side ? trade.price.toFixed(3) : '—';
        const cost = trade.side ? '$' + trade.cost.toFixed(2) : '—';
        const motive = escHtml(tradeMotive(trade, outcome));
        const pnl = (outcome === 'filled' || outcome === 'placed' || outcome === 'paper') && trade.resolved
          ? '<span class="' + ((trade.pnl||0)>=0?'positive':'negative') + '"><b>' + fmtUsd(trade.pnl||0) + '</b></span>'
          : (trade.paper || outcome === 'paper') && !trade.resolved
            ? '<span style="color:var(--muted)">' + t('pending') + '</span>'
            : '—';
        const title = tradeDetailTitle(trade);
        const detailRow = trade.clobDetail
          ? '<br><span style="color:var(--muted);font-size:0.7rem" title="' + escHtml(trade.clobDetail) + '">↳ ' + escHtml(trade.clobDetail.slice(0, 80)) + (trade.clobDetail.length > 80 ? '…' : '') + '</span>'
          : '';
        return '<tr><td>' + fmtTime(trade.placedAt) + '</td><td title="' + escHtml(title) + '">' + trade.marketSlug.replace('btc-updown-5m-','') + '</td><td>' + sideTag + '</td><td>' + price + '</td><td>' + cost + '</td><td>' + resultTag + '</td><td class="motive" title="' + escHtml(tradeDetailTitle(trade)) + '">' + motive + detailRow + '</td><td>' + pnl + '</td></tr>';
      }).join('');
    }

    document.getElementById('trade-filter-controls')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-trade-filter]');
      if (!btn) return;
      const nextFilter = btn.getAttribute('data-trade-filter');
      if (!['fills', 'misses', 'all'].includes(nextFilter)) return;
      tradeFilter = nextFilter;
      localStorage.setItem('pm.tradeFilter', tradeFilter);
      document.querySelectorAll('#trade-filter-controls .chip').forEach((c) => {
        c.classList.toggle('active', c.getAttribute('data-trade-filter') === tradeFilter);
      });
      renderTrades();
    });
    document.querySelectorAll('#trade-filter-controls .chip').forEach((c) => {
      c.classList.toggle('active', c.getAttribute('data-trade-filter') === tradeFilter);
    });

    function sigTypeLabel(n) {
      const map = { 0: '0 EOA', 1: '1 proxy (MetaMask)', 2: '2 Gnosis Safe', 3: '3 deposit (1271)' };
      return map[n] || String(n);
    }

    function render(d) {
      lastPayload = d;
      const isPaper = d.config.mode === 'paper';
      const banner = document.getElementById('paper-banner');
      if (isPaper) {
        banner.style.display = 'block';
        const lr = d.pnl.lastResolved;
        const lastTxt = lr && lr.resolved
          ? (lr.won ? '<span class="positive">' + t('won') + ' ' + fmtUsd(lr.pnl||0) + '</span>' : '<span class="negative">' + t('lost') + ' ' + fmtUsd(lr.pnl||0) + '</span>')
          : t('pending');
        banner.innerHTML = '<strong>' + t('paperBanner') + '</strong> · '
          + 'P&L: <b class="' + (d.pnl.totalPnl >= 0 ? 'positive' : 'negative') + '">' + fmtUsd(d.pnl.totalPnl) + '</b>'
          + ' · ' + d.pnl.wins + ' ' + t('win') + ' / ' + d.pnl.losses + ' ' + t('loss') + ' · ' + lastTxt;
      } else {
        banner.style.display = 'none';
      }
      document.getElementById('status-text').textContent = displayStatus(d);
      document.getElementById('status-dot').className = 'dot ' + statusDot(d.bot.status, d.bot.tradingActive);
      updateControlButtons(d.bot.tradingActive);
      const modeBadge = document.getElementById('mode-badge');
      modeBadge.textContent = d.config.mode.toUpperCase() + ' · ' + d.config.strategy;
      modeBadge.className = 'badge' + (isPaper ? ' paper-mode' : '');
      document.getElementById('updated-at').textContent = '● live ' + new Date(d.timestamp).toLocaleTimeString(lang === 'en' ? 'en-US' : lang === 'es' ? 'es-ES' : 'en-US');

      renderStats(d);
      startCountdown(d.bot.nextBetAt);
      renderCharts(d);
      renderBalanceChart(d);

      const bal = d.wallet.balance || {};
      const saldoTxt = bal.currentBalanceUsd != null
        ? '<span class="positive"><b>$' + bal.currentBalanceUsd.toFixed(2) + '</b></span>'
        : (bal.lastError ? '<span class="negative" title="' + escHtml(bal.lastError) + '">' + t('error') + '</span>' : '—');
      const saldoSub = bal.lastUpdated ? t('lastUpdate') + ' ' + fmtTime(bal.lastUpdated) : (bal.polling ? t('loading') : '');

      renderKv('wallet-kv', [
        [t('balanceLabel'), saldoTxt + (saldoSub ? '<br><span style="color:var(--muted);font-size:0.75rem">' + saldoSub + '</span>' : '')],
        [t('profileAccount'), d.wallet.polymarketAccount
          ? '<code>' + d.wallet.polymarketAccount + '</code>'
          : '<span class="negative">' + t('notConfigured') + '</span>'],
        [t('signer'), d.wallet.signerAddress ? '<code>' + d.wallet.signerAddress + '</code>' : '—'],
      ]);

      renderKv('system-kv', [
        [t('trading'), d.bot.tradingActive ? '<span class="positive">' + t('active') + '</span>' : '<span class="negative">' + t('paused') + '</span>'],
        [t('status'), displayStatus(d)],
        ['Staking', d.staking.mode === 'paroli'
          ? 'paroli · ' + t('nextStake') + ' <b>$' + d.staking.nextStakeUsd.toFixed(2) + '</b>'
          : 'fixed · ' + d.config.sizeShares + ' shares'],
        [t('seriesBankroll'), d.staking.mode === 'paroli'
          ? '<span class="' + (d.staking.seriesBankroll > 0 ? 'positive' : '') + '">$' + d.staking.seriesBankroll.toFixed(2) + '</span>'
          : '—'],
        [t('recovery'), d.staking.recoveryCapEnabled
          ? (d.staking.pendingRecoveryUsd > 0
            ? '<span class="negative">' + t('pendingRecovery') + ' $' + d.staking.pendingRecoveryUsd.toFixed(2) + '</span> · max $' + d.staking.recoveryMaxStakeUsd
            : '<span class="positive">' + t('recoveryOn') + '</span> · max $' + d.staking.recoveryMaxStakeUsd)
          : t('recoveryOff')],
        [t('market'), d.bot.currentSlug || '—'],
        ['Health', d.health.lastError ? '<span class="negative">' + d.health.lastError + '</span>' : '<span class="positive">OK</span>'],
        [t('feed') + ' BTC', d.feed.chainlinkConnected
          ? '<span class="positive">chainlink</span>'
          : d.feed.currentSource === 'binance'
            ? '<span class="positive">binance fallback</span>'
            : '<span class="negative">offline</span>'],
        ['Ticks', d.feed.tickCount ?? 0],
        [t('uptime'), fmtTime(d.health.startedAt)],
      ]);

      const tg = d.telegram;
      const tgStatus = !tg.enabled ? t('disabled') : tg.configured ? '<span class="positive">' + t('active') + '</span>' : '<span class="negative">' + t('noCredentials') + '</span>';
      const lastTg = tg.lastSend
        ? (tg.lastSend.ok ? '<span class="positive">OK</span>' : '<span class="negative">' + tg.lastSend.error + '</span>') + ' · ' + fmtTime(tg.lastSend.at)
        : '—';
      renderKv('telegram-kv', [
        [t('status'), tgStatus],
        ['Chat ID', tg.chatId || '—'],
        ['OK', tg.sendCount],
        [t('error'), tg.failCount],
        [t('lastUpdate'), lastTg],
      ]);

      renderKv('config-kv', [
        [t('mode'), d.config.mode],
        ['Staking', d.staking.mode + (d.staking.maxStakeUsd > 0 ? ' · max $' + d.staking.maxStakeUsd : '')],
        [t('base'), d.staking.mode === 'paroli' ? '$' + d.staking.baseUsd.toFixed(2) : '—'],
        [t('recovery'), d.staking.recoveryCapEnabled
          ? t('recoveryOn') + ' · $' + d.staking.recoveryMaxStakeUsd
          : t('recoveryOff')],
        [t('accountType'), sigTypeLabel(d.config.signatureType)],
        [t('strategy'), d.config.strategy],
        [t('betBeforeClose'), d.config.betSecondsBeforeClose + 's → ' + d.config.betMinSecondsBeforeClose + 's'],
        [t('size'), d.config.sizeShares + ' shares'],
        [t('maxPrice'), d.config.maxPrice],
        [t('minDelta'), d.config.minDeltaBps + ' bps'],
      ]);

      const lb = d.bot.lastBet;
      const lr = d.pnl.lastResolved;
      if (lb) {
        renderKv('lastbet-kv', [
          [t('colResult'), lastBetLabel(lb, lr, isPaper)],
          [t('colSide'), lb.side ? lb.side.toUpperCase() : '—'],
          [t('colPrice'), lb.price ? lb.price.toFixed(3) : '—'],
          ['Shares', lb.filledSize ? lb.filledSize.toFixed(2) : (lb.size || '—')],
          ['P&L', lr && lr.resolved && lr.marketSlug === lb.marketSlug
            ? '<span class="' + ((lr.pnl||0)>=0?'positive':'negative') + '"><b>' + fmtUsd(lr.pnl||0) + '</b> · ' + t('winner') + ' ' + (lr.winner||'?').toUpperCase() + '</span>'
            : (isPaper || lb.paper) ? '<span style="color:var(--muted)">' + t('pendingAfterClose') + '</span>' : '—'],
          [t('order'), lb.orderId ? '<code>' + lb.orderId + '</code>' : (isPaper ? '— (' + t('paper') + ')' : '—')],
          [t('reason'), lb.error || lb.strategyReason || '—'],
          [t('detail'), lb.clobDetail ? '<code title="' + escHtml(lb.clobDetail) + '">' + escHtml(lb.clobDetail.slice(0, 120)) + (lb.clobDetail.length > 120 ? '…' : '') + '</code>' : '—'],
          [t('time'), fmtTime(lb.timestamp)],
        ]);
      } else {
        renderKv('lastbet-kv', [['—', t('noBetsYet')]]);
      }

      renderTrades(d.trades);

      if (!resolutionsSeeded) {
        seedResolvedNotifications(d.trades);
        resolutionsSeeded = true;
      } else {
        maybeNotifyResolutions(d.trades);
      }
    }

    // ── Settings (full configuration) ──────────────────────────────────────────
    let draftConfig = null;
    let configMeta = null;

    function getByPath(obj, path) {
      return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object') ? acc[key] : undefined, obj);
    }
    function setByPath(obj, path, value) {
      const parts = path.split('.');
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }

    function showSettingsMsg(text, kind) {
      const el = document.getElementById('settings-msg');
      el.textContent = text;
      el.className = 'settings-msg' + (kind ? ' ' + kind : '');
    }

    function setView(name) {
      document.getElementById('view-dashboard').classList.toggle('active', name === 'dashboard');
      document.getElementById('view-settings').classList.toggle('active', name === 'settings');
      document.getElementById('btn-settings').classList.toggle('active-tab', name === 'settings');
      if (name === 'settings') loadSettings();
    }

    function applySettingControl(el) {
      const path = el.getAttribute('data-path');
      if (!path) return true;
      let value;
      try {
        if (el.type === 'checkbox') value = el.checked;
        else if (el.type === 'number') value = el.value === '' ? 0 : Number(el.value);
        else if (el.getAttribute('data-value-type') === 'json') value = JSON.parse(el.value);
        else value = el.value;
        el.setCustomValidity('');
        el.closest('.field')?.classList.remove('invalid');
        setByPath(draftConfig, path, value);
        return true;
      } catch (e) {
        const message = 'Invalid JSON in ' + path + ': ' + (e.message || String(e));
        el.setCustomValidity(message);
        el.closest('.field')?.classList.add('invalid');
        el.reportValidity();
        showSettingsMsg(message, 'err');
        return false;
      }
    }

    function validateSettingsForm() {
      const controls = document.querySelectorAll('#settings-sections [data-path]');
      for (const el of controls) {
        if (!applySettingControl(el)) return false;
      }
      return true;
    }

    function renderSettingsForm() {
      const root = document.getElementById('settings-sections');
      if (!draftConfig || !configMeta) return;
      root.innerHTML = configMeta.sections.map((section) => {
        const fields = section.fields.map((f) => {
          const val = getByPath(draftConfig, f.path);
          const restart = f.restartHint ? '<span class="restart-tag">' + t('restart') + '</span>' : '';
          const desc = f.description ? '<div class="desc">' + escHtml(f.description) + '</div>' : '';
          if (f.type === 'json') {
            return '<div class="field wide"><label>' + escHtml(f.label) + restart + '</label>'
              + '<textarea rows="8" data-path="' + f.path + '" data-value-type="json">'
              + escHtml(JSON.stringify(val ?? null, null, 2)) + '</textarea>' + desc + '</div>';
          }
          if (f.type === 'boolean') {
            return '<div class="field bool">'
              + '<input type="checkbox" data-path="' + f.path + '"' + (val ? ' checked' : '') + ' />'
              + '<label>' + escHtml(f.label) + restart + '</label>'
              + desc + '</div>';
          }
          if (f.type === 'enum') {
            const opts = (f.options || []).map((o) =>
              '<option value="' + escHtml(o) + '"' + (String(val) === String(o) ? ' selected' : '') + '>' + escHtml(o) + '</option>'
            ).join('');
            return '<div class="field"><label>' + escHtml(f.label) + restart + '</label>'
              + '<select data-path="' + f.path + '">' + opts + '</select>' + desc + '</div>';
          }
          if (f.type === 'number') {
            const step = f.step != null ? ' step="' + f.step + '"' : '';
            const min = f.min != null ? ' min="' + f.min + '"' : '';
            const max = f.max != null ? ' max="' + f.max + '"' : '';
            return '<div class="field"><label>' + escHtml(f.label) + restart + '</label>'
              + '<input type="number" data-path="' + f.path + '" value="' + (val ?? '') + '"' + step + min + max + ' />'
              + desc + '</div>';
          }
          return '<div class="field"><label>' + escHtml(f.label) + restart + '</label>'
            + '<input type="text" data-path="' + f.path + '" value="' + escHtml(String(val ?? '')) + '" />'
            + desc + '</div>';
        }).join('');
        return '<div class="settings-section card" style="padding:0.85rem">'
          + '<h3>' + escHtml(section.title) + '</h3>'
          + (section.description ? '<div class="hint">' + escHtml(section.description) + '</div>' : '')
          + '<div class="settings-grid">' + fields + '</div></div>';
      }).join('');

      root.querySelectorAll('[data-path]').forEach((el) => {
        el.addEventListener('change', () => { applySettingControl(el); });
      });
    }

    async function loadSettings() {
      showSettingsMsg(t('loading'));
      try {
        const data = await fetchJson('/api/config?lang=' + encodeURIComponent(lang));
        draftConfig = JSON.parse(JSON.stringify(data.config));
        configMeta = data.meta;
        renderSettingsForm();
        showSettingsMsg(t('readyEdit'));
      } catch (e) {
        showSettingsMsg(e.message || String(e), 'err');
      }
    }

    async function saveSettings() {
      if (!draftConfig || !validateSettingsForm()) return;
      showSettingsMsg(t('saving'));
      try {
        const data = await fetchJson('/api/config?lang=' + encodeURIComponent(lang), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: draftConfig }),
        });
        draftConfig = JSON.parse(JSON.stringify(data.config));
        configMeta = data.meta || configMeta;
        renderSettingsForm();
        const hint = (data.requiresRestart && data.requiresRestart.length)
          ? t('savedRestart') + ': ' + data.requiresRestart.join(', ')
          : t('savedApplied');
        showSettingsMsg(hint, 'ok');
      } catch (e) {
        showSettingsMsg(e.message || String(e), 'err');
      }
    }

    document.getElementById('btn-settings').addEventListener('click', () => {
      const settingsOn = document.getElementById('view-settings').classList.contains('active');
      setView(settingsOn ? 'dashboard' : 'settings');
    });
    document.getElementById('btn-config-save').addEventListener('click', () => { void saveSettings(); });
    document.getElementById('btn-config-reload').addEventListener('click', () => { void loadSettings(); });

    const source = new EventSource(apiUrl('/api/stream'));

    source.onmessage = (event) => {
      try {
        render(JSON.parse(event.data));
      } catch (e) {
        console.error('SSE parse error', e);
      }
    };

    source.onerror = () => {
      document.getElementById('status-text').textContent = t('reconnecting');
      document.getElementById('status-dot').className = 'dot error';
    };

    source.onopen = () => {
      document.getElementById('status-dot').className = 'dot';
    };
  </script>
</body>
</html>`;
}
