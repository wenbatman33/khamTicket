#!/usr/bin/env bash
# 寬宏搶票：兩個帳號 × 兩個場次 = 四個視窗
#
#   scripts/launch.sh setup   首次使用：開兩個 profile 的視窗，讓你分別登入兩個帳號、設定擴充功能
#   scripts/launch.sh go      開賣日：兩個視窗左右並排（帳號 A → 2/27、帳號 B → 2/28）
#   scripts/launch.sh go 4    備用：四個視窗 2×2（兩個帳號各開兩天）
#   scripts/launch.sh stop    關掉這支腳本開的所有瀏覽器
#
# 設計：
#   - 一個帳號一個 profile（cookie 完全隔離），同一 profile 開兩個視窗搶兩天。
#     不用四個 profile，是因為同帳號在兩個 profile 同時登入有被互踢的風險；
#     同 profile 開兩個視窗搶不同場次，實測過互不干擾。
#   - 四個視窗平鋪不重疊：被蓋住的視窗會被瀏覽器節流，開賣瞬間會慢。
#   - Chromium 可用 --load-extension 直接載入；Google Chrome 137 起正式版不吃這個參數，
#     改為每個 profile 在 chrome://extensions 手動「載入未封裝項目」一次，之後永久記住。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"          # 擴充功能所在目錄（repo 根）
PROFILE_ROOT="${KHAM_PROFILE_ROOT:-$HOME/kham_profiles}"
ACCOUNTS=(A B)                                                   # 兩個帳號的 profile 名稱

URL_0227="https://kham.com.tw/application/UTK02/UTK0201_.aspx?PRODUCT_ID=P1EMCIC6"
URL_0228="https://kham.com.tw/application/UTK02/UTK0201_.aspx?PRODUCT_ID=P1EVUYWG"
HOME_URL="https://kham.com.tw/"
EXT_URL="chrome://extensions"

DRY_RUN="${DRY_RUN:-0}"

say()  { printf '\033[1;31m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }

# ── 找瀏覽器：Chromium 優先 ─────────────────────────────────────
find_browser() {
  local c
  for c in \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$HOME/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

BROWSER="${KHAM_BROWSER:-$(find_browser || true)}"
[ -n "$BROWSER" ] || { warn "找不到 Chromium 或 Chrome。可用 brew 安裝：brew install --cask chromium"; exit 1; }

case "$BROWSER" in
  *Chromium*|*Canary*|*Dev*) LOAD_EXT=1 ;;   # 這幾種吃 --load-extension
  *)                          LOAD_EXT=0 ;;   # 正式版 Chrome 137+ 不吃，要手動載一次
esac

# ── 螢幕大小，算 2×2 平鋪 ───────────────────────────────────────
read -r SW SH < <(osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null \
                  | awk -F', *' '{print $3, $4}' || echo "1920 1080")
: "${SW:=1920}" "${SH:=1080}"
MENUBAR=25
W=$(( SW / 2 )); H=$(( (SH - MENUBAR) / 2 ))
# 四個格子：左上、右上、左下、右下
POS=( "0,$MENUBAR" "$W,$MENUBAR" "0,$(( MENUBAR + H ))" "$W,$(( MENUBAR + H ))" )

# ── 啟動 ────────────────────────────────────────────────────────
launch() {   # launch <profile> <url> <x,y> <w> <h>  → 印出瀏覽器主程序 PID（已在跑則印 0）
  local profile="$1" url="$2" pos="$3" w="$4" h="$5"
  local dir="$PROFILE_ROOT/$profile"
  mkdir -p "$dir"
  local args=(
    "--user-data-dir=$dir"
    --no-first-run --no-default-browser-check --disable-session-crashed-bubble
    --disable-features=TranslateUI,SidePanelPinning,ChromeWhatsNewUI     # 少幾個會冒出來的提示
    "--window-position=$pos" "--window-size=$w,$h"
    --new-window "$url"
  )
  [ "$LOAD_EXT" = 1 ] && args=("--load-extension=$HERE" "${args[@]}")
  if [ "$DRY_RUN" = 1 ]; then
    { printf '  [dry-run] %q' "$BROWSER"; printf ' %q' "${args[@]}"; echo; } >&2
    echo 0; return
  fi
  # 同一 profile 已經在跑的話，這次啟動只是把網址交給既有程序，PID 會很快結束
  "$BROWSER" "${args[@]}" >/dev/null 2>&1 &
  echo $!
}

# 用 System Events 依 PID 把該程序的視窗排好（需要「輔助使用」權限；沒權限就略過）
tile() {   # tile <pid> <win_index> <x> <y> <w> <h>
  local pid="$1" idx="$2" x="$3" y="$4" w="$5" h="$6"
  [ "$DRY_RUN" = 1 ] && return 0
  osascript >/dev/null 2>&1 <<EOF || return 1
tell application "System Events"
  set p to first process whose unix id is $pid
  tell window $idx of p
    set position to {$x, $y}
    set size to {$w, $h}
  end tell
end tell
EOF
}

wait_windows() {   # wait_windows <pid> <count> 最多等 15 秒
  local pid="$1" n="$2" i
  [ "$DRY_RUN" = 1 ] && return 0
  for i in $(seq 1 30); do
    local c
    c=$(osascript -e "tell application \"System Events\" to count windows of (first process whose unix id is $pid)" 2>/dev/null || echo 0)
    [ "${c:-0}" -ge "$n" ] && return 0
    sleep 0.5
  done
  return 1
}

cmd_setup() {
  say "首次設定：兩個 profile 各開一個視窗，左＝帳號 ${ACCOUNTS[0]}、右＝帳號 ${ACCOUNTS[1]}"
  local i=0 pid
  for acct in "${ACCOUNTS[@]}"; do
    pid=$(launch "$acct" "$HOME_URL" "${POS[$i]}" "$W" "$(( SH - MENUBAR ))")
    if [ "$LOAD_EXT" = 0 ]; then
      sleep 2
      launch "$acct" "$EXT_URL" "${POS[$i]}" "$W" "$(( SH - MENUBAR ))" >/dev/null
    fi
    i=$(( i + 1 ))
  done
  echo
  say "接下來在每個視窗裡各做一次："
  echo "   1. 登入該帳號（左邊登 A、右邊登 B）—— 帳密請自己輸入，腳本與擴充功能都不碰"
  if [ "$LOAD_EXT" = 0 ]; then
    echo "   2. chrome://extensions 分頁：右上角開「開發人員模式」→「載入未封裝項目」→ 選"
    echo "      $HERE"
    echo "      （Google Chrome 正式版不吃 --load-extension，這步每個 profile 只要做一次）"
  else
    echo "   2. 擴充功能已自動載入（Chromium）"
  fi
  echo "   3. 點工具列 🎫 圖示設定：優先購序號（兩個帳號各自的）、每次買幾張、開搶時間、票區優先順序"
  echo "   4. 兩邊都弄好後關掉視窗，開賣日執行：  $0 go"
  echo
  echo "   profile 位置：$PROFILE_ROOT/{${ACCOUNTS[0]},${ACCOUNTS[1]}}（登入與設定都存在裡面，之後不用再弄）"
}

# 預設：兩個視窗左右並排，一個帳號負責一天，畫面乾淨、驗證碼一左一右
cmd_go2() {
  say "開賣模式：左＝帳號 ${ACCOUNTS[0]} → 2/27，右＝帳號 ${ACCOUNTS[1]} → 2/28"
  [ "$LOAD_EXT" = 0 ] && warn "用的是 Google Chrome：請確認兩個 profile 都已在 chrome://extensions 載入過擴充功能（沒有的話先跑 setup）"
  local FULL=$(( SH - MENUBAR ))
  launch "${ACCOUNTS[0]}" "$URL_0227" "0,$MENUBAR"  "$W" "$FULL" >/dev/null
  launch "${ACCOUNTS[1]}" "$URL_0228" "$W,$MENUBAR" "$W" "$FULL" >/dev/null
  echo
  say "兩個視窗都開了。開賣前請確認："
  echo "   • 兩邊都停在節目頁、擴充功能面板顯示「等待開賣」倒數"
  echo "   • 兩個視窗各佔半個螢幕、不重疊"
  echo "   • 序號一組限 2 張，「每次買幾張」設 2"
  echo "   • 同帳號想兩天都買再用：  $0 go 4"
}

cmd_go() {
  say "開賣模式：四個視窗 2×2（上排帳號 ${ACCOUNTS[0]}、下排帳號 ${ACCOUNTS[1]}；左 2/27、右 2/28）"
  [ "$LOAD_EXT" = 0 ] && warn "用的是 Google Chrome：請確認兩個 profile 都已在 chrome://extensions 載入過擴充功能（沒有的話先跑 setup）"
  local row=0 pid
  for acct in "${ACCOUNTS[@]}"; do
    local left="${POS[$(( row * 2 ))]}" right="${POS[$(( row * 2 + 1 ))]}"
    pid=$(launch "$acct" "$URL_0227" "$left" "$W" "$H")
    sleep 2.5                                          # 等主程序起來，第二個視窗才會開在同一 profile
    launch "$acct" "$URL_0228" "$right" "$W" "$H" >/dev/null
    if [ "$DRY_RUN" != 1 ]; then
      if wait_windows "$pid" 2; then
        # 第二個視窗是靠既有程序開的，命令列位置參數不會生效，這裡補排；window 1 是最新開的
        tile "$pid" 1 "${right%,*}" "${right#*,}" "$W" "$H" || warn "無法自動排列視窗（系統設定 → 隱私權與安全性 → 輔助使用，允許終端機），請手動拖一下"
        tile "$pid" 2 "${left%,*}"  "${left#*,}"  "$W" "$H" || true
      else
        warn "帳號 $acct 的第二個視窗沒等到，請看一下是不是開在同一個視窗的分頁裡"
      fi
    fi
    row=$(( row + 1 ))
  done
  echo
  say "四個視窗都開了。開賣前請確認："
  echo "   • 每個視窗都停在節目頁、擴充功能面板顯示「等待開賣」倒數"
  echo "   • 四個視窗互不遮蔽（被蓋住的分頁會被瀏覽器節流）"
  echo "   • 同一帳號兩個視窗共用設定；「有分頁搶到後其他分頁停手」預設開 —— 若想同一帳號兩天都搶，到面板把它關掉"
  echo "   • 序號一組限 2 張，「每次買幾張」設 2"
}

cmd_stop() {
  say "關閉由 $PROFILE_ROOT 啟動的瀏覽器"
  pkill -f -- "--user-data-dir=$PROFILE_ROOT/" 2>/dev/null || echo "   （沒有在跑的）"
}

case "${1:-go}" in
  setup) cmd_setup ;;
  go)    if [ "${2:-2}" = 4 ]; then cmd_go; else cmd_go2; fi ;;
  stop)  cmd_stop ;;
  *)     echo "用法：$0 {setup|go|stop}"; exit 2 ;;
esac
