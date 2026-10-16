/**
 * 摘要窗格：搜尋、命中清單與節點範圍的 scope。
 *
 * Split out of viewer.ts (ADBVIEW-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, displayName, escapeHtml, fmtInt, mapper, mods, reader, session } from './viewer';
import { setSide, showTab } from './ui';
import { dirTrees, realmHits, renderDirTree, renderFreq } from './scopes';
import { revealHit } from './link';

/** search state */
let lastResult: SearchResult | null = null;

/**
 * The result the 摘要 pane currently shows. Normally the same as `lastResult`, but
 * the 頻次／全文 pane runs its OWN search (its own input), so a click there scopes
 * the summary to that result instead of the 目錄 query.
 */
let summaryResult: SearchResult | null = null;

let searchSeq = 0;

/** index into result.groups, -1 = all groups */
let activeGroup = -1;

/**
 * How many summaries the 摘要 pane shows after an input update. The requirement
 * is "只更新摘要（顯示最前面 30 筆）": typing must not touch the document, and
 * the rest of the hits are revealed by clicking a node's 命中數 badge.
 */
const SNIPPET_LIMIT = 30;

let snippetShown = SNIPPET_LIMIT;

/** when a node's 命中數 was clicked, the 摘要 pane is scoped to that node */
let snippetScope: { realm: { from: number; to: number }; label: string } | null = null;

/** the query that scope belongs to: re-running the SAME query keeps it */
let snippetScopeQuery = '';

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
    snippetScope = null;
    snippetShown = SNIPPET_LIMIT;
    refreshTreeHits();   // no search: the badges go back to the child counts
    $('#searchList').innerHTML = '';
    $('#searchMeta').textContent = '';
    $('#searchMore').textContent = '';
    return;
  }
  const res = await session.search(q);
  if (seq !== searchSeq) return;          // a newer keystroke won
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
  refreshTreeHits();   // the badges are hit counts: repaint them with THIS result
  await renderSearchResult(res, seq);
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
async function renderSnippets(seq: number) {
  const res = summaryResult ?? lastResult;
  if (!res || !mapper) return;
  const list = $('#searchList');
  const realm = snippetScope?.realm;
  let pool = activeGroup >= 0 ? res.hits.filter((h) => inGroup(res, h.va, activeGroup)) : res.hits;
  if (realm) pool = pool.filter((h) => h.va >= realm.from && h.va < realm.to);
  const show = pool.slice(0, snippetShown);
  const cards: string[] = [];
  for (const hit of show) {
    // pass the query: the snippet then anchors on the line table (walk-independent)
    const s = await searchSummary(mapper, hit.va, hit.units, { phrase: res.query });
    if (seq !== searchSeq) return;        // superseded while building snippets
    if (!s) { cards.push(`<div class="snippet"><div class="snippetHead">VA ${fmtInt(hit.va)}：無法定位</div></div>`); continue; }
    const before = escapeHtml(s.text.slice(0, s.start));
    const mid = escapeHtml(s.text.slice(s.start, s.end));
    const after = escapeHtml(s.text.slice(s.end));
    cards.push(`<div class="snippet" data-va="${hit.va}" data-units="${hit.units}">
        <div>${before}<mark>${mid}</mark>${after}</div>
      </div>`);
  }
  list.innerHTML = cards.join('');
  list.querySelectorAll<HTMLElement>('.snippet').forEach((el) => {
    el.onclick = (ev) => {
      list.querySelectorAll('.snippet').forEach((x) => x.classList.toggle('active', x === el));
      // the summary is the reader's context: make sure the right column is visible
      setSide('right', true);
      showTab('sum', 'right');
      // Ctrl (Cmd) + click opens the hit in a NEW document tab
      void revealHit(
        Number(el.dataset.va),
        (summaryResult ?? lastResult)?.tokens.map((t) => t.token).join('') ?? '',
        Number(el.dataset.units),
        mods(ev),
      );
    };
  });
  const more = $('#searchMore');
  const scopeNote = snippetScope ? `「${displayName(snippetScope.label)}」內 ` : (activeGroup >= 0 ? '此群 ' : '');
  more.textContent = pool.length > show.length
    ? `顯示前 ${fmtInt(show.length)} 筆（${scopeNote}共 ${fmtInt(pool.length)} 筆）；捲到底載入更多`
    : `${scopeNote}共 ${fmtInt(pool.length)} 筆`;
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
  summaryResult = res;
  snippetScope = { realm, label };
  // the query the user is searching for RIGHT NOW: a debounced search of the same
  // text may still be in flight, and it must keep this scope rather than replace
  // the pane with the unscoped result
  snippetScopeQuery = (query ?? ($('#query') as HTMLInputElement | null)?.value ?? res.query).trim();
  snippetShown = SNIPPET_LIMIT;
  meta.innerHTML = `「${escapeHtml(displayName(label))}」範圍內 <b>${fmtInt(count)}</b> 筆命中（共 ${fmtInt(res.hits.length)} 筆；點摘要才會聯動本文）`;
  // pass a LIVE sequence number: a re-search may be in flight, and renderSnippets
  // drops its work when the sequence has moved on
  await renderSnippets(searchSeq);
}

/** true when `va` falls inside group `gi`'s VA range */
function inGroup(res: SearchResult, va: number, gi: number): boolean {
  const g = res.groups[gi];
  return !!g && va >= g.from && va < g.to;
}

/** a fresh database has nothing to summarise */
export function resetSummary(): void {
  lastResult = null;
  summaryResult = null;
  snippetScope = null;
  snippetScopeQuery = '';
  snippetShown = SNIPPET_LIMIT;
}

/** the 摘要 list scrolled to the end: reveal the next batch (the state lives here) */
export function showMoreSnippets(): void {
  snippetShown += SNIPPET_LIMIT;
  void renderSnippets(searchSeq);
}

import { SearchResult, SearchSession, searchSummary } from './search';

function snapshotSummary() {
  return { lastResult, summaryResult, snippetScope, snippetScopeQuery, snippetShown, activeGroup };
}
function restoreSummary(s: any): void {
  lastResult = s.lastResult ?? null;
  summaryResult = s.summaryResult ?? null;
  snippetScope = s.snippetScope ?? null;
  snippetScopeQuery = s.snippetScopeQuery ?? '';
  snippetShown = s.snippetShown ?? SNIPPET_LIMIT;
  activeGroup = s.activeGroup ?? -1;
}
export { SNIPPET_LIMIT, activeGroup, inGroup, lastResult, refreshTreeHits, renderSearchResult, renderSnippets, restoreSummary, runSearch, searchSeq, showNodeHits, snapshotSummary, snippetScope, snippetScopeQuery, snippetShown, summaryResult };
