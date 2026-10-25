/** 只匯出／匯入 revisions（不傳整個 adb）。 */
import type { AdbReader } from './adb';
import type { RevisionInfo } from './rebuild-browser';
import { addRevisions, allRevisions } from './revisions-store';
import { sha256Hex } from './sha256';

export const EXPORT_FORMAT = 'accelon26-revisions-export/1';

export interface RevisionsExport {
  format: string;
  exportedAt: string;
  db: { name: string; size: number; lineCount: number; headerCrc: number };
  revisions: any[];
}

interface ParsedRevision { info: RevisionInfo; record: any }

function parse(revisions: RevisionInfo[]): ParsedRevision[] {
  const out: ParsedRevision[] = [];
  for (const info of revisions) {
    try {
      const record = JSON.parse(new TextDecoder().decode(info.blob));
      if (record && record.format === 'accelon26-revision/1' && typeof record.id === 'string') out.push({ info, record });
    } catch { /* 壞掉的 block 跳過 */ }
  }
  return out;
}

function download(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function safeName(name: string): string {
  return (name || 'adb').replace(/[\\/:*?"<>|]/g, '_').replace(/\.adb$/i, '');
}

export async function exportRevisions(reader: AdbReader): Promise<number> {
  const parsed = parse(await allRevisions(reader));
  const revisions: any[] = [];
  for (const { info, record } of parsed) {
    if (!record.hash) {
      const h = await sha256Hex(info.blob);
      if (h) record.hash = 'sha256:' + h;
    }
    revisions.push(record);
  }
  const payload: RevisionsExport = {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    db: {
      name: reader.header.dbname || '',
      size: reader.header.size,
      lineCount: reader.header.lineCount,
      headerCrc: reader.header.crc32,
    },
    revisions,
  };
  download(JSON.stringify(payload, null, 2), safeName(reader.header.dbname || 'adb') + '-revisions.json');
  return revisions.length;
}

export interface ImportResult {
  added: number;
  skipped: number;
  error?: string;
}

export async function importRevisions(reader: AdbReader, file: File): Promise<ImportResult> {
  let data: any;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return { added: 0, skipped: 0, error: '不是有效的 JSON 檔' };
  }
  const list: any[] = Array.isArray(data?.revisions) ? data.revisions
    : (Array.isArray(data) ? data : []);
  if (!list.length) return { added: 0, skipped: 0, error: '檔案裡沒有 revisions' };
  const valid = list.filter((r) => r && r.format === 'accelon26-revision/1' && typeof r.id === 'string');
  if (!valid.length) return { added: 0, skipped: list.length, error: 'revisions 格式不認得' };

  const cur = { lineCount: reader.header.lineCount, headerCrc: reader.header.crc32 };
  const badBase = valid.some((r) => r.base && (
    Number(r.base.lineCount) !== cur.lineCount || Number(r.base.headerCrc) !== cur.headerCrc
  ));
  if (badBase && !window.confirm('這些 revisions 的基底行數／CRC 和目前 adb 不同，套用後行號可能對不上。仍要匯入嗎？')) {
    return { added: 0, skipped: 0, error: '基底不同，已取消' };
  }

  const existing = new Set((await allRevisions(reader)).map((r) => r.id));
  const add: RevisionInfo[] = [];
  for (const record of valid) {
    if (existing.has(record.id)) continue;
    add.push({ id: record.id, blob: new TextEncoder().encode(JSON.stringify(record)) });
    existing.add(record.id);
  }
  const added = addRevisions(reader, add);
  return { added, skipped: valid.length - added };
}
