// popup 設定頁邏輯 —— 只管四件事會用到的設定

const DEFAULTS = {
  enabled: true,
  watch: false,
  presaleCode: '',
  autoSubmitPresale: true,
  count: 2,
  autoCheckout: true,
};

const ids = ['enabled', 'watch', 'presaleCode', 'autoSubmitPresale', 'count', 'autoCheckout'];
const els = {};
ids.concat(['masterBox', 'masterState', 'save', 'run', 'status', 'watchBox', 'watchState']).forEach((k) => {
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
  els.watch.checked = !!s.watch;
  renderMaster();
  els.presaleCode.value = s.presaleCode || '';
  els.autoSubmitPresale.checked = s.autoSubmitPresale !== false;
  els.count.value = String(parseInt(s.count, 10) || 2);
  els.autoCheckout.checked = s.autoCheckout !== false;
});

function collect() {
  const n = (el, d) => { const v = parseInt(el.value, 10); return Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    enabled: els.enabled.checked,
    watch: els.watch.checked,
    presaleCode: els.presaleCode.value.trim(),
    autoSubmitPresale: els.autoSubmitPresale.checked,
    count: Math.max(1, n(els.count, 2)),
    autoCheckout: els.autoCheckout.checked,
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

// ---- 監票：勾著就在每個票區頁自動每秒按「更新票數」，有票就點進去；F5 也不停 ----
async function activeKhamTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.url && tab.url.includes('kham.com.tw') ? tab : null;
}

function renderWatch(st) {
  const on = els.watch.checked;
  els.watchBox.style.background = on ? '#e9e0ff' : '#f3efff';
  if (st === null) { els.watchState.textContent = on ? '已勾選：開到票區頁就自動監票' : '勾了之後，開到票區頁就自動監票'; return; }
  if (st === undefined) { els.watchState.textContent = '⚠️ 這個分頁跑的是舊版：chrome://extensions 按「重新載入」，再把網頁 F5'; return; }
  if (!st.here) { els.watchState.textContent = on ? '已勾選：這一頁不是票區頁，到了票區頁會自動開始' : '這一頁不是票區頁（沒有「更新票數」按鈕）'; return; }
  els.watchState.textContent = st.entered ? '已替你點進票區，去打驗證碼；撲空會自動回來繼續監'
    : st.on ? '監票中｜已更新 ' + st.clicks + ' 次｜空位夠就替你點那一區'
    : (on ? '待命中' : '勾選就開始盯這一頁的票');
}

async function refreshWatch() {
  const tab = await activeKhamTab();
  if (!tab) { renderWatch(null); return; }
  try { renderWatch(await chrome.tabs.sendMessage(tab.id, { type: 'WATCH_STATE' })); }
  catch (e) { renderWatch(undefined); }
}

// 勾選立刻存檔並通知目前分頁，不必按儲存
els.watch.addEventListener('change', async () => {
  await chrome.storage.sync.set({ watch: els.watch.checked });
  const tab = await activeKhamTab();
  if (tab) { try { await chrome.tabs.sendMessage(tab.id, { type: 'WATCH_TOGGLE', on: els.watch.checked }); } catch (e) {} }
  refreshWatch();
});

refreshWatch();
setInterval(refreshWatch, 1000);
