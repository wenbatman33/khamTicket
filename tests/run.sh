#!/bin/bash
# 行為測試：用 headless Chrome 載入「跟真實網站同構的 DOM」，再載入真正的 content.js，
# 檢查它到底做了什麼。用法：bash tests/run.sh
CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
DIR="$(cd "$(dirname "$0")" && pwd)"
fail=0
run() {
  printf '%-18s ' "$1"
  out=$("$CHROME" --headless=new --disable-gpu --allow-file-access-from-files \
        --virtual-time-budget=9000 --dump-dom "file://$DIR/$1.html" 2>/dev/null)
  line=$(echo "$out" | grep -o '<div id="RESULT">[^<]*' | sed 's/<div id="RESULT">//')
  echo "${line:-（沒有結果：頁面可能被導走了）}"
  echo "$line" | grep -q FAIL && fail=1
  [ -z "$line" ] && fail=1
}
run notice_ok        # 訊息視窗自動按 Ok；錯誤訊息不可以幫忙關掉
run presale_box      # 序號欄位出現 → 填入 → 按送出
run presale_wrapper  # 送出鈕被空殼 div 包住時，要點到裡面真正可點的那一顆
run presale_card     # 中信卡友「卡號前6碼」要填；結帳頁的信用卡號絕不能碰
run presale_handsoff # 你一碰鍵盤，工具就不再填、不再送那個欄位
run presale_reopen   # 燈箱關掉再開（同一個 input 被清空）→ 要再填一次並再送出
run qty_fill         # 主開關關著也要填張數，但不可以送出
run captcha_ime      # 忘了切輸入法：全形轉半形、中文濾掉、正常英數不動
run master_off       # 總開關關掉：完全不動作（不關視窗、不填、不送）
run no_navigation    # 同一頁有訂購鈕與票區表時：只填該填的，絕不點、絕不換頁
echo "---"
[ $fail = 0 ] && echo "全部通過" || echo "有失敗項目"
exit $fail
