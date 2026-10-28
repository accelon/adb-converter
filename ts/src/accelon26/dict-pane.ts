/**
 * 右欄「詞典」分頁（作者 2026-10）
 *
 * 上半：詞條清單（點到的句子 → 所有詞典型 adb 的開頭匹配，長的在前）
 * 下半：點一列之後
 *   * 詞條正文
 *   * 再下面：「開頭」／「結尾」兩個分頁，列出以這個詞條開頭／結尾的其他詞條，
 *     讓讀者沿著詞條往下挖（例：般若 → 般若經典、般若經十喻）。
 *
 * 句子怎麼取：從點到的那個字往後讀到標點（`。，、；：！？…「」『』（）〔〕【】〈〉《》`）
 * 或空白為止，最多 24 個字。點擊位置常常落在字與字之間，所以會試幾個起點
 * （caret、caret-1、caret-2、caret+1），取第一個查得到詞條的。
 */
import { $, escapeHtml } from './viewer';
import { dictIndexState, dictLookup, relativesOfRow, renderEntry, rowOf, type DictRow } from './dict-lookup';
import { dictOrder } from './dict-settings';
import { setDictHooks } from './dict-hooks';

let rows: DictRow[] = [];
let active = -1;
let sentence = '';
let moreKind: 'start' | 'end' = 'start';

export function dictPaneState(): {
  sentence: string; active: number; moreKind: string;
  rows: { db: string; label: string }[];
  relatives: { db: string; label: string }[];
  indexes: { db: string; tag: string; entries: number }[];
} {
  const row = rows[active];
  const rel = row ? relativesOfRow(row, moreKind, 200, sentence) : [];
  return {
    sentence,
    active,
    moreKind,
    rows: rows.map((r) => ({ db: r.db, label: r.label })),
    relatives: rel.map((r) => ({ db: r.db, label: r.label })),
    indexes: dictIndexState(),
  };
}

const PUNCT = /[。，、；：！？…「」『』（）〔〕【】〈〉《》\s]/;

/** 從點到的字往後取到標點為止（回傳那一段文字） */
export function sentenceFrom(text: string, offset: number): string {
  const rest = text.slice(Math.max(0, offset));
  let out = '';
  for (const ch of rest) {
    if (PUNCT.test(ch)) break;
    out += ch;
    if ([...out].length >= 24) break;
  }
  return out;
}

/** 點擊位置 → 那一段句子（會試幾個起點，因為 caret 常常落在字與字之間） */
export function sentencesAtElement(el: HTMLElement | null, offset: number): string[] {
  const line = el?.closest?.('.lineText') as HTMLElement | null;
  if (!line) return [];
  const text = line.textContent ?? '';
  const starts = [offset, offset - 1, offset - 2, offset + 1].filter((n) => n >= 0 && n < text.length);
  const out: string[] = [];
  for (const s of starts) {
    // 跳過標點，從第一個「字」開始
    let start = s;
    for (let i = 0; i < 3 && start < text.length && PUNCT.test(text[start]); i++) start++;
    const cand = sentenceFrom(text, start);
    if (cand.length >= 1 && !out.includes(cand)) out.push(cand);
  }
  return out;
}

/** 從滑鼠事件取出候選句子（點在塗紅的詞上時，直接用那個 mark 定位） */
export function sentencesAtPoint(ev: MouseEvent): string[] {
  const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
  const mark = under?.closest?.('mark') as HTMLElement | null;
  if (mark?.textContent) {
    const line = mark.closest('.lineText') as HTMLElement | null;
    const text = line?.textContent ?? '';
    const at = text.indexOf(mark.textContent);
    if (at >= 0) return sentencesAtElement(line, at);
  }
  const range = document.caretRangeFromPoint?.(ev.clientX, ev.clientY);
  if (!range) return [];
  const node = range.startContainer;
  const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement));
  return sentencesAtElement(el, range.startOffset);
}

function renderList(): void {
  const list = $('#dictList');
  if (!list) return;
  const idx = dictIndexState();
  if (!idx.length) {
    list.innerHTML = '<div class="note">目前沒有詞典型 adb（有 <code>&lt;樹 s="$詞"&gt;</code> 宣告的庫）；'
      + '這裡會列出詞條。</div>';
    return;
  }
  if (!rows.length) {
    list.innerHTML = sentence
      ? `<div class="note">「${escapeHtml(sentence)}」查無詞條；可換短一點的詞，或改用選單「搜尋」。</div>`
      : '<div class="note">選一段本文 → 選單「查字典」，這裡會列出以它開頭的詞條。</div>';
    return;
  }
  const byDict = dictOrder().length > 0;
  const head = `<div class="dictSent">「${escapeHtml(sentence)}」→ ${rows.length} 個詞條`
    + `（${byDict ? '依詞典順序，同詞典內長的在前' : '長的在前'}）</div>`;
  const items = rows.map((r, i) => {
    const cls = 'dictItem' + (i === active ? ' active' : '');
    return `<button type="button" class="${cls}" data-i="${i}" title="在《${escapeHtml(r.db)}》查這個詞條">`
      + `<span class="lbl">${escapeHtml(r.label)}</span>`
      + `<span class="db">${escapeHtml(r.db)}</span>`
      + `<span class="len">${[...r.label].length}</span></button>`;
  }).join('');
  list.innerHTML = head + items;
  list.querySelectorAll<HTMLElement>('.dictItem').forEach((el) => {
    el.onclick = () => { void showEntry(Number(el.dataset.i)); };
  });
}

/** 下半部：詞條正文 ＋ 開頭／結尾兩份「親戚」清單 */
async function showEntry(i: number): Promise<void> {
  const row = rows[i];
  if (!row) return;
  active = i;
  renderList();
  const body = $('#dictBody');
  if (!body) return;
  body.innerHTML = `<div class="dictHead">${escapeHtml(row.label)}<span class="db">《${escapeHtml(row.db)}》</span></div>`
    + '<div class="note">讀取中…</div>';
  const html = await renderEntry(row);
  const rel = relativesOfRow(row, moreKind, 200, sentence);
  const relItems = rel.length
    ? rel.map((r) => `<button type="button" class="dictRel" data-key="${escapeHtml(r.key)}" data-label="${escapeHtml(r.label)}">`
      + `${escapeHtml(r.label)}<span class="db">${escapeHtml(r.db)}</span></button>`).join('')
    : `<div class="note">沒有「${escapeHtml(row.label)}」${moreKind === 'start' ? '開頭' : '結尾'}的其他詞條。</div>`;
  body.innerHTML = `<div class="dictHead">${escapeHtml(row.label)}<span class="db">《${escapeHtml(row.db)}》</span></div>`
    + `<div class="dictText">${html}</div>`
    + '<div class="dictMore">'
    + '<div class="dictMoreTabs">'
    + `<button type="button" class="dictMoreTab${moreKind === 'start' ? ' active' : ''}" data-kind="start">開頭</button>`
    + `<button type="button" class="dictMoreTab${moreKind === 'end' ? ' active' : ''}" data-kind="end">結尾</button>`
    + `</div><div class="dictMoreList">${relItems}</div></div>`;
  body.querySelectorAll<HTMLElement>('.dictMoreTab').forEach((el) => {
    el.onclick = () => {
      moreKind = (el.dataset.kind as 'start' | 'end') ?? 'start';
      void showEntry(active);
    };
  });
  body.querySelectorAll<HTMLElement>('.dictRel').forEach((el) => {
    el.onclick = () => {
      const label = el.dataset.label ?? '';
      const key = el.dataset.key ?? '';
      const target = rowOf(key, label);
      if (!target) return;
      // 把「親戚」變成清單的一列並選它：往下挖一層
      rows = [target, ...rows.filter((r) => !(r.key === target.key && r.label === target.label))];
      void showEntry(0);
    };
  });
  body.scrollTop = 0;
}

/** 對一段文字查所有詞典型 adb，並更新右欄（由選取選單「查字典」呼叫）。 */
export async function dictLookupAt(text: string): Promise<void> {
  sentence = text;
  rows = await dictLookup(text);
  active = rows.length ? 0 : -1;
  renderList();
  if (active >= 0) await showEntry(0);
  if (rows.length) setDictHooks.current?.();
}

/** 選取選單「查字典」：切到右欄詞典分頁，再用整段選取文字查。 */
export async function openDictLookup(text: string): Promise<void> {
  const right = document.getElementById('colRight');
  if (right && right.getBoundingClientRect().width < 10) {
    document.getElementById('toggleRight')?.click();
  }
  const tab = document.querySelector<HTMLElement>('#colRight .tabBtn[data-tab="dict"]');
  tab?.click();
  await dictLookupAt(text);
}

/**
 * 診斷用：從滑鼠位置取候選句子查詞（2026-10-28 起不再自動呼叫；
 * 一般讀者請用本文選取選單「查字典」）。
 */
export async function dictLookupAtPoint(ev: MouseEvent): Promise<void> {
  const cands = sentencesAtPoint(ev);
  for (const cand of cands) {
    const got = await dictLookup(cand);
    if (!got.length) continue;
    sentence = cand;
    rows = got;
    active = 0;
    renderList();
    await showEntry(0);
    setDictHooks.current?.();
    return;
  }
  if (cands.length) {
    sentence = cands[0];
    rows = [];
    active = -1;
    renderList();
  }
}

/** 開機接線：分頁被切到「詞典」時重畫；查詞由選取選單明確觸發。 */
export function initDictPane(): void {
  document.body.dataset.dictInit = '1';
  renderList();
  const btn = document.querySelector('#colRight .tabBtn[data-tab="dict"]') as HTMLElement | null;
  btn?.addEventListener('click', () => renderList());
}
