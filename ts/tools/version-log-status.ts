/**
 * 發佈前：看各 adb 工作區的 `version-log.md` 有哪些列還沒併進母區的彙整版。
 *
 *   cd ts && bun run tools/version-log-status.ts [--json]
 *
 * 分工（作者 2026-11-06）：各工作區自己維護 `version-log.md`；母區
 * `docs/adb/adb-version-log.md` 是彙整版，發佈前用這支把它們收進來。
 * 比對只認 sha（12 碼以上）——各區的表格欄位可以不同（cyd 多了行數／成品／發布）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const ROOT = 'D:\\2026';
const MASTER = `${ROOT}\\adb-converter\\docs\\adb\\adb-version-log.md`;
const JSON_OUT = process.argv.includes('--json');

const SHA = /\b([0-9a-fA-F]{12,64})\b/;
const ADB = /([A-Za-z0-9_.-]+\.adb)/;

interface Row { adb: string; sha: string; text: string }

function rowsOf(file: string): Row[] {
  const out: Row[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (!cells.length || /^adb$/i.test(cells[0]) || /^[-: ]+$/.test(cells[0])) continue;
    const m = SHA.exec(line);
    if (!m) continue;
    const a = ADB.exec(line);
    out.push({ adb: a ? a[1] : cells[0].replace(/`/g, ''), sha: m[1].toLowerCase(), text: line.trim() });
  }
  return out;
}

const master = new Set(rowsOf(MASTER).map((r) => r.sha));

const reports: { workspace: string; rows: number; missing: Row[] }[] = [];
for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const file = `${ROOT}\\${dir.name}\\version-log.md`;
  if (!existsSync(file)) continue;
  const rows = rowsOf(file);
  const missing = rows.filter((r) => !master.has(r.sha));
  reports.push({ workspace: dir.name, rows: rows.length, missing });
}

reports.sort((a, b) => b.missing.length - a.missing.length || a.workspace.localeCompare(b.workspace));

if (JSON_OUT) {
  console.log(JSON.stringify(reports.map((r) => ({ workspace: r.workspace, rows: r.rows, missing: r.missing.map((m) => ({ adb: m.adb, sha: m.sha })) })), null, 2));
} else {
  let total = 0;
  for (const r of reports) {
    const flag = r.missing.length ? '← 待併入' : '';
    console.log(`${r.workspace.padEnd(13)} ${String(r.rows).padStart(4)} 列  ${String(r.missing.length).padStart(4)} 列未併入 ${flag}`);
    for (const m of r.missing.slice(0, 20)) console.log(`    ${m.adb}  ${m.sha.slice(0, 12)}`);
    if (r.missing.length > 20) console.log(`    …還有 ${r.missing.length - 20} 列`);
    total += r.missing.length;
  }
  console.log(total ? `\n共 ${total} 列要併進 docs/adb/adb-version-log.md` : '\n各工作區的紀錄都已併入彙整版。');
  process.exitCode = total ? 0 : 0;
}
