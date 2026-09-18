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

  const VER = '2.8.0';

  // ---------------------------------------------------------------- 設定
  // 這個工具只做一件事：**看到元素就幫你填／幫你點**。
  // 它不挑場次、不挑票區、不自己換頁、不輪詢庫存 —— 那些都由你自己決定。
  const DEFAULTS = {
    enabled: true,           // 總開關：關掉之後這個工具什麼都不做
    watch: false,            // 監票：勾著就在每個票區頁自動每秒按「更新票數」，有票就點進去；F5 也不停
    presaleCode: '',         // 優先購序號：看到欄位就照原樣填入，不裁切
    autoSubmitPresale: true, // 序號填好自動按送出
    count: 2,                // 張數欄位要填幾張
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

  // 站席購票頁：票區是用下拉選單 #PRICE 選的（網址可能不同，所以看元素）
  const IS_STANDING = () => !!document.getElementById('PRICE');

  const qs = new URLSearchParams(location.search);
  const hid = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  const PERF_ID = hid('PERFORMANCE_ID') || qs.get('PERFORMANCE_ID') || '';
  const PRODUCT_ID = hid('PRODUCT_ID') || qs.get('PRODUCT_ID') || '';

  // ---------------------------------------------------------------- 小工具
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  const toInt = (v, d = 0) => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : d; };

  function log(...a) { try { console.log('[寬宏輔助]', ...a); } catch (e) {} }

  // 紀錄與頁面快照機制已於 2026-09-17 移除：使用者要的是一個乾淨的填寫工具，
  // 不要背景寫入、不要額外開銷。這裡只保留主控台輸出。
  const logEvent = () => {};
  const snapshot = () => {};
  const watchModals = () => {};

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
  let watchBtn = null;

  // 面板上的開關長相跟著狀態走：紅＝自動搶票中、灰＝已關閉
  function renderToggle() {
    renderWatchBtn();
    if (!toggleBtn) return;
    const on = S.enabled !== false;
    toggleBtn.textContent = on ? '⏸ 停止全部' : '▶ 已停止（點此啟用）';
    toggleBtn.style.background = on ? '#fff' : '#3a3f4a';
    toggleBtn.style.color = on ? '#c8102e' : '#fff';
    toggleBtn.title = on ? '點一下完全停止（什麼都不做）' : '點一下重新啟用';
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
      const next = S.enabled === false;
      S.enabled = next;                       // 先就地生效，不等 storage 回來
      renderToggle();
      toast(next ? '▶ 已啟用：看到欄位會幫你填' : '⏸ 已全部停止：完全不動作');
      if (!next && watchState.on) stopWatch();
      try { chrome.storage.sync.set({ enabled: next }); } catch (err) {}
      if (next) sweep();
    });

    // 監票：反覆按網站自己的「更新票數」。只在票區頁顯示，由你按下才開始
    watchBtn = document.createElement('button');
    watchBtn.style.cssText = toggleBtn.style.cssText + ';display:none';
    watchBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    watchBtn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); toggleWatch(); });

    bar.appendChild(title); bar.appendChild(watchBtn); bar.appendChild(toggleBtn);
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
      toastEl.id = '__kham_toast';     // 讓找按鈕的邏輯認得出這是我們自己的東西，別去點它
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

  // ---------------------------------------------------------------- 監票
  // 票區頁右下角有一顆網站自己的「更新票數」，按了會用 ajax 重畫票區表。
  // 「監票」就是幫你每秒按它一次，並在某一區從「已售完」變成有數字時大聲提醒。
  // 它不點票區、不換頁 —— 看到有票之後要不要進去，是你的事。
  const WATCH_MS = 1000;
  const watchState = { on: false, timer: null, prev: null, clicks: 0, hot: [] };

  const ours = (el) => !!el.closest('#__kham_panel,#__kham_toast');
  function refreshButton() {
    const all = [...document.querySelectorAll('button,a,input[type=button],input[type=submit]')].filter((b) => visibleEl(b) && !ours(b));
    return all.find((b) => /更新票數/.test(b.value || elText(b, 12)))
      || all.find((b) => /refreshArea|DO_REFRESH/i.test(b.getAttribute('onclick') || ''))
      || [...document.querySelectorAll('div,span')].filter((b) => visibleEl(b) && !ours(b))
        .map(innermostClickable).find((b) => /更新票數/.test(elText(b, 12)))
      || null;
  }

  // 讀票區表：票區名稱 → 空位（數字；已售完 = 0；沒顯示 = NaN）
  function readAreas() {
    const out = {};
    document.querySelectorAll('#salesTable tr.status_tr').forEach((tr) => {
      const c = tr.cells;
      const name = c[1] ? c[1].textContent.trim() : '';
      const t = c[3] ? c[3].textContent.trim() : '';
      if (!name) return;
      let left;
      if (/售完|額滿/.test(t) || /\bSoldout\b/i.test(tr.className || '')) left = 0;
      else if (/^[\d,]+$/.test(t.replace(/\s/g, ''))) left = toInt(t);
      else left = NaN;
      out[name] = { left, tr };
    });
    return out;
  }

  function renderWatchBtn() {
    if (!watchBtn) return;
    const here = !!refreshButton();
    watchBtn.style.display = here ? '' : 'none';
    if (!here) return;
    watchBtn.textContent = watchState.on ? '👁 監票中（' + watchState.clicks + '）' : (S.watch ? '👁 監票（待命）' : '👁 監票');
    watchBtn.style.background = (watchState.on || S.watch) ? '#7c4dff' : '#3a3f4a';
    watchBtn.style.color = '#fff';
    watchBtn.title = watchState.on ? '點一下停止監票' : '每秒幫你按一次「更新票數」，有區從售完變有票時提醒你';
  }

  function renderWatchPanel() {
    const cur = readAreas();
    const names = Object.keys(cur);
    const open = names.filter((n) => cur[n].left > 0 || Number.isNaN(cur[n].left));
    const lines = ['👁 監票中｜已更新 ' + watchState.clicks + ' 次｜' + new Date().toLocaleTimeString(),
      '票區 ' + names.length + '｜有票 ' + open.length,
      '按到：' + (watchState.how || '（尚無回報）')];
    open.slice(0, 10).forEach((n) => lines.push('🎟 ' + n + '：' + (Number.isNaN(cur[n].left) ? '未顯示' : cur[n].left)));
    if (watchState.hot.length) lines.push('★ 剛出現：' + watchState.hot.slice(-3).join('、'));
    lines.push('票一出現就替你點進去，之後你打驗證碼。');
    showPanel(lines);
  }

  // 監票看到有票 → 立刻點那一區（網站自己的列點擊 → 進張數頁）。
  // 2026-09-18 實測：回流票出現到消失不到兩秒，等人看到再點已經沒了。
  // 只點一次、點完就停止監票；優先挑空位 >= 你要的張數的那區，沒有就挑最多的。
  function enterArea(cur) {
    if (watchState.entered) return false;
    const need = Math.max(1, toInt(S.count, 1));
    const rows = Object.keys(cur).map((n) => ({ name: n, left: cur[n].left, tr: cur[n].tr }))
      .filter((r) => r.left > 0);
    if (!rows.length) return false;
    const enough = rows.filter((r) => r.left >= need);
    const pick = (enough.length ? enough : rows).reduce((a, b) => (b.left > a.left ? b : a));
    watchState.entered = true;
    clearInterval(watchState.timer); watchState.timer = null; watchState.on = false;
    try { if (watchState.mo) watchState.mo.disconnect(); } catch (e) {}
    toast('🎟 ' + pick.name + ' 有 ' + pick.left + ' 張，替你點進去', 6000);
    notify('🎟 有票：' + pick.name, '空位 ' + pick.left + '，已替你點進去，去打驗證碼');
    flashTitle('🎟 ' + pick.name);
    showPanel(['🎟 有票：' + pick.name + '（' + pick.left + '）', '已替你點進去 → 張數頁', '接下來：打驗證碼、按加入購物車']);
    // 交給網頁自己的環境去觸發那一列綁的 handler（jQuery 委派／onclick）。只點一次，不補點。
    window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'CLICK_ROW', id: pick.tr.id }, (location.origin === 'null' ? '*' : location.origin));
    // 撲空保險：點了之後 2.5 秒還停在這一頁（沒被帶去張數頁），不管網站有沒有說什麼、說了什麼，
    // 一律當作沒搶到，解鎖並繼續監票。不能只靠訊息裡有沒有「售完」兩個字。
    setTimeout(() => {
      if (!watchState.entered) return;                   // 已經由別的路徑解鎖
      if (!document.getElementById('salesTable') && !document.getElementById('AREA_DIV')) return;   // 已離開
      watchState.entered = false;
      if (S.watch && S.enabled !== false) { startWatch(); toast('沒進到張數頁，繼續監票'); }
    }, 2500);
    return true;
  }

  function watchCheck() {
    if (!watchState.on) return;
    const cur = readAreas();
    if (enterArea(cur)) return;
    if (watchState.prev) {
      Object.keys(cur).forEach((n) => {
        const was = watchState.prev[n] ? watchState.prev[n].left : 0;
        const now = cur[n].left;
        if (was === 0 && now > 0) {
          // 從售完變有票：把那一列標黃、閃標題、桌面通知
          watchState.hot.push(n + ' ' + now);
          try { cur[n].tr.style.background = '#fff176'; setTimeout(() => { cur[n].tr.style.background = ''; }, 6000); } catch (e) {}
          flashTitle('🎟 ' + n + ' 有票 ' + now);
          notify('🎟 有票：' + n, '空位 ' + now + '，要進去請自己點');
          toast('🎟 ' + n + ' 出現 ' + now + ' 張', 6000);
        }
      });
    }
    watchState.prev = cur;
    renderWatchPanel();
    renderWatchBtn();
  }

  function watchTick() {
    if (!watchState.on) return;
    if (S.enabled === false) { stopWatch(); return; }
    const btn = refreshButton();
    if (!btn) { stopWatch(); toast('找不到「更新票數」按鈕，監票停止'); return; }
    if (btn.disabled) return;
    // 交給 MAIN world 去叫網站自己綁的 handler（onclick 屬性／jQuery 事件／全域函式），
    // 從 content script 這邊 .click() 常常點到外層包裝、觸發不了它的 loading。
    window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'REFRESH_AREA' }, (location.origin === 'null' ? '*' : location.origin));
    watchState.clicks++;
    setTimeout(watchCheck, 450);   // 等網站的 ajax 把表格重畫完再讀
  }

  function startWatch() {
    if (watchState.on) return;
    watchState.on = true;
    watchState.prev = readAreas();
    watchState.clicks = 0;
    watchState.hot = [];
    watchState.entered = false;
    watchState.timer = setInterval(watchTick, WATCH_MS);
    // 網站 ajax 一重畫票區表就立刻讀、立刻點 —— 不等固定的 0.45 秒，回流票等不起
    try {
      if (!watchState.mo) {
        watchState.mo = new MutationObserver(() => {
          if (!watchState.on) return;
          clearTimeout(watchState.moT);
          watchState.moT = setTimeout(watchCheck, 30);
        });
      }
      const tbl = document.getElementById('salesTable') || document.getElementById('AREA_DIV');
      if (tbl) watchState.mo.observe(tbl, { childList: true, subtree: true, characterData: true });
    } catch (e) {}
    watchTick();
    toast('👁 開始監票：每秒按一次「更新票數」');
    renderWatchBtn();
  }

  function stopWatch() {
    watchState.on = false;
    clearInterval(watchState.timer); watchState.timer = null;
    try { if (watchState.mo) watchState.mo.disconnect(); } catch (e) {}
    stopFlash();
    renderWatchBtn();
    if (!S.watch) showPanel(['👁 監票已取消', '已更新 ' + watchState.clicks + ' 次']);
  }

  // 勾選＝持久狀態，寫進設定；頁面重整、撲空、換到別的票區頁都會自動接著監
  function setWatch(on) {
    S.watch = !!on;
    try { chrome.storage.sync.set({ watch: S.watch }); } catch (e) {}
    if (S.watch) { if (refreshButton()) startWatch(); }
    else stopWatch();
  }
  function toggleWatch() { setWatch(!S.watch); }

  // 這一頁有「更新票數」而且勾選著 → 自動開始
  function autoWatch() {
    if (S.enabled === false || !S.watch || watchState.on || watchState.entered) return;
    if (refreshButton()) startWatch();
  }

  const OK_TXT = /^(ok|確定|確認|知道了|我知道了|關閉|close|是)$/i;
  const DIALOG_SEL = '.ui-dialog,[role="dialog"],[id*="dialog" i],[class*="dialog" i],[class*="popout" i],[class*="modal" i]';

  function okButton(root) {
    const cands = [...root.querySelectorAll('button,input[type=button],input[type=submit],a')];
    return cands.find((b) => visibleEl(b) && OK_TXT.test(norm(b.value || elText(b, 12))))
      || cands.find((b) => /ui-dialog-buttonpane/.test(((b.parentElement || {}).className || '')))
      || null;
  }

  // 網站的訊息視窗（實名制提醒之類）：每頁都跳、每次都要人按 Ok。
  // 帶錯誤字眼的留著給人看，不要幫忙關掉。
  // 註：不能用「帳號」「密碼」當關鍵字 —— 實名制提醒裡就有「會員帳號」。
  const NOTICE_SKIP = /必須填寫|請輸入|認證|錯誤|失敗|售完|額滿|逾時|驗證碼|尚未啟售|不足|超過|無法|已無|重新/;
  // 需要你做決定的視窗，一律不代按（訂單、付款、刪除、離開…）
  const DECISION_SKIP = /是否|確定要|確認要|要不要|送出訂單|下單|付款|結帳|刪除|移除|取消訂單|離開|放棄/;
  // 視窗裡有「取消」之類的選項 = 網站在問你，不是單純提醒
  const CANCEL_TXT = /^(取消|否|放棄|返回|上一步|cancel|no)$/i;
  const isShown = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // 找出「現在畫面上、可以安全關掉」的訊息視窗
  function noticeDialog() {
    const presale = findPresaleField();
    for (const dlg of document.querySelectorAll(DIALOG_SEL)) {
      if (!isShown(dlg)) continue;
      // 只看最外層：.ui-dialog-buttonpane 之類的內層也會對到選擇器，
      // 而那一層的文字只有「Ok」——不含錯誤字眼，會害我們把錯誤訊息一起關掉。
      if (dlg.parentElement && dlg.parentElement.closest(DIALOG_SEL)) continue;
      if (presale && dlg.contains(presale)) continue;        // 優先購畫面不能關
      const text = elText(dlg, 400);
      if (!text || text.length < 6 || NOTICE_SKIP.test(text)) continue;
      if (DECISION_SKIP.test(text)) continue;                 // 要你決定的事，不代按
      // 有「取消」可選 → 這是選擇題，不是通知；替你按等於替你決定
      const hasCancel = [...dlg.querySelectorAll('button,input[type=button],input[type=submit],a')]
        .some((b) => visibleEl(b) && CANCEL_TXT.test(norm(b.value || elText(b, 12))));
      if (hasCancel) continue;
      const btn = okButton(dlg);
      if (btn) return { dlg, btn, text };
    }
    return null;
  }

  function dismissDialog() {
    const hit = noticeDialog();
    if (hit) { hit.btn.click(); return true; }
    const btn = document.querySelector('.ui-dialog-buttonpane button, .ui-dialog-titlebar-close');
    if (btn) { btn.click(); return true; }
    return false;
  }

  // 常駐：訊息視窗一出現就按掉，不限時間、不限哪一頁
  const noticeSeen = new Map();
  function watchNotice() {
    if (watchNotice.on) return;
    watchNotice.on = true;
    const check = () => {
      if (S.enabled === false) return;        // 總開關關著：什麼都不做
      try {
        const hit = noticeDialog();
        if (hit) {
          const key = hit.text.slice(0, 120);
          if (Date.now() - (noticeSeen.get(key) || 0) > 1500) {   // 同一則重複跳也要按，但別狂點
            noticeSeen.set(key, Date.now());
            hit.btn.click();
            toast('已關閉網站提示：' + hit.text.slice(0, 40) + (hit.text.length > 40 ? '…' : ''), 2500);
          }
        }
        // 張數頁／選位頁的「本次不再提醒」小視窗
        const tip = document.getElementById('POPOUT_TIP');
        if (tip && isShown(tip)) {
          const b = [...tip.querySelectorAll('button')].find((x) => /closeRemind/.test(x.getAttribute('onclick') || ''))
            || [...tip.querySelectorAll('button')].find((x) => /知道了/.test(x.textContent || ''));
          if (b) b.click();
        }
      } catch (e) { /* 關視窗失敗不影響填寫 */ }
    };
    check();
    try {
      const mo = new MutationObserver(() => { clearTimeout(watchNotice.t); watchNotice.t = setTimeout(check, 50); });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    } catch (e) {}
    setInterval(check, 300);
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
  // 「中國信託卡友 購票時請先輸入卡號前6碼以做驗證」這種畫面裡沒有「優先購」三個字，
  // 所以卡友／做驗證／購票驗證這類字樣也要算數，否則會拒填。
  const PRESALE_SCOPE_RE = /優先購|presale|會員認證|membership|vip\s*sell|卡友|以做驗證|購票驗證|身分驗證/i;
  // 一律不填（帳密、個資、驗證碼、付款安全性欄位）
  const NEVER_RE = /驗證碼|驗証碼|captcha|帳號|身分證|統一編號|密碼|password|e-?mail|信箱|手機|電話|生日|姓名|地址|cvv|安全碼|有效期|到期/i;
  // 卡號類要分兩種情況：
  //   優先購畫面裡的「卡號前 6 碼」是合法的認證欄位（中國信託卡友場次就是這樣驗證）→ 要填
  //   結帳頁的信用卡號是真的卡號 → 絕不能碰
  // 所以：只有在優先購／認證畫面裡，而且欄位長度像「前幾碼」時才填。
  const CARD_RE = /信用卡|卡號|card\s*number|卡片/i;

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
    // 規則只有一條：認證畫面（燈箱或整頁區塊，附近有 優先購／Presale／卡友／驗證 字樣）裡的
    // 文字欄位就是要填的欄位。不看標籤寫「序號」還是「卡號」，那是網站的措辭，跟你無關。
    // 唯二不碰：驗證碼、密碼／CVV 這類（NEVER_RE），以及長度像完整信用卡號的（maxlength >= 13）。
    const cands = [];
    for (const el of textInputs()) {
      if (isCaptchaField(el)) continue;               // 硬性排除
      if (NEVER_RE.test(fieldOwn(el))) continue;      // 帳密／個資／付款安全欄位
      // 只有「卡號」類欄位才看長度：完整信用卡號是 16 碼，認證用的前幾碼很短。
      // 序號欄位不看長度 —— 序號本來就可能很長。
      const ml = parseInt(el.getAttribute('maxlength'), 10);
      if (CARD_RE.test(fieldContext(el)) && Number.isFinite(ml) && ml >= 13) continue;
      if (el.id === 'ID1' || presaleScope(el)) cands.push(el);
    }
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    // 同一個畫面有好幾格時，優先挑標籤像序號／卡號的，否則第一格
    return cands.find((el) => CODE_RE.test(fieldContext(el)) || CARD_RE.test(fieldContext(el))) || cands[0];
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
          window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'VIP_SUBMIT' }, (location.origin === 'null' ? '*' : location.origin));
        }
      }, 800);
    } else {
      // 畫面上找不到鈕 → 直接叫網站自己的送出函式（在 MAIN world）
      toast('找不到送出鈕，改用網站自己的送出函式');
      window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'VIP_SUBMIT' }, (location.origin === 'null' ? '*' : location.origin));
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
    if (el.__khamUserTyped) return;                 // 你接手了，送出也交給你
    if (S.autoSubmitPresale && presaleState.tries < 3) presaleSubmit('序號已填');
    else try { el.focus(); } catch (e) {}
  }

  // 全站常駐監看：每一頁都跑，欄位一出現就填
  function watchPresaleField() {
    if (presaleState.watching) return;
    presaleState.watching = true;
    const tick = () => {
      if (S.enabled === false) return;        // 總開關關著：什麼都不做
      try {
        const el = findPresaleField();
        if (!el) return;
        // 你一碰鍵盤（keydown／paste 是工具永遠不會自己發的事件），這個欄位就交給你，
        // 工具從此不再填、不再送。否則你清掉錯的值想自己打，它 0.2 秒後又填回去 —— 那是在擋你。
        if (!el.__khamHandsOffBound) {
          el.__khamHandsOffBound = true;
          const handsOff = () => {
            if (el.__khamUserTyped) return;
            el.__khamUserTyped = true;
            showPanel(['● 優先購序號', '你自己在輸入了，這個欄位我不再碰。', '打完請自己按送出（或按 Enter）。']);
          };
          el.addEventListener('keydown', handsOff);
          el.addEventListener('paste', handsOff);
        }
        if (el.__khamUserTyped) return;
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
  function fillPresaleBox() {
    const el = findPresaleField() || presaleState.el;
    if (el) fillPresaleField(el, '手動執行');
    else toast('這一頁沒看到優先購序號欄位');
  }

  // ================================================================ 張數頁
  const qtyState = { filled: false, submitted: false, backTimer: null };

  function loggedOut() {
    const el = document.getElementById('LOGIN_ID');
    return !!(el && el.offsetParent !== null);
  }

  // 同一區有多種票種時用第一種。
  // 「身心障礙票」「身障陪同票」入場要證明，一律不碰。
  const SPECIAL_TYPE = /身障|身心障礙|陪同|輪椅/;

  function pickType(list) {
    const normal = list.filter((t) => !SPECIAL_TYPE.test(t.name));
    return (normal.length ? normal : list)[0] || null;
  }

  // 站席頁的票區下拉：value = "票區ID|餘位"。網址帶了 PERFORMANCE_PRICE_AREA_ID，先對到同一區
  // 站席頁的票區下拉（value = "票區ID|餘位"）：**只讀你選了什麼，絕不幫你選**。
  // 2026-09-17 使用者明確要求：區域由他自己挑，工具分不清哪一區已完售。
  // 還沒選（-1）就先不填張數，等你選了再填（下面有 change 監聽）。
  function readStandingArea() {
    const sel = document.getElementById('PRICE');
    if (!sel) return null;
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value || opt.value === '-1') return { none: true };
    return { name: opt.textContent.trim(), last: toInt(opt.value.split('|')[1], 0) };
  }

  function fillQty() {
    const standing = IS_STANDING() ? readStandingArea() : null;
    if (standing && standing.none) return { ok: false, msg: '請先自己選票區（上面的下拉選單），選好我就幫你填張數' };
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
    // 填得下就填你要的張數；剩餘或限購比較少就填那個數字（不足也先填好，要不要買由你決定）
    let want = Math.min(need, limit);
    if (last > 0 && want > last) want = last;

    const target = pickType(list);
    list.forEach((t) => { t.box.value = (t === target ? String(want) : '0'); });

    // 「接受不連位座位」網站預設沒勾，就維持沒勾 —— 那是你的決定，不是我的。

    const where = standing ? standing.name + '：' : '';
    return { ok: true, msg: '已填 ' + where + target.name + ' × ' + want + ' 張', want, type: target.name };
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
    // 輸入法提示：桌面 Chrome 管不到 macOS 的輸入法（ime-mode 早已從標準移除，
    // chrome.input.ime 只有 ChromeOS 才有），這幾個屬性只對行動裝置的虛擬鍵盤有效。
    chk.setAttribute('inputmode', 'latin');
    chk.setAttribute('lang', 'en');
    chk.setAttribute('autocapitalize', 'off');
    chk.setAttribute('spellcheck', 'false');
    try { chk.scrollIntoView({ block: 'center' }); } catch (e) {}
    setTimeout(() => { try { chk.focus(); } catch (e) {} }, 60);

    if (!chk.__khamBound) {
      chk.__khamBound = true;
      chk.addEventListener('input', () => {
        if (chk.disabled) return;                       // 元件正在換圖，這時的值是半截的
        if (document.querySelector('.captcha-mask.is-visible')) return;   // 新元件的載入遮罩還在
        normalizeCaptcha(chk);   // 只把全形轉半形、濾掉中文，不做任何送出
      });
      // 中文輸入法組字期間不要動它的值，否則會把你正在打的字打斷
      chk.addEventListener('compositionstart', () => { chk.__khamComposing = true; });
      chk.addEventListener('compositionend', () => {
        chk.__khamComposing = false;
        normalizeCaptcha(chk);
      });
    }
    return true;
  }

  // 2026-09-17 事故：這裡原本寫死 pic.src = '/pic.aspx?TYPE=UTK0201_001'，
  // 但當天買的是 UTK0202_ 站席頁（TYPE 應為 UTK0202），等於把畫面換成「另一個驗證碼槽」的圖，
  // 使用者看到的圖與伺服器要驗的答案從此對不上，打再對都是錯。
  // 而且網站已改用 jquery.captcha 元件，錯誤回應自己就帶 captchaInstance().refresh(true)。
  // 結論：一律不碰圖片，只清空欄位並把游標放回去，刷新交給網站。
  // 忘了切輸入法時，打出來的是全形英數（ＡＢ１２）或中文。驗證碼一定是半形英數，
  // 所以：全形一律轉半形、非英數一律去掉，並提醒你切輸入法。
  // 只動「你已經打進去的內容」，永遠不碰驗證碼圖片。
  function toHalfWidth(t) {
    return String(t).replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ');
  }

  // 回傳 true = 現在的值可以拿來判斷長度；false = 還在組字中，先別動
  function normalizeCaptcha(chk) {
    if (chk.__khamComposing) return false;              // 注音／倉頡組字中
    const raw = chk.value;
    const cleaned = toHalfWidth(raw).replace(/[^A-Za-z0-9]/g, '');
    if (cleaned === raw) return true;
    const pos = chk.selectionStart;
    chk.value = cleaned;
    try { chk.setSelectionRange(Math.min(pos, cleaned.length), Math.min(pos, cleaned.length)); } catch (e) {}
    if (/[\uFF01-\uFF5E\u4E00-\u9FFF\u3100-\u312F]/.test(raw)) {
      chk.style.outline = '3px solid #ff9800';
      toast('⚠️ 偵測到全形或中文，已自動轉半形並濾掉\n請把輸入法切成英文（⌃Space 或 ⌘Space）', 4000);
      setTimeout(() => { chk.style.outline = '3px solid #c8102e'; }, 2500);
    }
    return true;
  }

  // 位數一律以頁面上的 maxlength 為準（實測 #CHK maxlength="4"）。
  // 不做成設定：設錯會提早送出半截的驗證碼，這種錯不該讓使用者自己承擔。
  function captchaLen(chk) {
    const dom = chk && parseInt(chk.getAttribute('maxlength'), 10);
    return Number.isFinite(dom) && dom > 0 ? dom : 4;
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

  function renderQtyPanel(extra) {
    const sel = document.getElementById('PRICE');
    const selOpt = sel && sel.selectedOptions && sel.selectedOptions[0];
    const areaName = IS_STANDING() ? ((selOpt && selOpt.textContent.trim()) || '—') : (hid('AREA_NAME') || '—');
    const lastAmt = IS_STANDING()
      ? (selOpt && selOpt.value.indexOf('|') >= 0 ? selOpt.value.split('|')[1] : '—')
      : (hid('LAST_AMOUNT') || '—');
    const lines = [
      (IS_STANDING() ? '● 站席購票頁' : '● 張數頁（電腦配位）'),
      '票區：' + areaName + '｜剩餘 ' + lastAmt + '｜限購 ' + (hid('QUANTITY_LIMIT') || '—'),
    ];
    if (loggedOut()) lines.push('⚠️ 尚未登入：請先登入，本工具不代填帳密');
    else lines.push('✔ 已登入');
    lines.push('驗證碼打完請自己按「加入購物車」');
    if (extra) lines.push(extra);
    showPanel(lines);
  }

  function runQty() {
    const r = fillQty();
    if (!r.ok) {
      logEvent('fill_fail', { area: hid('AREA_NAME'), msg: r.msg, last: hid('LAST_AMOUNT') }, true);
      renderQtyPanel('⚠️ ' + r.msg);
      toast('⚠️ ' + r.msg);
      // 張數不足時只告訴你，不幫你換頁（換頁是你的事）
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
    toast('✔ ' + r.msg + '\n請輸入驗證碼，打完自己按「加入購物車」');
  }

  // ================================================================ 網站訊息處理
  function handleAlert(text) {
    const t = String(text || '');
    if (!t) return;
    log('網站提示：', t);
    logEvent('alert', { text: t }, true);
    // 序號被網站退回：不看在哪一頁，只看序號欄位還在不在（#ID1 是舊結構，不能寫死）
    if (presaleState.el && visibleEl(presaleState.el)) {
      presaleState.submitted = false;
      toast('⚠️ ' + t + '\n請檢查序號（全半形、大小寫）後重新送出');
      try { presaleState.el.focus(); } catch (e) {}
      return;
    }
    if (/驗證碼/.test(t)) {
      qtyState.submitted = false;
      window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'RESET_CLICK' }, (location.origin === 'null' ? '*' : location.origin));
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
      window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'RESET_CLICK' }, (location.origin === 'null' ? '*' : location.origin));
      toast('⚠️ ' + t);
      // 監票點進去卻撲空（回流票幾秒就沒了）→ 還在票區頁的話，立刻回去繼續監票
      if (watchState.entered) {
        watchState.entered = false;
        if (S.watch && refreshButton()) { startWatch(); toast('撲空了，繼續監票'); }
      }
      return;
    }
    qtyState.submitted = false;
    toast('網站提示：' + t);
  }

  // 注意：工具不再解析回應裡的導向網址、也不會幫你提前跳頁。
  // 換頁一律由網站自己或你自己來 —— 2026-09-17 之後這個工具只負責填與點。

  // 回應的用途只剩兩個：記錄、以及在失敗時把「送出中」的鎖解開讓你能再送。
  // 不再解析導向網址、不再幫你跳頁。
  function handleXhr(d) {
    if (!d) return;
    // 購票流程的請求全記：送出參數（帳密已在 inject.js 遮蔽）與伺服器回應原文
    logEvent('xhr', {
      url: d.url, method: d.method || '', action: d.action || '',
      status: d.status, ms: d.ms,
      sent: String(d.sent || '').slice(0, 2000),
      resp: String(d.text || '').slice(0, 1500),
    }, true);

    const body = String(d.text || '');
    const hasRedirect = /(?:top\.)?location\.href\s*=\s*['"][^'"]*UTK\d/i.test(body);

    if (/DO_FIRST_Click|GET_FIRST_INFO/i.test(d.action || '')) {
      presaleState.submitted = false;          // 讓你（或工具）能再送一次
      if (hasRedirect) { logEvent('presale_ok', {}, true); toast('✔ 優先購認證通過，網站正在帶你進票區頁'); }
      return;                                   // 認證失敗會走 alert1，由 handleAlert 顯示
    }

    if (!/ADD_SHOPPING_CAR/i.test(d.action || '')) return;
    // 新版 UTK0201_001.min.js 的 error callback 是空的，失敗時不會有任何提示；
    // 回應沒有導向也沒有 alert 就當失敗，立刻解鎖讓你能再送
    if (!hasRedirect && !/alert1?\(/.test(body)) {
      qtyState.submitted = false;
      window.postMessage({ __khamCmd: 'KHAM_HELPER', cmd: 'RESET_CLICK' }, (location.origin === 'null' ? '*' : location.origin));
      toast('⚠️ 送出沒有回應（HTTP ' + d.status + '），可再試一次');
      return;
    }
    if (hasRedirect && /UTK0206|UTK0203|CART/i.test(body)) {
      notify('🎫 加入購物車成功', '請於保留時間內完成結帳');
      flashTitle('🎫 搶到票了！');
      showPanel(['✔ 已加入購物車', '網站會自己帶你去購物車']);
      logEvent('won', { area: hid('AREA_NAME'), perf: PERF_ID, product: PRODUCT_ID }, true);
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || !d.__kham) return;
    if (d.kind === 'ALERT') handleAlert(d.data && d.data.text);
    if (d.kind === 'CMD' && d.data && d.data.cmd === 'REFRESH_AREA') {
      watchState.how = (d.data.ok ? '' : '✗ ') + (d.data.how || '');
    }
    if (d.kind === 'CMD' && d.data && d.data.cmd === 'VIP_SUBMIT') {
      presaleState.done = !!d.data.ok;
      logEvent('vip_submit_result', d.data, true);
      if (d.data.ok) toast('已透過網站的送出函式送出序號');
    }
    if (d.kind === 'XHR') handleXhr(d.data);
  });

  // ================================================================ 啟動
  // 看畫面上有沒有這個元素。規則引擎全靠它。
  // 2026-09-17：這個函式曾被我誤刪，導致 sweep() 每次都丟「has is not defined」，
  // 整組規則完全沒跑，而且例外被包在 promise 裡、主控台一片安靜。tests/ 就是為了擋這種事。
  const has = (sel) => !!document.querySelector(sel);

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
    if (S.enabled === false) return;          // 總開關關著：什麼都不做

    // 1. 訊息視窗 → 由 watchNotice() 常駐按 Ok
    // 2. 優先購序號 → 由 watchPresaleField() 常駐填入並送出
    // 這兩件事都是常駐監看，不佔規則位置。

    // 3. 張數欄位（含站席頁的票區下拉）→ 填張數
    //    填寫一律做，不受主開關影響；主開關只管「會送出去的動作」。
    if (!fired.qty && (has("input[KEY='TYPE_ID']") || has('#PRICE'))) {
      once('qty', () => {
        renderQtyPanel(); runQty();
        // 站席頁：你在下拉選單選好票區之後，張數要跟著補填
        const sel = document.getElementById('PRICE');
        if (sel && !sel.__khamBound) {
          sel.__khamBound = true;
          sel.addEventListener('change', () => setTimeout(runQty, 50));
        }
      });
    }

    // 監票：勾選著就在票區頁自動開始（F5 之後也是）
    autoWatch();

    // 4. 驗證碼 → 放大並把游標放進去。
    //    ⚠️ 只做這兩件事，永遠不碰圖片、不代填、不猜答案。
    if (!fired.captcha && document.getElementById('CHK')) once('captcha', () => setupCaptcha());
  }

  let sweepTimer = null;

  function start() {
    logEvent('nav', { url: location.href, title: document.title }, true);
    watchNotice();
    // 每一頁都拍，包含購物車／結帳／實名制等沒特別處理的頁：
    //   進頁面立刻一張（快頁不到 1.5 秒就跳走也留得住）、1.5 秒穩定後一張、
    //   離開前一張（操作完的最終狀態，最重要）、燈箱或對話框彈出時再一張
    snapshot('load');
    setTimeout(() => snapshot('settled'), 1500);
    window.addEventListener('pagehide', () => snapshot('leave'));
    document.addEventListener('visibilitychange', () => { if (document.hidden) snapshot('hidden'); });
    watchModals();
    watchPresaleField();     // 常駐：序號欄位一出現就填並送出
    sweep();
    // 內容是 ajax 後補的（燈箱、張數欄位）→ 元素一出現就再掃一次
    try {
      const mo = new MutationObserver(() => {
        clearTimeout(sweepTimer);
        sweepTimer = setTimeout(sweep, 60);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    setInterval(sweep, 500);
    // 從張數頁按「上一頁」回來時 Chrome 會用快取還原這一頁，內部狀態還停在「已點過」→ 重置並接著監
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) { watchState.entered = false; watchState.on = false; autoWatch(); }
    });
    // 這一頁沒有要自動做的事時也把面板叫出來：開關要隨時按得到
    setTimeout(() => {
      if (!panelBody || !panelBody.textContent) {
        showPanel([S.enabled === false ? '⏸ 已全部停止' : '● 待命中',
          S.enabled === false ? '工具完全不動作。點標題列的按鈕可重新啟用。'
            : (refreshButton() ? '票區頁：要盯這一區的票，按標題列的「👁 監票」。' : '這一頁沒有要幫你填的東西。'),
          '我只做四件事：關訊息視窗、填優先購序號並送出、填張數、放大驗證碼。',
          '場次與票區由你自己選。']);
      }
    }, 900);
  }

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    S = Object.assign({}, DEFAULTS, s);
    start();
  });

  // 設定改動立即生效，不必重整
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    Object.keys(changes).forEach((k) => { S[k] = changes[k].newValue; });
    renderToggle();
    if (changes.watch) { if (S.watch) autoWatch(); else stopWatch(); }
    if (changes.enabled && S.enabled === false) stopWatch();
    if (has("input[KEY='TYPE_ID']") || has('#PRICE')) renderQtyPanel();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    // popup 上的監票鈕
    if (msg.type === 'WATCH_STATE' || msg.type === 'WATCH_TOGGLE') {
      if (msg.type === 'WATCH_TOGGLE') setWatch(typeof msg.on === 'boolean' ? msg.on : !S.watch);
      sendResponse && sendResponse({ here: !!refreshButton(), watch: !!S.watch, on: watchState.on, clicks: watchState.clicks, entered: !!watchState.entered });
      return;
    }
    if (msg.type !== 'RUN_NOW') return;
    // 手動執行：把這一頁「現在能幫你做的」全做一遍
    let did = false;
    if (dismissDialog()) did = true;
    if (findPresaleField()) { fillPresaleBox(); did = true; }
    if (has("input[KEY='TYPE_ID']") || has('#PRICE')) { runQty(); did = true; }
    if (document.getElementById('CHK')) { setupCaptcha(); did = true; }
    if (!did) toast('這一頁沒有可以幫你填的欄位');
    sendResponse && sendResponse({ ok: true });
  });
})();
