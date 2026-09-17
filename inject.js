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
      window.postMessage({ __kham: true, kind, data }, location.origin);
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

  // 原生 alert 也記一份（少數流程會用到）
  const origAlert = window.alert;
  window.alert = function (msg) {
    post('ALERT', { text: String(msg == null ? '' : msg) });
    return origAlert.call(this, msg);
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
    if (d.cmd === 'RESET_CLICK') {
      // 網站用 isClick 當送出中旗標；失敗後偶爾沒還原會卡住，這裡只還原旗標
      try { if (typeof window.isClick !== 'undefined') window.isClick = false; } catch (e) {}
    }
  });
})();
