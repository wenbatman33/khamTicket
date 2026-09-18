// 頁面主環境（world: MAIN）的唯讀狀態讀取。
// 目的：把網站自己的回應與提示訊息轉給 content script 顯示／判斷。
// 不修改請求內容、不重送請求、不改變網站原有行為。
(() => {
  'use strict';
  const TAG = 'KHAM_HELPER';

  // 送出的參數要留紀錄，但帳號（身分證字號）與密碼絕不寫進紀錄
  function sanitize(body) {
    return String(body == null ? '' : body)
      .replace(/(LOGIN_PWD=)[^&]*/gi, '$1***')
      .replace(/(LOGIN_ID=)[^&]*/gi, '$1***')
      .slice(0, 4000);
  }

  function post(kind, data) {
    try {
      window.postMessage({ __kham: true, kind, data }, (location.origin === 'null' ? '*' : location.origin));
    } catch (e) { /* 轉發失敗不影響網站 */ }
  }

  // ---- 1. 監看 XHR 回應（加入購物車走 jQuery.ajax → XHR）----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__khamUrl = String(url || '');
    this.__khamMethod = String(method || '');
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__khamUrl || '';
    // 只看購票流程自己的頁面請求，其餘（廣告／追蹤）一律不碰
    if (/UTK\d+/i.test(url)) {
      const bodyStr = typeof body === 'string' ? body : '';
      const action = (bodyStr.match(/action=([A-Z_]+)/) || [])[1] || '';
      const sent = sanitize(bodyStr);
      const at = Date.now();
      this.addEventListener('load', () => {
        let text = '';
        try { text = String(this.responseText || ''); } catch (e) { /* 跨域或非文字回應 */ }
        post('XHR', {
          url, action, sent, status: this.status,
          ms: Date.now() - at, method: this.__khamMethod,
          text: text.slice(0, 4000),
        });
      });
      this.addEventListener('error', () => post('XHR', {
        url, action, sent, status: 0, ms: Date.now() - at, method: this.__khamMethod, text: '',
      }));
    }
    return origSend.call(this, body);
  };

  // ---- 1b. fetch 也攔一份（網站現在走 jQuery/XHR，改版後可能改用 fetch）
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input || '');
      const at = Date.now();
      const p = origFetch.apply(this, arguments);
      if (/UTK\d+/i.test(url) && !/__khamOwn/.test(url)) {
        const bodyStr = init && typeof init.body === 'string' ? init.body : '';
        const action = (bodyStr.match(/action=([A-Z_]+)/) || [])[1] || '';
        const sent = sanitize(bodyStr);
        p.then((res) => {
          const clone = res.clone();
          clone.text().then((text) => {
            post('XHR', {
              url, action, sent, status: res.status,
              ms: Date.now() - at, method: (init && init.method) || 'GET',
              text: String(text || '').slice(0, 4000),
            });
          }).catch(() => {});
        }).catch(() => post('XHR', { url, action, sent, status: 0, ms: Date.now() - at, text: '' }));
      }
      return p;
    };
  }

  // ---- 2. 攔截網站自訂的 alert1（購票流程的錯誤提示都走這個）----
  // 頁面腳本尚未載入，先用 setter 等它被定義，之後包一層再放回去。
  let _alert1;
  try {
    Object.defineProperty(window, 'alert1', {
      configurable: true,
      get() { return _alert1; },
      set(fn) {
        if (typeof fn === 'function') {
          _alert1 = function (msg, ...rest) {
            post('ALERT', { text: String(msg == null ? '' : msg) });
            return fn.apply(this, [msg, ...rest]);
          };
        } else {
          _alert1 = fn;
        }
      },
    });
  } catch (e) { /* 定義失敗就只靠 XHR 判斷 */ }

  // 原生 alert：一律接掉，不讓瀏覽器跳出會擋住整頁的對話框（例如「該票區已售完！」）。
  // 訊息轉給 content script 用 toast 顯示，內容一個字都不少，只是不再需要人按「確定」。
  // confirm() 不碰 —— 那是要人做決定的。
  window.alert = function (msg) {
    post('ALERT', { text: String(msg == null ? '' : msg) });
    try { console.log('[寬宏輔助] 已接掉 alert：', msg); } catch (e) {}
  };

  // ---- 3. 提供 content script 觸發頁面函式的管道 ----
  // content script 在隔離環境無法直接呼叫頁面的 addShoppingCart()，
  // 這裡只在收到自家訊息時代為呼叫網站原有的函式，不另外組請求。
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__khamCmd !== TAG) return;
    if (d.cmd === 'ADD_CART' && typeof window.addShoppingCart === 'function') {
      try { window.addShoppingCart(); } catch (e) { /* 由網站自行處理 */ }
    }
    // 優先購送出：畫面上的鈕點不到時，直接呼叫網站自己的送出函式
    if (d.cmd === 'VIP_SUBMIT') {
      try {
        if (typeof window.DoVIPLogin === 'function') { window.DoVIPLogin(); post('CMD', { cmd: 'VIP_SUBMIT', ok: true }); }
        else post('CMD', { cmd: 'VIP_SUBMIT', ok: false });
      } catch (e) { post('CMD', { cmd: 'VIP_SUBMIT', ok: false, err: String(e && e.message || e) }); }
    }
    // 監票：叫網站自己的「更新票數」。在 MAIN world 才拿得到它的 onclick 屬性與 jQuery 綁的 handler。
    if (d.cmd === 'REFRESH_AREA') {
      const how = [];
      try {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        // 排除擴充功能自己畫的面板與提示框 —— 提示文字裡就有「更新票數」四個字，
        // 2026-09-18 實測就是因為挑到自己的 toast，按了 85 次網站都沒反應。
        const ours = (x) => !!x.closest('#__kham_panel,#__kham_toast');
        const hit = (x) => vis(x) && !ours(x) && /更新票數/.test(x.textContent || x.value || '');
        // 先找真正可互動的元素；沒有才退到 div/span，且取最內層（textContent 最短）的那個
        let el = [...document.querySelectorAll('a,button,input')].filter(hit)[0]
          || [...document.querySelectorAll('div,span,i')].filter(hit).sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0]
          || null;
        let target = el;
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          if (n.onclick || /javascript:|refresh/i.test(n.getAttribute('href') || '') || (n.getAttribute('onclick') || '')) { target = n; break; }
        }
        if (!target) { post('CMD', { cmd: 'REFRESH_AREA', ok: false, how: 'not found' }); return; }
        how.push(target.tagName + (target.id ? '#' + target.id : '') + (target.className ? '.' + String(target.className).split(/\s+/)[0] : ''));
        let fired = false;
        // (a) 元素自己的 onclick 屬性
        if (typeof target.onclick === 'function') { try { target.onclick.call(target, new MouseEvent('click', { bubbles: true })); fired = true; how.push('onclick'); } catch (e) { how.push('onclick!' + e.message); } }
        // (b) jQuery 綁的 click handler（含在祖先上用 .on('click', selector) 委派的）
        if (!fired && window.jQuery) {
          try {
            for (let n = target; n && n !== document; n = n.parentElement) {
              const ev = window.jQuery._data && window.jQuery._data(n, 'events');
              if (ev && ev.click && ev.click.length) {
                window.jQuery(target).trigger('click'); fired = true; how.push('jq:' + n.tagName); break;
              }
            }
          } catch (e) { how.push('jq!' + e.message); }
        }
        // (c) href="javascript:xxx()"：直接執行
        if (!fired) {
          const href = target.getAttribute('href') || '';
          const m = /^javascript:\s*(.+)$/i.exec(href);
          if (m && !/^;?\s*$|void/.test(m[1])) { try { (0, eval)(m[1]); fired = true; how.push('href-js'); } catch (e) { how.push('href!' + e.message); } }
        }
        // (d) 網站常見的全域函式名
        if (!fired) {
          const fn = ['refreshArea', 'RefreshArea', 'refresh_area', 'doRefreshArea', 'DoRefreshArea', 'refreshTicket', 'RefreshTicket']
            .map((k) => window[k]).find((f) => typeof f === 'function');
          if (fn) { try { fn(); fired = true; how.push('global'); } catch (e) { how.push('global!' + e.message); } }
        }
        // (e) 真的沒別的了，原生 click
        if (!fired) { target.click(); fired = true; how.push('native'); }
        post('CMD', { cmd: 'REFRESH_AREA', ok: fired, how: how.join(' ') });
      } catch (e) { post('CMD', { cmd: 'REFRESH_AREA', ok: false, how: 'err ' + String(e && e.message || e) }); }
    }
    // 監票命中：觸發票區列自己綁的點擊（網站用 jQuery 委派在 tr 上）
    if (d.cmd === 'CLICK_ROW' && d.id) {
      try {
        const tr = document.getElementById(String(d.id));
        if (tr) {
          // 從列裡最內層可點的東西點起（a → td → tr），事件一路往上冒泡：
          // handler 不管綁在 a、td、tr、還是用 jQuery 委派在表格上，都收得到
          const target = tr.querySelector('a,button') || tr.querySelector('td') || tr;
          // 兩種方式都會沿路冒泡到 tr／表格，tr 上的 onclick 也會被叫到，不必再另外呼叫
          if (window.jQuery) window.jQuery(target).trigger('click');
          else target.click();
        }
      } catch (e) { /* 由 content script 的原生 click 補 */ }
    }
    if (d.cmd === 'RESET_CLICK') {
      // 網站用 isClick 當送出中旗標；失敗後偶爾沒還原會卡住，這裡只還原旗標
      try { if (typeof window.isClick !== 'undefined') window.isClick = false; } catch (e) {}
    }
  });
})();
