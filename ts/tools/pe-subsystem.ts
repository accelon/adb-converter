/**
 * Windows PE 檔頭的子系統（`IMAGE_OPTIONAL_HEADER.Subsystem`）。
 *
 *   bun run tools/pe-subsystem.ts <exe 或多個 exe>
 *
 * 2 = WINDOWS_GUI（雙擊不跳命令列）、3 = WINDOWS_CUI（console，會開一個命令列視窗）。
 * `go build` 預設是 3；只有加 `-ldflags "-H windowsgui"` 才是 2。發佈 exe 前用它確認，
 * 免得一次漏掉 flag 的本機重建就把「使用者會看到黑視窗」的版本送出去（2026-10-25 就是這樣）。
 */
import { readFileSync } from 'node:fs';

export function peSubsystem(file: string): number {
  const b = readFileSync(file);
  const pe = b.readInt32LE(0x3c);          // e_lfanew
  if (b.readUInt32LE(pe) !== 0x00004550) throw new Error('not a PE file: ' + file); // "PE\0\0"
  const opt = pe + 24;                     // PE sign + COFF header (20)
  const magic = b.readUInt16LE(opt);       // 0x10b = PE32, 0x20b = PE32+
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('unknown optional header: ' + magic);
  return b.readUInt16LE(opt + 68);         // Subsystem（PE32 與 PE32+ 同位）
}

export function subsystemLabel(n: number): string {
  return n === 2 ? 'GUI（雙擊不跳命令列）' : n === 3 ? 'console（會開命令列視窗）' : 'unknown(' + n + ')';
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: bun run tools/pe-subsystem.ts <exe> [...]');
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    const n = peSubsystem(f);
    console.log(`${n === 2 ? 'ok  ' : 'FAIL'} ${f}  subsystem=${n} ${subsystemLabel(n)}`);
    if (n !== 2) bad++;
  }
  process.exit(bad ? 1 : 0);
}
