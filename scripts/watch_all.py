#!/usr/bin/env python3
"""全區監票：每分鐘把每個票價的票區頁都看一遍，有票（身障／輪椅除外）就通知。

票區頁不需登入就讀得到「空位」欄，所以這支腳本不碰帳號、不下單、不碰驗證碼，只讀。

用法：
  python3 scripts/watch_all.py                 # 監預設兩場，每 60 秒
  python3 scripts/watch_all.py --open          # 有票時順便用瀏覽器開直達網址
  python3 scripts/watch_all.py --interval 30 P1EMCIC6

Telegram 通知（選用）：在專案根目錄 .env 加
  TELEGRAM_BOT_TOKEN=123456:ABC...
  TELEGRAM_CHAT_ID=123456789
  python3 scripts/watch_all.py --tg-chatid   # 先傳訊息給 bot，再跑這個查 chat id
  python3 scripts/watch_all.py --tg-test     # 發一則測試訊息
"""
import argparse
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

BASE = 'https://kham.com.tw/application/UTK02/'
DEFAULT_PRODUCTS = ['P1EMCIC6', 'P1EVUYWG']  # 2/27、2/28 BIGBANG 高雄
EXCLUDE = ('身障', '輪椅')                     # 票價名稱或票區名稱含這些字就跳過
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
LOG = Path(__file__).with_name('watch_all.log')
ENV = Path(__file__).resolve().parent.parent / '.env'


def load_env():
    """讀 .env（KEY=VALUE），不覆蓋已存在的環境變數。"""
    if not ENV.exists():
        return
    for line in ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def tg_api(method, **params):
    token = os.environ.get('TELEGRAM_BOT_TOKEN')
    if not token:
        raise RuntimeError('.env 沒有 TELEGRAM_BOT_TOKEN')
    data = urllib.parse.urlencode(params).encode() if params else None
    with urllib.request.urlopen(f'https://api.telegram.org/bot{token}/{method}', data=data, timeout=15) as r:
        return json.load(r)


def tg_send(msg):
    """沒設定就安靜略過；失敗只記 log，不中斷監票。"""
    chat = os.environ.get('TELEGRAM_CHAT_ID')
    if not (os.environ.get('TELEGRAM_BOT_TOKEN') and chat):
        return
    try:
        tg_api('sendMessage', chat_id=chat, text=msg, disable_web_page_preview='true')
    except Exception as e:
        log(f'⚠️ Telegram 發送失敗：{e}')


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'zh-TW'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode('utf-8', 'replace')


def text(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s))).strip()


def list_performances(product_id):
    """節目頁 → [(PERFORMANCE_ID, 票價名稱)]，依頁面順序、去重。"""
    s = fetch(f'{BASE}UTK0201_00.aspx?PRODUCT_ID={product_id}')
    title = text(re.search(r'<title>(.*?)</title>', s, re.S).group(1)) if '<title>' in s else ''
    out, seen = [], set()
    # 每一列：票價名稱在前、立即訂購連結在後，以 <tr> 切
    for tr in re.findall(r'<tr[^>]*>.*?</tr>', s, re.S):
        m = re.search(r'UTK0201_000\.aspx\?PERFORMANCE_ID=(\w+)', tr)
        if not m or m.group(1) in seen:
            continue
        seen.add(m.group(1))
        name = re.search(r'【([^】]+)】', text(tr))
        out.append((m.group(1), name.group(1) if name else m.group(1)))
    return out, title


def list_areas(perf_id, product_id):
    """票區頁 → [(票區名, 票價, 空位文字, 直達網址)]"""
    s = fetch(f'{BASE}UTK0201_000.aspx?PERFORMANCE_ID={perf_id}&PRODUCT_ID={product_id}')
    areas = []
    for m in re.finditer(r'<tr class="status_tr[^"]*"([^>]*)>(.*?)</tr>', s, re.S):
        attrs, body = m.group(1), m.group(2)
        area_id = re.search(r'id="(\w+)"', attrs)
        rel = re.search(r'rel="([^"]*)"', attrs)
        cells = [text(c) for c in re.findall(r'<td[^>]*>(.*?)</td>', body, re.S)]
        if len(cells) < 4:
            continue
        url = ''
        if area_id and rel and rel.group(1).split():
            url = (f'{BASE}UTK0201_001.aspx?PERFORMANCE_ID={perf_id}'
                   f'&GROUP_ID={rel.group(1).split()[0]}&PERFORMANCE_PRICE_AREA_ID={area_id.group(1)}')
        areas.append((cells[1], cells[2], cells[3], url))
    return areas


def notify(title, msg):
    msg = msg.replace('"', "'")
    subprocess.run(['osascript', '-e', f'display notification "{msg}" with title "{title}" sound name "Glass"'],
                   check=False)
    subprocess.Popen(['afplay', '/System/Library/Sounds/Hero.aiff'])


def log(line):
    stamp = datetime.now().strftime('%H:%M:%S')
    print(f'[{stamp}] {line}', flush=True)
    with LOG.open('a') as f:
        f.write(f'{datetime.now():%Y-%m-%d %H:%M:%S} {line}\n')


def one_round(products, auto_open, prev_open):
    found = 0
    checked = 0
    now_open = set()
    for pid in products:
        try:
            perfs, _ = list_performances(pid)
        except Exception as e:
            log(f'⚠️ {pid} 節目頁讀取失敗：{e}')
            continue
        for perf_id, price_name in perfs:
            if any(k in price_name for k in EXCLUDE):
                continue
            try:
                areas = list_areas(perf_id, pid)
            except Exception as e:
                log(f'⚠️ {price_name} 票區頁讀取失敗：{e}')
                continue
            for name, price, seats, url in areas:
                if any(k in name for k in EXCLUDE):
                    continue
                checked += 1
                if '售完' in seats:
                    continue
                found += 1
                line = f'🎫 有票！{pid}【{price_name}】{name} ${price} 空位：{seats}\n    {url}'
                log(line)
                key = (perf_id, name)
                now_open.add(key)
                if key not in prev_open:
                    tg_send(f'🎫 寬宏有票！\n【{price_name}】{name}\n票價 {price}　空位 {seats}\n{url}')
                notify('寬宏有票！', f'{price_name} {name} 空位 {seats}')
                if auto_open and url:
                    subprocess.run(['open', url], check=False)
            time.sleep(0.3)  # 別一次把 22 頁同時打過去
    prev_open.clear()
    prev_open.update(now_open)
    return found, checked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('products', nargs='*', default=DEFAULT_PRODUCTS)
    ap.add_argument('--interval', type=int, default=60)
    ap.add_argument('--open', action='store_true', help='有票時用預設瀏覽器開直達網址')
    ap.add_argument('--once', action='store_true', help='只跑一輪')
    ap.add_argument('--tg-chatid', action='store_true', help='列出傳訊息給 bot 的 chat id')
    ap.add_argument('--tg-test', action='store_true', help='發一則 Telegram 測試訊息')
    a = ap.parse_args()
    load_env()

    if a.tg_chatid:
        res = tg_api('getUpdates').get('result', [])
        chats = {(u.get('message') or {}).get('chat', {}).get('id'): (u.get('message') or {}).get('chat', {})
                 for u in res if u.get('message')}
        if not chats:
            print('找不到訊息：先在 Telegram 對你的 bot 傳一句話，再跑一次')
        for cid, c in chats.items():
            print(f'TELEGRAM_CHAT_ID={cid}   # {c.get("first_name", "")} {c.get("username", "")}')
        return
    if a.tg_test:
        if not os.environ.get('TELEGRAM_CHAT_ID'):
            sys.exit('.env 沒有 TELEGRAM_CHAT_ID')
        tg_api('sendMessage', chat_id=os.environ['TELEGRAM_CHAT_ID'], text='✅ 寬宏監票 Telegram 通知測試')
        print('已送出，看一下 Telegram')
        return

    tg_on = bool(os.environ.get('TELEGRAM_BOT_TOKEN') and os.environ.get('TELEGRAM_CHAT_ID'))
    prev_open = set()

    log(f'開始監票：{", ".join(a.products)}，每 {a.interval} 秒一輪（排除：{"/".join(EXCLUDE)}，Telegram：{"開" if tg_on else "未設定"}）')
    while True:
        t0 = time.time()
        try:
            found, checked = one_round(a.products, a.open, prev_open)
            log(f'本輪看了 {checked} 個票區，有票 {found} 區')
        except Exception as e:
            log(f'⚠️ 本輪失敗：{e}')
        if a.once:
            break
        time.sleep(max(1, a.interval - (time.time() - t0)))


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
