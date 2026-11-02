/**
 * 摘要窗格：搜尋、命中清單與節點範圍的 scope。
 *
 * Split out of viewer.ts (ACCELON26-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, displayName, escapeHtml, fmtInt, mapper, reader, session } from './viewer';
import { setSide, showTab } from './ui';
import { dirTrees, realmHits, renderDirTree, renderFreq } from './scopes';
import { revealHit } from './link';
import { hueFor, hueStyle, kwMarks, setKwMarks } from './kw-marks';
import { noteSearch, resetEngineStats } from './engine-stats';
import { renderPageBlocks } from './render_accelon3';
import { simConverter } from './doc-pane';
import { foldGlossary, loadGlossary } from './glossary';

/** search state */
let lastResult: SearchResult | null = null;

/**
 * The result the 摘要 pane currently shows. Normally the same as `lastResult`, but
 * the 頻次／全文 pane runs its OWN search (its own input), so a click there scopes
 * the summary to that result instead of the 目錄 query.
 */
let summaryResult: SearchResult | null = null;

let searchSeq = 0;

/** 這一輪查詢實際用的模式：片語／AND／鄰近；一般全文為空。 */
let lastSearchMode = '';

/**
 * 摘要清單自己的序號（作者 2026-10-29）：每次重畫 +1，較舊的一次畫到一半就放棄。
 * 沒有它，輸入後還在慢慢組卡的「全體摘要」會在點完節點命中數之後才寫進 DOM，
 * 把剛畫好的節點摘要蓋掉——讀者看到的標題是「此節點 23 筆」，卡片卻是全體的。
 */
let snippetSeq = 0;

/** index into result.groups, -1 = all groups */
let activeGroup = -1;

/**
 * How many summaries the 摘要 pane shows after an input update. The requirement
 * is "只更新摘要（顯示最前面 30 筆）": typing must not touch the document, and
 * the rest of the hits are revealed by clicking a node's 命中數 badge.
 */
const SNIPPET_LIMIT = 30;

let snippetShown = SNIPPET_LIMIT;
/** 上一張點過的摘要卡（va/units/query）：同一張重複點時沿用分頁，不疊新分頁。 */
let lastSnippet: { va: number; units: number; query: string } | null = null;

/** when a node's 命中數 was clicked, the 摘要 pane is scoped to that node */
let snippetScope: { realm: { from: number; to: number }; label: string } | null = null;

/** the query that scope belongs to: re-running the SAME query keeps it */
let snippetScopeQuery = '';

/**
 * The text of the search that produced `lastResult` ('' when there is none).
 *
 * This is what a 命中數 click scopes to — NOT the live content of the input box: a
 * click that lands while a NEW query is still in flight belongs to the result on
 * screen, and when the new result arrives the constraint is dropped (author's rule:
 * 重新輸入之後，這個約束取消).
 */
let lastQuery = '';
/** 西文查詢換成漢詞時，摘要要附註的說明（2026-10-31）。 */
let glossNote = '';

// -------------------------------------------------------------- full text search
/**
 * Live search. Each keystroke re-runs the query; the posting list of every token
 * already seen is cached by `SearchSession`, so typing one more character only
 * costs the new token's block read plus the phrase pass.
 */
async function runSearch(query: string) {
  if (!session || !mapper) return;
  const seq = ++searchSeq;
  void renderFreq();   // the 頻次 tab re-groups on every search
  const q = query.trim();
  if (!q) {
    lastResult = null;
    summaryResult = null;
    lastQuery = '';
    snippetScope = null;
    snippetShown = SNIPPET_LIMIT;
    setKwMarks([]);            // 沒有查詢：本文回到單色
    resetEngineStats();        // 標題上的「上一輪耗時」也回到預設
    refreshTreeHits();   // no search: the badges go back to the child counts
    $('#searchList').innerHTML = '';
    $('#searchMeta').textContent = '';
    $('#searchMore').textContent = '';
    return;
  }
  // 純容器 adb（--no-index）：正文、目錄、頁碼都正常，只是沒有 token 索引可搜。
  if (reader && !reader.hasFullTextIndex) {
    lastResult = null;
    summaryResult = null;
    lastQuery = q;
    lastSearchMode = '';
    snippetScope = null;
    snippetShown = SNIPPET_LIMIT;
    setKwMarks([]);
    resetEngineStats();
    refreshTreeHits();
    $('#searchList').innerHTML = '';
    $('#searchMeta').textContent = '此資料庫未建全文索引（建置時略過），仍可閱讀與瀏覽。';
    $('#searchMore').textContent = '';
    return;
  }
  // 西文查詢（2026-10-31）：外語在 <术> 屬性裡，全文索引沒有；先用詞彙表換成漢詞。
  // 詞彙表可能對到多個漢詞，逐一試（最多 4 個），取第一個在索引裡找得到的。
  let qq = q;
  let hans: string[] = [];
  glossNote = '';
  if (/[A-Za-z\u00C0-\u024F]/.test(q) && !/[\u3400-\u9fff]/.test(q) && reader) {
    const rows = await loadGlossary(reader);
    const fq = foldGlossary(q);
    const hits = rows?.filter((r) => r.fold.includes(fq)) ?? [];
    if (hits.length) {
      const exact = hits.filter((r) => r.fold === fq);
      const pool = (exact.length ? exact : hits).sort((a, b) => b.count - a.count);
      hans = [...new Set(pool.map((r) => r.han))].slice(0, 4);
      qq = hans[0];
      glossNote = `（西文「${q}」→ ${hans.join('、')}）`;
    }
  }
  // 純外文（cs／sc）：空白先當片語（作者 2026-11-02）。找不到再退 AND、再退鄰近。
  // 中文／混合語料仍走原本的 searchAuto（空白＝optional 詞組）。
  let res: SearchResult;
  let searchMode = '';
  const pureForeign = !!reader && (reader.header.dbname === 'cs' || reader.header.dbname === 'sc');
  const plain = qq.trim();
  if (pureForeign && session && /\s/.test(plain) && !/[+\-*"]/.test(plain)) {
    const phraseRes = await session.searchPhrase(plain);
    if (phraseRes.hits.length) {
      res = phraseRes;
      searchMode = '片語';
    } else {
      const andQ = plain.split(/\s+/).filter(Boolean).map((t) => '+' + t).join(' ');
      const andRes = await searchAutoVia(session, reader?.io ?? null, andQ);
      if (andRes.hits.length) {
        res = andRes;
        searchMode = 'AND';
      } else {
        const parts = plain.split(/\s+/).filter(Boolean);
        const nearQ = '+' + parts[0] + parts.slice(1).map((t) => '*' + t).join('');
        res = await searchAutoVia(session, reader?.io ?? null, nearQ);
        searchMode = '鄰近';
      }
      // 摘要仍顯示使用者原本的查法，不顯示內部的 +／*。
      res.query = q;
    }
  } else {
    // searchAuto: 單一詞組走舊引擎，多詞組／運算子走 BM25
    res = await searchAutoVia(session, reader?.io ?? null, qq);
  }
  for (const h of hans.slice(1)) {
    if (!res.missing.length) break;
    const r2 = await searchAutoVia(session, reader?.io ?? null, h);
    if (!r2.missing.length) { res = r2; break; }
  }
  if (seq !== searchSeq) return;          // a newer keystroke won
  lastSearchMode = searchMode;
  if (searchMode) {
    const badge = $('#queryMode');
    if (badge) { badge.hidden = false; badge.textContent = searchMode; }
  }
  lastQuery = q;
  // 每個關鍵字一個顏色（塗本文與摘要都用同一組色相）
  const clauses = res.multi?.clauses.filter((c) => c.colorIndex >= 0) ?? [];
  setKwMarks(clauses.map((c) => ({ text: c.text, hue: hueFor(c.colorIndex, clauses.length) })));
  // A keystroke may land while a node-scoped summary is on screen (the debounce
  // can outlive a click). The same query keeps the scope — that re-search was
  // already in flight when 命中數 was clicked — only a DIFFERENT query drops it.
  if (snippetScope && snippetScopeQuery !== q) {
    snippetScope = null;
    snippetScopeQuery = '';
  }
  lastResult = res;
  summaryResult = res;
  snippetShown = SNIPPET_LIMIT;
  // 本文標題顯示「上一輪引擎耗時」（hover 看 token／posting 細節）
  noteSearch({
    query: q,
    ms: res.ms,
    hits: res.hits.length,
    truncated: res.truncated,
    missing: res.missing,
    lookups: session?.lookups() ?? [],
    docs: res.multi?.docCount,
    segments: res.multi?.segments,
    segmentSource: res.multi?.segmentSource,
  });
  refreshTreeHits();   // the badges are hit counts: repaint them with THIS result
  await renderSearchResult(res, seq);
  if (glossNote && seq === searchSeq) {
    const meta = $('#searchMeta');
    if (meta) meta.textContent = (meta.textContent ?? '') + ' ' + glossNote;
  }
}

async function renderSearchResult(res: SearchResult, seq: number) {
  const meta = $('#searchMeta');
  activeGroup = -1;
  const scoped = snippetScope && snippetScopeQuery === res.query ? snippetScope : null;
  if (snippetScope && !scoped) {
    snippetScope = null;
    snippetScopeQuery = '';
  }
  if (res.missing.length) {
    meta.textContent = `「${res.query}」：索引中沒有 ${res.missing.map((m) => `「${m}」`).join('、')}`;
    $('#searchList').innerHTML = '';
    $('#searchMore').textContent = '';
    return;
  }
  if (scoped) {
    // a node's 命中數 is the active scope: keep its header even when the SAME
    // query is re-run (the debounce may land just after the click)
    await showNodeHits(scoped.realm, scoped.label, realmHits(scoped.realm.from, scoped.realm.to));
    return;
  }
  const groupInfo = res.groups.length ? `，分 ${fmtInt(res.groups.filter((g) => g.count).length)} 群（依 ${res.groupTag}）` : '';
  const nodeHint = '<span class="dim">｜輸入只更新摘要，本文要點目錄節點的命中數或摘要</span>';
  const multi = res.multi;
  if (multi) {
    // 多詞組：把每個詞組的角色、idf 與文件數說清楚（BM25 才有鑑別力）
    const parts = multi.clauses.map((c) => {
      const sign = c.role === 'required' ? '+' : c.role === 'excluded' ? '−' : '';
      const near = c.nearOf >= 0 ? '*' : '';
      return `<span class="kwTag" style="--hue:${hueFor(Math.max(0, c.colorIndex), Math.max(1, multi.clauses.filter((x) => x.colorIndex >= 0).length))}">${near}${sign}${escapeHtml(c.text)}</span>`
        + ` <span class="dim">idf ${c.idf.toFixed(1)}</span>`;
    }).join(' ＋ ');
    const docNote = `文件＝${fmtInt(multi.segments)} 段，命中 ${fmtInt(multi.docCount)} 份`;
    meta.innerHTML = `${parts}　${escapeHtml(docNote)}｜${fmtInt(res.hits.length)} 筆命中${res.truncated ? ' 以上' : ''}`
      + `｜BM25（長度＝tag VA 差值）${multi.ms.toFixed(0)} ms`
      + '<span class="dim">｜本文與摘要的顏色＝各詞組（HSV）</span>';
    await renderSnippets(seq);
    return;
  }
  meta.innerHTML = escapeHtml(`${res.tokens.map((t) => t.token).join(' + ')}（詞組，${fmtInt(res.hits.length)} 筆命中${res.truncated ? ' 以上' : ''}${groupInfo}，${res.ms.toFixed(0)} ms）`) + nodeHint;
  await renderSnippets(seq);
}

/**
 * The 摘要 pane: the first `snippetShown` hits of the current result. With no
 * scope it lists the whole result (top 30 after an input update); with a scope
 * (a directory node's 命中數 was clicked) only that node's realm is shown.
 *
 * Typing MUST NOT move the document: this function therefore never links to the
 * text. Only a click on a summary card (or the 命中數 badge) does.
 */
/**
 * 把一段摘要文字裡的每個關鍵字都塗上自己的顏色。
 *
 * 重疊時保留「起點較前、長度較長」的那一個（先排序再跳過已覆蓋的區間），
 * 所以「緣起性空」這種查詢不會把長詞切碎。`own` 是這張卡片對應的詞組（加 `cur`）。
 */
function markedSnippetHtml(text: string, marks: { text: string; hue: number }[], own?: string): string {
  type Span = { start: number; end: number; hue: number; own: boolean };
  const spans: Span[] = [];
  const seen = new Set<string>();
  for (const m of marks) {
    if (!m.text || seen.has(m.text)) continue;
    seen.add(m.text);
    let at = 0;
    while ((at = text.indexOf(m.text, at)) >= 0) {
      spans.push({ start: at, end: at + m.text.length, hue: m.hue, own: !!own && m.text === own });
      at += m.text.length;
    }
  }
  if (!spans.length) return escapeHtml(text);
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  let out = '';
  let pos = 0;
  for (const sp of spans) {
    if (sp.start < pos) continue;                 // 已被前一個（更長的）區間蓋住
    out += escapeHtml(text.slice(pos, sp.start));
    out += `<mark class="kw${sp.own ? ' cur' : ''}" style="${hueStyle(sp.hue)}">${escapeHtml(text.slice(sp.start, sp.end))}</mark>`;
    pos = sp.end;
  }
  return out + escapeHtml(text.slice(pos));
}

/**
 * 摘要卡片也要渲染標籤（作者 2026-10）：
 *   * **不保留硬換行** —— 文字連著排（`hardBreaks: false`）
 *   * **標題只上色、不放大** —— `headScale: false`
 *   * 關鍵字在渲染 HTML 之前就用文字比對上色（`marks`）；這張卡片的主要命中文字
 *     （`primary`）會多一個 `cur` class。
 */
function snippetHtml(text: string, marks: { text: string; hue: number }[], primary?: string): string {
  const lines = text.split('\n');
  const blocks = renderPageBlocks(lines, lines.map((_, i) => i), {
    hardBreaks: false, headScale: false, marks, primary, convert: simConverter(),
  });
  return blocks.map((b) => b.lines.map((l) => l.html).join('')).join('');
}

async function renderSnippets(seq: number) {
  const my = ++snippetSeq;
  const superseded = () => seq !== searchSeq || my !== snippetSeq;
  const res = summaryResult ?? lastResult;
  if (!res || !mapper) return;
  const list = $('#searchList');
  const realm = snippetScope?.realm;
  let pool = activeGroup >= 0 ? res.hits.filter((h) => inGroup(res, h.va, activeGroup)) : res.hits;
  if (realm) pool = pool.filter((h) => h.va >= realm.from && h.va < realm.to);
  const show = pool.slice(0, snippetShown);
  const multi = res.multi;
  const cards: string[] = [];
  // 同一段（同一行）有多個命中時，摘要只列一張卡（作者 2026-10-27）：卡片文字
  // 一樣、著色也一樣，重複只會佔掉 30 張的額度。多詞組不動（每個詞組要自己的 cur）。
  const seenLines = new Set<number>();
  let merged = 0;
  for (const hit of show) {
    const book = bookNameOf(res.groups, hit.va);
    const bookHtml = book ? `<span class="snippetBook">${escapeHtml(book)}</span>` : '';
    if (multi) {
      // 多詞組：這個命中屬於哪一個詞組，就用那個詞組的顏色；其餘詞組在同一段
      // 文字裡的出現也一併上色（讀者要看得出「哪個字是哪個關鍵字」）。
      const clause = multi.clauses[hit.clause ?? 0];
      const own = clause?.text ?? '';
      const wildcard = !!clause?.wildcard;
      const positives = multi.clauses.filter((c) => c.colorIndex >= 0).length;
      // 萬用字元（阿.漢）在文字裡找不到「阿.漢」這個字串，只能靠 VA span 取得實際文字
      const s = await searchSummary(mapper, hit.va, hit.units, wildcard ? {} : { phrase: own });
      if (superseded()) return;
      let body: string;
      if (!s) {
        body = `VA ${fmtInt(hit.va)}：無法定位`;
      } else if (wildcard && s.end > s.start) {
        const hue = hueFor(Math.max(0, clause?.colorIndex ?? 0), Math.max(1, positives));
        const hitText = s.text.slice(s.start, s.end);
        body = snippetHtml(s.text, [...kwMarks(), { text: hitText, hue }], hitText);
      } else {
        body = snippetHtml(s.text, kwMarks(), own);
      }
      cards.push(`<div class="snippet" data-va="${hit.va}" data-units="${hit.units}" data-clause="${hit.clause ?? 0}">
          <div>${body}${bookHtml}</div></div>`);
      continue;
    }
    // pass the query: the snippet then anchors on the line table (walk-independent)
    const s = await searchSummary(mapper, hit.va, hit.units, { phrase: res.query });
    if (superseded()) return;        // superseded while building snippets
    if (!s) { cards.push(`<div class="snippet"><div class="snippetHead">VA ${fmtInt(hit.va)}：無法定位</div></div>`); continue; }
    if (seenLines.has(s.line)) { merged++; continue; }
    seenLines.add(s.line);
    const mid = s.text.slice(s.start, s.end);
    const body = snippetHtml(s.text, [{ text: mid, hue: 0 }], mid);
    cards.push(`<div class="snippet" data-va="${hit.va}" data-units="${hit.units}">
        <div>${body}${bookHtml}</div>
      </div>`);
  }
  if (superseded()) return;   // 較新的一次已經開始畫：不要把舊清單寫回去
  list.innerHTML = cards.join('');
  list.querySelectorAll<HTMLElement>('.snippet').forEach((el) => {
    el.onclick = (ev) => {
      list.querySelectorAll('.snippet').forEach((x) => x.classList.toggle('active', x === el));
      // the summary is the reader's context: make sure the right column is visible
      setSide('right', true);
      showTab('sum', 'right');
      const cur = summaryResult ?? lastResult;
      const m = cur?.multi;
      // 多詞組：用「這張卡片是哪個詞組」當 token，本文才塗得到對的字
      const token = m
        ? (m.clauses[Number(el.dataset.clause ?? 0)]?.text ?? cur?.query ?? '')
        : (cur?.tokens.map((t) => t.token).join('') ?? '');
      /**
       * 作者 2026-11-01：點摘要**預設開新分頁**，不要蓋掉從目錄打開的閱讀頁。
       * 例外：同一張卡重複點（沒有 Ctrl）沿用剛剛那個分頁，避免疊一堆重複。
       */
      const va = Number(el.dataset.va);
      const units = Number(el.dataset.units);
      const query = cur?.query ?? '';
      const ctrl = ev.ctrlKey || ev.metaKey;
      const same = !ctrl && lastSnippet?.va === va && lastSnippet.units === units
        && lastSnippet.query === query;
      lastSnippet = { va, units, query };
      void revealHit(va, token, units, { newTab: !same });
    };
  });
  const more = $('#searchMore');
  const scopeNote = snippetScope ? `「${displayName(snippetScope.label)}」內 ` : (activeGroup >= 0 ? '此群 ' : '');
  more.textContent = pool.length > show.length
    ? `顯示前 ${fmtInt(show.length)} 筆（${scopeNote}共 ${fmtInt(pool.length)} 筆${merged ? '；同段只列一次' : ''}）；捲到底載入更多`
    : `${scopeNote}共 ${fmtInt(pool.length)} 筆${merged ? '；同段只列一次' : ''}`;
  // No auto-jump: the document is linked by an explicit click (requirement 一).
}

/**
 * Repaint the directory tree's hit badges after the query changed.
 *
 * The badges are the search hit counts, so they must move with the input; they used
 * to stay on the previous query (or on the child count) until a node was reopened.
 * Only the rendered rows are rebuilt, and only when the 目錄 pane is on screen.
 */
function refreshTreeHits(): void {
  const btn = $('#colLeft .tabBtn[data-tab="dir"]') as HTMLElement | null;
  if (!btn || btn.hidden || getComputedStyle(btn).display === 'none' || !dirTrees.length) return;
  if (!$('#dirTree')) return;
  void renderDirTree();
}

/**
 * Show the hits of ONE directory node in the 摘要 pane (a click on its 命中數).
 *
 * The node's VA range is the filter, and the label travels with the scope so the
 * header can say which node is being shown.
 */
async function showNodeHits(
  realm: { from: number; to: number },
  label: string,
  count: number,
  res: SearchResult | null = lastResult,
  query?: string,
): Promise<void> {
  setSide('right', true);       // the summary must be visible to be useful
  showTab('sum', 'right');
  const meta = $('#searchMeta');
  if (!res) {
    meta.textContent = `「${displayName(label)}」：尚未輸入搜尋詞`;
    return;
  }
  // The pane shows THIS result: 頻次／全文 searches on its own input, so its rows
  // must not be filtered against a 目錄 query that may be a different word.
  snippetScope = { realm, label };
  // The scope belongs to the query that produced THIS result — NOT to whatever text
  // happens to sit in the box right now. Reading the live text made the constraint
  // stick after a re-typed query: a 命中數 clicked while the new query was still in
  // flight adopted the new text, and the debounced search then counted as "the same
  // query" and kept the node's realm on screen. Author's rule (2026-10): 重新輸入
  // 之後，這個「只看這個節點」的約束就取消。A debounced re-search of the SAME text
  // still matches and keeps the scope, which is what the debounce needs.
  snippetScopeQuery = (query ?? lastQuery).trim();
  snippetShown = SNIPPET_LIMIT;
  // The global result holds at most 5,000 hits (a VA-ordered prefix), so for a common
  // word every node after the cut-off had an EMPTY pool and its 命中數 looked like a
  // lie. When the list was truncated, ask the index for THIS realm's hits instead.
  if (res.truncated && !res.multi && session) {
    try {
      const hits = await session.hitsInRange(res.query, realm.from, realm.to, SNIPPET_LIMIT * 20);
      if (snippetScope?.realm.from === realm.from && hits.length) {
        res = { ...res, hits, truncated: hits.length >= SNIPPET_LIMIT * 20 };
      }
    } catch (e) {
      // the pane must still open with whatever the global result holds
      console.warn('hitsInRange failed:', e);
    }
  }
  summaryResult = res;
  // `count` is the realm's exact hit count; `res.hits` may hold only the first batch
  // of them (a 10k-hit division is not 10k rendered cards), so say which is which.
  const loaded = res.hits.length < count ? `；已載入前 ${fmtInt(res.hits.length)} 筆` : '';
  meta.innerHTML = `「${escapeHtml(displayName(label))}」範圍內 <b>${fmtInt(count)}</b> 筆命中${loaded}（點摘要才會聯動本文）`;
  // pass a LIVE sequence number: a re-search may be in flight, and renderSnippets
  // drops its work when the sequence has moved on
  await renderSnippets(searchSeq);
}

/** true when `va` falls inside group `gi`'s VA range */
function inGroup(res: SearchResult, va: number, gi: number): boolean {
  const g = res.groups[gi];
  return !!g && va >= g.from && va < g.to;
}

/**
 * 命中所在的書名（作者 2026-10-29）：摘要每張卡片最後要標出這一句出自哪一本。
 * 書名直接取自搜尋分群（`依 書` 的 groups），不必再查一次目錄。
 */
function bookNameOf(groups: { name: string; from: number; to: number }[], va: number): string {
  let lo = 0, hi = groups.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (groups[mid].from <= va) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const g = groups[at];
  return g && va < g.to ? g.name : '';
}

/** a fresh database has nothing to summarise */
export function resetSummary(): void {
  lastResult = null;
  summaryResult = null;
  lastSearchMode = '';
  snippetScope = null;
  snippetScopeQuery = '';
  snippetShown = SNIPPET_LIMIT;
  // 換庫時把上一輪搜尋的關鍵字也清掉，否則開新庫（或回到書籤）時，
  // paintKeywordMarks 會拿舊關鍵字把整頁塗滿（作者 2026-10-31 回報）。
  setKwMarks([]);
}

/** the 摘要 list scrolled to the end: reveal the next batch (the state lives here) */
export function showMoreSnippets(): void {
  snippetShown += SNIPPET_LIMIT;
  void renderSnippets(searchSeq);
}

import { SearchResult, SearchSession, searchSummary } from './search';
import { searchAutoVia } from './backend';

function snapshotSummary() {
  return { lastResult, summaryResult, lastQuery, snippetScope, snippetScopeQuery, snippetShown, activeGroup };
}
function restoreSummary(s: any): void {
  lastResult = s.lastResult ?? null;
  summaryResult = s.summaryResult ?? null;
  lastQuery = s.lastQuery ?? lastResult?.query ?? '';
  snippetScope = s.snippetScope ?? null;
  snippetScopeQuery = s.snippetScopeQuery ?? '';
  snippetShown = s.snippetShown ?? SNIPPET_LIMIT;
  activeGroup = s.activeGroup ?? -1;
}

/**
 * 切換 adb 後，把「這個庫自己的摘要」重畫回右欄（作者 2026-11-01）。
 * restoreSummary 只還原變數，DOM 還是上一個庫的；沒有結果就清空。
 */
export async function repaintSummary(): Promise<void> {
  const res = summaryResult ?? lastResult;
  const meta = $('#searchMeta');
  const list = $('#searchList');
  const more = $('#searchMore');
  if (!res) {
    if (meta) meta.textContent = '';
    if (list) list.innerHTML = '';
    if (more) more.textContent = '';
    setKwMarks([]);
    return;
  }
  // 關鍵字顏色跟結果一起還原（否則本文與摘要會沿用上一個庫的塗色）
  const clauses = res.multi?.clauses.filter((c) => c.colorIndex >= 0) ?? [];
  setKwMarks(clauses.map((c) => ({ text: c.text, hue: hueFor(c.colorIndex, clauses.length) })));
  await renderSearchResult(res, searchSeq);
}
export { SNIPPET_LIMIT, activeGroup, inGroup, lastQuery, lastResult, lastSearchMode, refreshTreeHits, renderSearchResult, renderSnippets, restoreSummary, runSearch, searchSeq, showNodeHits, snapshotSummary, snippetScope, snippetScopeQuery, snippetShown, summaryResult };
