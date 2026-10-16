/// <reference types='bun' />
/** One-off: split ts/src/adbview/viewer.ts into modules (see ADBVIEW-HANDOVER 3.2).
 *  usage:  bun run build/split-viewer.ts <module>       (doc-pane | link | summary | scopes | panes | ui)
 *  Rebuilds the ownership registry from what is already on disk, so it can run
 *  once per module in separate processes. */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const DIR = 'ts/src/adbview/';
const V = DIR + 'viewer.ts';
const RE = /^(export )?(async )?function ([A-Za-z_$][\w$]*)|^(export )?(const|let|class|interface|type) ([A-Za-z_$][\w$]*)/;

const MODULES: Record<string, { title: string; names: string[] }> = {
  'doc-pane': { title: '本文分頁與捲動：session、分頁（page）、本文渲染、字級。', names: ['docFontSized','DocSession','docTabs','docActive','docSeq','PAGE_LINES','lastDocLines','paintAsked','lastLink','pagerLog','docSession','wholeRealm','docOfVa','scrollToVa','edgeLine','realmFirstLine','realmLastLine','boundsCache','realmKey','boundsOfRealm','pageBounds','pageOfLine','sessionForRealm','sessionFor','fetchPage','ensurePage','showsLine','renderDoc','docScrollWired','scheduleCursorSync','shortLabel','renderDocTabs','switchDocTab','closeDocTab','renderPager','goPage','DOCFS_KEY','DOCFS_DEFAULT','DOCFS_MIN','DOCFS_MAX','DOCFS_READABLE_MIN','readDocFont','setDocFont','PROBE_FS','lastFit','DOC_TEXT_FAMILY','autoFitFont','longestOf','pickProbeLine','makeTextMeasurer','pendingProbeCleanup','fitDebugInfo','docTextWidth'] },
  'link': { title: '聯動：把 VA 變成「打開某個 realm 的本文並捲到某行」，以及游標高亮。', names: ['deepestNode','nodeLabelOf','nodeContaining','linkTo','revealHit','showLine','cursorNode','cursorPending','paintTreeActive','syncCursorFromScroll','revealCursorInTree','pinnedHit','lastReveal'] },
  'summary': { title: '摘要窗格：搜尋、命中清單與節點範圍的 scope。', names: ['lastResult','summaryResult','searchSeq','activeGroup','SNIPPET_LIMIT','snippetShown','snippetScope','snippetScopeQuery','runSearch','renderSearchResult','renderSnippets','refreshTreeHits','showNodeHits','inGroup'] },
  'scopes': { title: '搜尋 scheme／左欄分頁：目錄樹、名詞、頻次（全文）、原書分頁、西文。', names: ['DirTree','dirTrees','treePhases','dirActive','dirError','dirLoading','labelTables','labelTableFor','labelFor','loadDirectoryTrees','countNodes','syncTreeTabs','realmHits','hitBadge','renderDirTree','depthColor','findNode','renderFreq','renderLatin','freqSegments','nameSegs','tagVas','tagSegments','lowerBound','wrappedText','countHitsPerSegment','treeScope','renderTerms','folioCache','folioEntries','renderFolio'] },
  'panes': { title: '右欄與進階面板：META／容量／文件／圖片／token 瀏覽。', names: ['containerSummary','THUMB_LIMIT','renderResources','renderMeta','renderContainers','renderDocs','renderTokens','hideAllExcept','showAllClasses','PAGE','tokenOffset','tokenList','renderTokenList','appendTokenRows','showToken','binarySearch','vapaProbe'] },
  'ui': { title: '版面與 wiring：欄寬、分隔線、分頁切換、進階模式、boot。', names: ['COLS_KEY','MIN_SIDE','MAX_SIDE','DEFAULT_COLS','readCols','applyCols','saveCols','setSide','toggleSide','attachSplitter','showTab','ADV_KEY','advanced','readAdvanced','defaultLeftTab','setAdvanced','boot'] },
};

function index(lines: string[]) {
  const out: Array<{ name: string; line: number; kind: string }> = [];
  lines.forEach((l, i) => { const m = RE.exec(l); if (m) out.push({ name: m[3] ?? m[6], line: i + 1, kind: m[3] ? 'fn' : m[5] }); });
  return out;
}
/** first line of each declaration, INCLUDING its leading doc comment */
function startsOf(lines: string[], decls: Array<{ line: number }>): number[] {
  return decls.map((d) => {
    let s = d.line;
    for (;;) {
      if (s <= 1) break;
      const t = lines[s - 2].trim();
      if (t.startsWith('*') || t.startsWith('/**') || t.startsWith('//') || t.startsWith('/*')) s--; else break;
    }
    return s;
  });
}
/** [start, end] of declaration i; `end` is the line before the NEXT start, so the
 *  next declaration's doc comment is not stolen (that overlapped the spans and
 *  removed the head of the following function). */
function spanOf(lines: string[], starts: number[], i: number): [number, number] {
  const s = starts[i];
  let e = i + 1 < starts.length ? starts[i + 1] - 1 : lines.length;
  while (e > s && lines[e - 1].trim() === '') e--;
  return [s, e];
}
function wordRe(n: string) { return new RegExp('(?<![\\w$.])' + n.replace(/\$/g, '\\$') + '(?![\\w$])'); }

const all = readdirSync(DIR).filter((f) => f.endsWith('.ts') && f !== 'viewer.ts');
const registry: Record<string, string> = {};   // name -> module
for (const f of all) {
  const mod = f.replace(/\.ts$/, '');
  const t = readFileSync(DIR + f, 'utf8');
  const m = /export \{([^}]*)\};/.exec(t);
  if (m) for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) registry[n] = mod;
}
const vSrc = readFileSync(V, 'utf8');
const vDecls = index(vSrc.split('\n'));
for (const d of vDecls) if (!registry[d.name]) registry[d.name] = '';

const spec = MODULES[process.argv[2]];
if (!spec) { console.error('unknown module: ' + process.argv[2] + '  (have: ' + Object.keys(MODULES).join(', ') + ')'); process.exit(2); }

let lines = vSrc.split('\n');
const decls = index(lines);
const picked = spec.names.map((n) => {
  const i = decls.findIndex((d) => d.name === n);
  if (i < 0) throw new Error('not found: ' + n);
  return { name: n, i };
}).sort((a, b) => a.i - b.i);
const starts = startsOf(lines, decls);
const spans = picked.map((p) => { const [s, e] = spanOf(lines, starts, p.i); return { name: p.name, s, e }; });
for (let k = 1; k < spans.length; k++) if (spans[k].s <= spans[k - 1].e) throw new Error('overlapping spans: ' + spans[k - 1].name + ' / ' + spans[k].name);
const payload = spans.map((sp) => lines.slice(sp.s - 1, sp.e).join('\n')).join('\n\n');

// candidates come from the registry (viewer + every module already split off):
// a symbol that moved to another module still has to be imported from THERE.
const need = new Set<string>();
for (const name of Object.keys(registry)) {
  if (spec.names.includes(name)) continue;
  if (wordRe(name).test(payload)) need.add(name);
}
const byModule: Record<string, string[]> = {};
for (const n of need) { const owner = registry[n]; if (owner === undefined) throw new Error('unknown symbol: ' + n); (byModule[owner] ||= []).push(n); }
const importLines = Object.keys(byModule).sort().map((mod) => {
  const from = mod === '' ? './viewer' : './' + mod;
  return "import { " + byModule[mod].sort().join(', ') + " } from '" + from + "';";
});
const head = '/**\n * ' + spec.title + '\n *\n * Split out of viewer.ts (ADBVIEW-HANDOVER 3.2). Shared state is read from\n * ./viewer and the other split modules as ESM live bindings; a module OWNS the\n * state it declares, and other modules get/set it through that module\'s exports.\n */\n' + importLines.join('\n') + '\n\n';
const modName = process.argv[2];
writeFileSync(DIR + modName + '.ts', head + payload + '\n\nexport { ' + picked.map((p) => p.name).sort().join(', ') + ' };\n', 'utf8');

for (const sp of spans.slice().sort((a, b) => b.s - a.s)) lines.splice(sp.s - 1, sp.e - sp.s + 1);
let doc = lines.join('\n');
for (const n of picked.map((p) => p.name)) {
  doc = doc.replace(new RegExp('^(?!export )((?:async )?function ' + n + '\\b)', 'm'), 'export $1');
  doc = doc.replace(new RegExp('^(?!export )(const ' + n + '\\b)', 'm'), 'export $1');
  doc = doc.replace(new RegExp('^(?!export )(let ' + n + '\\b)', 'm'), 'export $1');
}
// what does the remaining viewer.ts still use?
const stillUsed = picked.map((p) => p.name).filter((n) => wordRe(n).test(doc));
if (stillUsed.length) doc = doc.replace("} from './search';\n", "} from './search';\nimport { " + stillUsed.sort().join(', ') + " } from './" + modName + "';\n");
writeFileSync(V, doc, 'utf8');

// re-point every other module's import of a name that just moved
for (const f of all) {
  const path = DIR + f;
  let t = readFileSync(path, 'utf8');
  const m = /import \{([^}]*)\} from '\.\/viewer';\n/.exec(t);
  if (!m) continue;
  const syms = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  const stay = syms.filter((s) => registry[s] !== modName && !picked.some((p) => p.name === s));
  const move = syms.filter((s) => picked.some((p) => p.name === s));
  if (!move.length) continue;
  t = t.replace(m[0], (stay.length ? "import { " + stay.sort().join(', ') + " } from './viewer';\n" : '') + "import { " + move.sort().join(', ') + " } from './" + modName + "';\n");
  writeFileSync(path, t, 'utf8');
}
console.log('split ' + modName + ': ' + spans.length + ' decls, ' + payload.split('\n').length + ' lines; imports ' + importLines.join(' | ') + '; viewer keeps ' + stillUsed.length);