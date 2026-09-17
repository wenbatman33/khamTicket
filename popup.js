// popup 設定頁邏輯 —— 只管四件事會用到的設定

const DEFAULTS = {
  enabled: true,
  presaleCode: '',
  autoSubmitPresale: true,
  count: 2,
};

const ids = ['enabled', 'presaleCode', 'autoSubmitPresale', 'count'];
const els = {};
ids.concat(['masterBox', 'masterState', 'save', 'run', 'status']).forEach((k) => {
  els[k] = document.getElementById(k);
});

function renderMaster() {
  const on = els.enabled.checked;
  els.masterBox.classList.toggle('on', on);
  els.masterState.textContent = on
    ? '看到訊息視窗、序號欄位、張數欄位、驗證碼就會幫你處理。'
    : '完全停止：什麼都不做，全部由你自己操作。';
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  els.enabled.checked = s.enabled !== false;
  renderMaster();
  els.presaleCode.value = s.presaleCode || '';
  els.autoSubmitPresale.checked = s.autoSubmitPresale !== false;
  els.count.value = String(parseInt(s.count, 10) || 2);
});

function collect() {
  const n = (el, d) => { const v = parseInt(el.value, 10); return Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    enabled: els.enabled.checked,
    presaleCode: els.presaleCode.value.trim(),
    autoSubmitPresale: els.autoSubmitPresale.checked,
    count: Math.max(1, n(els.count, 2)),
  };
}

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { els.status.textContent = ''; }, 2500);
}

els.enabled.addEventListener('change', async () => {
  renderMaster();
  await chrome.storage.sync.set(collect());
  flash(els.enabled.checked ? '✅ 已啟用' : '⏸ 已全部停止');
});

els.save.addEventListener('click', async () => {
  await chrome.storage.sync.set(collect());
  flash('✅ 已儲存（每次填 ' + collect().count + ' 張）');
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
    flash('▶ 已在目前分頁填一次');
  } catch (e) {
    flash('⚠️ 這個分頁還沒載入擴充功能，請重整頁面');
  }
});
