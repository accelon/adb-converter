#!/usr/bin/env bun
/**
 * 用 ybh.html 的外殼（同一份 <style>／頁首／頁尾）生出 www/adb/vmtd.html。
 * 同 make-dfb-page.ts 的做法：外殼只取「<main> 之前」與「<footer> 之後」，內文重寫。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SHELL = resolve(ROOT, "www/adb/ybh.html");
const OUT = resolve(ROOT, "www/adb/vmtd.html");
const src = readFileSync(SHELL, "utf8").split("\n");
const headEnd = src.findIndex((l) => l.startsWith("<main"));
const tailStart = src.findIndex((l) => l.startsWith("<footer>"));
if (headEnd < 0 || tailStart < 0) throw new Error(`外殼找不到 <main>／<footer>（head=${headEnd} tail=${tailStart}）`);
const head = src.slice(0, headEnd).join("\n").replace(
  /<title>[^<]*<\/title>/,
  "<title>vmtd.adb 製作說明（唯識文獻）</title>",
);
const tail = src.slice(tailStart).join("\n");

const main = `<main class="doc">
<h1>vmtd.adb 製作說明（唯識文獻）</h1>

<p>法鼓文理學院「唯識典籍數位資料庫」（VMTD）四部論合一。<b>目錄第一層只有四部書名</b>，
每部之下的科判目錄連成一棵完整樹，不因分卷而斷開。全庫 98,326 行、3,899 個科判節點、
2,763 個大正藏頁標。</p>

<div class="tableWrap"><table>
<thead><tr><th>書名（目錄第一層）</th><th>內容</th><th>來源</th></tr></thead>
<tbody>
<tr><td><b>成唯識論（會注）</b></td><td>玄奘譯《成唯識論》十卷本文，逐段整合窺基《述記》《掌中樞要》、惠沼《了義燈》、智周《演秘》四層注疏；科判樹 25 層、大正校勘 3,034 筆。</td><td>vms.dila.edu.tw</td></tr>
<tr><td><b>唯識二十論（對照）</b></td><td>玄奘／真諦／般若流支三漢譯、Lévi 校訂梵本、藏譯，多欄對照。</td><td>vvms.dila.edu.tw</td></tr>
<tr><td><b>唯識三十頌（對照）</b></td><td>玄奘《唯識三十論頌》、真諦《轉識論》、藏譯頌、Lévi 校訂梵文安慧疏，並附梵文語譯與文法解析。</td><td>tvk.dila.edu.tw</td></tr>
<tr><td><b>辯中邊論（對照）</b></td><td>玄奘《辯中邊論》、真諦《中邊分別論》、梵本，并窺基《辯中邊論述記》三卷。</td><td>mavb.dila.edu.tw</td></tr>
</tbody></table></div>

<h2>結構還原</h2>
<ul>
<li><b>會注本</b>：本文與四層注疏交疊，以 <code>&lt;SJ&gt;/&lt;SY&gt;/&lt;YD&gt;/&lt;YM&gt;/&lt;CL&gt;</code> 分層；大正校勘 <code>&lt;註&gt;</code>／<code>&lt;釋&gt;</code> 全數配對。</li>
<li><b>對照表</b>：逐科判列多譯本 <code>&lt;欄&gt;</code>（漢／梵／藏），會注另立 <code>&lt;層&gt;</code>，編者注／校勘入 <code>&lt;註&gt;</code>／<code>&lt;釋&gt;</code>。</li>
<li><b>科判樹</b>：<code>data-n</code> 點分路徑轉成 <code>&lt;章&gt;/&lt;節&gt;/&lt;項&gt;…</code> tier 鏈，掛在同一書名下；卷標題降為 <code>&lt;文&gt;</code> 留正文，不進目錄。</li>
<li><b>頁標</b>：<code>&lt;頁 id="T43p0736c"&gt;</code> 形式，點一下在右欄開大正藏同頁經文。<b>此功能須搭配新版閱讀器</b>；舊版 reader 只認舊式帶經號的頁 id。</li>
</ul>

<h2>來源與授權</h2>
<p>資料來源：<a href="https://vmtd.dila.edu.tw/" target="_blank" rel="noopener">法鼓文理學院唯識典籍數位資料庫</a>。
原典（成唯識論及注疏、唯識二十論、唯識三十頌、辯中邊論等）皆為公有領域古籍；
本站所作科判結構還原、多譯本對照與標記僅供研究使用，內容正確性以原資料庫為準。
VMTD 網站未見明確授權條款，如需引用或再散布請逕洽法鼓文理學院。</p>

<h2>搭配使用</h2>
<p>點頁標跳大正藏需同資料夾放 <b>taisho.adb</b>（大正藏）。本庫為研究用資料庫，
可單獨下載，也可放入 accelon26.exe 所在資料夾由桌面版列出。</p>

<p class="versions">首次上架：2026-11-18（v3，5.6 MiB）。</p>
</main>
`;

writeFileSync(OUT, head + main + tail, "utf8");
console.log(`寫好 ${OUT}`);
