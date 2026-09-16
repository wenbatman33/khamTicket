// popup 設定頁邏輯

const DEFAULTS = {
  enabled: false,
  startAt: '',
  refreshMs: 800,
  perfKeyword: '',
  presaleCode: '',
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

const ids = ['enabled', 'startAt', 'refreshMs', 'perfKeyword', 'presaleCode', 'targets', 'count', 'ticketType',
  'acceptNonAdjacent', 'allowFewer', 'captchaLen', 'autoSubmitCaptcha', 'autoCheckout',
  'pauseOthersOnWin'];
const els = {};
ids.concat(['masterBox', 'masterState', 'save', 'run', 'status',
  'wonBox', 'wonInfo', 'clearWon',
  'logStat', 'expJson', 'expStock', 'expReq', 'expSnap', 'clearLog']).forEach((k) => {
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
  els.presaleCode.value = s.presaleCode || '';
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
    presaleCode: els.presaleCode.value.trim(),
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


// ---------------------------------------------------------------- 搶票紀錄
// 每個分頁寫自己的 log_<token>，匯出時合併並依時間排序
async function collectLogs() {
  const all = await chrome.storage.local.get(null);
  const rows = [];
  Object.keys(all).filter((k) => k.indexOf('log_') === 0).forEach((k) => {
    const b = all[k] || {};
    (b.rows || []).forEach((r) => rows.push(Object.assign({ tab: b.tab || k }, r)));
  });
  rows.sort((a, b) => (a.t || 0) - (b.t || 0));
  return rows;
}

const ts = (n) => {
  const d = new Date(n);
  const p2 = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' '
    + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
};

async function renderLogStat() {
  const rows = await collectLogs();
  if (!rows.length) { els.logStat.textContent = '目前沒有紀錄。開始搶票後會自動記錄。'; return; }
  const stock = rows.filter((r) => r.type === 'stock').length;
  const req = rows.filter((r) => r.type === 'xhr').length;
  els.logStat.textContent = '共 ' + rows.length + ' 筆（票源快照 ' + stock + '、購票請求 ' + req + '）\n'
    + ts(rows[0].t) + ' ～ ' + ts(rows[rows.length - 1].t);
}
renderLogStat();

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const stamp = () => ts(Date.now()).replace(/[-: ]/g, '').slice(0, 15);
const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
const toCsv = (head, lines) => '\uFEFF' + [head.map(csvCell).join(',')].concat(lines.map((r) => r.map(csvCell).join(','))).join('\r\n');

els.expJson.addEventListener('click', async () => {
  const rows = await collectLogs();
  if (!rows.length) return flash('⚠️ 目前沒有紀錄');
  download('kham_log_' + stamp() + '.json', JSON.stringify(rows, null, 1), 'application/json');
  flash('📥 已匯出 ' + rows.length + ' 筆');
});

// 票源變化：每個票區展開成一列
els.expStock.addEventListener('click', async () => {
  const rows = (await collectLogs()).filter((r) => r.type === 'stock');
  if (!rows.length) return flash('⚠️ 沒有票源紀錄');
  // 票區名稱記在 areas 事件裡，這裡建對照表把名稱補回每一列
  const all = await collectLogs();
  const nameOf = {};
  all.filter((r) => r.type === 'areas').forEach((r) => {
    (r.list || []).forEach((a) => { nameOf[a.id] = { name: a.name, price: a.price }; });
  });
  const lines = [];
  rows.forEach((r) => {
    const pairs = r.s || (r.rows || []).map((a) => [a.id, a.n == null ? a.left : a.n]);
    pairs.forEach((pair) => {
      const id = pair[0], v = pair[1];
      const meta = nameOf[id] || {};
      lines.push([ts(r.t), r.tab, r.perf || '', r.scan || '', r.status || '',
        id, meta.name || '', meta.price || '',
        v, typeof v === 'number' ? v : '']);
    });
  });
  download('kham_stock_' + stamp() + '.csv',
    toCsv(['時間', '分頁', '場次ID', '第幾次掃描', '場次狀態', '票區ID', '票區名稱', '票價', '餘位', '餘位(數字)'], lines),
    'text/csv;charset=utf-8');
  flash('📊 已匯出 ' + lines.length + ' 列');
});

// 購票請求：送出參數與伺服器回應
els.expReq.addEventListener('click', async () => {
  const rows = (await collectLogs()).filter((r) => ['xhr', 'submit', 'pick', 'fill', 'fill_fail', 'alert', 'won', 'lost', 'nav', 'error'].indexOf(r.type) >= 0);
  if (!rows.length) return flash('⚠️ 沒有請求紀錄');
  const lines = rows.map((r) => [
    ts(r.t), r.tab, r.type, r.page || '',
    r.action || r.reason || r.name || r.msg || r.text || r.title || '',
    r.status == null ? '' : r.status,
    r.ms == null ? '' : r.ms,
    r.url || r.go || '',
    r.sent || (r.amounts ? JSON.stringify(r.amounts) : ''),
    r.resp || '',
  ]);
  download('kham_requests_' + stamp() + '.csv',
    toCsv(['時間', '分頁', '事件', '頁面', '動作/內容', 'HTTP狀態', '耗時ms', '網址', '送出參數(帳密已遮蔽)', '伺服器回應'], lines),
    'text/csv;charset=utf-8');
  flash('📋 已匯出 ' + lines.length + ' 列');
});

els.clearLog.addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.indexOf('log_') === 0 || k.indexOf('snap_') === 0);
  if (!keys.length) return flash('⚠️ 目前沒有紀錄');
  await chrome.storage.local.remove(keys);
  renderLogStat();
  flash('🗑 已清除 ' + keys.length + ' 個分頁的紀錄');
});


// 頁面快照：所有分頁合併成一個可直接開的 HTML（每頁一段，附索引）
els.expSnap.addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const items = [];
  Object.keys(all).filter((k) => k.indexOf('snap_') === 0).forEach((k) => {
    ((all[k] || {}).items || []).forEach((it) => items.push(Object.assign({ tab: (all[k] || {}).tab || k }, it)));
  });
  if (!items.length) return flash('⚠️ 沒有頁面快照');
  items.sort((a, b) => a.t - b.t);
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const idx = items.map((it, i) => '<li><a href="#s' + i + '">' + esc(ts(it.t)) + ' [' + esc(it.page) + '/' + esc(it.label) + '] ' + esc(it.url) + '</a> (' + it.len + 'B)</li>').join('');
  const body = items.map((it, i) => '<section id="s' + i + '"><h2>' + esc(ts(it.t)) + ' · ' + esc(it.page) + ' · ' + esc(it.label) + '</h2><div><code>' + esc(it.url) + '</code> · 分頁 ' + esc(it.tab) + '</div><textarea readonly style="width:100%;height:320px;font:11px/1.4 monospace">' + esc(it.html) + '</textarea></section>').join('');
  const doc = '<!doctype html><meta charset="utf-8"><title>kham 頁面快照</title><style>body{font:14px system-ui;margin:20px}section{margin:24px 0;border-top:1px solid #ddd;padding-top:12px}</style>'
    + '<h1>寬宏搶票 頁面快照（' + items.length + ' 頁，個資已遮蔽）</h1><ol>' + idx + '</ol>' + body;
  download('kham_snapshots_' + stamp() + '.html', doc, 'text/html;charset=utf-8');
  flash('📄 已匯出 ' + items.length + ' 頁');
});
