#!/usr/bin/env bun
/**
 * 用 ybh.html 的外殼（同一份 <style>／頁首／頁尾）生出 www/adb/dfb.html。
 * 為什麼腳本生而不手抄：官網各庫的說明頁必須同一套樣式與導覽，手抄必然慢慢分叉；
 * 外殼只取 ybh.html 的「<main> 之前」與「</main> 之後」兩段，內文全部重寫。
 * 這支腳本一次性使用，留在 ts/tools/ 裡供日後改頁面時重跑。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SHELL = resolve(ROOT, "www/adb/ybh.html");
const OUT = resolve(ROOT, "www/adb/dfb.html");
const src = readFileSync(SHELL, "utf8").split("\n");
const headEnd = src.findIndex((l) => l.startsWith("<main"));
const tailStart = src.findIndex((l) => l.startsWith("<footer>"));
if (headEnd < 0 || tailStart < 0) throw new Error(`外殼找不到 <main>／<footer>（head=${headEnd} tail=${tailStart}）`);
const head = src.slice(0, headEnd).join("\n").replace(
  /<title>[^<]*<\/title>/,
  "<title>dfb.adb 製作說明（丁福保《佛學大辭典》）</title>",
);
const tail = src.slice(tailStart).join("\n");

const main = `<main class="doc">
<h1>dfb.adb 製作說明（丁福保《佛學大辭典》）</h1>

<p>丁福保編《佛學大辭典》（1922 年初版）的 adb 版，<b>31,585 條</b>。詞頭按「詞條查詢」直接跳，
詞頭前有彩色小色塊標示該條的體類（術語、名數、雜語、經名、人名、書名…共 87 類）；
引文帶<b>字元級的大正藏連結</b>，點一個字就能落到《大正藏》那一頁那一句。</p>

<div class="tableWrap"><table>
<thead><tr><th>項目</th><th>內容</th></tr></thead>
<tbody>
<tr><td>詞條</td><td>31,585 條（抓取範圍 entryid 1–31,586，仍缺 1 條，見〈六、已知缺口〉）</td></tr>
<tr><td>資料來源</td><td>中華電子佛典協會（CBETA／DILA）<b>BAUS 線上佛學辭典</b>
  <a href="https://www.baus-ebs.org/fodict_online/" target="_blank" rel="noopener">dictid=1</a>，2026-11-15 全量抓取</td></tr>
<tr><td>核對用第二來源</td><td>CBETA 鏡像 <code>buddhaspace.org/dict/dfb/</code>（全量詞頭 31,377；頁內 <code>des/nor/uni/code</code> 四元屬性是缺字正解的橋）；DDBC TEI <code>github.com/myhpwa/dfb-dict</code></td></tr>
<tr><td>授權</td><td><b>Creative Commons Zero（CC0）</b>。丁福保（1874–1952）逝世已逾 50 年，原書屬公有領域；轉寫與正規化不另創著作，故本庫整份放棄權利。</td></tr>
<tr><td>搭配使用</td><td>同頁的 <b>taisho.adb</b>（大正藏）是本庫所有經文鏈的目標；<b>wxzj.adb</b>（卍續藏）可用來續查同一部書的別譯與輯佚。三個庫放進同一資料夾即可互點。</td></tr>
<tr><td>檔案</td><td><code>dfb.adb</code>，11.1 MiB（本機 <code>D:\\accelon3</code> 那份为准，線上以清單顯示的大小／日期為準）</td></tr>
</tbody></table></div>

<h2>一、體例怎麼進 adb</h2>

<p>BAUS 的原文把體例寫在釋文開頭，例如「　（雜語）猶言逐一也。…」。這些標記不是內文，
所以一律改成結構，不在詞條裡顯示成方括號：</p>

<ul>
<li><b>87 種體類</b>「（術語）（名數）…」→ 詞頭屬性 <code>&lt;詞 t="術語"&gt;</code>，閱讀端在詞頭前長出一個小色塊，
色相依 <code>&lt;集 scheme&gt;</code> 的順序表分配（表内容由頻次排，同一類別全庫同色）。</li>
<li><b>同形詞頭</b> 592 種（如兩個「阿彌陀經」）以 <code>a="2"</code> 序號區分，序號照 entryid 先後編，連續無跳。</li>
<li><b>交叉引用</b> <code>(參見：X)</code> → <code>&lt;聯 n="X"&gt;</code>：<b>只有 X 確實在詞頭表裡才成鏈</b>，
成鏈 5,891 條；查無此條的 400 條保留原文，<b>不造點了會落空的死鏈</b>。</li>
<li><b>義項分段</b>「（一）…（二）…」前插 <code>&lt;段/&gt;</code>，共 137 處／66 行。
帶段號的 <code>&lt;段 n=…&gt;</code> 是巴利藏幾庫的跨庫對齊鍵（會長出一顆 <code>¶N</code> 的對讀晶片），
本庫沒有對讀對象，所以只發不帶 n 的形式——它是單純的段落分隔，落在同一個源碼行內，不影響全文檢索。</li>
</ul>

<h2>二、字：缺字與梵文轉寫</h2>

<p>辭典裡有兩類「顯示不出來」的字，處理方式完全不同，混在一起就會把正字當成缺字：</p>

<ul>
<li><b>組字式</b>（如 <code>[口*縛]</code>）是 CBETA 用來表示一個漢字缺字的構成描述，共 964 處，
其中 <b>919 處</b>依 165 種構成對照表直接換成正確漢字（<code>[口*縛] → 嚩</code>），剩 45 種構成查無對應正字，維持原樣並在表裡標「未決」。</li>
<li><b>CBDIA 羅馬轉寫記號</b>（<code>a%</code>、<code>n%</code>、<code>i^</code>、<code>v!</code> 等）是「記號＋基字」的組合，
<b>同一記號隨基字改變讀法</b>：<code>%</code> 在母音上是長音（ā）、在子音上是點上（ṁ/ṅ）；<code>^</code> 在母音上是長音、在 <code>n</code> 上變波浪（ñ）。
所以對照表必須以 (記號, 基字) 為鍵；6,936 處轉了 <b>6,890 處（99.34%）</b>為 Unicode 拼音字元。</li>
<li>悉曇／種子字用 <b>Unicode 悉曇段（U+11580–U+115BF）</b>，這是閱讀器認得的位置；
U+87xx 一類是借來當容器的碼位，<b>同一碼位在大正語料與丁福保語料所指不同</b>，故絕不按碼位無差別替換。</li>
</ul>

<p class="fine">留在表裡沒轉的 46 處不是偷工：或兩版連基字都不同（BAUS 寫 <code>N!a</code>、鏡像作 <code>Ḍa</code>），
或鏡像自己以缺字圖片代 é/è，機械無從判定，一律不硬湊規則，逐條列在轉寫殘留清單裡。</p>

<h2>三、修復的引用錯誤（附校勘表）</h2>

<p>經文出處的鏈路是兩段式做的，這是作者定的方法：<b>先拿引文去大正藏查候選頁，再用經名核對它挑的本經對不對</b>。
核對這一環前後修掉五類錯誤，每一類都留下可覆核的表：</p>

<div class="tableWrap"><table>
<thead><tr><th>修掉的問題</th><th>說明</th><th>影響量</th></tr></thead>
<tbody>
<tr><td>回指分支形同虛設</td><td>題面「同經」「又」「本經」這類回指，程式先把引導字洗掉再判是否回指，
於是「同經」變成裸字「經」，回指分支永遠進不去——作者舉的例
「佛說阿彌陀經之異名。…同經曰：『汝等眾生…』」就一直在這種狀態。</td><td>以回指字起頭 1,424 條，此前走回指 0 條；現判為回指 929 條（正文回溯 764、順序繼承 149）</td></tr>
<tr><td>單字經名造成的假通過</td><td>「經」是任何書名的子串，舊比對讓它配上《佛說阿彌陀經》判成「一致」；
這是<b>看起來對、其實沒核</b>的那類。</td><td>已規定兩邊少於兩字一律標「題名過短不可比」，單列不計功（26 條）</td></tr>
<tr><td>品名剝離攔腰截斷書名</td><td>剝「法華經譬喻品→法華經」的規則尾巴是選填，結果凡含體裁字的長書名都從第一個體裁字鋦斷：
「法華經玄義」→法華經、「四分律刪繁補闕行事鈔」→四分律、「四十二章經」→四十二章。</td><td>全庫 22,652 條題面，舊式剝 4,412 條、新式剝 2,272 條，<b>2,140 條不再被截斷</b></td></tr>
<tr><td>注家代稱污染上下文</td><td>「同天台疏」這類代稱被寫進「前文經名」，後面整串回指一起錯到一個語料裡沒有的書名上。</td><td>受污染的繼承 301 行（帶錨點 111 個）；已拆開計數，閘門待作者定案後再開</td></tr>
<tr><td>異體字認不出</td><td>丁福保寫「增<b>一</b>阿含經」，大正題「增<b>壹</b>阿含經」；「<b>秘</b>藏寶鑰」對「<b>祕</b>藏寶鑰」。
這類不是簡繁轉換，是逐對異體。</td><td>異寫表 4 對；注家·省稱對照 22 條（止觀→摩訶止觀、輔行→止觀輔行傳弘決、玄應音義→一切經音義…）</td></tr>
<tr><td>簡稱展開</td><td>「法華經」是「妙法蓮華經」的<b>跳字</b>子序列，不是連續子串，用子串比會把正確鏈判成不符；
一对多的（如「智度論」）標為歧義，不硬選一部。</td><td>題名對照 4,628 條；書名底表 4,108 部</td></tr>
</tbody></table></div>

<p>鏈路總量與去留：<b>引文 27,024 筆 → 大正候選錨點 14,235 個 → 經名核對剔除 3,158（經名不符 2,824、候選超過 100 家的短通用引文等）
→ 保留 11,077 → 實際發射字元級錨點 10,577 個</b>（其餘是同一行內兩段引文重疊，共用一個錨點）。
「候選 &gt; 100」這一刀是刻意留的：一句「一切眾生悉有佛性」在藏裡到處都是，位置基本靠猜，寧可不鏈。</p>

<h3>隨庫附帶的校勘表</h3>

<p>全部在兩個原料倉（<code>github.com/accelon/fodict</code>、<code>github.com/accelon/dfbdict</code>），
每張都可逐條覆核、可用同目錄的腳本重跑：</p>

<div class="tableWrap"><table>
<thead><tr><th>表</th><th>內容</th><th>條目</th></tr></thead>
<tbody>
<tr><td><code>gaiji-bracket-map.tsv</code></td><td>組字式構成 → 正字</td><td>165 種</td></tr>
<tr><td><code>translit-cbdia-map.csv</code></td><td>CBDIA 轉寫（記號＋基字）→ Unicode</td><td>25 規則／6,890 處套用</td></tr>
<tr><td><code>variant-map.csv</code>／<code>punct-width-map.csv</code></td><td>異體字對照、標點寬窄</td><td>51／3</td></tr>
<tr><td><code>corpus-titles.tsv</code></td><td>大正＋卍續藏書名底表</td><td>4,108 部</td></tr>
<tr><td><code>title-map.tsv</code></td><td>丁福保題面 → 語料書名（含歧義標記）</td><td>4,628 條</td></tr>
<tr><td><code>title-master.tsv</code>／<code>title-variant.tsv</code></td><td>注家·省稱對照、異寫</td><td>22／4</td></tr>
<tr><td><code>title-verdicts-dfb-v3.tsv</code></td><td><b>逐條判定</b>：候選錨點的期望經名、命中書名、判定、解析方式</td><td>14,235 條</td></tr>
<tr><td><code>seg-review.md</code></td><td>每一處 <code>&lt;段/&gt;</code> 的分段前後對照（可打勾複核）</td><td>66 行／137 段</td></tr>
<tr><td><code>lost-pages.csv</code></td><td>被重疊去重吃掉的頁，兩方判定並排（供判斷該不該改取勝規則）</td><td>31 頁／36 段</td></tr>
<tr><td><code>second-source-ledger.md</code></td><td>缺條的第二來源補録</td><td>4 補／1 仍缺</td></tr>
</tbody></table></div>

<h2>四、驗收與對賬</h2>

<p>每次建置都跑同一組硬檢查，<b>任何一項的樣本數為零即視為失敗</b>（這個坑踩過：拿掉標籤後的純文字去數詞條行，數到 0 卻報「通過」）：</p>

<ul>
<li>詞條實數 31,585 ＝ <code>&lt;詞&gt;</code> 行 ＝ 詞條索引實例，且<b>逐位對齊 0 偏移</b>——這三者不對齊時閱讀器會<b>靜默退化</b>成全文搜尋，表面看不出問題。</li>
<li><code>&lt;聯 n=&gt;</code> 2,724 種目標，不在詞條索引者 0（零死鏈）；同形詞頭序號連續。</li>
<li>31,585 條逐條回讀比對內容（兩側套同一張正規化規則）：不符 0；詞頭與源逐條相等。</li>
<li>版面：詞條必在行首、<code>&lt;段/&gt;</code> 不落行首／不嵌在標記內／後面必接義項序號、標記成對——六項皆 0。</li>
<li>母區閱讀端測試 17 項通過（詞頭色塊走的是既有 <code>&lt;例&gt;</code> 配色通道，不影響既有庫）。</li>
</ul>

<p>另外做一層<b>獨立對賬</b>，不只引用打包工具的自報數：實讀行數＝庫總行數、庫內錨點數＝打包驗收、
保留集＝由逐條判定檔重算、501 個重疊丟棄按「段自身性質」重分類、照發射邏輯模擬一遍得 10,576＋跨標記重發 1＝庫內 10,577、
開閉標記配對。六項互相咬合才算數。</p>

<h2>五、版本記錄</h2>

<div class="tableWrap"><table>
<thead><tr><th>版</th><th>日期</th><th>sha256（前 12）</th><th>重點</th></tr></thead>
<tbody>
<tr><td>v5</td><td>2026-11-16</td><td><code>6b4c7b4798d9</code></td><td>異寫與注家·省稱對照表上線；「是否真有這本書」的判尺拆掉跳字子序列（只准連字與表內證據）；經名核對多認出 1,101 條指名一致，鏈路 10,469→10,577</td></tr>
<tr><td>v4</td><td>2026-11-16</td><td><code>66690bfe9916</code></td><td>回指再掃全型（光杆一字「偈／中／註／品」、同經＋品名、裸字表補全）；封堵第二條單字假途徑；品名剝離不再攔腰截斷書名（2,140 條）</td></tr>
<tr><td>v3</td><td>2026-11-15</td><td><code>401eb937cc96</code></td><td>「同經」這類回指真的接上（先回溯正文、再退回首條經名）；作者點名的「一切諸佛所護念經」條從無鏈到字元級鏈入《佛說阿彌陀經》</td></tr>
<tr><td>v2</td><td>2026-11-15</td><td><code>21fcc7496740</code></td><td>義項序號前插 <code>&lt;段/&gt;</code> 137 處；證明改動是純增量（去標記後與上版逐位元組相同）</td></tr>
<tr><td>v1</td><td>2026-11-15</td><td><code>9d28917d55ea</code></td><td>首次建庫：31,585 條；轉寫改 Unicode、87 類體例併入詞頭色塊、字元級大正藏鏈 10,622 個</td></tr>
</tbody></table></div>

<h2>六、已知缺口（不藏）</h2>

<ul>
<li><b>entryid 16755 仍缺</b>（悉曇／種子條）。根因是站端 IIS 腳本逾時 <code>ASP 0113 Script timed out</code>，
把逾時放到 300 秒會回 HTTP 500 錯誤頁，與網路無關；同一批另四條已從 CBETA 系來源補齊並記在補錄表。</li>
<li><b>45 個組字式、46 處轉寫</b>無法機械判定，維持原樣並列在表內。</li>
<li><b>卍續藏尚未發鏈</b>：本版所有字元級連結只指向大正藏（taisho.adb）。查卍續藏請另開 wxzj.adb 的全文檢索。</li>
<li>「同天台疏」這類<b>引導詞＋注家專名</b>仍當書名處理，未收進對照表——它隨前文所論經而指不同書，靜態映射必錯。</li>
<li>玄應《一切經音義》與慧琳《一切經音義》<b>在大正書名層同名</b>，靠書名無法區分兩家（實測受影響 1 條）。</li>
<li>大正連結是「查得到出處」，<b>不保證與丁福保引文同文</b>：辭典常有節錄、改字與異文。詞典本文一律照 BAUS 原樣，
不按大正擅改；要校異文請查 CBETA 的 P5 校勘記。</li>
</ul>

<p class="fine">原料與建置腳本、逐條校勘表與可重跑的驗收／對賬腳本，都在
<a href="https://github.com/accelon/dfbdict" target="_blank" rel="noopener">dfbdict（建庫端）</a>與
<a href="https://github.com/accelon/fodict" target="_blank" rel="noopener">fodict（抓取端與校勘表）</a>。
發現錯字、漏條或鏈錯本經，歡迎到<a href="../index.html#contact">聯絡頁</a>留言，請附詞條名與頁碼，便於逐條覆核。</p>
</main>
`;

writeFileSync(OUT, head + "\n" + main + "\n" + tail, "utf8");
const written = readFileSync(OUT, "utf8");
console.log(`-> ${OUT}（${written.split("\n").length} 行、${(written.length / 1024).toFixed(1)} KiB）`);
console.log(`外殼取自 ybh.html：前 ${headEnd} 行＋尾 ${src.length - tailStart} 行；內文全為重寫`);
for (const probe of ["<title>dfb.adb", "CC0", "10,577", "title-verdicts", "校勘", "六、已知缺口", "<footer>"]) {
  if (!written.includes(probe)) throw new Error(`產物少了「${probe}」`);
}
console.log("內容探查：標題、授權、鏈路數、校勘表、缺口、頁尾 — 全部在位");
