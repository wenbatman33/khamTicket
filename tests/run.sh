#!/bin/bash
# 行為測試：用 headless Chrome 載入「跟真實網站同構的 DOM」，再載入真正的 content.js，
# 檢查它到底做了什麼。用法：bash tests/run.sh
CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
DIR="$(cd "$(dirname "$0")" && pwd)"
fail=0
run() {
  printf '%-18s ' "$1"
  out=$("$CHROME" --headless=new --disable-gpu --allow-file-access-from-files \
        --virtual-time-budget=12000 --dump-dom "file://$DIR/$1.html" 2>/dev/null)
  # 這一項會真的導頁（有票就跳購票網址），所以用最終文件裡的網址判斷，不看 RESULT
  if [ "$1" = watch_buyurl ]; then
    if echo "$out" | grep -q 'UTK0201_001.aspx?PERFORMANCE_ID=P1FE10V3&GROUP_ID=24&PERFORMANCE_PRICE_AREA_ID=P1FEAAA1'; then
      echo "PASS（跳到 UTK0201_001，GROUP_ID 與票區 ID 都正確）"
    else echo "FAIL（沒跳或網址不對）"; fail=1; fi
    return
  fi
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
run captcha_untouched # 驗證碼：值不被改、不自動送出、圖不換；只放大＋聚焦
run cart_checkout    # 購物車自動按「結帳」；付款與送出訂單絕不能碰
run master_off       # 總開關關掉：完全不動作（不關視窗、不填、不送）
run watch_refresh    # 監票：每秒按「更新票數」，某區售完→有票就點那一區並停止監票
run watch_persist    # 監票是勾選：設定裡勾著，F5 之後不按任何鈕也要自動繼續
run watch_buyurl     # 有票時直接組出購票網址跳過去（不靠網站 handler）
run watch_stops_on_buypage # 進到購票頁：監票自動關閉、不再按更新；張數照填、驗證碼照聚焦
run watch_retry      # 點進去後網站毫無回應：2.5 秒沒到張數頁就自動繼續監；handler 綁在 td 也點得到
run alert_soldout    # 原生 alert 接掉不擋頁；監票點進去撲空（已售完）要自動繼續監票
run no_navigation    # 同一頁有訂購鈕與票區表時：只填該填的，絕不點、絕不換頁
echo "---"
[ $fail = 0 ] && echo "全部通過" || echo "有失敗項目"
exit $fail
