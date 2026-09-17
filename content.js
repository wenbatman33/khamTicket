// 寬宏售票（kham.com.tw）表單填寫輔助 — 主邏輯
//
// 網站的購票流程（實地追出來的）：
//   UTK0201_      節目頁：開賣前按「立即購票」只會得到「節目尚未啟售！」，要輪詢到開賣
//   UTK0201_00    場次頁：多場次時在這裡選一場（按「立即訂購」）
//   UTK0201_000   票區頁（A 型）：有「自行選位／電腦配位」兩顆按鈕，預設電腦配位
//   UTK0204_      票區頁（B 型）：同樣列票區，但這條流程沒有電腦配位，只能自行選位
//   UTK0201_001   張數頁：電腦配位才會走到，填張數 + 驗證碼
//   UTK0205_      選位頁：B 型流程點票區後到這裡，座位要自己勾（本工具不代選）
//   UTK0206_      購物車
//
// 注意：這些頁面綁 session 流程狀態，直接用網址跳進去會被踢回首頁。
//
// 所有請求都由網站原有程式碼發出；本工具不辨識驗證碼、不代填帳號密碼。
(() => {
  'use strict';
  if (window.__khamHelperLoaded) return;
  window.__khamHelperLoaded = true;

  const VER = '1.9.0';

  // ---------------------------------------------------------------- 設定
  const DEFAULTS = {
    enabled: false,          // 主開關：關閉時只做提示與「立即執行」單次動作
    startAt: '',             // 開搶時間 HH:MM(:SS)，留空 = 進頁面就開始
    refreshMs: 800,          // 重試間隔（毫秒）
    perfKeyword: '',         // 場次關鍵字（多場次時用，如 2/27），留空 = 第一個可訂購的
    presaleCode: '',         // 優先購序號／認證碼：看到欄位就自動填入，照原樣填不裁切
    autoSubmitPresale: true, // 序號填好就自動按送出（跟主開關脫鉤：填了卻不送等於做一半）
    priceTargets: '',        // 票價優先順序，一行一個（場次頁依票價拆列的活動用）
    crossPrice: true,        // 票區頁背景監控其他票價的場次，有票就跳過去
    targets: '',             // 票區優先順序（或票價），一行一個
    count: 2,                // 每次買幾張
    ticketType: '',          // 票種優先順序（逗號分隔），留空 = 用第一種
    acceptNonAdjacent: true, // 自動勾「接受不連位座位」
    allowFewer: false,       // 剩餘不足需求張數時，是否改買剩下的
    captchaLen: 4,           // 驗證碼位數，輸滿即送出
    autoSubmitCaptcha: true, // 驗證碼輸滿自動按「加入購物車」
    autoCheckout: false,     // 購物車頁自動按結帳
    pauseOthersOnWin: true,  // 有分頁搶到後，其他分頁先停手（驗證碼一次只能打一個）
    hideSoldOut: true,       // 票區頁自動勾「僅顯示未完售區」
    pickMostSeats: true,     // 同一優先順序對到多個票區時，選空位最多的
  };
  let S = Object.assign({}, DEFAULTS);

  // ---------------------------------------------------------------- 頁面判斷
  const PATH = location.pathname;
  // 比對順序由長到短：_001 / _000 / _00 / _ 前綴相同，短的會誤中長的
  const PAGE =
    /UTK0201_001\.aspx/i.test(PATH) ? 'qty' :
    /UTK0202_\.aspx/i.test(PATH)    ? 'qty' :
    /UTK0201_000\.aspx/i.test(PATH) ? 'area' :
    /UTK0201_00\.aspx/i.test(PATH)  ? 'perf' :
    /UTK0201_\.aspx/i.test(PATH)    ? 'product' :
    /UTK0204_\.aspx/i.test(PATH)    ? 'area' :
    /UTK0205_\.aspx/i.test(PATH)    ? 'seatmap' :
    /UTK0206_\.aspx/i.test(PATH)    ? 'cart' : 'other';

  // 票區頁有兩種：UTK0201_000 可走電腦配位；UTK0204_ 這條流程只能自行選位
  // （實測：從 UTK0204_ 的 session 直接跳 UTK0201_001 會被踢回首頁）
  const AREA_FLAVOR = /UTK0204_\.aspx/i.test(PATH) ? 'seatpick' : 'auto';

  // UTK0202_ 是站席（無座位、序號票）的購票頁：
  // 沒有「接受不連位」，票區改由下拉選單 #PRICE 決定（值為「票區ID|餘位」，-1 = 未選），
  // 送出前網站還有一段 maxWaitTime 節流。BIGBANG 的 VIP1 平面站席就是走這裡。
  const IS_STANDING = /UTK0202_\.aspx/i.test(PATH);

  const qs = new URLSearchParams(location.search);
  const hid = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  const PERF_ID = hid('PERFORMANCE_ID') || qs.get('PERFORMANCE_ID') || '';
  const PRODUCT_ID = hid('PRODUCT_ID') || qs.get('PRODUCT_ID') || '';

  // 票區頁網址：張數頁失敗時要退回這裡繼續搜尋
  function areaPageUrl() {
    const saved = sessionStorage.getItem('kham_area_url');
    if (saved) return saved;
    const p = new URLSearchParams();
    if (PERF_ID) p.set('PERFORMANCE_ID', PERF_ID);
    if (PRODUCT_ID) p.set('PRODUCT_ID', PRODUCT_ID);
    return '/application/UTK02/UTK0201_000.aspx?' + p.toString();
  }

  // ---------------------------------------------------------------- 小工具
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  const parseList = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toInt = (v, d = 0) => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : d; };

  function log(...a) { try { console.log('[寬宏輔助]', ...a); } catch (e) {} }

  // ---------------------------------------------------------------- 搶票紀錄
  // 每個分頁寫自己的 key，兩個分頁同時搶不同場次也不會互相覆蓋。
  // 關鍵事件（請求／回應／跳轉）立即寫入，庫存快照批次寫，避免拖慢開賣瞬間。
  const TAB_TOKEN = (() => {
    let t = sessionStorage.getItem('kham_tab_token');
    if (!t) {
      t = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('kham_tab_token', t);
    }
    return t;
  })();
  const LOG_KEY = 'log_' + TAB_TOKEN;
  const LOG_MAX = 3000;          // 每分頁保留最近 3000 筆
  const STOCK_HEARTBEAT = 30000; // 庫存沒變化時，至少每 30 秒留一筆
  let logBuf = [];
  let logTimer = null;
  let lastStockSig = '';
  let lastStockAt = 0;
  let areasLogged = false;

  function logEvent(type, data, urgent) {
    try {
      logBuf.push(Object.assign({ t: Date.now(), page: PAGE, type }, data || {}));
      if (urgent) flushLog();
      else if (!logTimer) logTimer = setTimeout(flushLog, 2000);
    } catch (e) { /* 記錄失敗不影響搶票 */ }
  }

  async function flushLog() {
    clearTimeout(logTimer); logTimer = null;
    if (!logBuf.length) return;
    const batch = logBuf; logBuf = [];
    try {
      const r = await chrome.storage.local.get({ [LOG_KEY]: null });
      const cur = (r && r[LOG_KEY]) || { tab: TAB_TOKEN, startedAt: Date.now(), rows: [] };
      cur.rows = (cur.rows || []).concat(batch).slice(-LOG_MAX);
      cur.updatedAt = Date.now();
      cur.url = location.href;
      await chrome.storage.local.set({ [LOG_KEY]: cur });
    } catch (e) { /* 空間滿或寫入失敗都不影響搶票 */ }
  }

  // 頁面要跳走了，先把緩衝寫出去（票區頁→張數頁會換頁，記憶體會清掉）
  window.addEventListener('pagehide', flushLog);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushLog(); });

  // 全場票區餘位快照：有變化才記一筆，沒變化每 30 秒留一筆心跳。
  // 票區名稱只在第一筆記一次（areas），之後快照只存 [票區ID, 數量]，
  // 否則大場館 40+ 區每輪全記，很快就把 storage 撐爆。
  function logStock(info) {
    const rows = info.rows || [];
    if (!rows.length) return;
    const sig = rows.map((r) => r.id + '=' + r.leftText).join('|');
    const now = Date.now();
    const changed = sig !== lastStockSig;
    if (!changed && now - lastStockAt < STOCK_HEARTBEAT) return;

    if (!areasLogged) {
      areasLogged = true;
      logEvent('areas', {
        perf: PERF_ID, product: PRODUCT_ID,
        list: rows.map((r) => ({ id: r.id, name: r.name, price: r.priceText })),
      }, true);
    }
    lastStockSig = sig; lastStockAt = now;
    logEvent('stock', {
      scan: areaState.scans,
      perf: PERF_ID,
      status: info.action || '',
      changed,
      s: rows.map((r) => [r.id, Number.isNaN(r.left) ? r.leftText : r.left]),
    });
  }

  function notify(title, body) {
    try { chrome.runtime.sendMessage({ type: 'NOTIFY', title, body }); } catch (e) {}
  }

  // 分頁標題閃爍：搶到票時即使在背景也看得到
  let flashTimer = null;
  const origTitle = document.title;
  function flashTitle(text) {
    if (flashTimer) return;
    let on = false;
    flashTimer = setInterval(() => { document.title = (on = !on) ? text : origTitle; }, 700);
    ['click', 'keydown', 'visibilitychange'].forEach((ev) =>
      window.addEventListener(ev, stopFlash, { once: true }));
  }
  function stopFlash() {
    if (!flashTimer) return;
    clearInterval(flashTimer); flashTimer = null; document.title = origTitle;
  }

  // ---------------------------------------------------------------- 畫面元件
  let panel, panelBody, toastEl;

  let toggleBtn = null;

  // 面板上的開關長相跟著狀態走：紅＝自動搶票中、灰＝已關閉
  function renderToggle() {
    if (!toggleBtn) return;
    const on = !!S.enabled;
    toggleBtn.textContent = on ? '⏸ 停止自動' : '▶ 開始自動';
    toggleBtn.style.background = on ? '#fff' : '#3a3f4a';
    toggleBtn.style.color = on ? '#c8102e' : '#fff';
    toggleBtn.title = on ? '點一下關閉自動搶票，改由你自己操作' : '點一下開始自動搶票';
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = '__kham_panel';
    const pos = JSON.parse(localStorage.getItem('kham_panel_pos') || 'null') || { left: 12, top: 90 };
    panel.style.cssText = [
      'position:fixed', 'z-index:2147483600', 'left:' + pos.left + 'px', 'top:' + pos.top + 'px',
      'min-width:230px', 'max-width:330px', 'background:rgba(20,22,28,.93)', 'color:#fff',
      'font:12px/1.6 "Microsoft JhengHei",system-ui,sans-serif', 'border-radius:8px',
      'box-shadow:0 4px 18px rgba(0,0,0,.4)', 'pointer-events:none', 'overflow:hidden',
    ].join(';');

    const bar = document.createElement('div');
    bar.style.cssText = 'background:#c8102e;padding:6px 10px;font-weight:700;cursor:move;pointer-events:auto;'
      + 'display:flex;align-items:center;gap:8px;';
    const title = document.createElement('span');
    title.textContent = '🎫 v' + VER;
    title.style.cssText = 'flex:1;white-space:nowrap;';

    // 頁面上的主開關：想自己手動搶的時候，就地關掉，不必再去點擴充功能
    toggleBtn = document.createElement('button');
    toggleBtn.style.cssText = [
      'pointer-events:auto', 'cursor:pointer', 'border:0', 'border-radius:5px',
      'padding:3px 10px', 'font:700 12px/1.4 "Microsoft JhengHei",system-ui,sans-serif',
      'white-space:nowrap', 'box-shadow:0 1px 3px rgba(0,0,0,.35)',
    ].join(';');
    // 標題列會拖曳，按鈕上的滑鼠事件不要傳上去，否則按一下就變成拖一下
    toggleBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      const next = !S.enabled;
      S.enabled = next;                       // 先就地生效，不等 storage 回來
      renderToggle();
      logEvent('toggle', { enabled: next, by: 'panel' }, true);
      toast(next ? '▶ 自動搶票：開' : '⏸ 自動搶票：關（改成你自己操作）');
      try { chrome.storage.sync.set({ enabled: next }); } catch (err) {}
      if (next) resumeAfterPause();
      else { areaState.stop = true; productState.stop = true; perfState.stop = true; }
    });

    bar.appendChild(title); bar.appendChild(toggleBtn);
    renderToggle();

    panelBody = document.createElement('div');
    panelBody.style.cssText = 'padding:8px 10px;white-space:pre-wrap;';

    panel.appendChild(bar); panel.appendChild(panelBody);
    document.documentElement.appendChild(panel);

    // 標題列可拖曳；位置記在 localStorage
    let dx = 0, dy = 0, dragging = false;
    bar.addEventListener('mousedown', (e) => {
      dragging = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - dx));
      const top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - dy));
      panel.style.left = left + 'px'; panel.style.top = top + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      localStorage.setItem('kham_panel_pos', JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop }));
    });
    return panel;
  }

  function showPanel(lines) {
    ensurePanel();
    renderToggle();
    panelBody.textContent = Array.isArray(lines) ? lines.join('\n') : String(lines);
  }

  function toast(msg, ms = 3500) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = [
        'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483601', 'max-width:340px',
        'background:rgba(20,22,28,.94)', 'color:#fff', 'padding:10px 14px', 'border-radius:8px',
        'font:13px/1.6 "Microsoft JhengHei",system-ui,sans-serif', 'box-shadow:0 4px 18px rgba(0,0,0,.4)',
        'pointer-events:none', 'white-space:pre-wrap',
      ].join(';');
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toastEl.style.display = 'none'; }, ms);
    log(msg);
  }

  // ---------------------------------------------------------------- 開搶時間
  // 回傳今天（或明天）該時刻的 timestamp；格式無效視同未設定
  function startTimestamp() {
    const t = String(S.startAt || '').trim();
    if (!t) return 0;
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
    if (!m) return 0;
    const h = +m[1], mi = +m[2], se = m[3] ? +m[3] : 0;
    if (h > 23 || mi > 59 || se > 59) return 0;
    const d = new Date();
    d.setHours(h, mi, se, 0);
    // 已經過了就當作立刻開始（不自動跳到隔天，避免整天空等）
    return d.getTime();
  }

  // 開賣後前 3 秒催快一點（最快 300ms），之後回到設定值
  function gapMs() {
    const ts = startTimestamp();
    const base = Math.max(50, toInt(S.refreshMs, 800));
    if (!ts) return base;
    const since = Date.now() - ts;
    return (since >= 0 && since < 3000) ? Math.min(base, 300) : base;
  }

  function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }

  // 網站的提示對話框是 jQuery UI dialog（#dialog-message），開賣前輪詢會一直跳，要順手關掉
  function dismissDialog() {
    const btn = document.querySelector('.ui-dialog-buttonpane button, .ui-dialog-titlebar-close');
    if (btn) { btn.click(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- 頁面快照
  // 每一頁把 HTML 存下來，事後才有辦法對著真實結構優化（購物車／結帳／實名制頁一直沒登入看不到）。
  // 個資在寫入前遮掉：身分證字號、Email、手機、password 欄位值。
  const SNAP_KEY = 'snap_' + TAB_TOKEN;
  const SNAP_MAX = 120;
  let lastSnapSig = '';
  function redact(html) {
    return String(html || '')
      .replace(/(<input[^>]*type=["']password["'][^>]*value=["'])[^"']*/gi, '$1***')
      .replace(/\b[A-Z][12]\d{8}\b/g, '***ID***')                         // 身分證字號
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***@***')                     // Email
      .replace(/\b09\d{2}[- ]?\d{3}[- ]?\d{3}\b/g, '09********')          // 手機
      .replace(/(LOGIN_PWD=)[^&"'<]*/gi, '$1***');
  }
  async function snapshot(label, node) {
    try {
      const html = redact((node || document.documentElement).outerHTML);
      // 內容沒變就不重複存（同一頁拍好幾張，很多會一樣）
      const sig = html.length + ':' + html.slice(0, 200) + html.slice(-200);
      if (!node && sig === lastSnapSig) return;
      if (!node) lastSnapSig = sig;
      const r = await chrome.storage.local.get({ [SNAP_KEY]: null });
      const cur = (r && r[SNAP_KEY]) || { tab: TAB_TOKEN, items: [] };
      cur.items = (cur.items || []).concat([{
        t: Date.now(), page: PAGE, label, url: location.href, title: document.title, len: html.length, html,
      }]).slice(-SNAP_MAX);
      await chrome.storage.local.set({ [SNAP_KEY]: cur });
      logEvent('snapshot', { label, len: html.length }, false);
    } catch (e) { /* 存不下也不影響搶票 */ }
  }

  // 頁面上後來才冒出來的東西（選入場人視窗、錯誤對話框、任何 popout），出現時補拍一張
  function watchModals() {
    let timer = null, shots = 0;
    const isModal = (el) => el && el.nodeType === 1 && el.matches &&
      (el.matches('.ui-dialog, .popoutBG, .popout, [class*="popout"], [class*="modal"], [class*="dialog"], [id^="POPOUT"]')
        || el.querySelector('.ui-dialog, .popoutBG, .popout, [class*="modal"], [id^="POPOUT"]'));
    const obs = new MutationObserver((muts) => {
      if (shots >= 12) { obs.disconnect(); return; }
      let hit = false;
      for (const m of muts) {
        if (m.type === 'attributes' && isModal(m.target) && isShown(m.target)) { hit = true; break; }
        for (const n of m.addedNodes) { if (isModal(n)) { hit = true; break; } }
        if (hit) break;
      }
      if (!hit) return;
      clearTimeout(timer);
      timer = setTimeout(() => { shots++; snapshot('modal'); }, 400);   // 等它畫完再拍
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  }

  // 網站在頁面載入時常跳一個「訊息視窗」（實名制提醒之類），每頁都要按一次 Ok 很煩。
  // 進頁面後監看 10 秒，這類提示自動關掉；帶錯誤字眼的（售完／帳號／驗證碼…）留著給人看。
  // 只認網站真正的錯誤句型；不能用「帳號」「密碼」這種字，實名制提醒裡就有「會員帳號」
  const NOTICE_SKIP = /必須填寫|請輸入|認證|錯誤|失敗|售完|額滿|逾時|驗證碼|尚未啟售|不足|超過|無法|已無|重新/;
  const isShown = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  function autoDismissNotice(windowMs = 10000) {
    const t0 = Date.now();
    const seen = new Set();
    const check = () => {
      const dlg = document.querySelector('.ui-dialog');
      const msg = document.getElementById('dialog-message');
      if (dlg && msg && isShown(dlg)) {
        const text = (msg.textContent || '').replace(/\s+/g, ' ').trim();
        if (text && !seen.has(text) && !NOTICE_SKIP.test(text)) {
          seen.add(text);
          if (dismissDialog()) {
            logEvent('notice_dismissed', { text: text.slice(0, 300) }, false);
            toast('已關閉網站提示：' + text.slice(0, 40) + (text.length > 40 ? '…' : ''), 2500);
          }
        }
      }
      // 張數頁／選位頁的「本次不再提醒」小視窗，點掉後網站會記在 sessionStorage 不再跳
      const tip = document.getElementById('POPOUT_TIP');
      if (tip && isShown(tip)) {
        const b = [...tip.querySelectorAll('button')].find((x) => /closeRemind/.test(x.getAttribute('onclick') || ''))
          || [...tip.querySelectorAll('button')].find((x) => /知道了/.test(x.textContent || ''));
        if (b) { b.click(); logEvent('notice_dismissed', { text: 'POPOUT_TIP' }, false); }
      }
      if (Date.now() - t0 < windowMs) setTimeout(check, 150);
    };
    check();
  }

  // ================================================================ 節目頁（開賣前等待啟售）
  // 開賣前按「立即購票」，伺服器只會回 alert1('節目尚未啟售！')，
  // 這時候連 PERFORMANCE_ID 都拿不到，票區頁也進不去，只能在這頁等到啟售。
  const productState = { tries: 0, running: false, stop: false, lastRespAt: 0, lastMsg: '' };

  function clickGoBuy() {
    const btn = document.getElementById('GO_BUY2')
      || [...document.querySelectorAll('button,a')].find((b) => /doGoBuy/.test(b.getAttribute('onclick') || ''));
    if (!btn) return false;
    btn.click();
    return true;
  }

  function renderProductPanel(extra) {
    const lines = [
      (S.enabled ? '● 等待啟售' : '○ 已關閉（手動）') + '｜第 ' + productState.tries + ' 次｜' + new Date().toLocaleTimeString(),
      '節目頁：啟售後會自動進入購票流程',
    ];
    if (productState.lastMsg) lines.push('網站回應：' + productState.lastMsg);
    if (extra) lines.push(extra);
    if (document.hidden) lines.push('⚠️ 分頁在背景，計時可能被瀏覽器節流');
    showPanel(lines);
  }

  async function productLoop() {
    if (productState.running) return;
    productState.running = true;
    try {
      while (!productState.stop && S.enabled) {
        const ts = startTimestamp();
        const wait = ts - Date.now();
        if (wait > 0) {
          showPanel([
            '● 等待開賣｜' + S.startAt,
            '倒數 ' + fmtCountdown(wait),
            '時間一到才會開始按「立即購票」',
            document.hidden ? '⚠️ 分頁在背景，開賣瞬間可能慢約 1 秒' : '請保持此分頁在前景',
          ]);
          await sleep(Math.min(500, wait));
          continue;
        }

        dismissDialog();
        // 網站用 isClick 當送出中旗標，回應沒回來就會一直鎖著；超過 3 秒沒回應才還原
        if (productState.tries > 0 && Date.now() - (productState.lastRespAt || 0) > 3000) {
          window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'RESET_CLICK' }, location.origin);
        }
        productState.tries++;
        if (!clickGoBuy()) {
          showPanel(['⚠️ 找不到「立即購票」按鈕', '請確認這是節目頁，或重新整理後再試']);
          return;
        }
        renderProductPanel();
        await sleep(gapMs());
      }
    } finally {
      productState.running = false;
    }
  }

  // ================================================================ 場次頁（決定買哪個票價）
  // BIGBANG 這種活動：同一天同一場，依票價拆成十幾列，每一列是一個 PERFORMANCE_ID。
  // 2026-09-17 事故：工具不看有沒有票就點「立即訂購」，全部完售了還一路點進去。
  // 現在這頁是**監控站**：重整 → 讀每個票價的狀態 → 確認有票才進去。
  const PERF_URL_KEY = 'kham_perf_url';
  const PERF_COOL_KEY = 'kham_perf_cool';

  function perfRowOf(el) {
    let n = el;
    for (let i = 0; i < 6 && n && n.parentElement; i++) {
      n = n.parentElement;
      if (n.tagName === 'TR' || n.tagName === 'LI' || /row|item|list/i.test(n.className || '')) break;
    }
    return n || el;
  }
  function perfRowText(el) {
    return ((perfRowOf(el).innerText || perfRowOf(el).textContent || '')).replace(/\s+/g, ' ').trim();
  }

  // 完售標記：網站把票價畫上刪除線。
  // 2026-09-17 直接看真實 DOM 確認（UTK0201_00.aspx?PRODUCT_ID=P1EMCIC6）：
  //   完售列：<td><s><font color="lightblue">9430</font></s></td>
  //          <td><a href="javascript:;"><button class="gray" onclick="return false;">已售完</button></a></td>
  //   有票列：票價無 <s>，按鈕是 doLink(...) 的「立即訂購」
  // 也就是說完售列**根本沒有訂購網址**，本來就不會成為候選；<s> 是標籤不是 CSS，
  // 所以用 fetch 拉回來的 HTML 一樣判得出來（不必依賴樣式表）。
  // 活的頁面用 computed style 判最準，
  // 順便把帶刪除線的 class 記起來 —— 之後用 fetch 拉回來的 HTML（沒有樣式表）也能照同一個 class 判。
  const LT_KEY = 'kham_lt_class';
  function rememberLt(cls) {
    const c = String(cls || '').trim();
    if (!c) return;
    try {
      const set = new Set(JSON.parse(sessionStorage.getItem(LT_KEY) || '[]'));
      c.split(/\s+/).forEach((x) => set.add(x));
      sessionStorage.setItem(LT_KEY, JSON.stringify([...set].slice(0, 20)));
    } catch (e) {}
  }
  function ltClasses() {
    try { return JSON.parse(sessionStorage.getItem(LT_KEY) || '[]'); } catch (e) { return []; }
  }

  // 回傳 true=完售 / false=有票 / null=看不出來
  function rowSoldOut(row) {
    const txt = (row.innerText || row.textContent || '');
    if (/完售|售完|已售罄|額滿|sold\s*out/i.test(txt)) return true;
    const win = row.ownerDocument && row.ownerDocument.defaultView;   // fetch 回來的 doc 沒有 view
    const nodes = [row, ...row.querySelectorAll('*')];
    let known = false;
    for (const n of nodes) {
      if (/^(DEL|S|STRIKE)$/.test(n.tagName)) { rememberLt(n.className); return true; }
      if (/line-through/.test(n.getAttribute('style') || '')) { rememberLt(n.className); return true; }
      if (win && win.getComputedStyle) {
        const st = win.getComputedStyle(n);
        if (/line-through/.test(st.textDecorationLine || st.textDecoration || '')) { rememberLt(n.className); return true; }
        known = true;
      }
      const cls = ltClasses();
      if (cls.length && String(n.className || '').split(/\s+/).some((c) => c && cls.includes(c))) return true;
    }
    if (win && known) return false;        // 活頁面上逐一看過都沒刪除線 → 確定有票
    return ltClasses().length ? false : null;   // 沒有可比對的標記 → 看不出來
  }

  // 場次頁按鈕有兩種：
  //   一般販售：onclick='doLink("UTK0201_000.aspx?…",3704)'  → 網站會先空等 3.7 秒才跳，我們直接取網址跳
  //   優先購：  onclick='VipSellCheck("PERF_ID")'            → 會跳序號畫面，之後由網站導向票區頁
  function perfCandidates(root) {
    const doc = root || document;
    return [...doc.querySelectorAll('button,a,input[type=submit]')]
      .map((b) => {
        const oc = (b.getAttribute('onclick') || '') + ' ' + (b.getAttribute('href') || '');
        const url = (/(?:doLink|location\.href)\s*[(=]\s*["']([^"']*UTK020[^"']*)["']/.exec(oc) || [])[1];
        const vip = /VipSellCheck\(\s*["']([^"']*)["']/.exec(oc);
        if (!url && !/VipSellCheck/.test(oc)) return null;
        const row = perfRowOf(b);
        const text = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
        // 只認往票區頁去的訂購鈕；票區頁上的「回上頁／重新選擇」也長得像連結，不能誤點
        if (url && (!/UTK0201_000|UTK0204_|UTK0202_/i.test(url) || /回上頁|重新選擇|上一步/.test(text))) return null;
        const perf = url ? (new URLSearchParams((url.split('?')[1] || '')).get('PERFORMANCE_ID') || '')
                         : (vip ? vip[1] : '');
        return {
          el: doc === document ? b : null, row, mode: url ? 'link' : 'vip',
          url: url || '', perf, text, price: priceOf(text), soldOut: rowSoldOut(row),
        };
      })
      .filter(Boolean);
  }

  // ---- 票價比對 ----
  function priceOf(text) {
    const m = /([\d,]{3,6})\s*元/.exec(String(text || ''));
    return m ? toInt(m[1]) : NaN;
  }

  // 目標是純數字 → 當成票價比，而且要整個數字相符（填 980 不會被 9430 對到）；
  // 其他情況照舊：不分大小寫、忽略空白的文字包含比。
  function matchTarget(text, target) {
    const t = String(target || '').trim();
    if (!t) return false;
    if (/^\d[\d,]*$/.test(t)) {
      const want = toInt(t);
      const str = String(text || '');
      const withYuan = [...str.matchAll(/([\d,]{3,6})\s*元/g)].map((m) => toInt(m[1]));
      const pool = withYuan.length ? withYuan : [...str.matchAll(/\d[\d,]{2,5}/g)].map((m) => toInt(m[0]));
      return pool.includes(want);
    }
    return norm(text).includes(norm(t));
  }

  // 場次頁看到的所有票價 → 存起來，票區頁要用它跨票價監控
  const PERFS_KEY = 'kham_perfs_' + (PRODUCT_ID || 'x');
  function savePerfList(list) {
    try {
      const rows = list.filter((x) => x.perf).map((x) => ({
        perf: x.perf, price: x.price, text: x.text.slice(0, 80), url: x.url || '', mode: x.mode,
      }));
      if (rows.length) localStorage.setItem(PERFS_KEY, JSON.stringify({ at: Date.now(), rows }));
      return rows;
    } catch (e) { return []; }
  }
  function loadPerfList() {
    try {
      const raw = JSON.parse(localStorage.getItem(PERFS_KEY) || 'null');
      return (raw && raw.rows) || [];
    } catch (e) { return []; }
  }

  // 進去發現沒票就退回來的場次，短時間內別再進去（避免一直來回彈）
  function perfCool() {
    try { return JSON.parse(sessionStorage.getItem(PERF_COOL_KEY) || '{}'); } catch (e) { return {}; }
  }
  function markPerfEmpty(perf, ms = 20000) {
    try {
      const c = perfCool(); c[perf] = Date.now() + ms;
      sessionStorage.setItem(PERF_COOL_KEY, JSON.stringify(c));
    } catch (e) {}
  }
  function perfCooled(perf) {
    const c = perfCool();
    return !!(c[perf] && c[perf] > Date.now());
  }

  const WHEELCHAIR = /輪椅/;
  const perfState = { running: false, stop: false, scans: 0, rows: [], lastProbe: 0, probing: '' };

  // 依「場次關鍵字 → 票價優先順序」縮小範圍
  function perfShortlist(list) {
    let out = list;
    if (!WHEELCHAIR.test(S.perfKeyword || '')) {
      const normal = out.filter((x) => !WHEELCHAIR.test(x.text));
      if (normal.length) out = normal;
    }
    const k = norm(S.perfKeyword);
    if (k) {
      const byKey = out.filter((x) => norm(x.text).includes(k));
      out = byKey;            // 關鍵字對不到就是空的，交給呼叫端提示
    }
    const prio = parseList(S.priceTargets);
    if (!prio.length) return out;
    const ranked = [];
    prio.forEach((t) => out.forEach((x) => { if (matchTarget(x.text, t) && !ranked.includes(x)) ranked.push(x); }));
    return ranked;            // 設了票價就只認這些，順序照設定
  }

  // 挑一個「現在就該進去」的場次
  function pickPerfRow(list) {
    const short = perfShortlist(list).filter((x) => !perfCooled(x.perf));
    const open = short.find((x) => x.soldOut === false);
    if (open) return { row: open, why: '有票' };
    const unknown = short.find((x) => x.soldOut === null);
    if (unknown) return { row: unknown, why: '看不出庫存，進去確認' };
    // 全部標示完售 → 就是沒票，留在這頁繼續監控。
    // （原本這裡有「每 30 秒進去探路一次」，2026-09-17 實測確認刪除線就是完售後已移除：
    //   完售還自己點進去，只會浪費時間又把 session 走壞。）
    return null;
  }

  function renderPerfPanel(list, extra) {
    const lines = [];
    lines.push((S.enabled ? '● 場次頁監控中' : '○ 已關閉（手動）') + '｜第 ' + perfState.scans + ' 次｜' + new Date().toLocaleTimeString());
    const prio = parseList(S.priceTargets);
    lines.push('票價優先序：' + (prio.join(' → ') || '（未設定，取第一個有票的）'));
    const short = perfShortlist(list);
    const view = short.length ? short : list;
    lines.push('── 各票價狀態（' + view.length + '）');
    view.slice(0, 14).forEach((x) => {
      const mark = x.soldOut === true ? '✕ 完售' : x.soldOut === false ? '✔ 有票' : '？ 未知';
      lines.push(mark + '　' + (Number.isNaN(x.price) ? x.text.slice(0, 18) : x.price + ' 元')
        + (perfCooled(x.perf) ? '（剛確認沒票）' : ''));
    });
    // 有票的價位不在你的優先清單裡 → 明講，不要讓人以為工具當掉了
    if (prio.length) {
      const openOutside = list.filter((x) => x.soldOut === false && !short.includes(x));
      if (openOutside.length) {
        lines.push('⚠️ 這些價位有票但不在你的清單：'
          + openOutside.map((x) => (Number.isNaN(x.price) ? x.text.slice(0, 12) : x.price)).join('、'));
        lines.push('　要搶就把它加進「票價優先順序」，或把該欄留空＝有票就搶');
      }
    }
    if (extra) lines.push(extra);
    showPanel(lines);
  }

  // 重整：不整頁 reload，直接把這頁 fetch 回來重讀，狀態不會掉、也快得多
  async function fetchPerfRows() {
    const res = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
    const html = await res.text();
    if (/UTK0101|UTK1301/i.test(res.url || '')) return null;      // 被踢回首頁
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return perfCandidates(doc);
  }

  function enterPerf(hit, why) {
    savePerfList(perfState.rows);
    sessionStorage.setItem(PERF_URL_KEY, location.href);
    logEvent('perf', { mode: hit.mode, perf: hit.perf, price: hit.price, why, text: hit.text.slice(0, 80), url: hit.url || '' }, true);
    toast('進入票價 ' + (hit.price || '') + '：' + why);
    if (hit.mode === 'link' && hit.url) {
      location.href = new URL(hit.url, location.href).href;   // 跳過網站的 3.7 秒空等
      return;
    }
    // 優先購要按網站自己的鈕（它才會去查認證設定）；用 perf id 對回活頁面上的那一顆
    const live = perfCandidates(document).find((x) => x.perf === hit.perf) || hit;
    if (live.el) { live.el.click(); watchPresaleBox(); }
    else toast('⚠️ 找不到這場的訂購鈕，請自行點選');
  }

  async function perfLoop() {
    if (perfState.running) return;
    perfState.running = true;
    try {
      while (!perfState.stop && S.enabled) {
        const wait = startTimestamp() - Date.now();
        if (wait > 0) {
          showPanel(['● 等待開賣｜' + S.startAt, '倒數 ' + fmtCountdown(wait),
            '票價優先序：' + (parseList(S.priceTargets).join(' → ') || '（未設定）'),
            document.hidden ? '⚠️ 分頁在背景，開賣瞬間可能慢約 1 秒' : '請保持此分頁在前景']);
          await sleep(Math.min(500, wait));
          continue;
        }
        perfState.scans++;
        let list;
        if (perfState.scans === 1) list = perfCandidates(document);      // 進頁面當下的就是最新的
        else {
          try { list = await fetchPerfRows(); }
          catch (e) { logEvent('error', { where: 'perfScan', msg: String(e && e.message || e) }, true); list = null; }
        }
        if (!list) {
          renderPerfPanel(perfState.rows, '⚠️ 重整失敗或被導回首頁，' + gapMs() + 'ms 後重試');
          await sleep(gapMs());
          continue;
        }
        // fetch 回來的 HTML 沒有樣式表，若刪除線是 CSS class 給的就全判成「未知」。
        // 這時改用真的重整：重整後是活頁面，computed style 判得出來，而且會記住那個 class，
        // 之後的 fetch 就又能用了。寧可慢一點，也不要靠猜的亂點進去。
        if (perfState.scans > 1 && list.length && list.every((x) => x.soldOut === null)) {
          logEvent('perf_reload_mode', { n: list.length }, true);
          renderPerfPanel(perfState.rows, '判不出完售標記 → 改用整頁重整監控');
          await sleep(Math.max(1500, gapMs()));
          location.reload();
          return;
        }
        perfState.rows = list;
        savePerfList(list);
        logEvent('perf_stock', { n: list.length, open: list.filter((x) => x.soldOut === false).map((x) => x.price) });

        const short = perfShortlist(list);
        if (!short.length) {
          renderPerfPanel(list, list.length
            ? '⚠️ 沒有符合設定的場次（關鍵字／票價對不到），不亂點'
            : '目前全部完售（沒有任何可訂購的場次），持續重整監控回流票…');
          await sleep(gapMs());
          continue;
        }
        const pick = pickPerfRow(list);
        renderPerfPanel(list, pick ? '→ ' + pick.why + '，前往 ' + (pick.row.price || '') : '全部完售，持續監控中…');
        if (pick) {
          if (pick.row.soldOut === false) {
            notify('🎟 ' + (pick.row.price || '') + ' 元有票', pick.row.text.slice(0, 40));
            flashTitle('🎟 ' + (pick.row.price || '') + ' 有票');
          }
          enterPerf(pick.row, pick.why);
          return;
        }
        await sleep(gapMs());
      }
    } finally { perfState.running = false; }
  }

  // 這一頁是不是場次頁（就算一張票都不剩也要認得出來，才能繼續監控回流票）
  function looksLikePerfPage() {
    if (perfCandidates(document).length) return true;
    return [...document.querySelectorAll('button,a')].some((b) => /已售完|完售|立即訂購/.test(b.textContent || ''));
  }

  function runPerf(auto) {
    const list = perfCandidates(document);
    if (!list.length && !looksLikePerfPage()) {
      showPanel(['● 場次頁', '⚠️ 找不到可訂購的場次', '可能尚未開賣或不是場次頁']);
      return;
    }
    // 全部完售（一個候選都沒有）時不能就這樣收工 —— 回流票就是這時候出現的，要繼續重整監控
    perfState.rows = list;
    savePerfList(list);
    sessionStorage.setItem(PERF_URL_KEY, location.href);
    if (!auto) {
      const pick = pickPerfRow(list);
      renderPerfPanel(list, pick ? '→ ' + pick.why + '：' + (pick.row.price || '') + '（手動模式不自動進入）' : '目前沒有有票的票價');
      return;
    }
    perfState.stop = false;
    perfLoop();
  }

  // ---------------------------------------------------------------- 優先購序號（看到欄位就填）
  // 2026-09-17 事故：原本只認「場次頁 + .popoutBG + #ID1」這一種結構，
  // 真實的優先購畫面長得不一樣（整頁的「優先購買 / Presale Code：」），於是序號完全沒被填。
  // 改成元素驅動：不管在哪一頁、是燈箱還是整頁、DOM 什麼時候才長出來，
  // 只要畫面上出現「優先購序號欄位」就填 —— 不再靠頁面流程判斷。
  //
  // ⚠️ 驗證碼（#CHK 及任何 captcha 欄位）絕對不碰。已經害過一次，這裡是硬性排除，
  //    連「看起來像驗證碼」的欄位都直接跳過，寧可不填也不准動到它。
  const CAPTCHA_RE = /驗證碼|驗証碼|captcha|chk_pic/i;
  // 欄位本身的線索（弱訊號）
  const CODE_RE = /presale\s*code|序號|認證碼|認証碼|兌換碼|優惠碼/i;
  // 附近有這些字才算真的在優先購畫面（強訊號）
  const PRESALE_SCOPE_RE = /優先購|presale|會員認證|membership|vip\s*sell/i;
  // 對到這些一律不填（帳密、個資、付款欄位）
  const NEVER_RE = /驗證碼|驗証碼|captcha|帳號|身分證|統一編號|密碼|password|e-?mail|信箱|手機|電話|生日|姓名|地址|信用卡|卡號|card\s*number|cvv|有效期/i;

  const presaleState = { filled: false, submitted: false, watching: false, timer: null, tries: 0 };

  function elText(el, max = 300) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function visibleEl(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }

  // 欄位「自己」的線索：id／name／placeholder／title／對應的 label
  function fieldOwn(el) {
    const bits = [el.id || '', el.name || '', el.placeholder || '', el.getAttribute('title') || ''];
    try {
      if (el.id) {
        const lb = el.ownerDocument.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lb) bits.push(elText(lb, 80));
      }
    } catch (e) {}
    return bits.join(' ');
  }

  // 欄位「附近」的文字：自己 + 往上 4 層容器。用來找線索，不用來否決 ——
  // 容器裡常常混進「會員帳號」之類的字，拿它當否決條件會把該填的欄位也殺掉。
  function fieldContext(el) {
    const bits = [fieldOwn(el)];
    let n = el.parentElement;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      bits.push(elText(n, 150));
      if (/^(TR|LI|FORM)$/.test(n.tagName)) break;
    }
    return bits.join(' ');
  }

  // 驗證碼欄位辨識：id/name 以 CHK 開頭、或周邊文字提到驗證碼 → 一律視為驗證碼，永不碰
  function isCaptchaField(el) {
    if (!el) return true;
    if (/^chk/i.test(el.id || '') || /^chk/i.test(el.name || '')) return true;
    if (el.getAttribute && /captcha/i.test(el.getAttribute('class') || '')) return true;
    return CAPTCHA_RE.test(fieldContext(el));
  }

  // 往上找「這是優先購畫面」的證據，找到就回傳那個容器（燈箱或整頁區塊都適用）
  function presaleScope(el) {
    let n = el.parentElement;
    for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
      if (PRESALE_SCOPE_RE.test(elText(n, 500))) return n;
    }
    return null;
  }

  // 蒐集所有可見的文字輸入框（含同源 iframe：燈箱有時包在 iframe 裡）
  function textInputs() {
    const out = [];
    const walk = (doc, depth) => {
      try {
        doc.querySelectorAll('input').forEach((i) => {
          const t = (i.getAttribute('type') || 'text').toLowerCase();
          if (t !== 'text' && t !== 'tel' && t !== 'number' && t !== 'search' && t !== '') return;
          if (i.disabled || i.readOnly || !visibleEl(i)) return;
          out.push(i);
        });
        if (depth < 2) doc.querySelectorAll('iframe').forEach((f) => {
          try { if (f.contentDocument) walk(f.contentDocument, depth + 1); } catch (e) { /* 跨域，略過 */ }
        });
      } catch (e) {}
    };
    walk(document, 0);
    return out;
  }

  // 找出「該填序號」的那一格。分數 >= 3 才填，寧可漏填也不要填錯格子。
  // 2026-09-17 事故（第二次）：這裡原本有兩個會「漏填」的設計，都已移除——
  //   (a) 填過就在元素上蓋 __khamPresaleDone 旗標：燈箱關掉再打開是**同一個 input**，
  //       網站只是隱藏再清空，旗標還在 → 之後永遠不填。
  //   (b) 用「所有 input 的 id/name/type」當快取簽章：燈箱隱藏／顯示時簽章一模一樣 → 連掃都不掃。
  // 現在的規則很簡單：**看得到、是空的、有序號 → 就填**。貴一點也要對。
  function findPresaleField() {
    let best = null, bestScore = 0;
    for (const el of textInputs()) {
      if (isCaptchaField(el)) continue;               // 硬性排除，第一道
      const ctx = fieldContext(el);
      if (NEVER_RE.test(fieldOwn(el))) continue;      // 帳密／個資／付款欄位（只看欄位自己，不被容器文字誤殺）
      let score = 0;
      if (el.id === 'ID1') score += 5;                // 已知的燈箱欄位
      if (presaleScope(el)) score += 3;               // 附近寫著「優先購 / Presale」
      if (CODE_RE.test(ctx)) score += 2;              // 欄位自己叫序號／Presale Code
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return bestScore >= 3 ? best : null;
  }

  // 同一個優先購區塊裡還有沒有「第二個認證欄位」（密碼、卡號末四碼、生日之類）。
  // 只認真的像認證欄位的，不能看到任何一個空白輸入框就停手 ——
  // 容器裡常常混著搜尋框之類的東西，那樣會變成「填好了卻死不送出」。
  const SECOND_RE = /密碼|password|末.{0,2}碼|後.{0,2}碼|生日|出生|身分證|驗證身分|卡號/i;
  function secondField(el) {
    const scope = el.form || presaleScope(el) || document;
    return [...scope.querySelectorAll('input')].find((i) => {
      if (i === el || i.disabled || i.readOnly || !visibleEl(i)) return false;
      const t = (i.getAttribute('type') || 'text').toLowerCase();
      if (t !== 'text' && t !== 'tel' && t !== 'number' && t !== 'password' && t !== '') return false;
      if (isCaptchaField(i)) return false;
      if (String(i.value || '').trim()) return false;
      return t === 'password' || SECOND_RE.test(fieldContext(i));
    }) || null;
  }

  // 送出鈕：從輸入框往外一層一層找，找到就用 —— 不能只在「包住輸入框的那個小方塊」裡找，
  // 2026-09-17 實況：那顆「送　出」在灰色欄位方塊的外面，限定範圍就永遠找不到。
  // 文字比對一律先去掉所有空白（網站那顆是「送　出」，中間有全形空白）。
  const SUBMIT_TXT = /^(送出|確定|確認|提交|送出認證|submit|ok|go|next|下一步)$/i;

  // 2026-09-17 事故（第三次）：候選裡混進 div/span/td，**外層包裝比真正的按鈕先被找到**，
  // 文字一樣是「送出」→ 點到空殼，什麼都不會發生（面板卻顯示「自動送出中…」）。
  // 現在分三輪找，而且找到容器要再往內鑽到真正可點的那一顆。
  function textOf(b) { return norm(b.value || b.getAttribute('alt') || elText(b, 24)); }
  function hasVipHandler(b) { return /DoVIPLogin|VipSell/i.test(b.getAttribute('onclick') || ''); }
  function textIsSubmit(b) {
    const t = textOf(b);
    return !!t && (SUBMIT_TXT.test(t) || (t.length <= 6 && /送出|確定|確認/.test(t)));
  }

  // 容器 → 鑽到裡面真正的按鈕；沒有就用自己（自己得帶 onclick 才有意義）
  function innermostClickable(b) {
    const inner = [...b.querySelectorAll('button,input[type=submit],input[type=button],input[type=image],a')]
      .filter((x) => visibleEl(x) && (hasVipHandler(x) || textIsSubmit(x) || !textOf(x)));
    return inner.length ? inner[inner.length - 1] : b;
  }

  function presaleSubmitBtn(el) {
    const REAL = 'button,input[type=submit],input[type=button],input[type=image],a';
    let n = el.parentElement;
    for (let i = 0; i < 12 && n; i++, n = n.parentElement) {
      const all = [...n.querySelectorAll('*')].filter(visibleEl);
      // 第一輪：帶網站送出函式的（最可靠，不管它是什麼標籤）
      const byHandler = all.find(hasVipHandler);
      if (byHandler) return innermostClickable(byHandler);
      // 第二輪：真正可互動的元素，文字是「送出」之類
      const byReal = [...n.querySelectorAll(REAL)].filter(visibleEl).find(textIsSubmit);
      if (byReal) return byReal;
      // 第三輪：只好看容器，但一定要再鑽進去找真正可點的那顆
      const byText = all.find((x) => textIsSubmit(x) && !x.querySelector('input'));
      if (byText) return innermostClickable(byText);
      if (n.tagName === 'BODY') break;
    }
    return null;
  }

  // 有些元件只聽 mousedown/mouseup，光發 click 沒用；照真人操作的順序發一輪
  function clickReal(b) {
    const opts = { bubbles: true, cancelable: true, view: window };
    try { b.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
    try { b.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
    try { b.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
    try { b.click(); } catch (e) { try { b.dispatchEvent(new MouseEvent('click', opts)); } catch (e2) {} }
  }

  function presaleSubmit(reason) {
    if (presaleState.submitted) return;
    const el = presaleState.el;
    if (!el || !String(el.value || '').trim()) { toast('⚠️ 請先輸入序號'); return; }
    const second = secondField(el);
    if (second) {
      toast('⚠️ 這個認證還需要第二個欄位，請自行輸入後按送出');
      try { second.focus(); } catch (e) {}
      return;
    }
    const btn = presaleSubmitBtn(el);
    const code0 = String(el.value || '').trim();
    presaleState.submitted = true;
    presaleState.tries++;
    logEvent('presale_submit', { reason, tries: presaleState.tries, len: el.value.length, btn: btn ? (norm(btn.value || elText(btn, 12)) || btn.tagName) : 'none' }, true);
    if (btn) {
      const tag = (btn.tagName + (btn.className ? '.' + String(btn.className).split(/\s+/)[0] : '')).slice(0, 24);
      toast('送出優先購認證（' + reason + '）→ 點 ' + tag);
      showPanel(['● 優先購序號', '已填入：' + el.value, '送出中…點擊 ' + tag]);
      clickReal(btn);
      // 800ms 後欄位還在、值也沒被清 → 這顆八成是空殼，改叫網站自己的送出函式
      setTimeout(() => {
        if (visibleEl(el) && String(el.value || '').trim() === code0) {
          logEvent('presale_click_dead', { tag }, true);
          toast('點擊沒反應，改用網站的送出函式');
          window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'VIP_SUBMIT' }, location.origin);
        }
      }, 800);
    } else {
      // 畫面上找不到鈕 → 直接叫網站自己的送出函式（在 MAIN world）
      toast('找不到送出鈕，改用網站自己的送出函式');
      window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'VIP_SUBMIT' }, location.origin);
      setTimeout(() => {
        if (!presaleState.done) {
          showPanel(['● 優先購序號', '序號已填入：' + el.value,
            '⚠️ 自動送出失敗（找不到送出鈕，網站也沒有 DoVIPLogin）', '請自行按紅色「送出」']);
          toast('⚠️ 自動送出失敗，請自行按「送出」');
        }
      }, 1200);
    }
    // 網站送出前還會自己等 maxWaitTime（實測 3.7 秒），這段不動它
    setTimeout(() => { presaleState.submitted = false; }, 8000);
  }

  function fillPresaleField(el, why) {
    if (isCaptchaField(el)) return;                   // 硬性排除，第二道
    const code = String(S.presaleCode || '').trim();
    const scope = presaleScope(el);
    const title = scope ? elText(scope, 80) : document.title;
    if (!code) {
      if (Date.now() - (presaleState.warnAt || 0) > 10000) {
        presaleState.warnAt = Date.now();
        showPanel(['● 優先購序號欄位', title, '⚠️ 設定裡沒有填序號，請自行輸入後按送出（或按 Enter）']);
        toast('⚠️ 未設定優先購序號，請自行輸入');
        try { el.focus(); } catch (e) {}
      }
      return;
    }
    el.__khamLastFill = Date.now();
    presaleState.submitted = false;    // 重新填＝新的一次嘗試，解除上一次的送出鎖
    presaleState.el = el;
    presaleState.filled = true;
    logEvent('presale_box', { why, title, id: el.id || '', name: el.name || '', len: code.length }, true);
    snapshot('presale_box', scope || document.body);

    try { el.focus(); } catch (e) {}
    // 有些欄位綁 React/jQuery，用原生 setter 才吃得到
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, code);
    } catch (e) { el.value = code; }
    ['input', 'change', 'keyup', 'blur'].forEach((t) => {
      try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {}
    });

    if (!el.__khamBound) {
      el.__khamBound = true;
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); presaleSubmit('Enter'); } });
    }

    const second = secondField(el);
    const reason = second ? '⚠️ 還有第二個欄位要填（' + (fieldOwn(second) || '密碼類').slice(0, 20) + '），請自行輸入後按送出'
      : presaleState.tries >= 3 ? '⚠️ 已自動送出 3 次都沒過，改由你自己按（避免把序號試爆）'
      : (S.autoSubmitPresale ? '自動送出中…' : '（已關閉自動送出）請自行按紅色「送出」，或按 Enter');
    showPanel(['● 優先購序號', title, '已填入 ' + code.length + ' 碼：' + code, reason]);
    toast('已填入優先購序號：' + code + '\n' + reason);
    if (second) { try { second.focus(); } catch (e) {} return; }
    if (S.autoSubmitPresale && presaleState.tries < 3) presaleSubmit('序號已填');
    else try { el.focus(); } catch (e) {}
  }

  // 全站常駐監看：每一頁都跑，欄位一出現就填
  function watchPresaleField() {
    if (presaleState.watching) return;
    presaleState.watching = true;
    const tick = () => {
      try {
        const el = findPresaleField();
        if (!el) return;
        // 已經有值（我們填的、或你自己打的）→ 不動它
        if (String(el.value || '').trim()) return;
        if (Date.now() - (el.__khamLastFill || 0) < 800) return;   // 網站清空後的重填節流
        if ((presaleState.fills || 0) >= 10) return;               // 保險絲：不無限重填
        presaleState.fills = (presaleState.fills || 0) + 1;
        fillPresaleField(el, '欄位出現且是空的');
      } catch (e) { /* 偵測失敗不影響搶票 */ }
    };
    tick();
    try {
      const mo = new MutationObserver(() => {
        clearTimeout(presaleState.timer);
        presaleState.timer = setTimeout(tick, 40);
      });
      mo.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
      });
    } catch (e) {}
    setInterval(tick, 200);   // 燈箱只是改 style 顯示時 MutationObserver 不一定抓得到，補一層輪詢
  }

  // 畫面上有沒有正在等你輸入的序號欄位（別的規則要靠它避開）
  function presaleOpen() {
    if (presaleState.filled && !presaleState.submitted) return true;
    if (!String(S.presaleCode || '').trim()) return false;   // 沒序號可填就別擋住其他規則
    const el = findPresaleField();
    return !!(el && !String(el.value || '').trim());
  }

  // 舊名字留著：場次頁按下優先購鈕後仍會呼叫
  function watchPresaleBox() { watchPresaleField(); }
  function presaleBoxVisible() { return !!findPresaleField() || !!presaleState.filled; }
  function fillPresaleBox() {
    const el = findPresaleField() || presaleState.el;
    if (el) fillPresaleField(el, '手動執行');
    else toast('這一頁沒看到優先購序號欄位');
  }

  // ================================================================ 票區頁
  const areaState = { scans: 0, running: false, stop: false, cooldown: {}, lastRows: [], firstScan: true };

  // GROUP_ID 藏在座位圖 area 的 Send/SendA 呼叫裡。
  // 注意：座位圖的 <map> 是頁面載入後才由網站補上的，重新 fetch 回來的 HTML 裡沒有，
  // 所以要從「目前這個已載入完成的頁面」抓一次，快取起來給之後每一輪用。
  function readGroupMap(root) {
    const gmap = {};   // areaId -> {perf, group, ag, agi}
    root.querySelectorAll('map area').forEach((a) => {
      const href = a.getAttribute('href') || '';
      let m = /SendA\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/.exec(href);
      if (m) {
        // SendA(page, performance_id, group_id, area_id, activity_group_id, activity_group_item_id)
        if (!gmap[m[4]]) gmap[m[4]] = { perf: m[2], group: m[3], ag: m[5], agi: m[6], page: m[1] };
        return;
      }
      m = /Send\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/.exec(href);
      if (m) {
        // Send(page, performance_id, area_id, group_id)
        if (!gmap[m[3]]) gmap[m[3]] = { perf: m[2], group: m[4], ag: '', agi: '', page: m[1] };
      }
    });
    return gmap;
  }

  // tr 的 rel="a24 a25 a26" → 第一個 area 的編號就是 GROUP_ID
  // （實測 FEniX 3 區、MUSIC EXPO 8 區全部吻合）
  // rel 在原始 HTML 裡就有，不必等座位圖 ajax 補上 <map>，開賣瞬間可以省下數百毫秒到數秒
  function groupFromRel(rel) {
    const first = String(rel || '').trim().split(/\s+/)[0] || '';
    const m = /^a(\d+)$/.exec(first);
    return m ? m[1] : null;
  }

  // 有 ACTIVITY_GROUP 的活動（套票類）跳轉還要帶 ag/agi，那種只能等座位圖
  function needsActivityGroup() {
    return !!(hid('ACTIVITY_GROUP_ID') || hid('ACTIVITY_GROUP_ITEM_ID'));
  }

  const GMAP_KEY = 'kham_gmap_' + PERF_ID;
  function loadGmap() {
    try { return JSON.parse(sessionStorage.getItem(GMAP_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveGmap(g) {
    if (g && Object.keys(g).length) {
      try { sessionStorage.setItem(GMAP_KEY, JSON.stringify(Object.assign(loadGmap(), g))); } catch (e) {}
    }
  }
  // 目前頁面的座位圖 → 快取；回傳合併後的對照表
  function currentGmap() {
    const fromDom = readGroupMap(document);
    saveGmap(fromDom);
    return Object.assign(loadGmap(), fromDom);
  }

  // 有座位圖的活動要等網站把 <map> 補上，否則拿不到 GROUP_ID
  async function waitGmap(areaId, timeout = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const g = currentGmap();
      if (g[areaId]) return g[areaId];
      if (!document.getElementById('IMG_MAP')) return null;   // 本來就沒有座位圖
      await sleep(150);
    }
    return null;
  }

  // 解析票區頁 HTML：票區名稱、餘位、對應的 GROUP_ID
  function parseAreaDoc(doc) {
    const gmap = Object.assign({}, currentGmap(), readGroupMap(doc));

    const rows = [...doc.querySelectorAll('#salesTable tr.status_tr')].map((tr) => {
      const c = tr.cells;
      const name = c[1] ? c[1].textContent.trim() : '';
      const priceText = c[2] ? c[2].textContent.trim() : '';
      const leftText = c[3] ? c[3].textContent.trim() : '';
      let left;
      if (/售完|額滿/.test(leftText) || /\bSoldout\b/i.test(tr.className || '')) left = 0;
      else if (/^[\d,]+$/.test(leftText.replace(/\s/g, ''))) left = toInt(leftText);
      else left = NaN;   // 主辦方關閉餘位顯示時只能試了才知道
      const relGroup = groupFromRel(tr.getAttribute('rel'));
      const g = gmap[tr.id]
        || (relGroup != null ? { perf: PERF_ID, group: relGroup, ag: '', agi: '' } : null);
      return { id: tr.id, name, priceText, leftText, left, g };
    }).filter((r) => r.id && r.name);

    const action = (doc.querySelector('#action') || {}).textContent || '';
    return { rows, action: action.trim() };
  }

  // 這一區買不買得到（不含冷卻判斷，面板顯示也用同一套標準）
  function hasStock(r) {
    const need = Math.max(1, toInt(S.count, 1));
    if (r.left === 0) return false;
    if (Number.isNaN(r.left)) return true;               // 沒有餘位資訊 → 試一次
    return S.allowFewer ? r.left >= 1 : r.left >= need;
  }

  // 依設定的優先順序挑第一個買得到的票區
  function pickRow(rows) {
    const targets = parseList(S.targets);
    const now = Date.now();
    const ok = (r) => {
      if (areaState.cooldown[r.id] && areaState.cooldown[r.id] > now) return false;  // 剛試過又失敗的區先跳過
      return hasStock(r);
    };
    // 同一級裡挑空位最多的：配位成功率最高，也最可能連位
    const most = (cands) => (!S.pickMostSeats ? cands[0] : cands.reduce((best, r) => {
      const a = Number.isNaN(r.left) ? -1 : r.left, b = Number.isNaN(best.left) ? -1 : best.left;
      return a > b ? r : best;
    }, cands[0]));

    if (!targets.length) {
      // 沒設條件＝有票就進去；多個有票時挑空位最多的那一區
      const cands = rows.filter(ok);
      return cands.length ? most(cands) : null;
    }
    for (const t of targets) {
      const cands = rows.filter((r) => matchTarget(r.name + ' ' + (r.priceText || ''), t) && ok(r));
      if (!cands.length) continue;
      return most(cands);
    }
    return null;
  }

  // 「僅顯示未完售區」：網站的 handler 綁在 DOM ready 之後，這裡直接設 checked 並把售完列藏起來，
  // 之後網站 refreshArea() 重畫表格時會看 checked 狀態自己維持
  function applyHideSoldOut() {
    if (!S.hideSoldOut) return;
    const box = document.querySelector('#AREA_DIV .fix-checkbox input[type=checkbox], #AREA_DIV input[type=checkbox]');
    if (!box) return;
    if (!box.checked) box.checked = true;
    document.querySelectorAll('#salesTable tr.status_tr').forEach((tr) => {
      const c = tr.cells[3];
      if (/\bSoldout\b/i.test(tr.className) || (c && /售完|額滿/.test(c.textContent))) tr.style.display = 'none';
    });
  }

  // 站席型票區（Send 的第一個參數是 '0202'，例如 BIGBANG 的平面站席、N.Flying 的 1 樓搖滾）
  // 要進 UTK0202_，不是 UTK0201_001。不確定時回 null，改讓網站自己的 Send() 決定。
  function isStandingRow(row) {
    const page = row.g && row.g.page;
    return page ? page === '0202' : null;
  }

  function buyUrl(row) {
    const g = row.g || {};
    const p = new URLSearchParams();
    p.set('PERFORMANCE_ID', g.perf || PERF_ID);
    p.set('GROUP_ID', g.group != null && g.group !== '' ? g.group : '0');
    p.set('PERFORMANCE_PRICE_AREA_ID', row.id);
    if (g.ag) p.set('ACTIVITY_GROUP_ID', g.ag);
    if (g.agi) p.set('ACTIVITY_GROUP_ITEM_ID', g.agi);
    // 電腦配位 = UTK0201_001；站席 = UTK0202_（自行選位才是 UTK0205_）
    return (isStandingRow(row) === true ? 'UTK0202_.aspx?' : 'UTK0201_001.aspx?') + p.toString();
  }

  // 走網站原生的點擊，讓它自己決定去 0201_001／0202／0205；拿不到 page_name 時用這條最保險
  function clickRow(row) {
    const tr = document.getElementById(row.id);
    if (!tr) return false;
    tr.click();
    return true;
  }

  // UTK0204_ 流程：點票區走網站原生的 Send() 進選位頁（UTK0205_），座位由使用者自己勾
  function enterSeatPick(row) {
    const tr = document.getElementById(row.id);
    if (tr) { tr.click(); return; }
    const g = row.g || {};
    const p = new URLSearchParams();
    p.set('PERFORMANCE_ID', g.perf || PERF_ID);
    p.set('GROUP_ID', g.group != null && g.group !== '' ? g.group : '0');
    p.set('PERFORMANCE_PRICE_AREA_ID', row.id);
    location.href = 'UTK0205_.aspx?' + p.toString();
  }

  // 庫存查詢優先走網站「更新票數」按鈕用的端點 DO_REFRESH_AREA：
  //   回 JSON（含 RND_GROUP_ID、SOLD_OUT、AMOUNT），實測 45ms／14.6KB，整頁 HTML 是 85ms／40KB，
  //   而且售完的區也列出來，全場紀錄才完整。失敗就退回抓整頁 HTML。
  let refreshBroken = 0;
  async function scanViaRefresh(perfId) {
    const body = new URLSearchParams({
      PERFORMANCE_ID: perfId || PERF_ID,
      ACTIVITY_GROUP_ID: hid('ACTIVITY_GROUP_ID') || '',
      action: 'DO_REFRESH_AREA',
      sender: 'jquery',
    });
    const res = await fetch(location.pathname, {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: body.toString(),
    });
    const text = await res.text();
    if (/UTK0101|UTK1301/i.test(res.url || '')) return { rows: [], action: '', lost: true };
    const m = /SetArea\((\[[\s\S]*\])\)/.exec(text);
    if (!m) throw new Error('no SetArea: ' + text.slice(0, 80));
    const arr = JSON.parse(m[1]);
    const rows = arr.map((a) => {
      const leftText = String(a.AMOUNT == null ? '' : a.AMOUNT).trim();
      let left;
      if (a.SOLD_OUT || /售完|額滿/.test(leftText)) left = 0;
      else if (/^[\d,]+$/.test(leftText)) left = toInt(leftText);
      else left = NaN;
      const group = String(a.RND_GROUP_ID != null ? a.RND_GROUP_ID : groupFromRel(a.GROUP_ID) || '');
      return {
        id: a.PERFORMANCE_PRICE_AREA_ID, name: String(a.NAME_INFO || a.NAME || '').trim(),
        priceText: String(a.PRICE_STR || ''), leftText, left,
        g: { perf: perfId || PERF_ID, group, ag: '', agi: '' },
      };
    }).filter((r) => r.id && r.name);
    return { rows, action: '', lost: false, via: 'refresh' };
  }

  async function scanViaHtml() {
    const res = await fetch(areaPageUrl(), { credentials: 'include', cache: 'no-store' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const info = parseAreaDoc(doc);
    info.lost = /UTK0101|UTK1301/i.test(res.url || '') || !doc.getElementById('salesTable');
    info.via = 'html';
    return info;
  }

  // 這些頁面綁 session 的購票流程狀態，狀態一壞就會被導回首頁，兩條路都會認出來
  async function scanOnce() {
    if (refreshBroken < 3) {
      try {
        const info = await scanViaRefresh();
        refreshBroken = 0;
        return info;
      } catch (e) {
        refreshBroken++;
        logEvent('error', { where: 'refresh', msg: String(e && e.message || e) }, true);
      }
    }
    return scanViaHtml();
  }

  // session 失效：停手並要使用者從節目頁重新進來，不自作主張亂跳
  function onSessionLost() {
    logEvent('lost', { url: location.href }, true);
    areaState.stop = true;
    // 退回場次頁繼續監控全部價位（比停在死掉的票區頁有用）。最多退三次，避免來回彈。
    const backUrl = sessionStorage.getItem(PERF_URL_KEY);
    const n = toInt(sessionStorage.getItem('kham_lost_back'), 0);
    if (backUrl && backUrl !== location.href && n < 3) {
      sessionStorage.setItem('kham_lost_back', String(n + 1));
      markPerfEmpty(PERF_ID, 30000);
      toast('流程失效，退回場次頁繼續監控');
      location.href = backUrl;
      return;
    }
    showPanel([
      '⚠️ 購票流程已失效',
      '網站把請求導回首頁了（session 狀態壞掉或逾時）。',
      '請重新從節目頁「立即購票」走一次流程，再開自動搶票。',
    ]);
    toast('⚠️ 購票流程已失效，請重新從節目頁進入');
    notify('⚠️ 購票流程已失效', '請重新從節目頁「立即購票」走一次流程');
  }

  // ---------------------------------------------------------------- 跨票價監控
  // BIGBANG 這種活動一個價位就是一個 PERFORMANCE_ID，站在某一個價位的票區頁，
  // 看不到別的價位還有沒有票。DO_REFRESH_AREA 吃 PERFORMANCE_ID，
  // 所以可以在同一頁把場次頁記下來的每個價位都問一輪 —— 全部價位的庫存一起監控。
  const peerState = { at: 0, list: [], running: false, lastJump: 0 };

  async function scanPeers() {
    if (!S.crossPrice || peerState.running) return;
    if (Date.now() - peerState.at < Math.max(1500, gapMs() * 2)) return;
    const perfs = loadPerfList().filter((x) => x.perf && x.perf !== PERF_ID);
    if (!perfs.length) return;
    peerState.running = true;
    try {
      const out = [];
      for (const p of perfs) {
        try {
          const info = await scanViaRefresh(p.perf);
          const avail = info.rows.filter(hasStock);
          const total = info.rows.reduce((n, r) => n + (Number.isNaN(r.left) ? 0 : r.left), 0);
          out.push(Object.assign({}, p, { rows: info.rows, avail, total, err: false }));
        } catch (e) {
          out.push(Object.assign({}, p, { rows: [], avail: [], total: 0, err: true }));
        }
      }
      peerState.list = out;
      peerState.at = Date.now();
      logEvent('peers', { n: out.length, avail: out.filter((x) => x.avail.length).map((x) => x.price) });
    } finally { peerState.running = false; }
  }

  // 本場次沒票時，看看別的價位有沒有；只認票價優先順序裡有的價位，不亂跳
  function peerJumpTarget() {
    const prio = parseList(S.priceTargets);
    if (!prio.length) return null;
    if (Date.now() - peerState.lastJump < 5000) return null;
    const cands = peerState.list.filter((p) => p.avail.length && p.url);
    if (!cands.length) return null;
    const mine = prio.findIndex((t) => matchTarget(document.title + ' ' + (loadPerfList().find((x) => x.perf === PERF_ID) || {}).text, t));
    for (let i = 0; i < prio.length; i++) {
      if (mine >= 0 && i > mine) break;              // 只往「更想要的價位」跳，不往下掉
      const m = cands.find((p) => matchTarget(p.text, prio[i]));
      if (m) return m;
    }
    return null;
  }

  function renderAreaPanel(info, extra) {
    const need = Math.max(1, toInt(S.count, 1));
    const targets = parseList(S.targets);
    const lines = [];
    lines.push((S.enabled ? '● 監看中' : '○ 已關閉（手動）') + '｜第 ' + areaState.scans + ' 次｜' + new Date().toLocaleTimeString()
      + (info && info.via ? '｜' + (info.via === 'refresh' ? '更新票數' : '整頁') : ''));
    lines.push('模式：' + (AREA_FLAVOR === 'seatpick' ? '自行選位（此流程無電腦配位）' : '電腦配位') + '｜每次 ' + need + ' 張' + (S.pickMostSeats ? '｜同級選空位最多' : ''));
    if (info && info.action) lines.push('場次狀態：' + info.action);
    const rows = (info && info.rows) || [];
    const show = targets.length
      ? rows.filter((r) => targets.some((t) => norm(r.name).includes(norm(t))))
      : rows;
    if (!show.length) lines.push('（找不到符合的票區，請確認優先順序設定）');
    show.slice(0, 12).forEach((r) => {
      const left = Number.isNaN(r.left) ? r.leftText || '未顯示' : r.left;
      const mark = r.left === 0 ? '✕' : (Number.isNaN(r.left) || r.left >= need ? '✔' : '△');
      lines.push(mark + ' ' + r.name + '：' + left);
    });
    // 監控：全場有票的區域一律列出來（不受優先順序過濾），沒設條件也看得到哪裡還有票
    const free = rows.filter(hasStock);
    if (rows.length) {
      lines.push('── 本場次有票的區域：' + (free.length ? free.length + ' 區' : '無'));
      free.slice(0, 8).forEach((r) => {
        lines.push('　🎟 ' + r.name + (r.priceText ? '（' + r.priceText + '）' : '') + '：' + (Number.isNaN(r.left) ? r.leftText || '未顯示' : r.left));
      });
    }
    // 監控：其他票價的場次
    if (S.crossPrice && peerState.list.length) {
      const hot = peerState.list.filter((p) => p.avail.length);
      lines.push('── 其他票價（' + peerState.list.length + ' 個）：' + (hot.length ? hot.length + ' 個有票' : '都沒票')
        + '｜' + new Date(peerState.at).toLocaleTimeString());
      hot.slice(0, 8).forEach((p) => {
        lines.push('　💰 ' + (Number.isNaN(p.price) ? p.text.slice(0, 16) : p.price + ' 元') + '：'
          + p.avail.length + ' 區｜' + p.avail.slice(0, 3).map((r) => r.name + ' ' + (Number.isNaN(r.left) ? '?' : r.left)).join('、'));
      });
    }
    if (extra) lines.push(extra);
    if (document.hidden) lines.push('⚠️ 分頁在背景，計時可能被瀏覽器節流');
    showPanel(lines);
  }

  async function areaLoop() {
    if (areaState.running) return;
    areaState.running = true;
    try {
      while (!areaState.stop && S.enabled) {
        const ts = startTimestamp();
        const wait = ts - Date.now();
        if (wait > 0) {
          showPanel([
            '● 等待開賣｜' + S.startAt,
            '倒數 ' + fmtCountdown(wait),
            '目標：' + (parseList(S.targets).join('、') || '（未設定，抓第一個有票的）'),
            document.hidden ? '⚠️ 分頁在背景，開賣瞬間可能慢約 1 秒' : '請保持此分頁在前景',
          ]);
          await sleep(Math.min(500, wait));
          continue;
        }

        areaState.scans++;
        let info = null;
        try {
          if (areaState.firstScan && document.getElementById('salesTable')) {
            // 進頁面當下的庫存就是最新的，先用它判一次，省掉一次往返
            areaState.firstScan = false;
            info = parseAreaDoc(document);
            info.lost = false;
          } else {
            info = await scanOnce();
          }
          areaState.lastRows = info.rows;
          logStock(info);
        } catch (e) {
          logEvent('error', { where: 'scan', msg: String(e && e.message || e) }, true);
          renderAreaPanel(null, '查詢失敗，' + gapMs() + 'ms 後重試');
          await sleep(gapMs());
          continue;
        }

        if (info.lost) { onSessionLost(); return; }

        const hit = pickRow(info.rows);
        if (hit) areaState.empty = 0;
        if (!hit) scanPeers();                 // 不擋主迴圈，背景問其他票價
        renderAreaPanel(info, hit ? '→ 前往 ' + hit.name : null);

        if (!hit) {
          areaState.empty = (areaState.empty || 0) + 1;
          const backUrl = sessionStorage.getItem(PERF_URL_KEY);
          const peersDead = !S.crossPrice || (peerState.at && !peerState.list.some((p) => p.avail.length));
          // 連續 5 輪本場次沒票、其他票價也沒票 → 退回場次頁。
          // 卡在一個完售的價位上什麼都等不到，場次頁才看得到全部價位。
          if (backUrl && areaState.empty >= 5 && peersDead) {
            markPerfEmpty(PERF_ID);
            logEvent('back_to_perf', { perf: PERF_ID, rounds: areaState.empty }, true);
            toast('這個票價沒票了，退回場次頁繼續監控全部價位');
            location.href = backUrl;
            return;
          }
          const jump = peerJumpTarget();
          if (jump) {
            peerState.lastJump = Date.now();
            const names = jump.avail.slice(0, 3).map((r) => r.name).join('、');
            logEvent('peer_jump', { perf: jump.perf, price: jump.price, areas: names }, true);
            notify('🎟 ' + (jump.price || '') + ' 元有票', names);
            toast('其他票價有票：' + (jump.price || jump.text.slice(0, 16)) + '（' + names + '）\n跳過去搶');
            location.href = new URL(jump.url, location.href).href;
            return;
          }
        }

        if (hit) {
          // 一般活動的 GROUP_ID 已經從 rel 推出來了，不必等；只有套票類需要 ag/agi 才等座位圖
          if (!hit.g || needsActivityGroup()) hit.g = (await waitGmap(hit.id)) || hit.g;
          sessionStorage.setItem('kham_area_url', location.href);
          sessionStorage.setItem('kham_last_area', JSON.stringify({ id: hit.id, name: hit.name, at: Date.now() }));
          const left = Number.isNaN(hit.left) ? '未顯示' : hit.left;
          logEvent('pick', {
            id: hit.id, name: hit.name, left: hit.leftText,
            group: hit.g ? hit.g.group : null,
            go: AREA_FLAVOR === 'seatpick' ? 'UTK0205_(自行選位)' : buyUrl(hit),
          }, true);
          if (AREA_FLAVOR === 'seatpick') {
            // 這條流程沒有電腦配位，只能進選位頁自己勾座位
            toast('找到票區：' + hit.name + '（餘 ' + left + '）\n這個活動只能自行選位，座位請自己勾');
            notify('🎫 有票：' + hit.name, '餘 ' + left + '，已進入選位頁，請自行勾選座位');
            flashTitle('🎫 有票：' + hit.name);
            enterSeatPick(hit);
            return;
          }
          const standing = isStandingRow(hit);
          if (standing === null) {
            // 座位圖還沒載入 → 不知道這區是站席還是對號座，交給網站原生的點擊決定
            if (clickRow(hit)) {
              toast('找到票區：' + hit.name + '（餘 ' + left + '）\n依網站流程進入購票頁');
              return;
            }
            hit.g = (await waitGmap(hit.id)) || hit.g;   // 點不到才等座位圖，再自己組網址
          }
          toast('找到票區：' + hit.name + '（餘 ' + left + '）\n'
            + (isStandingRow(hit) === true ? '站席購票頁' : '以電腦配位進入張數頁'));
          location.href = buyUrl(hit);
          return;
        }
        await sleep(gapMs());
      }
    } finally {
      areaState.running = false;
    }
  }

  async function areaRunOnce() {
    areaState.scans++;
    try {
      const info = await scanOnce();
      if (info.lost) { onSessionLost(); return; }
      const hit = pickRow(info.rows);
      renderAreaPanel(info, hit ? '→ 有票：' + hit.name + '（手動模式不自動前往）' : '目前沒有符合條件的票');
      toast(hit ? '有票：' + hit.name + '\n手動模式不自動前往，請自行點選' : '目前沒有符合條件的票');
    } catch (e) {
      toast('查詢失敗：' + e.message);
    }
  }

  // ================================================================ 張數頁
  const qtyState = { filled: false, submitted: false, backTimer: null };

  function loggedOut() {
    const el = document.getElementById('LOGIN_ID');
    return !!(el && el.offsetParent !== null);
  }

  // 依票種優先順序挑一種：完全相符優先於包含，都沒對上就用第一種
  const SPECIAL_TYPE = /身障|身心障礙|陪同|輪椅/;

  function pickType(list) {
    const prefs = String(S.ticketType || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    // 「身心障礙票」「身障陪同票」入場要證明，沒在優先順序裡點名就不碰
    if (!prefs.some((p) => SPECIAL_TYPE.test(p))) {
      const normal = list.filter((t) => !SPECIAL_TYPE.test(t.name));
      if (normal.length) list = normal;
    }
    for (const p of prefs) {
      const k = norm(p);
      const exact = list.find((t) => norm(t.name) === k);
      if (exact) return exact;
      const part = list.find((t) => norm(t.name).includes(k));
      if (part) return part;
    }
    return list[0] || null;
  }

  // 站席頁的票區下拉：value = "票區ID|餘位"。網址帶了 PERFORMANCE_PRICE_AREA_ID，先對到同一區
  function pickStandingArea() {
    const sel = document.getElementById('PRICE');
    if (!sel) return null;
    const want = hid('PERFORMANCE_PRICE_AREA_ID');
    const opts = [...sel.options].filter((o) => o.value && o.value !== '-1');
    if (!opts.length) return null;
    let opt = want && opts.find((o) => o.value.split('|')[0] === want);
    if (!opt) {
      // 網址沒指定或對不到就照票區優先順序挑，再退而求其次挑餘位最多的
      const targets = parseList(S.targets);
      for (const t of targets) {
        const k = norm(t);
        const hit = opts.find((o) => norm(o.textContent).includes(k) && toInt(o.value.split('|')[1], 0) > 0);
        if (hit) { opt = hit; break; }
      }
      if (!opt) opt = opts.reduce((b, o) => (toInt(o.value.split('|')[1], 0) > toInt(b.value.split('|')[1], 0) ? o : b), opts[0]);
    }
    if (sel.value !== opt.value) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { name: opt.textContent.trim(), last: toInt(opt.value.split('|')[1], 0) };
  }

  function fillQty() {
    const standing = IS_STANDING ? pickStandingArea() : null;
    const ids = [...document.querySelectorAll("input[KEY='TYPE_ID']")].map((i) => i.value).filter(Boolean);
    const list = ids.map((id) => ({
      id,
      name: (document.getElementById(id + '_NAME') || {}).value || id,
      box: document.querySelector("input[KEY='" + id + "']"),
    })).filter((t) => t.box);
    if (!list.length) {
      const soldOut = [...document.querySelectorAll('.mui-numbox')].some((d) => /售完|額滿/.test(d.textContent));
      return soldOut ? { ok: false, msg: '這一區所有票種都已售完', few: true } : { ok: false, msg: '找不到張數欄位' };
    }

    const limit = toInt(hid('QUANTITY_LIMIT'), 0) || 8;
    const last = standing ? standing.last : toInt(hid('LAST_AMOUNT'), 0);
    const need = Math.max(1, toInt(S.count, 1));
    let want = Math.min(need, limit);
    if (last > 0 && want > last) {
      if (!S.allowFewer) return { ok: false, msg: '剩餘 ' + last + ' 張，不足 ' + need + ' 張', few: true };
      want = last;
    }

    const target = pickType(list);
    list.forEach((t) => { t.box.value = (t === target ? String(want) : '0'); });

    const atype = document.getElementById('ATYPE');
    if (atype && S.acceptNonAdjacent && !atype.checked) atype.click();

    const where = standing ? standing.name + '：' : '';
    return { ok: true, msg: '已填 ' + where + target.name + ' × ' + want + ' 張' + (atype && atype.checked ? '（接受不連位）' : ''), want, type: target.name };
  }

  // 驗證碼：放大原圖並聚焦輸入框，由使用者輸入；不做辨識
  function setupCaptcha() {
    const chk = document.getElementById('CHK');
    const pic = document.getElementById('chk_pic');
    if (!chk) return false;
    // 放大只改 width，讓瀏覽器做平滑縮放；transform + pixelated 會把新版驗證碼元件的圖糊掉。
    // 絕對不要碰 src —— 網站改用 jquery.captcha 元件（captchaInstance），src 由它自己管。
    if (pic && !pic.__khamZoom) {
      pic.__khamZoom = true;
      const w = pic.getBoundingClientRect().width || pic.naturalWidth || 0;
      if (w) pic.style.width = Math.round(w * 1.5) + 'px';
      pic.style.height = 'auto';
      pic.style.margin = '10px 0 10px 4px';
    }
    chk.style.outline = '3px solid #c8102e';
    chk.setAttribute('autocomplete', 'off');
    try { chk.scrollIntoView({ block: 'center' }); } catch (e) {}
    setTimeout(() => { try { chk.focus(); } catch (e) {} }, 60);

    if (!chk.__khamBound) {
      chk.__khamBound = true;
      chk.addEventListener('input', () => {
        const len = captchaLen(chk);
        if (chk.disabled) return;                       // 元件正在換圖，這時的值是半截的
        if (document.querySelector('.captcha-mask.is-visible')) return;   // 新元件的載入遮罩還在
        if (S.enabled && S.autoSubmitCaptcha && chk.value.trim().length >= len) submitCart('驗證碼輸入完成');
      });
      chk.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCart('Enter 送出'); } });
    }
    return true;
  }

  // 2026-09-17 事故：這裡原本寫死 pic.src = '/pic.aspx?TYPE=UTK0201_001'，
  // 但當天買的是 UTK0202_ 站席頁（TYPE 應為 UTK0202），等於把畫面換成「另一個驗證碼槽」的圖，
  // 使用者看到的圖與伺服器要驗的答案從此對不上，打再對都是錯。
  // 而且網站已改用 jquery.captcha 元件，錯誤回應自己就帶 captchaInstance().refresh(true)。
  // 結論：一律不碰圖片，只清空欄位並把游標放回去，刷新交給網站。
  // 位數以頁面上的 maxlength 為準（實測 #CHK maxlength="4"），設定值只是備援：
  // 設錯會提早送出半截的驗證碼，這種錯不該讓使用者自己承擔
  function captchaLen(chk) {
    const dom = chk && parseInt(chk.getAttribute('maxlength'), 10);
    if (Number.isFinite(dom) && dom > 0) return dom;
    return Math.max(1, toInt(S.captchaLen, 4));
  }

  // 真正要換圖時，按網站自己的刷新鈕（onclick="$('#chk_pic').captchaInstance().refresh()"），
  // 永遠不要自己組 /pic.aspx 網址 —— 真實網址在元件的 data-captcha-url，TYPE 每頁不同。
  function clickCaptchaRefresh() {
    const btn = [...document.querySelectorAll('img,button,a,span')]
      .find((b) => /captchaInstance\(\)\.refresh/.test(b.getAttribute('onclick') || ''))
      || document.querySelector('.captcha-refresh-btn');
    if (btn) { btn.click(); return true; }
    return false;
  }

  function refreshCaptcha() {
    const chk = document.getElementById('CHK');
    if (!chk) return;
    // 元件刷新期間會把欄位 disabled，等它放行再清空聚焦，否則我們的清空會被它蓋掉
    let tries = 0;
    const ready = () => {
      if (chk.disabled && tries++ < 40) { setTimeout(ready, 100); return; }
      chk.value = '';
      try { chk.focus(); } catch (e) {}
      // 網站沒自己換圖（src 還停在佔位的 1x1 gif）才按它的刷新鈕，仍然不碰 src
      const pic = document.getElementById('chk_pic');
      if (pic && /^data:image\/gif/.test(pic.getAttribute('src') || '')) {
        setTimeout(() => {
          const p2 = document.getElementById('chk_pic');
          if (p2 && /^data:image\/gif/.test(p2.getAttribute('src') || '')) clickCaptchaRefresh();
        }, 800);
      }
    };
    setTimeout(ready, 120);
  }

  function submitCart(reason) {
    if (qtyState.submitted) return;
    if (loggedOut()) { toast('⚠️ 尚未登入，請先登入會員後再送出（本工具不代填帳密）'); return; }
    const chk = document.getElementById('CHK');
    if (chk && !chk.value.trim()) { toast('⚠️ 請先輸入驗證碼'); return; }
    qtyState.submitted = true;
    logEvent('submit', {
      reason,
      area: hid('AREA_NAME'),
      perf: PERF_ID,
      amounts: [...document.querySelectorAll("input[KEY='TYPE_ID']")].map((i) => ({
        type: i.value,
        name: (document.getElementById(i.value + '_NAME') || {}).value || '',
        n: (document.querySelector("input[KEY='" + i.value + "']") || {}).value || '0',
      })),
      atype: !!(document.getElementById('ATYPE') || {}).checked,
      captchaLen: ((document.getElementById('CHK') || {}).value || '').length,
    }, true);
    toast('送出：加入購物車（' + reason + '）');
    // 呼叫網站原有的 addShoppingCart()；先試按鈕，退而求其次請 inject 代呼叫
    const btn = [...document.querySelectorAll('button,input[type=submit]')]
      .find((b) => /addShoppingCart/.test(b.getAttribute('onclick') || ''));
    if (btn) btn.click();
    else window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'ADD_CART' }, location.origin);
    // 送出後 5 秒沒有結果就解鎖，允許再試
    setTimeout(() => { qtyState.submitted = false; }, 5000);
  }

  function backToArea(why, delay = 400) {
    if (qtyState.backTimer) return;
    const last = JSON.parse(sessionStorage.getItem('kham_last_area') || 'null');
    if (last && last.id) {
      // 這個票區剛失敗，10 秒內不再重試，換下一個目標
      const cd = JSON.parse(sessionStorage.getItem('kham_cooldown') || '{}');
      cd[last.id] = Date.now() + 10000;
      sessionStorage.setItem('kham_cooldown', JSON.stringify(cd));
    }
    toast('↩ ' + why + '，返回票區頁繼續搜尋');
    qtyState.backTimer = setTimeout(() => { location.href = areaPageUrl(); }, delay);
  }

  function renderQtyPanel(extra) {
    const sel = document.getElementById('PRICE');
    const selOpt = sel && sel.selectedOptions && sel.selectedOptions[0];
    const areaName = IS_STANDING ? ((selOpt && selOpt.textContent.trim()) || '—') : (hid('AREA_NAME') || '—');
    const lastAmt = IS_STANDING
      ? (selOpt && selOpt.value.indexOf('|') >= 0 ? selOpt.value.split('|')[1] : '—')
      : (hid('LAST_AMOUNT') || '—');
    const lines = [
      (S.enabled ? '● 自動模式' : '○ 手動模式') + '｜' + (IS_STANDING ? '站席購票頁' : '張數頁（電腦配位）'),
      '票區：' + areaName + '｜剩餘 ' + lastAmt + '｜限購 ' + (hid('QUANTITY_LIMIT') || '—'),
    ];
    if (loggedOut()) lines.push('⚠️ 尚未登入：請先登入，本工具不代填帳密');
    else lines.push('✔ 已登入');
    lines.push(S.autoSubmitCaptcha
      ? '驗證碼輸滿 ' + captchaLen(document.getElementById('CHK')) + ' 碼即自動送出'
      : '請自行按「加入購物車」');
    if (extra) lines.push(extra);
    showPanel(lines);
  }

  function runQty() {
    const r = fillQty();
    if (!r.ok) {
      logEvent('fill_fail', { area: hid('AREA_NAME'), msg: r.msg, last: hid('LAST_AMOUNT') }, true);
      renderQtyPanel('⚠️ ' + r.msg);
      toast('⚠️ ' + r.msg);
      if (S.enabled && r.few) backToArea(r.msg, 300);
      return;
    }
    qtyState.filled = true;
    logEvent('fill', {
      area: hid('AREA_NAME'), type: r.type, want: r.want,
      last: hid('LAST_AMOUNT'), limit: hid('QUANTITY_LIMIT'),
      loggedOut: loggedOut(),
    }, true);
    setupCaptcha();
    renderQtyPanel('✔ ' + r.msg);
    toast('✔ ' + r.msg + '\n請輸入驗證碼' + (S.autoSubmitCaptcha ? '（輸滿自動送出）' : ''));
  }

  // ================================================================ 購物車頁
  function runCart() {
    const txt = document.body ? document.body.innerText : '';
    const has = /剩餘時間|購物車/.test(txt);
    showPanel(['● 購物車頁', has ? '請於保留時間內完成結帳' : '購物車內容讀取中…']);
    notify('🎫 已加入購物車', '請於保留時間內完成結帳');
    flashTitle('🎫 已加入購物車！');
    if (S.enabled && S.autoCheckout) {
      const btn = [...document.querySelectorAll('button,a,input[type=submit]')]
        .find((b) => /結帳|下一步/.test((b.innerText || b.value || '')) && !/繼續購物|刪除/.test(b.innerText || ''));
      if (btn) { toast('自動前往結帳'); setTimeout(() => btn.click(), 500); }
      else toast('找不到結帳按鈕，請自行點選');
    }
  }

  // ================================================================ 跨分頁協調
  // 兩個分頁分別搶不同場次時（例如 2/27 與 2/28），任一邊加入購物車成功後，
  // 另一邊可以先停手 —— 驗證碼只有一雙手能打，兩邊同時跳出來只會兩頭空。
  const WON_TTL = 10 * 60 * 1000;   // 超過 10 分鐘的「搶到」紀錄視同過期，不再壓住其他分頁

  function markWon(info) {
    try {
      chrome.storage.local.set({ won: { at: Date.now(), by: TAB_TOKEN, info: String(info || '') } });
    } catch (e) { /* 協調失敗不影響本分頁 */ }
  }

  function pauseForOtherTab(won) {
    if (!S.pauseOthersOnWin) return false;
    if (!won || won.by === TAB_TOKEN) return false;
    if (Date.now() - (won.at || 0) > WON_TTL) return false;
    areaState.stop = true;
    productState.stop = true;
    showPanel([
      '⏸ 已暫停：另一個分頁搶到了',
      won.info ? '對方：' + won.info : '',
      '先去把那邊的驗證碼打完。要繼續搶這一場，',
      '請開擴充功能面板按「解除暫停」。',
    ].filter(Boolean));
    toast('⏸ 另一個分頁已加入購物車，這一邊先停手');
    return true;
  }

  function resumeAfterPause() {
    if (!S.enabled) return;
    // 看元素決定要重啟哪個迴圈，不看網址
    if ((has('#salesTable') || has('#AREA_DIV')) && !areaState.running) { areaState.stop = false; areaLoop(); }
    else if (has('#GO_BUY2') && !productState.running) { productState.stop = false; productLoop(); }
    else if (perfCandidates(document).length && !perfState.running) { perfState.stop = false; perfLoop(); }
  }

  // ================================================================ 網站訊息處理
  function handleAlert(text) {
    const t = String(text || '');
    if (!t) return;
    log('網站提示：', t);
    logEvent('alert', { text: t }, true);
    if (PAGE === 'product') {
      // 開賣前每輪都會跳一次，只更新面板並把對話框關掉，不洗版
      productState.lastMsg = t;
      renderProductPanel();
      setTimeout(dismissDialog, 150);
      return;
    }
    // 序號被網站退回：不看在哪一頁，只看序號欄位還在不在（#ID1 是舊結構，不能寫死）
    if (presaleState.el && visibleEl(presaleState.el)) {
      presaleState.submitted = false;
      toast('⚠️ ' + t + '\n請檢查序號（全半形、大小寫）後重新送出');
      try { presaleState.el.focus(); } catch (e) {}
      return;
    }
    if (/驗證碼/.test(t)) {
      qtyState.submitted = false;
      window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'RESET_CLICK' }, location.origin);
      refreshCaptcha();
      toast('⚠️ ' + t + '\n已換新驗證碼，請重新輸入');
      return;
    }
    if (/帳號|密碼|登入/.test(t)) {
      qtyState.submitted = false;
      toast('⚠️ ' + t + '\n請先登入會員（本工具不代填帳密）');
      return;
    }
    if (/售完|已無|不足|額滿|超過|逾時|重新|已被|失敗/.test(t)) {
      qtyState.submitted = false;
      window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'RESET_CLICK' }, location.origin);
      toast('⚠️ ' + t);
      // 張數頁被退回：有張數欄位就回票區頁重找（同樣看元素，不看網址）
      if (S.enabled && (has("input[KEY='TYPE_ID']") || has('#PRICE'))) backToArea(t, 600);
      return;
    }
    qtyState.submitted = false;
    toast('網站提示：' + t);
  }

  // 網站很多回應長這樣：showProcess();setTimeout(function(){top.location.href = 'X';}, 3260);
  // 目的地已經決定了，空等只是它的節流；我們直接過去
  // 回應是否真的帶「導向購票流程頁」的指令。
  // 2026-09-17 事故：原本只測 /location/i，伺服器 500 的 GenericErrorPage 也含 location，
  // 被誤判成搶到票並發了通知，還會讓另一個分頁停手。
  const REDIRECT_RE = /(?:top\.)?location\.href\s*=\s*['"]([^'"]*UTK\d[^'"]*)['"]/i;
  function redirectTarget(body) {
    const m = REDIRECT_RE.exec(String(body || ''));
    return m ? m[1] : null;
  }

  function jumpEarly(body) {
    const b = String(body || '');
    if (!/setTimeout/.test(b)) return false;
    const m = REDIRECT_RE.exec(b);
    if (!m) return false;
    const url = new URL(m[1], location.href).href;
    logEvent('jump', { url }, true);
    location.href = url;
    return true;
  }

  function handleXhr(d) {
    if (!d) return;
    // 購票流程的請求全記：送出參數（帳密已在 inject.js 遮蔽）與伺服器回應原文
    logEvent('xhr', {
      url: d.url, method: d.method || '', action: d.action || '',
      status: d.status, ms: d.ms,
      sent: String(d.sent || '').slice(0, 2000),
      resp: String(d.text || '').slice(0, 1500),
    }, true);
    if (/GOBUY/i.test(d.action || '')) {
      productState.lastRespAt = Date.now();
      const body = String(d.text || '');
      if (redirectTarget(body)) {
        // 網站回傳導向指令 = 已啟售；網址就在回應裡，不等它的 setTimeout
        productState.stop = true;
        productState.lastMsg = '已啟售，進入購票流程';
        toast('🎫 已啟售，進入購票流程');
        notify('🎫 開賣了', '節目已啟售，正在進入購票流程');
        flashTitle('🎫 開賣了！');
        renderProductPanel();
        if (S.enabled) jumpEarly(body);
        return;
      }
      const m = /alert1\(\s*'([^']*)'/.exec(body);
      productState.lastMsg = m ? m[1] : (body ? body.slice(0, 40) : '(無回應內容)');
      renderProductPanel();
      return;
    }
    if (/DO_FIRST_Click|GET_FIRST_INFO/i.test(d.action || '')) {
      const body = String(d.text || '');
      presaleState.submitted = false;
      if (redirectTarget(body)) {
        logEvent('presale_ok', {}, true);
        toast('✔ 優先購認證通過，進入票區頁');
        if (S.enabled) jumpEarly(body);
      }
      // 認證失敗會走 alert1，由 handleAlert 顯示
      return;
    }
    if (!/ADD_SHOPPING_CAR/i.test(d.action || '')) return;
    const body = String(d.text || '');
    // 新版 UTK0201_001.min.js 的 error callback 是空的，失敗時不會有任何提示；
    // 回應沒有導向也沒有 alert 就當失敗，立刻解鎖讓你能再送
    if (!redirectTarget(body) && !/alert1?\(/.test(body)) {
      qtyState.submitted = false;
      window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'RESET_CLICK' }, location.origin);
      toast('⚠️ 送出沒有回應（HTTP ' + d.status + '），可再試一次');
      return;
    }
    const cartUrl = redirectTarget(body);
    if (cartUrl && /UTK0206|UTK0203|CART/i.test(cartUrl)) {
      // 導向購物車頁才算真的加入成功
      notify('🎫 加入購物車成功', '請於保留時間內完成結帳');
      flashTitle('🎫 搶到票了！');
      showPanel(['✔ 已加入購物車', '正在前往購物車…']);
      logEvent('won', { area: hid('AREA_NAME'), perf: PERF_ID, product: PRODUCT_ID }, true);
      markWon((hid('AREA_NAME') || '') + '（' + (document.title || '') + '）');
      if (S.enabled) jumpEarly(body);
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || !d.__kham) return;
    if (d.kind === 'ALERT') handleAlert(d.data && d.data.text);
    if (d.kind === 'CMD' && d.data && d.data.cmd === 'VIP_SUBMIT') {
      presaleState.done = !!d.data.ok;
      logEvent('vip_submit_result', d.data, true);
      if (d.data.ok) toast('已透過網站的送出函式送出序號');
    }
    if (d.kind === 'XHR') handleXhr(d.data);
  });

  // ================================================================ 啟動
  function loadCooldown() {
    try {
      const cd = JSON.parse(sessionStorage.getItem('kham_cooldown') || '{}');
      const now = Date.now();
      Object.keys(cd).forEach((k) => { if (cd[k] > now) areaState.cooldown[k] = cd[k]; });
    } catch (e) {}
  }

  // 看畫面上有沒有這個元素。規則引擎全靠它。
  // 2026-09-17：這個函式曾被我連同舊的 detect() 一起誤刪，導致 sweep() 每次都丟
  // 「has is not defined」→ 整組規則完全沒跑。tests/perf_pick.html 就是為了擋住這種事。
  const hasEl2 = (sel) => !!document.querySelector(sel);
  const has = hasEl2;

  // 規則：條件成立就做那件事，彼此不互相牽制。
  // 同一頁可以同時成立好幾條（例如序號欄位＋驗證碼＋訊息視窗），各做各的，
  // 不再是「這一頁只能走一條流程」。每條各自只觸發一次，元素消失又出現才重來。
  const fired = {};
  function once(id, fn) {
    if (fired[id]) return;
    fired[id] = true;
    try { logEvent('rule', { id, url: location.href }, true); fn(); }
    catch (e) { logEvent('error', { where: 'rule:' + id, msg: String(e && e.message || e) }, true); }
  }

  function sweep() {
    // 序號欄位 → 由 watchPresaleField() 常駐處理（看到就填），不占用其他規則

    // 節目頁「立即購票」
    if (!fired.product && (has('#GO_BUY2') || [...document.querySelectorAll('button,a')].some((b) => /doGoBuy/.test(b.getAttribute('onclick') || '')))) {
      once('product', () => {
        renderProductPanel(S.enabled ? '啟動中…' : '主開關關閉，可按「立即執行」試一次');
        if (S.enabled) productLoop();
      });
    }

    // 場次列表（含各票價）
    if (!fired.perf && perfCandidates().length) once('perf', () => runPerf(S.enabled));

    // 票區表
    if (!fired.area && (has('#salesTable') || has('#AREA_DIV'))) {
      once('area', () => {
        sessionStorage.setItem('kham_area_url', location.href);
        currentGmap();
        applyHideSoldOut(); setTimeout(applyHideSoldOut, 1000);
        renderAreaPanel(null, S.enabled ? '啟動中…' : '主開關關閉，可按「立即執行」查一次');
        if (S.enabled) areaLoop();
      });
    }

    // 張數欄位（含站席頁的票區下拉）
    if (!fired.qty && (has("input[KEY='TYPE_ID']") || has('#PRICE'))) {
      once('qty', () => {
        renderQtyPanel();
        if (S.enabled) runQty();
        else toast('手動模式：可按擴充功能的「立即執行」填表單（不自動送出）');
      });
    }

    // 驗證碼：不管在哪一頁，看到就放大並把游標放進去。
    // ⚠️ 只做這兩件事，永遠不碰圖片、不代填、不猜答案。
    if (!fired.captcha && document.getElementById('CHK')) once('captcha', () => setupCaptcha());

    // 自行選位頁
    if (!fired.seatmap && (PAGE === 'seatmap' || has('#SEAT_DIV') || has('area[href*="SeatClick"]'))) {
      once('seatmap', () => showPanel([
        '● 自行選位頁',
        '這個活動的流程沒有電腦配位，座位要自己勾。',
        '勾完座位後按「加入購物車」，驗證碼一樣要自己輸入。',
      ]));
    }

    // 購物車
    // 購物車只認明確的頁面／表格：這條會按「結帳」，寧可漏判也不能誤觸
    if (!fired.cart && (PAGE === 'cart' || has('#CART_TABLE'))) once('cart', () => runCart());
  }

  let sweepTimer = null;

  function start() {
    loadCooldown();
    logEvent('nav', { url: location.href, title: document.title, flavor: PAGE === 'area' ? AREA_FLAVOR : '' }, true);
    autoDismissNotice();
    // 每一頁都拍，包含購物車／結帳／實名制等沒特別處理的頁：
    //   進頁面立刻一張（快頁不到 1.5 秒就跳走也留得住）、1.5 秒穩定後一張、
    //   離開前一張（操作完的最終狀態，最重要）、燈箱或對話框彈出時再一張
    snapshot('load');
    setTimeout(() => snapshot('settled'), 1500);
    window.addEventListener('pagehide', () => snapshot('leave'));
    document.addEventListener('visibilitychange', () => { if (document.hidden) snapshot('hidden'); });
    watchModals();
    watchPresaleField();     // 常駐：序號欄位一出現就填，跟在哪一頁無關
    // 分頁後開的情況：先確認別的分頁是不是已經搶到了
    try {
      chrome.storage.local.get({ won: null }).then((r) => { pauseForOtherTab(r && r.won); });
    } catch (e) {}
    sweep();
    // 內容是 ajax 後補的（票區表、場次列表、燈箱）→ 元素一出現就再掃一次
    try {
      const mo = new MutationObserver(() => {
        clearTimeout(sweepTimer);
        sweepTimer = setTimeout(sweep, 60);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    setInterval(sweep, 500);
    // 這一頁沒有要自動做的事時也把面板叫出來：開關要隨時按得到
    setTimeout(() => {
      if (!panelBody || !panelBody.textContent) {
        showPanel(['● 待命中', '這一頁沒有要自動處理的東西。', '標題列的按鈕可以就地開關自動搶票。']);
      }
    }, 900);
  }

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    S = Object.assign({}, DEFAULTS, s);
    start();
  });

  // 主開關改動立即生效，不必重整
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      // 另一個分頁搶到／被解除暫停
      if (changes.won) { if (!pauseForOtherTab(changes.won.newValue)) resumeAfterPause(); }
      return;
    }
    if (area !== 'sync') return;
    Object.keys(changes).forEach((k) => { S[k] = changes[k].newValue; });
    renderToggle();
    const kind = has('#salesTable') || has('#AREA_DIV') ? 'area'
      : (has("input[KEY='TYPE_ID']") || has('#PRICE')) ? 'qty'
      : has('#GO_BUY2') ? 'product'
      : perfCandidates(document).length ? 'perf' : 'other';
    if (kind === 'product') {
      if (S.enabled && !productState.running) { productState.stop = false; productLoop(); }
      if (!S.enabled) { productState.stop = true; renderProductPanel('已停止'); }
    }
    if (kind === 'perf') {
      if (S.enabled && !perfState.running) { perfState.stop = false; perfLoop(); }
      if (!S.enabled) { perfState.stop = true; renderPerfPanel(perfState.rows, '已停止'); }
    }
    if (kind === 'area') {
      if (S.enabled && !areaState.running) { areaState.stop = false; areaLoop(); }
      if (!S.enabled) { areaState.stop = true; renderAreaPanel(null, '已停止'); }
    }
    if (kind === 'qty') renderQtyPanel();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'RUN_NOW') return;
    // 手動執行：把這一頁「現在成立」的事全做一遍，不挑流程
    fillPresaleBox();
    const kind = has('#salesTable') || has('#AREA_DIV') ? 'area'
      : (has("input[KEY='TYPE_ID']") || has('#PRICE')) ? 'qty'
      : perfCandidates().length ? 'perf'
      : has('#GO_BUY2') ? 'product' : 'other';
    if (kind === 'product') {
      if (S.enabled) { productState.stop = false; productLoop(); }
      else { productState.tries++; dismissDialog(); clickGoBuy(); renderProductPanel('已試一次'); }
    } else if (kind === 'perf') {
      runPerf(true);
    } else if (kind === 'area') {
      if (S.enabled) { areaState.stop = false; areaLoop(); } else areaRunOnce();
    } else if (kind === 'qty') {
      runQty();
    } else {
      toast('這一頁沒有可執行的動作');
    }
    sendResponse && sendResponse({ ok: true });
  });
})();
