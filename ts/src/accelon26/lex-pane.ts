/**
 * lex-pane（2026-11-02；2026-11-03 改成右欄「詞」分頁）：詞形／詞譜的詞卡。
 *
 * 這一版刻意**不碰 dict-pane**：詞典條目仍由右欄「詞典」分頁負責；lex-pane 只處理
 * cs 的 `<詞 b j>`（詞譜）與 lex.adb 的詞條：
 *   - 單擊本文的 `.word`（或精讀模式的 ruby）→ 切到右欄「詞」分頁，顯示詞形與詞譜 b/j；
 *   - 若 lex.adb 已在 catalog／桌面清單裡，順便查它的 `塊 w="詞形"`，顯示次數、中文、
 *     詞件、格位、PTS、義項；
 *   - 查不到就明說，不打斷閱讀。
 *
 * 不改既有手勢：word span 只有 cs 有 b/j 才長；漢語譯本沒有 span。
 *
 * 2026-11-03：漢語譯本**選取文字** → 選取選單「查詞」→ 反向查 `lex.adb` 的「中文」行，
 * 列出對應的巴利詞（`openLexPaneForHan`）。漢語沒有逐詞語法，所以詞卡只給「候選詞」，
 * 點一個候選詞再走一般詞條畫面（格位／詞件／例句都由 cs 的 lex 詞條提供）。
 */
import { AdbReader, BlobIO, type AdbSource } from './adb';
import { catalog, openDbs } from './dbs';
import { desktopSources } from './host';
import { reader } from './viewer';
import { VaPaMapper } from './vapa';
import { locatorAtVa } from './page-text';
import { normalize } from '../tokenize';
import { revealDocLine } from './doc-pane';
import { setLexHooks } from './lex-hooks';
import { hanCandidates, hanIndex, parseLexEntry, type HanCandidate, type LexEntry } from './lex-index';

const readers = new WeakMap<object, Promise<AdbReader | null>>();
const wordMaps = new WeakMap<AdbReader, Promise<Map<string, number>>>();
const tokenMaps = new WeakMap<AdbReader, Promise<Map<string, number>>>();

async function tokenMap(r: AdbReader): Promise<Map<string, number>> {
  let p = tokenMaps.get(r);
  if (!p) {
    p = (async () => {
      const m = new Map<string, number>();
      const arr = await r.tokens();
      for (let i = 0; i < arr.length; i++) m.set(arr[i].name, i);
      return m;
    })();
    tokenMaps.set(r, p);
  }
  return p;
}

function sourceName(s: AdbSource | string): string {
  const raw = typeof s === 'string' ? s : ((s as { name?: string }).name ?? '');
  return raw.split(/[\\/]/).pop() ?? '';
}

/** 找 lex.adb：目前開著的庫 → catalog → 桌面宿主清單。 */
async function lexSource(): Promise<AdbSource | null> {
  const isLex = (s: AdbSource): boolean => /^lex(\.adb)?$/i.test(sourceName(s));
  for (const d of openDbs) if (d.file && isLex(d.file)) return d.file;
  const e = catalog.find((x) => isLex(x.file));
  if (e) return e.file;
  const host = await desktopSources().catch(() => [] as AdbSource[]);
  return host.find(isLex) ?? null;
}

async function lexReader(): Promise<AdbReader | null> {
  if (reader?.header.dbname === 'lex') return reader;
  const src = await lexSource();
  if (!src) return null;
  if (readers.has(src)) return readers.get(src)!;
  const p = AdbReader.open(new BlobIO(src)).catch(() => null);
  readers.set(src, p);
  return p;
}

async function lexWordMap(r: AdbReader): Promise<Map<string, number>> {
  const old = wordMaps.get(r);
  if (old) return old;
  const p = (async () => {
    const out = new Map<string, number>();
    const tags = r.containers.get('tags');
    const ti = tags?.names.indexOf('塊') ?? -1;
    if (!tags || ti < 0) return out;
    const vas = await r.decodeBlockList('tags', ti);
    const av = await r.attributeValues('塊.w').catch(() => null);
    if (!av?.values?.length || !av.pointers) return out;
    for (let i = 0; i < av.values.length; i++) {
      const ptr = av.pointers[i];
      if (((ptr >>> 24) & 0xff) !== ti) continue;
      const va = vas[(ptr & 0xffffff) - 1];
      if (va === undefined) continue;
      const w = av.values[i].replace(/^[（(]\s*/, '').replace(/\s*[）)]$/, '').trim();
      if (w && !out.has(w.toLowerCase())) out.set(w.toLowerCase(), va);
    }
    return out;
  })();
  wordMaps.set(r, p);
  return p;
}

async function readEntry(r: AdbReader, va: number): Promise<LexEntry | null> {
  const m = new VaPaMapper(r);
  await m.init();
  const line = m.lineOfVa(va);
  if (line < 0) return null;
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) {
    const s = await m.lineText(line + i);
    if (!s) break;
    if (i > 0 && /<塊(?=[\s>])/.test(s)) break;
    lines.push(s);
  }
  return lines.length ? parseLexEntry(lines) : null;
}

/* ---------------------------------------------- 反向查：漢詞 → 巴利候選（2026-11-03） */

/** 選取漢詞 → 切到右欄「詞」分頁，列出巴利候選（給選取選單「查詞」用）。 */
export async function openLexPaneForHan(han: string): Promise<void> {
  const text = String(han ?? '').trim();
  if (!text) return;
  const box = ensurePane();
  if (!box) return;
  setLexHooks.current?.();
  const body = box.querySelector('.lexPaneBody') as HTMLElement;
  const sub = box.querySelector('.lexPaneSub') as HTMLElement;
  const my = ++seq;
  sub.textContent = '漢詞';
  body.innerHTML = `<div class="lexWord">${escapeHtml(text)}</div>`
    + '<div class="lexNote">查 lex.adb…</div>';

  const lr = await lexReader();
  if (my !== seq) return;
  if (!lr) {
    body.querySelector('.lexNote')!.textContent = '找不到 lex.adb：查詞需要巴利詞解（lex.adb 放在同一資料夾或 catalog）。';
    return;
  }
  let index: Map<string, HanCandidate[]>;
  try {
    index = await hanIndex(lr);
  } catch {
    if (my !== seq) return;
    body.querySelector('.lexNote')!.textContent = '讀不到 lex.adb 的詞條（檔案可能損壞）。';
    return;
  }
  if (my !== seq) return;
  const hits = hanCandidates(index, text);
  if (!hits.length) {
    body.querySelector('.lexNote')!.textContent = `lex.adb 沒有含「${text}」的中文詞條。`;
    return;
  }
  body.innerHTML = `<div class="lexWord">${escapeHtml(text)}</div>`
    + `<div class="lexCodes">查到 ${hits.length} 個巴利詞；點一個看詞形、格位與例句。</div>`
    + `<div class="lexCands">${hits.map((h) => `<button type="button" class="lexCand" data-word="${escapeHtml(h.word)}">`
      + `<b>${escapeHtml(h.word)}</b><span class="lexCandGloss">${escapeHtml(h.gloss)}</span>`
      + `<i>${escapeHtml(h.count)} 次</i></button>`).join('')}</div>`;
}

let pane: HTMLElement | null = null;
let seq = 0;

/** 詞卡固定住在右欄「詞」分頁；找不到容器（舊版 HTML）就安靜地不開。 */
function ensurePane(): HTMLElement | null {
  const host = document.getElementById('lexInTab');
  if (!host) return null;
  if (pane) return pane;
  pane = document.createElement('aside');
  pane.id = 'lexPane';
  pane.className = 'lexPane inTab';
  pane.innerHTML = '<div class="lexPaneHead"><b>詞</b><span class="lexPaneSub"></span></div>'
    + '<div class="lexPaneBody"></div>';
  host.innerHTML = '';
  host.appendChild(pane);
  pane.addEventListener('click', (ev) => {
    const cand = (ev.target as Element | null)?.closest?.('.lexCand') as HTMLElement | null;
    if (cand) {
      ev.stopPropagation();
      const w = cand.dataset.word ?? '';
      if (w) void openLexPane(w);
      return;
    }
    const part = (ev.target as Element | null)?.closest?.('.lexPart') as HTMLElement | null;
    if (part) {
      ev.stopPropagation();
      const w = part.dataset.word ?? '';
      if (w) void openLexPane(w);
      return;
    }
    const ex = (ev.target as Element | null)?.closest?.('.lexExample') as HTMLElement | null;
    if (ex) {
      ev.stopPropagation();
      const line = Number(ex.dataset.line);
      if (Number.isFinite(line)) void revealDocLine(line);
      return;
    }
    const b = (ev.target as Element | null)?.closest?.('.lexCopy') as HTMLElement | null;
    if (!b) return;
    ev.stopPropagation();
    const addr = b.dataset.addr ?? '';
    void navigator.clipboard?.writeText(addr).then(() => {
      b.textContent = '已複製';
      setTimeout(() => { b.textContent = '複製'; }, 1200);
    }).catch(() => undefined);
  });
  return pane;
}

export async function openLexPane(word: string, b = '', j = '', line = 0, ordinal = 0): Promise<void> {
  const box = ensurePane();
  if (!box) return;
  setLexHooks.current?.();
  const body = box.querySelector('.lexPaneBody') as HTMLElement;
  const sub = box.querySelector('.lexPaneSub') as HTMLElement;
  const my = ++seq;
  let loc = '';
  let example = '';
  if (reader && line) {
    const lv = await reader.linesVirtual();
    const at = lv[line] != null ? await locatorAtVa(reader, lv[line]) : null;
    if (at) loc = `${at.block}.${at.seg}:${at.sentence}${ordinal ? `#${ordinal}` : ''}`;
    try {
      const m = new VaPaMapper(reader);
      await m.init();
      example = (await m.lineText(line)).replace(/<[^>]*>/g, '').trim().slice(0, 240);
    } catch { /* 例文抓不到不影響詞條 */ }
  }
  const where = loc ? `<div class="lexWhere">位置 <span>${escapeHtml(loc)}</span>`
    + ` <button type="button" class="lexCopy" data-addr="${escapeHtml(loc)}">複製</button></div>`
    : line ? `<div class="lexWhere">行 ${line}${ordinal ? ` · 第 ${ordinal} 詞` : ''}</div>` : '';
  sub.textContent = b ? b.replace(/\|/g, ' + ') : '';
  body.innerHTML = `<div class="lexWord">${escapeHtml(word)}</div>` + where
    + (b ? `<div class="lexCodes">詞譜：${escapeHtml(b.replace(/\|/g, ' + '))}${j ? `　j=${escapeHtml(j)}` : ''}</div>` : '')
    + '<div class="lexNote">查 lex.adb…</div>';

  const lr = await lexReader();
  if (my !== seq) return;
  if (!lr) {
    body.querySelector('.lexNote')!.textContent = '找不到 lex.adb；只有詞譜 b/j。';
    return;
  }
  const map = await lexWordMap(lr);
  if (my !== seq) return;
  const va = map.get(word.trim().toLowerCase());
  if (va === undefined) {
    body.querySelector('.lexNote')!.textContent = 'lex.adb 沒有這個詞形。';
    return;
  }
  const entry = await readEntry(lr, va);
  if (my !== seq) return;
  if (!entry) {
    body.querySelector('.lexNote')!.textContent = '讀不到 lex.adb 的詞條。';
    return;
  }
  const examples = reader ? await exampleLines(reader, word) : [];
  if (my !== seq) return;
  const row = (label: string, value?: string): string =>
    value ? `<div class="lexRow"><span class="lexLabel">${label}</span><span>${escapeHtml(value)}</span></div>` : '';
  body.innerHTML = `<div class="lexWord">${escapeHtml(entry.word || word)}</div>` + where
    + (b ? `<div class="lexCodes">詞譜：${escapeHtml(b.replace(/\|/g, ' + '))}${j ? `　j=${escapeHtml(j)}` : ''}</div>` : '')
    + row('次數', entry.count ? entry.count + ' 次' : '')
    + row('中文', entry.gloss)
    + row('例', examples.length ? '' : example)
    + (examples.length ? `<div class="lexExamples"><div class="lexLabel">例句</div>${examples.map((x) => `<button type="button" class="lexExample" data-line="${x.line}">${escapeHtml(x.text)}</button>`).join('')}</div>` : '')
    + row('詞件', entry.parts)
    + partTree(entry.word || word, entry.parts)
    + row('格位', entry.cases)
    + caseBars(entry.cases)
    + row('上下文', entry.context)
    + row('詞幹', entry.stem)
    + row('PTS', entry.pts)
    + (entry.senses?.length ? `<div class="lexSenses">${entry.senses.map((s) => `<div>${escapeHtml(s)}</div>`).join('')}</div>` : '');
}

async function exampleLines(r: AdbReader, word: string): Promise<{ text: string; line: number }[]> {
  const needle = normalize(word.trim());
  if (!needle) return [];
  const idx = (await tokenMap(r)).get(needle) ?? -1;
  if (idx < 0) return [];
  const vas = await r.decodeBlockList('tokens', idx);
  const m = new VaPaMapper(r);
  await m.init();
  const needleRe = new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
  const out: { text: string; line: number }[] = [];
  for (const va of vas.slice(0, 12)) {
    const line = m.lineOfVa(va);
    if (line < 0) continue;
    const s = (await m.lineText(line)).replace(/<[^>]*>/g, '').trim();
    if (!s || out.some((x) => x.text === s)) continue;
    // token index 是正規化後的形（tajjanīyakammaṃ → tajjaniyakammam）；
    // 只取真正含這個詞形的行，避免把同 token 的其他複合詞當例句。
    if (!needleRe.test(normalize(s))) continue;
    out.push({ text: s.slice(0, 180), line });
    if (out.length >= 3) break;
  }
  return out;
}

function partTree(word: string, parts?: string): string {
  const xs = (parts ?? '').split(/\s*\+\s*/).filter(Boolean);
  if (xs.length < 2) return '';
  return `<div class="lexTree"><div class="lexTreeHead">${escapeHtml(word)}</div>`
    + xs.map((p, i) => `<div class="lexTreePart">${i === xs.length - 1 ? '└' : '├'} `
      + `<button type="button" class="lexPart" data-word="${escapeHtml(p)}">${escapeHtml(p)}</button></div>`).join('')
    + '</div>';
}

function caseBars(cases?: string): string {  if (!cases) return '';
  const items = [...cases.matchAll(/([^\d\s·,;、]+)\s*(\d+(?:\.\d+)?)/g)]
    .map((m) => ({ name: m[1], value: Number(m[2]) }))
    .filter((x) => Number.isFinite(x.value));
  if (items.length < 2) return '';
  const max = Math.max(...items.map((x) => x.value), 1);
  return `<div class="lexCaseBars">${items.map((x) =>
    `<div class="lexCaseRow"><span>${escapeHtml(x.name)}</span>`
    + `<i style="width:${Math.max(2, Math.round((x.value / max) * 100))}%"></i>`
    + `<b>${x.value}</b></div>`).join('')}</div>`;
}

function escapeHtml(s: string): string {  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let bound = false;

/** 只綁一次：單擊 `.word`（沒有拖曳選取時）開 lex-pane。 */
export function initLexPane(): void {
  if (bound) return;
  bound = true;
  document.addEventListener('click', (ev) => {
    const el = (ev.target as Element | null)?.closest?.('.lineText .word') as HTMLElement | null;
    if (!el) return;
    // `data-w` 是 vedic 的詞級錨（`<詞 w="1">`），不是詞典條目／lex 詞；
    // 不要讓它開 lex-pane（提示詞 §六）。
    if (el.dataset.w) return;
    if (el.closest('a')) return;                 // 連結優先
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;         // 拖曳選取不搶
    ev.stopPropagation();
    const row = el.closest('.docLine') as HTMLElement | null;
    const line = Number((row?.id ?? '').replace(/^L/, '')) || 0;
    const box = el.closest('.lineText');
    const words = box ? [...box.querySelectorAll<HTMLElement>('.word')] : [];
    const ordinal = words.indexOf(el) + 1;
    void openLexPane(el.textContent ?? '', el.dataset.b ?? '', el.dataset.j ?? '', line, ordinal);
  }, true);
  // 精讀模式的 ruby（reading-pane 只發事件，不 import 這個檔）。
  window.addEventListener('accelon26:lexword', (ev) => {
    const d = (ev as CustomEvent<{ word?: string; line?: number }>).detail;
    if (!d?.word) return;
    void openLexPane(d.word, '', '', Number.isFinite(d.line) ? d.line! : 0);
  });
}
