# 斷言字面串漂移的定期對齊（工作流規格）

> 狀態：**生效**（2026-11-13 定案，首例 commit `1fa56e7`「基線四條轉綠」）。
> 目的：把「測試掛在字面 HTML 上、渲染器改版後斷言滯後」這類漂移**納入常規維護**，
> 同一次代碼改動的 commit 裡順帶對齊、不再攢成大對齊、也不再當不可碰的基線。
> 生效範圍：`ts/test/*.test.ts` 的斷言字面串／期望屬性名／邊界宽容度；不動產品碼路。

---

## 1. 三種掛法、三種處理

跑 `bun test`／`bun run` 掛的斷言先歸類，再決定處理方向：

### 1.1 屬漂移 → **同 commit 對齊**

斷言掛在**字面 HTML 串**上：attribute 名／順序／包法。行為沒變、只是渲染器改版把輸出格式調了。

例（首例 `1fa56e7`）：

| 斷言 | 舊期望 | 現況輸出 | 對齊方向 |
|---|---|---|---|
| `<聯 n>` | `<a class="entryLink" href="#" data-entry=…>` | 多了 `data-link="entry"`（連結委派要辨 entry／xref） | 加進字面串 |
| `<註 n="1"/>` | `title="註 1"` | `aria-label="註 1"`（a11y 改版） | 換屬性名 |
| `<术 sk=…>` hover | `class="term term-sk has-tip"`＋`title="梵：…"` | `class="term term-sk" data-lang="sk" data-term="…"` | 移除 `has-tip`／`title=`，改查 `data-lang`＋`data-term`（外語提示改由 JS 現取，避免 XSS 面、方便 i18n） |
| `<术 tb=…>` off | `class="term term-tb"` 仍留 `<span>` 虛線框 | `法`（連 span 都剝除） | 斷言改成 `termOff === '法'`；**斷言名**也順路改（「外框與提示一併剝除」） |
| `<經>` 楷體 | 內聯 `font-family:'DFKai-SB',…` | `class="fmt-kai"`（FMT 捷徑，2026-11-11 起） | 只查 `class="fmt-kai"`；`--tagtext:#00aaff` 對 FMT 捷徑不生效是刻意取捨 |
| `&quot;` 術語值 | `data-term="a&quot;b"` ＋ `title="梵：a&quot;b"` | 只 `data-term="a&quot;b"`（hover 改版） | 移除 `title=` 那條 |

### 1.2 屬真回歸 → **回滾或補救，不是改測試**

斷言掛在**行為／語義**上：取窗位置、字數、錨點解析、目錄樹層級、`anchorVa` 命中等。這類掛代表代碼改壞了。

**標準證明做法**（使用者 2026-11-13 要求納入流程）：

1. `git stash push -u -m <名>` 把本次改動藏起來
2. 對同一批斷言（HEAD 與 stash 後）各跑一次，`grep "FAIL "` 匯出兩份**斷言名清單**
3. 去標題行、`diff` 兩份 body、比 sha256 —— **完全一致**才算非回歸
4. 只要 diff 出一條原本綠、現在紅的斷言——本次改動就是回歸，回滾或補救

不是只比 pass/fail 數字；數字一樣但**掛的斷言不同**也是回歸。

### 1.3 屬引擎語義爭議 → **探針＋使用者裁**

斷言背後是引擎／資料端的**語義邊界沒定義清楚**（wildcard 是否含標點、`..` 是精確 2 個還是「至少 2 個」、`<頁>` skip tag 的 VA 偏移口徑等）。這類別既不屬「渲染器改版」也不屬「代碼改壞」，**不單方面**改測試或改引擎。

**標準做法**：先寫探針把**實際分佈**印出來（像 `1fa56e7` 前 `probe-wildcard.ts` 掃 `大..乘` 全 48 筆命中分五種形状：`raw=4 han=4` 37／`raw=4 han=3` 6／`raw=4 han=2` 1／`raw=5 han=4` 2／`raw=5 han=3` 2），把分佈報給使用者、附兩種修法建議、由使用者裁：

- 寬容：調斷言（例：`tokens ≤ len ≤ tokens+1`，因 `textOfVaSpan` 邊界黏全形標點）
- 嚴謹：調引擎／渲染器／資料端

**未裁之前**這類掛視為「待拍板」、不算回歸也不算漂移。

---

## 2. 每次跑測試要交付的資訊

跑完整 43 支（12 支 bun test ＋ 31 支 bun run；跑錯 runner 會假報非零 exit）之後，回報四項：

1. **43 支 pass/fail 數字** ＋ **既有紅燈清單**（現況：四條轉綠後為空；若又冒出，標明「漂移／回歸／爭議」歸類）
2. **斷言名 diff 檔的 sha256**（證明非回歸用；僅當本次代碼改了 `ts/src/` 或 `ts/test/` 時需要）
3. **`build:viewer` 的 size 變化**（KB 級差異要講為哪筆改動所致；MiB 級要講是否新 asset 進 exe）
4. **涉及 ybh／fuyan cooperation 單的落點**——代碼改同 commit 帶測試對齊時，diff 會同時看到 `xref.ts`／`page-text.ts` ＋ `test/*.test.ts`，這是刻意為之、不是 scope creep

---

## 3. 對其他線的影響

- **ybh 線**發 defects 單給我修時，同 commit 可能帶 1–5 條斷言字面串調整。斷言**名字**可能改（描述語反映實際行為）；**行為承諾不變**，你們看到的 `verify-fusion-fixture.ts`／`verify-all.ts` 斷言不會因為我方調整字面串而破。
- **fuyan 線**自己跑 `release.ts → deploy.ts --site`，動我方渲染器碼路的機會較少；若動，同樣把對應斷言一起對齊、`build:tours` 重產物、別留四條紅燈給下一位。
- **anchor fixture／fusion fixture 仍是凍結的**（sha `caf2ad05…`／`4748139d…`）：斷言對齊不動 fixture——綁實檔會隨 ybh.adb 改版天天誤紅，這條是先前定案、不變。

---

## 4. 首例參考（2026-11-13 commit `1fa56e7`）

四條基線紅燈轉綠的實際處置，作為此工作流的**首例**：

| 條 | 前 → 後 | 歸類 | 處置 |
|---|---|---|---|
| tour | 34/2 → **36/0** | 產物時點漂（非斷言漂） | `bun run build:tours` 重產 `tour-data.ts`；碼零改 |
| render | 47/5 → **52/0** | 漂移 § 1.1 | `test/render.test.ts` 5 條字面串對齊（見上表） |
| tag-style | 30/2 → **32/0** | 漂移 § 1.1 | 2 條 `<經>` 從內聯 style 改成查 `class="fmt-kai"`；註解寫明 FMT 捷徑取捨 |
| multi-search | 38/1 → **39/0** | 爭議 § 1.3 由使用者裁 → 採寬容 | wildcard 命中長度寬容成 `tokens ≤ len ≤ tokens+1`；引擎不動 |

代碼改動 `+33/−17`、全在測試檔。`build:viewer` 出 2391.6 KiB；其餘 39 支 pass 數**未降**。

原判斷表在 `ACCELON26-HANDOVER.md` §29.4（2026-11-03 寫「待作者定奪」），本次定案走 ①改測試。

---

## 5. 一句提醒

斷言對齊**不是永久免費午餐**——渲染器每次微調都得同步動測試。同 commit 帶對齊、
不要攢成大對齊。要留痕：每次對齊在 `ACCELON26-HANDOVER.md` §29.x 順路加一節，
或本次首例那樣寫進 commit message（`基線四條轉綠：對齊斷言字面串＋重跑 build:tours`）。

---

## 6. 與本區其他文件的邊界

| 文件 | 講的是 | 本檔 |
|---|---|---|
| `AGENTS.md` § 6 改動與回報 | 通用回報準則 | 加一條指向本檔 |
| `docs/system/architecture.md` | 分層圖、UI 動作 ↔ 非同步資料 | 不動 |
| `docs/system/ACCELON26-HANDOVER.md` §29.4 | render.test.ts 4 條 drift（舊判斷表） | §29.4 標已定案、指向本檔 |
| `docs/adb/adb-version-log.md` | 產品版次（exe／html） | 本檔改動屬測試端、**不進** version-log |
| ybh `link-audit/docs/prompt-ybh-test-drift-policy.md` | 給 ybh 的單向通知 | 本檔的對外縮寫 |
