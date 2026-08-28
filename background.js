// 背景服務：只負責發送桌面通知。
// content script 不能直接呼叫 chrome.notifications，必須經由這裡轉送。
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'NOTIFY') return;
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title: String(msg.title || '寬宏售票監控'),
      message: String(msg.body || ''),
      priority: 2,
      requireInteraction: true,   // 不自動消失，回到電腦前仍看得到
    });
  } catch (e) {
    // 通知失敗不影響監控本身
  }
});
