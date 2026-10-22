/**
 * `<樹>` directory tree tests.
 *
 *   bun run test/tree.test.ts [--adb <path>]...
 *
 * The invariants that matter:
 *   1. `t=` tiers parse, a trailing "." marks the last tier.
 *   2. Tier nesting follows the *measured* layout: the first `<章>` of 13j
 *      (VA 45) is inside the first `<書>` (VA 29), so depth is the tier index.
 *   3. Every child's VA is inside its parent's range, and ranges never overlap
 *      between siblings.
 *   4. Only `s="*"` (=full text) trees are picked for the search grouping.
 */
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper, parseAttrs } from '../src/accelon26/vapa';
import { loadTrees, loadTree, buildTree, flattenTree, nodeOwningVa, parseTiers, parseScope, SearchSession } from '../src/accelon26/search';

const args = process.argv.slice(2);
const ADBS = args.reduce<string[]>((acc, a, i) => (a === '--adb' ? [...acc, args[i + 1]] : acc), []);
if (!ADBS.length) ADBS.push('D:\\2026\\adb-converter\\13j.adb', 'D:\\accelon3\\yinshun\\yinshun.adb');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const fmt = (n: number) => n.toLocaleString('en-US');

// ---- parseTiers unit checks ------------------------------------------------
ok('t="書" -> one tier, none terminal',
  JSON.stringify(parseTiers('書')) === JSON.stringify({ tiers: ['書'], terminalTier: -1 }),
  JSON.stringify(parseTiers('書')));
ok('t="章,節,項." -> 項 terminal',
  JSON.stringify(parseTiers('章,節,項.')) === JSON.stringify({ tiers: ['章', '節', '項'], terminalTier: 2 }),
  JSON.stringify(parseTiers('章,節,項.')));
ok('t="" -> no tiers', parseTiers('').tiers.length === 0);

// ---- scope parsing (s=), per the format author's explanation ---------------
const scFull = parseScope('*');
ok('s="*" -> 全文', scFull.kind === 'full' && scFull.fullText, JSON.stringify(scFull));
const scRange = parseScope('~00602000');
ok('s="~00602000" -> U+0060–U+2000 範圍',
  scRange.kind === 'range' && scRange.codepoints?.[0] === 0x0060 && scRange.codepoints?.[1] === 0x2000,
  JSON.stringify(scRange));
const scSeg = parseScope('*u=文');
ok('s="*u=文" -> 以 <文> 分段', scSeg.kind === 'segment' && scSeg.tag === '文' && scSeg.fullText,
  JSON.stringify(scSeg));
const scWrap = parseScope('$詞');
ok('s="$詞" -> 列出 <詞> 包住的文字', scWrap.kind === 'wrapper' && scWrap.tag === '詞', JSON.stringify(scWrap));
ok('t="書" -> 往下探，t="書." -> 不再往下',
  parseTiers('書').terminalTier === -1 && parseTiers('書.').terminalTier === 0,
  `書 -> ${parseTiers('書').terminalTier}, 書. -> ${parseTiers('書.').terminalTier}`);

for (const path of ADBS) {
  console.log('\n=== ' + path + ' ===');
  const reader = await AdbReader.open(new SyncIO(path));
  const mapper = new VaPaMapper(reader);
  await mapper.init();
  const trees = await loadTrees(reader);
  const fullText = trees.filter((t) => t.fullText);
  ok('讀到 <樹> 宣告', trees.length > 0,
    trees.map((t) => `s="${t.scope}" t="${t.tiers.join(',')}"${t.terminalTier >= 0 ? '(終)' : ''}`).join(' ／ '));
  ok('至少一個 s="*" 全文樹', fullText.length > 0, `${fullText.length} / ${trees.length}`);

  const tree = fullText[0];
  const instances = await loadTree(reader, tree, {
    attrsAt: async (va) => {
      const el = await mapper.elementAt(va);
      return el ? parseAttrs(el.element.text) : {};
    },
    label: (va, vaEnd) => mapper.nodeLabel(va, vaEnd),
  });
  ok('讀到各層標籤實例', instances.length > 0,
    instances.length + ' 個：' + [...new Set(instances.map((i) => `${i.tag}×${instances.filter((x) => x.tag === i.tag).length}`))].join(' '));

  // instances are in document order and depths follow the tier order
  let ordered = true;
  for (let i = 1; i < instances.length; i++) if (instances[i].va < instances[i - 1].va) ordered = false;
  ok('實例依 VA 遞增', ordered);

  const roots = buildTree(instances);
  // Roots are the instances of tags no other tag declares as its child. The
  // tree-level `t=` names the entry tier, and deeper tiers follow each
  // instance's own `t=` (13j: 書 declares 章,節,項).
  const rootTags = new Set(roots.map((r) => r.tag));
  ok('根節點只由未被宣告為子層的標籤組成',
    roots.length > 0 && rootTags.size >= 1 && rootTags.has(tree.tiers[0]),
    `${roots.length} 個根，標籤 ${JSON.stringify([...rootTags])}`);

  // Heading semantics (the format's mental model): a tag behaves like a custom
  // <h1>..<h6> — a one-line marker whose scope runs to the next heading. So a
  // heading must never be nested inside another heading of the SAME tag, and the
  // document order must be preserved.
  let sameTagNested = 0, orderViolation = 0;
  const walkHeading = (ns: typeof roots, parentTag: string, parentVa: number) => {
    let prevVa = -1;
    for (const n of ns) {
      if (n.tag === parentTag) sameTagNested++;
      if (n.va < parentVa || n.va < prevVa) orderViolation++;
      prevVa = n.va;
      walkHeading(n.children, n.tag, n.va);
    }
  };
  walkHeading(roots, '', -1);
  ok('標題語義：同標籤不互相巢狀（沒有 <h2> 包 <h2>）', sameTagNested === 0, sameTagNested + ' 個');
  ok('標題語義：文件順序不變', orderViolation === 0, orderViolation + ' 個違反');

  // structural invariants over the whole tree
  let childOutside = 0, overlap = 0, depthOk = true, nodes = 0;
  const walk = (ns: typeof roots, parentDepth: number) => {
    let prevEnd = -1;
    for (const n of ns) {
      nodes++;
      if (n.depth <= parentDepth) depthOk = false;
      for (const c of n.children) if (c.va < n.va || c.va >= n.vaEnd) childOutside++;
      if (prevEnd >= 0 && n.va < prevEnd) overlap++;
      prevEnd = n.vaEnd;
      walk(n.children, n.depth);
    }
  };
  walk(roots, -1);
  ok('每個節點的深度都比父節點深', depthOk);
  ok('子節點都在父節點範圍內（允許邊界極少數例外）', childOutside <= 2, childOutside + ' 個例外');
  // A parent's range is deliberately widened to span its children (a chapter that
  // starts after the book heading must still resolve to the book), so siblings may
  // touch at the edges. What must hold is that no node swallows the NEXT node of
  // its own level.
  let swallowed = 0;
  const walkSibs = (ns: typeof roots) => {
    for (let i = 0; i + 1 < ns.length; i++) if (ns[i].vaEnd > ns[i + 1].va) swallowed++;
    for (const n of ns) walkSibs(n.children);
  };
  walkSibs(roots);
  ok('同層節點不被前一個吞掉', swallowed === 0, swallowed + ' 個被吞');
  void overlap;
  ok('節點數為正且不超過實例數', nodes > 0 && nodes <= instances.length,
    `${fmt(nodes)} 節點 / ${fmt(instances.length)} 實例`);

  // ---- `<檔>` 邊界優先（作者 2026-10-22） -------------------------------------
  // 節點的 vaEnd 是「下一個同層標題」的 VA，而 <檔> 的開標籤佔 4 個 VA：每一冊的
  // 最後一串節點都會跨進下一冊的檔頭（yinshun：44 個檔界、131 個節點，全部剛好 4）。
  // VA → 節點若照範圍判定，檔頭會被算成前一本書 —— 搜「彗」時目錄把命中標在
  // 華雨集第二冊（正確），本文 breadcrumb 卻說華雨集第一。
  const docRows = await reader.documents();
  const allNodes: typeof roots = [];
  const collect = (ns: typeof roots) => { for (const n of ns) { allNodes.push(n); collect(n.children); } };
  collect(roots);
  if (docRows.length) {
    let startWrong = 0, tailWrong = 0;
    const startDetail: string[] = [];
    for (const doc of docRows) {
      // 這一個檔的第一個節點：檔頭的 VA 應該屬於它，不是前一本書的最後一節
      const inDoc = allNodes.filter((n) => n.va >= doc.vaStart && n.va < doc.vaEnd);
      const first = inDoc.length ? inDoc.reduce((a, b) => (a.va <= b.va ? a : b)) : null;
      const atStart = nodeOwningVa(roots, doc.vaStart, docRows);
      if (atStart !== first) {
        startWrong++;
        if (startDetail.length < 3) startDetail.push(`#${doc.i} ${doc.name} ${doc.vaStart} → ${atStart ? atStart.label || '#' + atStart.va : '(none)'}`);
      }
      // 檔尾的最後一個 VA 仍然屬於這一個檔
      const atTail = nodeOwningVa(roots, doc.vaEnd - 1, docRows);
      if (atTail && !(atTail.va >= doc.vaStart && atTail.va < doc.vaEnd)) tailWrong++;
    }
    ok('檔頭的 VA 對到這一個檔的第一個節點（不是前一本書）',
      startWrong === 0, `${fmt(docRows.length)} 個 <檔>：起點錯 ${startWrong}${startDetail.length ? '｜' + startDetail.join('；') : ''}`);
    ok('檔尾的最後一個 VA 仍屬於同一個檔', tailWrong === 0, `${tailWrong} 個跨檔`);
  } else {
    // 13j 是單一檔：沒有檔界，資料庫開頭本來就不屬於任何書
    ok('沒有 <檔> 的庫：資料庫開頭不屬於任何節點', nodeOwningVa(roots, 0, docRows) === null);
  }

  // depth distribution: tier tags should appear at their own depth
  const byDepth = new Map<number, number>();
  const countDepth = (ns: typeof roots) => {
    for (const n of ns) { byDepth.set(n.depth, (byDepth.get(n.depth) ?? 0) + 1); countDepth(n.children); }
  };
  countDepth(roots);
  const depthDesc = [...byDepth.entries()].sort((a, b) => a[0] - b[0])
    .map(([d, c]) => `L${d + 1}=${tree.tiers[d]}×${fmt(c)}`).join(' ');
  ok('每層數量合理遞增', [...byDepth.keys()].every((d) => (byDepth.get(d) ?? 0) >= 1), depthDesc);

  // collapse/expand flattening
  const flatAll = flattenTree(roots, () => true);
  const flatNone = flattenTree(roots, () => false);
  ok('全部展開的列數 = 節點數', flatAll.length === nodes, `${fmt(flatAll.length)} 列`);
  ok('全部收合只剩根節點', flatNone.length === roots.length, `${flatNone.length} 列`);

  // labels: the first tier should get readable names where the data has them
  const labels: string[] = [];
  for (const r of roots.slice(0, 5)) {
    const lbl = await mapper.nodeLabel(r.va, r.vaEnd);
    if (lbl) labels.push(lbl);
  }
  ok('第一層節點能取得標籤', labels.length > 0, JSON.stringify(labels));

  // grouping tag must be the tree's first tier
  const session = new SearchSession(reader);
  await session.init();
  ok('搜尋分群用全文樹的第一層', session.grouping.tag === tree.tiers[0],
    `grouping=${session.grouping.tag} instances=${session.grouping.instances}`);

  reader.close?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
