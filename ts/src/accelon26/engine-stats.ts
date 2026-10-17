/**
 * 「上一輪引擎耗時」顯示在本文標題（`#docTitle`）。
 *
 * 作者 2026-10：`docTitle` 改為顯示**上一輪引擎耗時**（搜尋、取文字…），
 * hover 其上顯示搜尋細節（哪些 token、posting list 多長、命中數、文件數…）。
 *
 * 這個模組只負責「記住最近一次的量測」與「把字串寫進 DOM」，兩邊都呼叫它：
 *   搜尋完成 → `noteSearch()`（summary.ts）
 *   本文聯動完成 → `noteLink()`（link.ts）
 * 不相依 paint／summary，避免再繞一個循環。
 */

export interface SearchStat {
  query: string;
  ms: number;
  /** 命中數（送進摘要的筆數，可能被上限截掉） */
  hits: number;
  truncated: boolean;
  /** 索引裡沒有的 token */
  missing: string[];
  /** 這次查詢真的查過的 token 與 posting 長度（-1＝宿主回答，沒回傳長度） */
  lookups: { token: string; postings: number; fromHost: boolean }[];
  /** 多詞組：文件數／分段數（單詞組沒有） */
  docs?: number;
  segments?: number;
  segmentSource?: string;
}

export interface LinkStat {
  /** 整個聯動（找位置＋取文字＋掛頁面）花多久 */
  ms: number;
  /** 其中「確保頁面」那一段 */
  ensureMs: number;
  /** 這一頁幾行 */
  rows: number;
  /** 釘住的 VA */
  va: number;
}

let search: SearchStat | null = null;
let link: LinkStat | null = null;

const DEFAULT_TITLE = '文件內容（硬分行；未渲染 XML）';

export function noteSearch(s: SearchStat): void {
  search = s;
  render();
}

export function noteLink(l: LinkStat): void {
  link = l;
  render();
}

/** 換資料庫時清掉（不要讓上一個庫的數字留在標題上） */
export function resetEngineStats(): void {
  search = null;
  link = null;
  render();
}

export function engineStats(): { search: SearchStat | null; link: LinkStat | null } {
  return { search, link };
}

const fmtMs = (ms: number): string => (ms >= 10 ? Math.round(ms).toString() : (Math.round(ms * 10) / 10).toString());

/** 一個 token 的 posting 長度：`菩(1,506)`、宿主回答時 `菩(宿主)`、缺席 `菩(0)` */
function lookupText(l: { token: string; postings: number; fromHost: boolean }): string {
  const len = l.postings < 0 ? '宿主回答' : l.postings.toLocaleString('en-US');
  return `${l.token}(${len})`;
}

export function renderDocTitle(): void {
  const el = document.getElementById('docTitle');
  if (!el) return;
  const parts: string[] = [];
  const tips: string[] = [];

  if (search) {
    parts.push(`搜尋 ${fmtMs(search.ms)} ms`);
    tips.push(`搜尋：${fmtMs(search.ms)} ms`
      + `（${search.lookups.length} 個 token、${search.hits.toLocaleString('en-US')} 筆命中${search.truncated ? '以上' : ''}`
      + `${search.docs !== undefined ? `、${search.docs.toLocaleString('en-US')} 份文件` : ''}）`);
    if (search.lookups.length) tips.push('  token／posting：' + search.lookups.map(lookupText).join('　'));
    if (search.segments !== undefined) {
      tips.push(`  文件分割：${search.segmentSource ?? '?'}　${search.segments.toLocaleString('en-US')} 段`);
    }
    if (search.missing.length) tips.push('  索引沒有：' + search.missing.join('、'));
    tips.push(`  查詢：${search.query}`);
  }
  if (link) {
    parts.push(`取文 ${fmtMs(link.ms)} ms`);
    tips.push(`取文字：${fmtMs(link.ms)} ms（確保頁面 ${fmtMs(link.ensureMs)} ms、${link.rows} 列、VA ${link.va.toLocaleString('en-US')}）`);
  }

  if (!parts.length) {
    el.textContent = DEFAULT_TITLE;
    el.removeAttribute('title');
    return;
  }
  el.textContent = `文件內容（${parts.join('・')}）`;
  el.title = '上一輪引擎耗時\n' + tips.join('\n');
}

function render(): void {
  renderDocTitle();
}
