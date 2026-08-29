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

  const VER = '1.1.0';

  // ---------------------------------------------------------------- 設定
  const DEFAULTS = {
    enabled: false,          // 主開關：關閉時只做提示與「立即執行」單次動作
    startAt: '',             // 開搶時間 HH:MM(:SS)，留空 = 進頁面就開始
    refreshMs: 800,          // 重試間隔（毫秒）
    perfKeyword: '',         // 場次關鍵字（多場次時用，如 2/27），留空 = 第一個可訂購的
    targets: '',             // 票區優先順序，一行一個
    count: 2,                // 每次買幾張
    ticketType: '',          // 票種優先順序（逗號分隔），留空 = 用第一種
    acceptNonAdjacent: true, // 自動勾「接受不連位座位」
    allowFewer: false,       // 剩餘不足需求張數時，是否改買剩下的
    captchaLen: 4,           // 驗證碼位數，輸滿即送出
    autoSubmitCaptcha: true, // 驗證碼輸滿自動按「加入購物車」
    autoCheckout: false,     // 購物車頁自動按結帳
    pauseOthersOnWin: true,  // 有分頁搶到後，其他分頁先停手（驗證碼一次只能打一個）
  };
  let S = Object.assign({}, DEFAULTS);

  // ---------------------------------------------------------------- 頁面判斷
  const PATH = location.pathname;
  // 比對順序由長到短：_001 / _000 / _00 / _ 前綴相同，短的會誤中長的
  const PAGE =
    /UTK0201_001\.aspx/i.test(PATH) ? 'qty' :
    /UTK0201_000\.aspx/i.test(PATH) ? 'area' :
    /UTK0201_00\.aspx/i.test(PATH)  ? 'perf' :
    /UTK0201_\.aspx/i.test(PATH)    ? 'product' :
    /UTK0204_\.aspx/i.test(PATH)    ? 'area' :
    /UTK0205_\.aspx/i.test(PATH)    ? 'seatmap' :
    /UTK0206_\.aspx/i.test(PATH)    ? 'cart' : 'other';

  // 票區頁有兩種：UTK0201_000 可走電腦配位；UTK0204_ 這條流程只能自行選位
  // （實測：從 UTK0204_ 的 session 直接跳 UTK0201_001 會被踢回首頁）
  const AREA_FLAVOR = /UTK0204_\.aspx/i.test(PATH) ? 'seatpick' : 'auto';

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
    bar.style.cssText = 'background:#c8102e;padding:6px 10px;font-weight:700;cursor:move;pointer-events:auto;';
    bar.textContent = '🎫 寬宏搶票輔助 v' + VER;

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

  // ================================================================ 場次頁（多場次時選一場）
  // 每個場次的「立即訂購」是 top.location.href='UTK0204_.aspx?PERFORMANCE_ID=...'
  function perfRowText(el) {
    let n = el;
    for (let i = 0; i < 6 && n && n.parentElement; i++) {
      n = n.parentElement;
      if (n.tagName === 'TR' || n.tagName === 'LI' || /row|item|list/i.test(n.className || '')) break;
    }
    return ((n || el).innerText || '').replace(/\s+/g, ' ').trim();
  }

  function perfCandidates() {
    return [...document.querySelectorAll('button,a,input[type=submit]')]
      .filter((b) => /UTK0204_|UTK0201_000/i.test((b.getAttribute('onclick') || '') + (b.getAttribute('href') || '')))
      .map((b) => ({ el: b, text: perfRowText(b) }));
  }

  function runPerf(auto) {
    const list = perfCandidates();
    if (!list.length) {
      showPanel(['● 場次頁', '⚠️ 找不到可訂購的場次', '可能尚未開賣或該場次已售完']);
      return;
    }
    const k = norm(S.perfKeyword);
    const hit = k ? list.find((x) => norm(x.text).includes(k)) : list[0];
    if (!hit) {
      showPanel(['● 場次頁', '⚠️ 沒有符合「' + S.perfKeyword + '」的場次', '共 ' + list.length + ' 個可訂購場次']);
      toast('⚠️ 找不到符合「' + S.perfKeyword + '」的場次');
      return;
    }
    showPanel(['● 場次頁', '→ ' + hit.text.slice(0, 60), auto ? '自動進入中…' : '手動模式不自動進入']);
    if (!auto) return;
    toast('進入場次：' + hit.text.slice(0, 40));
    const m = /location\.href\s*=\s*'([^']+)'/.exec(hit.el.getAttribute('onclick') || '');
    if (m) location.href = new URL(m[1], location.href).href;
    else hit.el.click();
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
        if (!gmap[m[4]]) gmap[m[4]] = { perf: m[2], group: m[3], ag: m[5], agi: m[6] };
        return;
      }
      m = /Send\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/.exec(href);
      if (m) {
        // Send(page, performance_id, area_id, group_id)
        if (!gmap[m[3]]) gmap[m[3]] = { perf: m[2], group: m[4], ag: '', agi: '' };
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
      if (/售完|額滿/.test(leftText)) left = 0;
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

  // 依設定的優先順序挑第一個買得到的票區
  function pickRow(rows) {
    const targets = parseList(S.targets);
    const need = Math.max(1, toInt(S.count, 1));
    const now = Date.now();
    const ok = (r) => {
      if (areaState.cooldown[r.id] && areaState.cooldown[r.id] > now) return false;  // 剛試過又失敗的區先跳過
      if (r.left === 0) return false;
      if (Number.isNaN(r.left)) return true;             // 沒有餘位資訊 → 試一次
      return S.allowFewer ? r.left >= 1 : r.left >= need;
    };
    if (!targets.length) {
      // 沒設定目標就照畫面順序挑第一個有票的
      return rows.find(ok) || null;
    }
    for (const t of targets) {
      const key = norm(t);
      const hit = rows.filter((r) => norm(r.name).includes(key)).find(ok);
      if (hit) return hit;
    }
    return null;
  }

  function buyUrl(row) {
    const g = row.g || {};
    const p = new URLSearchParams();
    p.set('PERFORMANCE_ID', g.perf || PERF_ID);
    p.set('GROUP_ID', g.group != null && g.group !== '' ? g.group : '0');
    p.set('PERFORMANCE_PRICE_AREA_ID', row.id);
    if (g.ag) p.set('ACTIVITY_GROUP_ID', g.ag);
    if (g.agi) p.set('ACTIVITY_GROUP_ITEM_ID', g.agi);
    // 電腦配位 = UTK0201_001（自行選位才是 UTK0205_）
    return 'UTK0201_001.aspx?' + p.toString();
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

  // 只讀票區頁 HTML 取庫存，不整頁重載（省下約 1 秒）
  // 這些頁面綁 session 的購票流程狀態，狀態一壞就會被導回首頁，這裡要認出來
  async function scanOnce() {
    const res = await fetch(areaPageUrl(), { credentials: 'include', cache: 'no-store' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const info = parseAreaDoc(doc);
    info.lost = /UTK0101|UTK1301/i.test(res.url || '') || !doc.getElementById('salesTable');
    return info;
  }

  // session 失效：停手並要使用者從節目頁重新進來，不自作主張亂跳
  function onSessionLost() {
    areaState.stop = true;
    showPanel([
      '⚠️ 購票流程已失效',
      '網站把請求導回首頁了（session 狀態壞掉或逾時）。',
      '請重新從節目頁「立即購票」走一次流程，再開自動搶票。',
    ]);
    toast('⚠️ 購票流程已失效，請重新從節目頁進入');
    notify('⚠️ 購票流程已失效', '請重新從節目頁「立即購票」走一次流程');
  }

  function renderAreaPanel(info, extra) {
    const need = Math.max(1, toInt(S.count, 1));
    const targets = parseList(S.targets);
    const lines = [];
    lines.push((S.enabled ? '● 監看中' : '○ 已關閉（手動）') + '｜第 ' + areaState.scans + ' 次｜' + new Date().toLocaleTimeString());
    lines.push('模式：' + (AREA_FLAVOR === 'seatpick' ? '自行選位（此流程無電腦配位）' : '電腦配位') + '｜每次 ' + need + ' 張');
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
        } catch (e) {
          renderAreaPanel(null, '查詢失敗，' + gapMs() + 'ms 後重試');
          await sleep(gapMs());
          continue;
        }

        if (info.lost) { onSessionLost(); return; }

        const hit = pickRow(info.rows);
        renderAreaPanel(info, hit ? '→ 前往 ' + hit.name : null);

        if (hit) {
          // 一般活動的 GROUP_ID 已經從 rel 推出來了，不必等；只有套票類需要 ag/agi 才等座位圖
          if (!hit.g || needsActivityGroup()) hit.g = (await waitGmap(hit.id)) || hit.g;
          sessionStorage.setItem('kham_area_url', location.href);
          sessionStorage.setItem('kham_last_area', JSON.stringify({ id: hit.id, name: hit.name, at: Date.now() }));
          const left = Number.isNaN(hit.left) ? '未顯示' : hit.left;
          if (AREA_FLAVOR === 'seatpick') {
            // 這條流程沒有電腦配位，只能進選位頁自己勾座位
            toast('找到票區：' + hit.name + '（餘 ' + left + '）\n這個活動只能自行選位，座位請自己勾');
            notify('🎫 有票：' + hit.name, '餘 ' + left + '，已進入選位頁，請自行勾選座位');
            flashTitle('🎫 有票：' + hit.name);
            enterSeatPick(hit);
            return;
          }
          toast('找到票區：' + hit.name + '（餘 ' + left + '）\n以電腦配位進入張數頁');
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
  function pickType(list) {
    const prefs = String(S.ticketType || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    for (const p of prefs) {
      const k = norm(p);
      const exact = list.find((t) => norm(t.name) === k);
      if (exact) return exact;
      const part = list.find((t) => norm(t.name).includes(k));
      if (part) return part;
    }
    return list[0] || null;
  }

  function fillQty() {
    const ids = [...document.querySelectorAll("input[KEY='TYPE_ID']")].map((i) => i.value).filter(Boolean);
    const list = ids.map((id) => ({
      id,
      name: (document.getElementById(id + '_NAME') || {}).value || id,
      box: document.querySelector("input[KEY='" + id + "']"),
    })).filter((t) => t.box);
    if (!list.length) return { ok: false, msg: '找不到張數欄位' };

    const limit = toInt(hid('QUANTITY_LIMIT'), 0) || 8;
    const last = toInt(hid('LAST_AMOUNT'), 0);
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

    return { ok: true, msg: '已填 ' + target.name + ' × ' + want + ' 張' + (atype && atype.checked ? '（接受不連位）' : ''), want, type: target.name };
  }

  // 驗證碼：放大原圖並聚焦輸入框，由使用者輸入；不做辨識
  function setupCaptcha() {
    const chk = document.getElementById('CHK');
    const pic = document.getElementById('chk_pic');
    if (!chk) return false;
    if (pic) {
      pic.style.transform = 'scale(1.6)';
      pic.style.transformOrigin = 'left center';
      pic.style.margin = '10px 0 10px 4px';
      pic.style.imageRendering = 'pixelated';
    }
    chk.style.outline = '3px solid #c8102e';
    chk.setAttribute('autocomplete', 'off');
    try { chk.scrollIntoView({ block: 'center' }); } catch (e) {}
    setTimeout(() => { try { chk.focus(); } catch (e) {} }, 60);

    if (!chk.__khamBound) {
      chk.__khamBound = true;
      chk.addEventListener('input', () => {
        const len = Math.max(1, toInt(S.captchaLen, 4));
        if (S.enabled && S.autoSubmitCaptcha && chk.value.trim().length >= len) submitCart('驗證碼輸入完成');
      });
      chk.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCart('Enter 送出'); } });
    }
    return true;
  }

  function refreshCaptcha() {
    const pic = document.getElementById('chk_pic');
    if (pic) pic.src = '/pic.aspx?TYPE=UTK0201_001&ts=' + Date.now();
    const chk = document.getElementById('CHK');
    if (chk) { chk.value = ''; setTimeout(() => { try { chk.focus(); } catch (e) {} }, 50); }
  }

  function submitCart(reason) {
    if (qtyState.submitted) return;
    if (loggedOut()) { toast('⚠️ 尚未登入，請先登入會員後再送出（本工具不代填帳密）'); return; }
    const chk = document.getElementById('CHK');
    if (chk && !chk.value.trim()) { toast('⚠️ 請先輸入驗證碼'); return; }
    qtyState.submitted = true;
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
    const lines = [
      (S.enabled ? '● 自動模式' : '○ 手動模式') + '｜張數頁（電腦配位）',
      '票區：' + (hid('AREA_NAME') || '—') + '｜剩餘 ' + (hid('LAST_AMOUNT') || '—') + '｜限購 ' + (hid('QUANTITY_LIMIT') || '—'),
    ];
    if (loggedOut()) lines.push('⚠️ 尚未登入：請先登入，本工具不代填帳密');
    else lines.push('✔ 已登入');
    lines.push(S.autoSubmitCaptcha ? '驗證碼輸滿 ' + S.captchaLen + ' 碼即自動送出' : '請自行按「加入購物車」');
    if (extra) lines.push(extra);
    showPanel(lines);
  }

  function runQty() {
    const r = fillQty();
    if (!r.ok) {
      renderQtyPanel('⚠️ ' + r.msg);
      toast('⚠️ ' + r.msg);
      if (S.enabled && r.few) backToArea(r.msg, 300);
      return;
    }
    qtyState.filled = true;
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
  const TAB_TOKEN = (() => {
    let t = sessionStorage.getItem('kham_tab_token');
    if (!t) {
      t = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('kham_tab_token', t);
    }
    return t;
  })();
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
    if (PAGE === 'area' && !areaState.running) { areaState.stop = false; areaLoop(); }
    if (PAGE === 'product' && !productState.running) { productState.stop = false; productLoop(); }
  }

  // ================================================================ 網站訊息處理
  function handleAlert(text) {
    const t = String(text || '');
    if (!t) return;
    log('網站提示：', t);
    if (PAGE === 'product') {
      // 開賣前每輪都會跳一次，只更新面板並把對話框關掉，不洗版
      productState.lastMsg = t;
      renderProductPanel();
      setTimeout(dismissDialog, 150);
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
      if (PAGE === 'qty' && S.enabled) backToArea(t, 600);
      return;
    }
    qtyState.submitted = false;
    toast('網站提示：' + t);
  }

  function handleXhr(d) {
    if (!d) return;
    if (/GOBUY/i.test(d.action || '')) {
      productState.lastRespAt = Date.now();
      const body = String(d.text || '');
      if (/location/i.test(body)) {
        // 網站回傳導向指令 = 已啟售，接下來由網站自己帶到場次／票區頁
        productState.stop = true;
        productState.lastMsg = '已啟售，進入購票流程';
        toast('🎫 已啟售，進入購票流程');
        notify('🎫 開賣了', '節目已啟售，正在進入購票流程');
        flashTitle('🎫 開賣了！');
        renderProductPanel();
        return;
      }
      const m = /alert1\(\s*'([^']*)'/.exec(body);
      productState.lastMsg = m ? m[1] : (body ? body.slice(0, 40) : '(無回應內容)');
      renderProductPanel();
      return;
    }
    if (!/ADD_SHOPPING_CAR/i.test(d.action || '')) return;
    const body = String(d.text || '');
    if (/location/i.test(body)) {
      // 網站回傳導向指令 = 已加入購物車
      notify('🎫 加入購物車成功', '請於保留時間內完成結帳');
      flashTitle('🎫 搶到票了！');
      showPanel(['✔ 已加入購物車', '正在前往購物車…']);
      markWon((hid('AREA_NAME') || '') + '（' + (document.title || '') + '）');
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || !d.__kham) return;
    if (d.kind === 'ALERT') handleAlert(d.data && d.data.text);
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

  function start() {
    loadCooldown();
    // 分頁後開的情況：先確認別的分頁是不是已經搶到了
    try {
      chrome.storage.local.get({ won: null }).then((r) => { pauseForOtherTab(r && r.won); });
    } catch (e) {}
    if (PAGE === 'product') {
      renderProductPanel(S.enabled ? '啟動中…' : '主開關關閉，可按「立即執行」試一次');
      if (S.enabled) productLoop();
    } else if (PAGE === 'perf') {
      runPerf(S.enabled);
    } else if (PAGE === 'area') {
      sessionStorage.setItem('kham_area_url', location.href);
      currentGmap();
      renderAreaPanel(null, S.enabled ? '啟動中…' : '主開關關閉，可按「立即執行」查一次');
      if (S.enabled) areaLoop();
    } else if (PAGE === 'qty') {
      renderQtyPanel();
      if (S.enabled) runQty();
      else toast('手動模式：可按擴充功能的「立即執行」填表單（不自動送出）');
    } else if (PAGE === 'cart') {
      runCart();
    } else if (PAGE === 'seatmap') {
      showPanel([
        '● 自行選位頁',
        '這個活動的流程沒有電腦配位，座位要自己勾。',
        '勾完座位後按「加入購物車」，驗證碼一樣要自己輸入。',
      ]);
    }
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
    if (PAGE === 'product') {
      if (S.enabled && !productState.running) { productState.stop = false; productLoop(); }
      if (!S.enabled) { productState.stop = true; renderProductPanel('已停止'); }
    }
    if (PAGE === 'area') {
      if (S.enabled && !areaState.running) { areaState.stop = false; areaLoop(); }
      if (!S.enabled) { areaState.stop = true; renderAreaPanel(null, '已停止'); }
    }
    if (PAGE === 'qty') renderQtyPanel();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'RUN_NOW') return;
    if (PAGE === 'product') {
      if (S.enabled) { productState.stop = false; productLoop(); }
      else { productState.tries++; dismissDialog(); clickGoBuy(); renderProductPanel('已試一次'); }
    } else if (PAGE === 'perf') {
      runPerf(true);
    } else if (PAGE === 'area') {
      if (S.enabled) { areaState.stop = false; areaLoop(); } else areaRunOnce();
    } else if (PAGE === 'qty') {
      runQty();
    } else {
      toast('這一頁沒有可執行的動作');
    }
    sendResponse && sendResponse({ ok: true });
  });
})();
