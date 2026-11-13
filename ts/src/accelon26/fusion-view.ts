/**
 * 融視圖（R1 V6–V10）。
 *
 * 渲染器（`render_accelon3`）在視圖開時把 `<融 i="db?anchor">經文…</融>` 輸出成
 * `<span class="fusionBlock" data-i=… data-n=… data-max=…>原佔位</span>`；這裡在每次
 * 本文重畫後，用 IntersectionObserver「進視口才」把佔位內容換成目標節點的子樹 span。
 *
 * 鏡像 `embed.ts`：渲染同步長殼、內容非同步填。資料層沿用既有
 * `anchorVa`／`nodeAnchorInfo`／`nodeSpanText`／`nodeSubtreeEnd`，不新增解析規則。
 *
 * 向後兼容：`fusionViewEnabled()` 預設 off，`render_accelon3` 見 off 就走現行透明容器。
 * 為避免 import 循環，flag 由本模組掌管；`render_accelon3` 直接讀同一個 localStorage key。
 */
import { readerFor, embedNodeBody } from './xref';
import { anchorVa, nodeAnchorInfo, nodeSpanText, nodeSubtreeEnd } from './page-text';
import { setStatus } from './viewer';

const KEY = 'accelon26.fusionView';
let cached: boolean | null = null;

export function fusionViewEnabled(): boolean {
  if (cached == null) { try { cached = localStorage.getItem(KEY) === '1'; } catch { cached = false; } }
  return cached;
}
export function setFusionView(on: boolean): void {
  cached = on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* 無痕模式 */ }
}

/** 當前庫有沒有 `<融>`（決定開關要不要渲染，避免 0-融 的死 UI）。 */
export function hasFusionTag(readerLike: unknown): boolean {
  const names = (readerLike as { containers?: Map<string, { names?: string[] }> } | null)
    ?.containers?.get('tags')?.names ?? [];
  return names.includes('融') || names.includes('_融');
}

const plainLen = (el: HTMLElement): number => (el.textContent ?? '').replace(/[\s\u3000]/g, '').length;
// 護欄：只用「覆寫後純字數不得短於原佔位」這條（①，跨渲染器安全）。
// TODO(app)：嚴格「註/釋/上標 逐項保真」要讓 span 走 doc 渲染器（render_accelon3，
//   才會把 <註> 轉 noteRef）再與原佔位同渲染器對照；lineHtml/embedNodeBody 不產 noteRef，
//   跨渲染器比計數會永遠誤判 → 暫不做②，改由 app 端校。

async function fillOne(el: HTMLElement): Promise<void> {
  const i = el.dataset.i ?? '';
  const q = i.indexOf('?');
  const db = q >= 0 ? i.slice(0, q) : '';
  const anchor = q >= 0 ? i.slice(q + 1) : i;
  const max = Number(el.dataset.max ?? 200);
  if (!db || !anchor) return;
  const L0 = plainLen(el);
  let rd;
  try { rd = await readerFor(db); } catch { rd = null; }
  if (!rd) { setStatus(`融視圖：請先開啟 ${db}.adb（保留原文）`, 'warn'); el.dataset.done = '1'; return; }   // V7
  let info = await nodeAnchorInfo(rd, anchor);
  if (!info) { const v = await anchorVa(rd, anchor); if (v != null) info = { va: v, vaEnd: null, tag: '', ns: '', value: anchor }; }
  if (!info) { setStatus(`融視圖：缺目標 ${anchor}（保留原文）`, 'warn'); el.dataset.done = '1'; return; }        // V7
  let end: number | null = null;
  try { end = await nodeSubtreeEnd(rd, info.va); } catch { /* 用 info.vaEnd */ }
  if (end == null) end = info.vaEnd;
  const raw = await nodeSpanText(rd, info.va, end, max);
  const bodyHtml = embedNodeBody(raw);   // 與 <嵌 sub> 同一 body：科判 .embedTier 縮排、正文行
  const probe = document.createElement('div');
  probe.innerHTML = bodyHtml;
  if (plainLen(probe) < L0) { setStatus(`融視圖：${anchor} span 短於原文，保留原佔位`, 'warn'); el.dataset.done = '1'; return; }  // 護欄①
  const src = el.dataset.n ? `<span class="fusionSrc">${el.dataset.n}・${anchor}</span>` : '';
  el.innerHTML = src + `<div class="fusionBody">${bodyHtml}</div>`;
  el.dataset.done = '1';
}

let io: IntersectionObserver | null = null;
let mo: MutationObserver | null = null;
let queue: HTMLElement[] = [];
const BATCH = 50;                                        // V10：單次重建不同步拉 >50 段

function observePending(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('.fusionBlock[data-i]:not([data-done]):not([data-seen])')) {
    el.dataset.seen = '1';
    io?.observe(el);
  }
}
function pump(): void {
  let budget = BATCH;
  while (queue.length && budget-- > 0) { const el = queue.shift(); if (el) void fillOne(el); }
  if (queue.length) setTimeout(pump, 0);                 // 剩下的排下一輪，讓出主執行緒
}

/** boot 呼叫一次（與 `initEmbed()` 同縫）；`#docText` 每次重畫都會自動補填。 */
export function initFusion(docHost: HTMLElement | null): void {
  if (!docHost || io) return;
  io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { io?.unobserve(e.target); queue.push(e.target as HTMLElement); }
    pump();
  }, { rootMargin: '120px' });
  mo = new MutationObserver(() => observePending(docHost));
  mo.observe(docHost, { childList: true, subtree: true });
  observePending(docHost);
}

/** 關開關／換庫時清乾淨，下一輪重裝。 */
export function disposeFusion(): void {
  io?.disconnect(); mo?.disconnect(); io = null; mo = null; queue = [];
  for (const el of document.querySelectorAll<HTMLElement>('.fusionBlock[data-seen]')) delete el.dataset.seen;
}
