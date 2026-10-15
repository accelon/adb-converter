#!/usr/bin/env bun
/**
 * XML linter for .adb databases.
 *
 * indexer.dpr / TDocDef.Validate only reports a few structural problems (see
 * SPEC.md section 16) and the export path never repairs anything, so this tool
 * scans the actual database text and reports what would make the exported XML
 * malformed:
 *
 *   - mismatched / unclosed / orphan close tags        (tag stack, line numbers)
 *   - a tag that straddles a `檔` (file) boundary      (each exported file must
 *                                                       be well formed on its own)
 *   - a tag name that the build never declared         (the indexer skipped it:
 *                                                       `Undefine tag` / `invalid tag`)
 *   - a bare `&` in text, an unterminated `<`, an unquoted attribute
 *   - the reverse lookups of SPEC.md section 16: tag instances in the text vs
 *     tables/tags.virtual, and open/close list lengths for every tag name
 *
 *   bun run tools/xml-lint.ts <file.adb | directory> [...] [--max N] [--json]
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAdbText, type AdbText } from '../src/adbtext';

interface Issue {
  line: number;
  kind: string;
  message: string;
}

interface LintResult {
  file: string;
  lines: number;
  tagsSeen: number;
  issues: Issue[];
  issueTotal: number;
  issueCounts: Record<string, number>;
  separators: number;
  undeclared: string[];
  tagVirtual: number;
  tagInstances: number;
  suffix: string;
}

const VALUE_OPTS = new Set(['--max']);

function collectInputs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_OPTS.has(a)) i++; // skip the option value
      continue;
    }
    const st = statSync(a);
    if (!st.isDirectory()) {
      out.push(a);
      continue;
    }
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.adb$/i.test(e.name)) out.push(p);
      }
    };
    walk(a);
  }
  return out.sort();
}

/** Minimal XML well formedness scan of the tag stream of one database. */
function lint(adb: AdbText, maxIssues: number): LintResult {
  const declared = new Set<string>();
  for (const n of adb.tagNames) declared.add(n.startsWith('/') ? n.slice(1) : n);

  const issues: Issue[] = [];
  const undeclared = new Set<string>();
  const stack: { name: string; line: number }[] = [];
  let tagInstances = 0;

  // `檔` boundaries, expressed as line indices (VA -> line via lines.virtual)
  const fileTagAt = adb.tagNames.indexOf('檔');
  const boundaryLines = new Set<number>();
  if (fileTagAt >= 0) {
    for (const va of adb.tagHits(fileTagAt)) {
      let lo = 0;
      let hi = adb.linesVirtual.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (adb.linesVirtual[mid] < va) lo = mid + 1;
        else hi = mid;
      }
      boundaryLines.add(lo);
    }
  }

  const counts = new Map<string, number>();
  let issueTotal = 0;
  const push = (line: number, kind: string, message: string) => {
    issueTotal++;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (issues.length < maxIssues) issues.push({ line, kind, message });
  };

  // `檔` (FILE) is the document separator: databases use it either as a pair
  // (<檔 ...> ... </檔>) or as an unclosed marker that implicitly ends the
  // previous document. Treat it separately so it does not drown real problems.
  const isSeparator = (name: string): boolean => name === '檔' || name === '/檔';
  let separators = 0;

  for (let li = 0; li < adb.lines.length; li++) {
    const text = adb.lines[li];
    // state before this line: a new 檔 may legitimately start here while the
    // previous 檔 marker is still open
    const openAtLineStart = stack.filter((s) => !isSeparator(s.name));
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '&') {
        const m = /^&(#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/.exec(text.slice(i));
        if (!m) push(li + 1, 'entity', `bare & in text: ${JSON.stringify(text.slice(i, i + 12))}`);
        i += m ? m[0].length : 1;
        continue;
      }
      if (ch !== '<') {
        i++;
        continue;
      }
      // a tag starts here
      const rest = text.slice(i);
      if (rest.startsWith('<!--')) {
        const end = rest.indexOf('-->');
        if (end < 0) {
          push(li + 1, 'comment', 'unterminated comment');
          break;
        }
        i += end + 3;
        continue;
      }
      if (rest.startsWith('<![CDATA[')) {
        const end = rest.indexOf(']]>');
        if (end < 0) {
          push(li + 1, 'cdata', 'unterminated CDATA');
          break;
        }
        i += end + 3;
        continue;
      }
      const close = findTagEnd(text, i);
      if (close < 0) {
        push(li + 1, 'unterminated', `unterminated tag: ${JSON.stringify(rest.slice(0, 20))}`);
        break;
      }
      const raw = text.slice(i + 1, close);
      i = close + 1;

      if (raw.startsWith('?') || raw.startsWith('!')) continue; // PI / doctype

      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const isClose = body.startsWith('/');
      const name = (isClose ? body.slice(1) : body).split(/[\s/]/)[0];
      if (!name) continue;
      tagInstances++;
      if (!declared.has(name)) undeclared.add(name);

      const attrs = /\s+([^\s=/>]+)\s*(=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
      let m: RegExpExecArray | null;
      while ((m = attrs.exec(body.slice(name.length)))) {
        if (!m[2]) push(li + 1, 'attribute', `<${name}> attribute ${m[1]} has no value`);
        else if (!/^["']/.test(m[2].trim().slice(1))) push(li + 1, 'attribute', `<${name}> attribute ${m[1]} is not quoted`);
      }

      if (selfClosing) continue;
      if (isClose) {
        const top = stack.pop();
        if (!top) push(li + 1, 'mismatch', `</${name}> without an open tag`);
        else if (top.name !== name) push(li + 1, 'mismatch', `</${name}> closes <${top.name}> opened on line ${top.line}`);
      } else {
        stack.push({ name, line: li + 1 });
      }
    }
    if (boundaryLines.has(li)) {
      separators++;
      if (openAtLineStart.length) {
        push(
          li + 1,
          'file-boundary',
          `檔 boundary starts a new file but ${openAtLineStart.length} tag(s) are still open: ${openAtLineStart
            .slice(-3)
            .map((s) => `<${s.name}>@${s.line}`)
            .join(' ')}`,
        );
      }
    }
  }
  const leftover = stack.filter((s) => !isSeparator(s.name));
  separators += stack.length - leftover.length;
  for (const s of leftover.slice(-10)) {
    push(adb.lines.length, 'unclosed', `<${s.name}> opened on line ${s.line} is never closed`);
  }
  if (separators) {
    push(
      adb.lines.length,
      'separator',
      `檔 is used as an unclosed document separator (${separators} instances); every exported 檔 file therefore ` +
        `contains an unclosed <檔> element`,
    );
  }

  const tagVirtual = adb.table('tags.virtual').length;
  const suffix = `tags.virtual=${tagVirtual} tagInstances=${tagInstances}${tagVirtual === tagInstances ? '' : ` (diff ${tagInstances - tagVirtual})`}`;
  return {
    file: adb.path,
    lines: adb.lines.length,
    tagsSeen: tagInstances,
    issues,
    issueTotal,
    issueCounts: Object.fromEntries(counts),
    separators,
    undeclared: [...undeclared],
    tagVirtual,
    tagInstances,
    suffix,
  };
}

/** End of the tag that starts at `start` (index of '>'), respecting quotes. */
function findTagEnd(text: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') return i;
    if (c === '<') return -1; // a new tag started before this one ended
  }
  return -1;
}

const argv = process.argv.slice(2);
const maxIssues = argv.includes('--max') ? Number(argv[argv.indexOf('--max') + 1]) : 8;
const asJson = argv.includes('--json');
const files = collectInputs(argv);
if (files.length === 0) {
  console.error('usage: bun run tools/xml-lint.ts <file.adb | directory> [...] [--max N] [--json]');
  process.exit(2);
}

const results: LintResult[] = [];
let bad = 0;
for (const file of files) {
  const adb = readAdbText(file);
  const r = lint(adb, maxIssues);
  adb.close();
  results.push(r);
  if (r.issueTotal || r.undeclared.length) bad++;
  if (!asJson) {
    const kinds = new Map<string, number>();
    for (const it of r.issues) kinds.set(it.kind, (kinds.get(it.kind) ?? 0) + 1);
    const clean = r.issues.length === 0 && r.undeclared.length === 0;
    const head = `${clean ? 'ok  ' : 'WARN'} ${file}  lines=${r.lines} tags=${r.tagsSeen}  ${r.suffix}`;
    console.log(head);
    if (!clean) {
      const summary = [...kinds.entries()].map(([k, n]) => `${k}=${n}`).join(' ');
      console.log(`     issues: ${summary || '(none)'}${r.undeclared.length ? ` undeclaredTags=${r.undeclared.length}` : ''}`);
      for (const u of r.undeclared.slice(0, 5)) console.log(`     undeclared tag <${u}> (the indexer skipped it)`);
      const shown = new Map<string, number>();
      for (const it of r.issues) {
        const n = shown.get(it.kind) ?? 0;
        if (n >= 2) continue; // two examples per kind is enough in the console
        shown.set(it.kind, n + 1);
        console.log(`     line ${it.line} [${it.kind}] ${it.message}`);
      }
    }
  }
}
if (asJson) {
  const out = join(import.meta.dir, '..', '..', 'build', 'xml-lint.json');
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.error(`wrote ${out}`);
}
console.log(`\n${files.length} databases, ${bad} with findings`);
process.exit(0);
