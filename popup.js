// popup 設定頁邏輯 —— 只管四件事會用到的設定

const DEFAULTS = {
  enabled: true,
  presaleCode: '',
  autoSubmitPresale: true,
  count: 2,
  acceptNonAdjacent: true,
  allowFewer: false,
  autoSubmitCaptcha: true,
};

const ids = ['enabled', 'presaleCode', 'autoSubmitPresale', 'count',
  'acceptNonAdjacent', 'allowFewer', 'autoSubmitCaptcha'];
const els = {};
ids.concat(['masterBox', 'masterState', 'save', 'run', 'status']).forEach((k) => {
  els[k] = document.getElementById(k);
});

function renderMaster() {
  const on = els.enabled.checked;
  els.masterBox.classList.toggle('on', on);
  els.masterState.textContent = on
    ? '序號填好會自動送出；驗證碼輸滿會自動按「加入購物車」。填寫一律照做。'
    : '只填不送：序號、張數照樣填好，送出的動作交給你自己按。';
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  els.enabled.checked = s.enabled !== false;
  els.presaleCode.value = s.presaleCode || '';
  els.autoSubmitPresale.checked = s.autoSubmitPresale !== false;
  els.count.value = String(parseInt(s.count, 10) || 2);
  els.acceptNonAdjacent.checked = !!s.acceptNonAdjacent;
  els.allowFewer.checked = !!s.allowFewer;
  els.autoSubmitCaptcha.checked = s.autoSubmitCaptcha !== false;
  renderMaster();
});

function collect() {
  const n = (el, d) => { const v = parseInt(el.value, 10); return Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    enabled: els.enabled.checked,
    presaleCode: els.presaleCode.value.trim(),
    autoSubmitPresale: els.autoSubmitPresale.checked,
    count: Math.max(1, n(els.count, 2)),
    acceptNonAdjacent: els.acceptNonAdjacent.checked,
    allowFewer: els.allowFewer.checked,
    autoSubmitCaptcha: els.autoSubmitCaptcha.checked,
  };
}

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { els.status.textContent = ''; }, 2500);
}

// 主開關立刻存檔：搶票當下要能馬上停手，不必再按儲存
els.enabled.addEventListener('change', async () => {
  renderMaster();
  await chrome.storage.sync.set(collect());
  flash(els.enabled.checked ? '✅ 自動送出已開啟' : '⏸ 只填不送');
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
