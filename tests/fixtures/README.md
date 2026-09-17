# 真實 DOM 素材與還原出的場次對照表

2026-09-17 BIGBANG 優先購**開賣當下**存下來的場次頁 HTML，一個字都沒改。

| 檔案 | 內容 |
|---|---|
| `perf_P1EMCIC6.html` | 2/27 場次頁（存下時十個票價都已完售） |
| `perf_P1EVUYWG.html` | 2/28 場次頁（存下時仍有可訂購列，**優先購與一般兩種按鈕都有**） |

價值在於：**一旦完售，網站就把訂購網址從 DOM 拿掉，事後再也撈不回來**。
這份對照表只在還買得到的時候看得到，必須當場存下來。

## 票價 → PERFORMANCE_ID（三個來源交叉還原）

來源：① 開賣當下的場次頁 HTML ② 搶票紀錄的 `nav` 網址 ③ 搶票紀錄的 `xhr` 票區資料（票區名稱帶票價）

### 2/27 場次　`PRODUCT_ID=P1EMCIC6`

| 票價 | PERFORMANCE_ID | 來源 | 備註 |
|---|---|---|---|
| 9430 | `P1FDECMD` | nav | 走 `UTK0202_`（站席） |
| 9380 | `P1FDSO0X` | xhr 票區名稱 | |
| 8880 | `P1FDWY6H` | xhr 票區名稱 | |
| 其餘七個 | — | | 存快照時已完售，網址已被網站移除 |

### 2/28 場次　`PRODUCT_ID=P1EVUYWG`

| 票價 | PERFORMANCE_ID | 當時按鈕 |
|---|---|---|
| 9430 | `P1FHHBJX` | 優先購 `VipSellCheck` → 走 `UTK0202_`（站席） |
| 8880 | `P1FHLMTF` | 一般 `doLink` |
| 8380 | `P1FHNQO9` | 一般 `doLink` |
| 7980 | `P1FHPVUV` | 一般 `doLink` |
| 6980 | `P1FHRYXX` | 一般 `doLink` |
| 6480 | `P1FHU4JT` | 一般 `doLink` |
| 3980 | `P1FHYGYX` | 一般 `doLink` |
| 2980 | `P1FI0P2R` | 一般 `doLink` |
| 9380 / 4980 | — | 存快照時已完售 |

## 直接貼票區頁網址：**可以進**（有登入的前提下）

```
https://kham.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=<上表>&PRODUCT_ID=<上表>
```

使用者實測可進。（我這邊用未登入的瀏覽器測會被導向 `UTK0101_03.aspx`，
一度誤判成「票區頁綁 session 流程」——**是沒登入，不是流程綁定**。）

意義：**開賣時可以略過場次頁，直接開票區頁**。工具在票區頁一樣會接手
（規則看的是 `#salesTable`，不看網址怎麼來的）。

## 場次頁的三種訂購按鈕（都已支援）

```html
<button class='red' onclick='doLink("UTK0201_000.aspx?PERFORMANCE_ID=…",323);return false;'>立即訂購</button>
<button class='red' onclick="top.location.href='UTK0204_.aspx?PERFORMANCE_ID=…';return false;">立即訂購</button>
<button class='red' onclick='VipSellCheck("P1FHHBJX");return false;'>立即訂購</button>   <!-- 優先購 -->
<button class='gray' onclick='return false;'>已售完</button>                              <!-- 完售 -->
```
