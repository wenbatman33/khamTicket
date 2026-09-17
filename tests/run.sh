#!/bin/bash
# 用 headless Chrome 跑擴充功能的行為測試。
# 每個測試頁都是「跟真實網站同構」的 DOM，載入真正的 content.js，再檢查它做了什麼。
# 用法：bash tests/run.sh
CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
DIR="$(cd "$(dirname "$0")" && pwd)"
fail=0
run() {
  printf '%-22s ' "$1"
  out=$("$CHROME" --headless=new --disable-gpu --allow-file-access-from-files \
        --virtual-time-budget=9000 --dump-dom "file://$DIR/$1.html" 2>/dev/null)
  case "$1" in
    direct_jump)
      # 開賣時間到 → 不經節目頁／場次頁，直接跳第一個票區頁網址
      if echo "$out" | grep -q 'PERFORMANCE_ID=P1FDECMD'; then echo "PASS（直達第一個目標）";
      else echo "FAIL（沒有直達）"; fail=1; fi ;;
    perf_real_vip)
      # 真實 HTML：票價 9430 是優先購列（VipSellCheck），要按網站的鈕而不是自己組網址
      if echo "$out" | grep -q 'VIP=P1FHHBJX'; then echo "PASS（優先購列按網站的鈕）";
      else echo "FAIL（$(echo "$out" | grep -o '<div id="RESULT">[^<]*' | sed 's/.*>//')）"; fail=1; fi ;;
    perf_real_link)
      # 真實 HTML：票價 8880 是一般訂購列（doLink），要直接跳它的網址
      got=$(echo "$out" | grep -o 'PERFORMANCE_ID=P1FHLMTF' | head -1)
      if [ -n "$got" ]; then echo "PASS（一般列直接跳 P1FHLMTF）";
      else echo "FAIL（沒跳到 P1FHLMTF）"; fail=1; fi ;;
    perf_allsoldout)
      # 全部完售：不可以導航。還留在原頁面（RESULT 還在）就是沒進去。
      if echo "$out" | grep -q 'id="RESULT"'; then echo "PASS（全部完售，留在原地監控）";
      else echo "FAIL（完售還是自己進去了）"; fail=1; fi ;;
    area_pick)
      # 這個測試也會導航離開，看最終網址挑到哪一區（1004 空位最多）
      got=$(echo "$out" | grep -o 'PERFORMANCE_PRICE_AREA_ID=[0-9]*' | sort -u | head -1)
      if [ "$got" = "PERFORMANCE_PRICE_AREA_ID=1004" ]; then echo "PASS（挑了空位最多的有票區）";
      else echo "FAIL（挑到 ${got:-none}，應為 1004）"; fail=1; fi ;;
    perf_pick)
      # 這個測試會真的導航離開，用最終文件裡的 PERFORMANCE_ID 判斷去了哪一場
      # 有票就一定要離開本頁（RESULT 不見了），且目的地是 A2
      got=$(echo "$out" | grep -o 'PERFORMANCE_ID=A[0-9]' | sort -u | head -1)
      if [ "$got" = "PERFORMANCE_ID=A2" ] && ! echo "$out" | grep -q 'id="RESULT"'; then echo "PASS（只進有票的 8880）";
      else echo "FAIL（去了 ${got:-none}，應為 A2=8880）"; fail=1; fi ;;
    *)
      line=$(echo "$out" | grep -o '<div id="RESULT">[^<]*' | sed 's/<div id="RESULT">//')
      echo "$line"
      echo "$line" | grep -q FAIL && fail=1 ;;
  esac
}
run presale_box       # 燈箱出現 → 填序號 → 按送出；認證中不亂點訂購鈕
run presale_wrapper   # 送出鈕被空殼 div 包住時，要點到裡面真正可點的那顆
run presale_reopen    # 燈箱關掉再開（同一個 input 被清空）→ 要再填一次並再送出
run perf_pick         # 場次頁：只點沒有刪除線（有票）的那一列
run direct_jump       # 開賣瞬間直接跳票區頁，跳過節目頁與場次頁
run perf_real_vip     # 真實 HTML：優先購列要按網站的鈕（刪除線不得誤判成完售）
run perf_real_link    # 真實 HTML：一般列要直接跳它的訂購網址
run perf_allsoldout   # 全部完售時不可以自己點進去
run area_pick         # 票區頁：跳過已售完，挑有票且空位最多的區進去
echo "---"
[ $fail = 0 ] && echo "全部通過" || echo "有失敗項目"
exit $fail
