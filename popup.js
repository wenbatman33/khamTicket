// popup 設定頁邏輯

const DEFAULTS = {
  enabled: false,
  startAt: '',
  refreshMs: 800,
  perfKeyword: '',
  targets: '',
  count: 2,
  ticketType: '',
  acceptNonAdjacent: true,
  allowFewer: false,
  captchaLen: 4,
  autoSubmitCaptcha: true,
  autoCheckout: false,
  pauseOthersOnWin: true,
};

const ids = ['enabled', 'startAt', 'refreshMs', 'perfKeyword', 'targets', 'count', 'ticketType',
  'acceptNonAdjacent', 'allowFewer', 'captchaLen', 'autoSubmitCaptcha', 'autoCheckout',
  'pauseOthersOnWin'];
const els = {};
ids.concat(['masterBox', 'masterState', 'save', 'run', 'status',
  'wonBox', 'wonInfo', 'clearWon']).forEach((k) => {
  els[k] = document.getElementById(k);
});

function renderMaster() {
  const on = els.enabled.checked;
  els.masterBox.classList.toggle('on', on);
  const t = els.startAt.value.trim();
  els.masterState.textContent = !on
    ? '已關閉：不會自動動作。可按「立即執行」查一次票區／填一次表單，不送出。'
    : (t ? t + ' 一到就開始：節目頁按「立即購票」→ 選場次 → 查票 → 填好表單，等你打驗證碼。'
         : '進頁面就開始：節目頁按「立即購票」→ 選場次 → 查票 → 填好表單，等你打驗證碼。');
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  els.enabled.checked = !!s.enabled;
  els.startAt.value = s.startAt || '';
  els.refreshMs.value = String(parseInt(s.refreshMs, 10) || 800);
  els.perfKeyword.value = s.perfKeyword || '';
  els.targets.value = s.targets || '';
  els.count.value = String(parseInt(s.count, 10) || 2);
  els.ticketType.value = s.ticketType || '';
  els.acceptNonAdjacent.checked = !!s.acceptNonAdjacent;
  els.allowFewer.checked = !!s.allowFewer;
  els.captchaLen.value = String(parseInt(s.captchaLen, 10) || 4);
  els.autoSubmitCaptcha.checked = !!s.autoSubmitCaptcha;
  els.autoCheckout.checked = !!s.autoCheckout;
  els.pauseOthersOnWin.checked = !!s.pauseOthersOnWin;
  renderMaster();
});

// 有分頁搶到時顯示狀態與解除按鈕（10 分鐘後視同過期）
function renderWon() {
  chrome.storage.local.get({ won: null }).then((r) => {
    const w = r && r.won;
    const fresh = w && Date.now() - (w.at || 0) < 10 * 60 * 1000;
    els.wonBox.style.display = fresh ? 'block' : 'none';
    if (fresh) {
      const t = new Date(w.at).toLocaleTimeString();
      els.wonInfo.textContent = '（' + t + (w.info ? '｜' + String(w.info).slice(0, 30) : '') + '）';
    }
  });
}
renderWon();

els.clearWon.addEventListener('click', async () => {
  await chrome.storage.local.remove('won');
  renderWon();
  flash('▶ 已解除暫停，其他分頁會繼續搶');
});

els.startAt.addEventListener('input', renderMaster);

// 主開關立刻存檔：搶票當下要能馬上停手，不必再按儲存
els.enabled.addEventListener('change', async () => {
  renderMaster();
  await chrome.storage.sync.set(collect());
  flash(els.enabled.checked ? '✅ 自動搶票已開啟' : '⏸ 自動搶票已關閉');
});

function collect() {
  const n = (el, d) => { const v = parseInt(el.value, 10); return Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    enabled: els.enabled.checked,
    startAt: els.startAt.value.trim().replace(/：/g, ':').replace(/\s/g, ''),
    refreshMs: n(els.refreshMs, 800),
    perfKeyword: els.perfKeyword.value.trim(),
    targets: els.targets.value.trim(),
    count: Math.max(1, n(els.count, 2)),
    ticketType: els.ticketType.value.trim(),
    acceptNonAdjacent: els.acceptNonAdjacent.checked,
    allowFewer: els.allowFewer.checked,
    captchaLen: Math.max(1, n(els.captchaLen, 4)),
    autoSubmitCaptcha: els.autoSubmitCaptcha.checked,
    autoCheckout: els.autoCheckout.checked,
    pauseOthersOnWin: els.pauseOthersOnWin.checked,
  };
}

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { els.status.textContent = ''; }, 2500);
}

els.save.addEventListener('click', async () => {
  const data = collect();
  await chrome.storage.sync.set(data);
  const c = data.targets.split('\n').map((s) => s.trim()).filter(Boolean).length;
  flash(c ? '✅ 已儲存（' + c + ' 個票區，每次 ' + data.count + ' 張，間隔 ' + data.refreshMs + 'ms）'
          : '⚠️ 已儲存，但還沒填票區優先順序');
});

els.run.addEventListener('click', async () => {
  await chrome.storage.sync.set(collect());
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('kham.com.tw')) {
    flash('⚠️ 請先開啟寬宏售票頁面');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'RUN_NOW' });
    flash('▶ 已觸發執行');
  } catch (e) {
    flash('⚠️ 請重新整理頁面後再試');
  }
});
