/**
 * 設置 → 悉曇・蘭札：字型測試頁（作者 2026-10-31）。
 *
 * 為甚麼要有這一頁：`taisho.adb` 的梵字是 Unicode 第 16 平面私用區
 * （SD-XXXX → U+FA000+XXXX、RJ-XXXX → U+100000+XXXX），沒有內建字型的
 * 讀者只會看到豆腐。這一頁把兩段實際經文直接放在程式裏，字型也隨程式內嵌，
 * 所以**沒有 taisho.adb 也看得到**真正的字型效果（CBETA Online 目前用 GIF）。
 *
 * 字型：CBETA 的 Siddam 1.062／Ranjana 2.000（2023-06-21），已改寫 cmap 並
 * 子集化成 WOFF2，見 ts/tools/build-sanskrit-fonts.py 與 docs/adb/siddham-ranjana.md。
 */
import { SANSKRIT_ROMAN, SANSKRIT_SAMPLES, EXTRA_GAIJI, EXTRA_SAMPLE, type SanskritSample } from './siddham-demo-data';
import { openExternalUrl } from './plates';
import { puaSequence } from './pua-seq';

/** CBETA 梵字碼 → Unicode 私用區碼位（SD：0xFA000+XXXX；RJ：0x100000+XXXX）。 */
export function sanskritPua(id: string): number | null {
  const m = /^(SD|RJ)-([0-9A-F]{4})$/.exec(id);
  if (!m) return null;
  const n = parseInt(m[2], 16);
  return (m[1] === 'SD' ? 0xFA000 : 0x100000) + n;
}

/** 把 `⟦SD-XXXX⟧` 佔位換成真正的 PUA 字元（設定頁的經文用這種寫法，原始碼才看得懂）。 */
export function expandSanskrit(text: string): string {
  return text.replace(/⟦([A-Z]{2}-[0-9A-F]{4})⟧/g, (whole, id: string) => {
    const cp = sanskritPua(id);
    return cp == null ? whole : String.fromCodePoint(cp);
  });
}

/**
 * 「字形右邊顯示 IAST」開關（作者 2026-10-31）。
 * 只是一個顯示偏好，存在這台電腦的 localStorage；不進 settings.json，
 * 因为它只影響這一頁測試頁，不是可分享的標籤樣式。
 */
const IAST_KEY = 'accelon26.sanskritIast';
export function iastOn(): boolean {
  try { return localStorage.getItem(IAST_KEY) === '1'; } catch { return false; }
}
export function setIast(on: boolean): void {
  try { localStorage.setItem(IAST_KEY, on ? '1' : '0'); } catch { /* 無痕模式 */ }
}

/**
 * 「悉曇字改用 Noto（Unicode）」已改為預設（2026-11-01）：PUA 在顯示時換成
 * Unicode 序列，由 Noto 子集排連字；只有 Noto 排不出來的 81 個字仍用 CBETA
 * 抽出來的小字型（Accelon Siddham Extra）。不再需要開關。
 */

const SOURCE_NOTES: Record<string, string> = {
  T21n1213_p0072b08:
    '《千臂軍荼利梵字真言》，CBETA《大正新脩大藏經》第 21 冊 No. 1213，頁 72 欄 b 行 08。',
  X23n0446_p0762b05:
    '《七俱胝佛母所說準提陀羅尼經會釋》，CBETA《卍新纂大日本續藏經》第 23 冊 No. 0446，頁 762 欄 b 行 05–08。',
};

/** 跳到那一頁後要捲到的句子（頁面頂端常常是校注，梵字在下面）。 */
const JUMP_PHRASE: Record<string, string> = {
  T21n1213_p0072b08: '千臂軍荼利真言曰',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function glyphIds(sample: SanskritSample): string[] {
  const out: string[] = [];
  for (const line of sample.lines) {
    for (const m of line.matchAll(/⟦([A-Z]{2}-[0-9A-F]{4})⟧/g)) out.push(m[1]);
  }
  return out;
}

/**
 * 一個梵字：PUA 字元 ＋（可選）右邊的 IAST 轉寫（不加括號，作者 2026-10-31）。
 * IAST 一定先建好、預設用 CSS 藏起來；開關只切換 `#sanskritSamples.showIast`，
 * 不必重畫，也不會影響對照表。
 */
function glyphNode(id: string): HTMLElement {
  const span = el('span', 'sanskritGlyph');
  const cp = sanskritPua(id);
  if (cp == null) {
    span.textContent = `⟦${id}⟧`;
    return span;
  }
  const seq = puaSequence(cp);
  if (seq) {
    span.classList.add('sdSeq');
    span.textContent = seq;
  } else {
    // 81 個 Noto 排不出來的字：仍用 CBETA 抽出來的小字型（Extra）
    span.textContent = String.fromCodePoint(cp);
  }
  const roman = SANSKRIT_ROMAN[id];
  if (roman) {
    span.title = roman;
    span.append(el('span', 'sanskritIast', roman));
  }
  return span;
}

/** 一行經文：文字照原樣，`⟦ID⟧` 換成 glyphNode（保留原本的空白與標點）。 */
function lineNode(line: string): HTMLElement {
  const div = el('div', 'sanskritLine');
  let last = 0;
  for (const m of line.matchAll(/⟦([A-Z]{2}-[0-9A-F]{4})⟧/g)) {
    const at = m.index ?? 0;
    if (at > last) div.append(document.createTextNode(line.slice(last, at)));
    div.append(glyphNode(m[1]));
    // <wbr>：打開 IAST 後一行會變長，允許在「字＋轉寫」後面換行；沒有字元、不影響複製。
    div.append(document.createElement('wbr'));
    last = at + m[0].length;
  }
  if (last < line.length) div.append(document.createTextNode(line.slice(last)));
  return div;
}

function mappingTable(ids: string[]): HTMLElement {
  const unique: string[] = [];
  const count = new Map<string, number>();
  for (const id of ids) {
    if (!count.has(id)) unique.push(id);
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  const wrap = el('div', 'sanskritMapScroll');
  const table = el('table', 'sanskritMapTable');
  const head = el('tr');
  for (const h of ['梵字碼', 'Unicode', '羅馬拼音', '次數']) head.append(el('th', undefined, h));
  table.append(head);
  for (const id of unique) {
    const tr = el('tr');
    tr.append(el('td', 'sdCode', id));
    const cp = sanskritPua(id);
    tr.append(el('td', 'sdPua', cp == null ? '—' : `U+${cp.toString(16).toUpperCase().padStart(6, '0')}`));
    tr.append(el('td', 'sdRoman', SANSKRIT_ROMAN[id] ?? '—'));
    tr.append(el('td', 'sdCount', String(count.get(id) ?? 0)));
    table.append(tr);
  }
  wrap.append(table);
  return wrap;
}

function sampleBlock(sample: SanskritSample): HTMLElement {
  const box = el('section', 'sanskritSample');
  const head = el('div', 'sanskritSampleHead');
  head.append(el('b', undefined, sample.font === 'siddham' ? '悉曇字' : '蘭札字'));
  head.append(el('code', undefined, sample.source));
  const a = el('a', undefined, 'CBETA Online ↗');
  a.href = sample.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // 桌面版交給宿主開系統瀏覽器（同 plates.ts 的外部連結做法）
  a.addEventListener('click', (ev) => { ev.preventDefault(); void openExternalUrl(sample.url); });
  head.append(a);
  const { db, page } = pageOf(sample.source);
  if (page) head.append(jumpButton(db, page, sample.title, JUMP_PHRASE[sample.source] ?? ''));
  box.append(head);

  const lines = el('div', `sanskritLines ${sample.font}`);
  for (const line of sample.lines) lines.append(lineNode(line));
  box.append(lines);

  const note = SOURCE_NOTES[sample.source];
  box.append(el('p', 'setHint', note ? `出處：${note}` : `出處：${sample.title}`));

  const ids = glyphIds(sample);
  const det = el('details', 'sanskritMapBox');
  det.append(el('summary', undefined, `字碼對映表（${ids.length} 字，${new Set(ids).size} 個不同梵字）`));
  det.append(mappingTable(ids));
  box.append(det);
  return box;
}

/**
 * Noto 連字（2026-11-01）：SAT 2018 的 `&SDxxxxx;` 在顯示時換成 Unicode 序列，
 * 由 Noto Sans Siddham 子集排出連字。這裡放幾個常見的例子（kṣa／tra／oṃ…），
 * 沒有 taisho.adb 也看得到效果。
 */
const NOTO_CONJUNCTS: Array<{ roman: string; seq: string }> = [
  { roman: 'kṣa', seq: '\u{1158E}\u{115BF}\u{115AC}' },
  { roman: 'tra', seq: '\u{1159D}\u{115BF}\u{115A8}' },
  { roman: 'jñā', seq: '\u{11595}\u{115BF}\u{11597}\u{115AF}' },
  { roman: 'oṃ', seq: '\u{1158C}\u{115BD}' },
  { roman: 'hūṃ', seq: '\u{115AE}\u{115B3}\u{115BD}' },
  { roman: 'phaṭ', seq: '\u{115A3}\u{11598}\u{115BF}' },
];

/** `T21n1213_p0072b08`／`X23n0446_p0762b05` → `21p72b`／`23p762b`。 */
function pageOf(source: string): { db: string; page: string } {
  const m = /^([TX])(\d+)n[^_]+_p(\d{4})([abc])/.exec(source);
  if (!m) return { db: '', page: '' };
  return {
    db: m[1] === 'T' ? 'taisho' : 'wxzj',
    page: `${Number(m[2])}p${Number(m[3])}${m[4]}`,
  };
}

/** 關掉設置頁（用既有的關閉鈕，避免和 ui.ts 循環 import）。 */
function closeSettingsPane(): void {
  (document.getElementById('settingsClose') as HTMLElement | null)?.click();
}

/**
 * 「在 taisho／wxzj 開啟這一頁」：跳到含梵字的頁（帶 phrase 時會捲到那一句），
 * 並順手關閉設置頁（作者 2026-11-01）。
 */
function jumpButton(db: string, page: string, label: string, phrase = ''): HTMLElement {
  const b = el('button', 'sanskritJump', `在 ${db} 開啟`);
  b.type = 'button';
  b.title = `跳到 ${db} 的 ${page}`;
  b.addEventListener('click', () => {
    closeSettingsPane();
    // 由 ui.ts 監聽（避免 demo → xref → 整個閱讀器的循環 import）
    document.dispatchEvent(new CustomEvent('accelon:jump-page', { detail: { db, page, label: label || page, phrase } }));
  });
  return b;
}

function extraBlock(): HTMLElement {
  const box = el('section', 'sanskritSample');
  const head = el('div', 'sanskritSampleHead');
  head.append(el('b', undefined, 'CBETA 獨有（81 字）'));
  head.append(el('code', undefined, 'Noto 排不出來'));
  box.append(head);
  box.append(el('p', 'setHint',
    '這 81 個字沒有 Unicode 序列（沒有 romanized，或是像 traṭ 這種兩個音節），'
    + '字形從 CBETA 的 Siddam 字型抽出，做成 12.1 KiB 的補充字型（Accelon Siddham Extra）。'));

  const grid = el('div', 'extraGrid');
  for (const id of EXTRA_GAIJI) {
    const cell = el('span', 'extraCell');
    cell.append(glyphNode(id));
    cell.append(el('code', undefined, id));
    grid.append(cell);
  }
  box.append(grid);

  const lines = el('div', 'sanskritLines');
  lines.append(lineNode(EXTRA_SAMPLE.line));
  box.append(lines);

  const note = el('p', 'setHint', `例：${EXTRA_SAMPLE.title} ${EXTRA_SAMPLE.source}。`);
  const a = el('a', undefined, 'CBETA Online ↗');
  a.href = EXTRA_SAMPLE.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.addEventListener('click', (ev) => { ev.preventDefault(); void openExternalUrl(EXTRA_SAMPLE.url); });
  note.append(a);
  note.append(jumpButton('taisho', '84p405c', EXTRA_SAMPLE.title, '源由字生'));
  box.append(note);
  return box;
}

function notoBlock(): HTMLElement {
  const box = el('section', 'sanskritSample');
  const head = el('div', 'sanskritSampleHead');
  head.append(el('b', undefined, 'Noto 連字（Unicode）'));
  head.append(el('code', undefined, '&SDxxxxx; → 序列'));
  box.append(head);

  const lines = el('div', 'sanskritLines noto');
  const line = el('div', 'sanskritLine');
  for (const s of NOTO_CONJUNCTS) {
    const g = el('span', 'sdSeq', s.seq);
    g.title = s.roman;
    line.append(g);
    line.append(el('span', 'sanskritIast', s.roman));
    line.append(document.createTextNode(' '));
  }
  lines.append(line);
  box.append(lines);
  box.append(el('p', 'setHint',
    'SAT 2018 的悉曇連字（一個碼＝一個連字）：顯示時換成 Unicode 序列，'
    + '由內嵌的 Noto Sans Siddham（OFL）排版；adb 文字仍是 &SDxxxxx;，一個碼一個 VA。'));
  return box;
}

let built = false;
let wired = false;

/** 重建整頁樣本（Noto／CBETA 切換時要重畫字形）。 */
function buildDemo(host: HTMLElement): void {
  host.replaceChildren();
  for (const sample of SANSKRIT_SAMPLES) {
    host.append(sampleBlock(sample));
    // CBETA 獨有的 81 字、Noto 連字，都放在悉曇字下面（作者 2026-11-01）
    if (sample.font === 'siddham') {
      host.append(extraBlock());
      host.append(notoBlock());
    }
  }
}

/** 畫設置 → 悉曇・蘭札（只建一次；IAST 開關只切 class）。 */
export function renderSanskritDemo(): void {
  const host = document.getElementById('sanskritSamples');
  if (!host) return;
  if (!built) {
    built = true;
    buildDemo(host);
  }
  const cb = document.getElementById('setSanskritIast') as HTMLInputElement | null;
  if (cb) {
    cb.checked = iastOn();
    if (!wired) {
      wired = true;
      cb.addEventListener('change', () => {
        setIast(cb.checked);
        host.classList.toggle('showIast', cb.checked);
      });
    }
  }
  host.classList.toggle('showIast', cb ? cb.checked : iastOn());
}
