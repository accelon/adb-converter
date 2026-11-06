/**
 * AdbEngine：adb-skill 的程式入口（二次開發用）。
 *
 *   import { openAdb } from './engine';
 *   const db = await openAdb('13j.adb');
 *   console.log(db.title, db.lines);
 *   const rows = await db.toc();          // [{depth,tag,label,va,vaEnd}]
 *   const hits = await db.search('涅槃');  // [{line,text,va}]
 *   const text = await db.line(42);       // 去標籤的那一行
 *   await db.exportText('out');           // 每檔一份純文字
 */
import { AdbReader, SyncIO } from '../../src/accelon26/adb';
import { VaPaMapper } from '../../src/accelon26/vapa';
import { SearchSession, loadTrees, loadTree } from '../../src/accelon26/search';

export { AdbReader, SyncIO, VaPaMapper, SearchSession, loadTrees, loadTree };
export { parseQuery } from '../../src/accelon26/query';
export { Tokenizer } from '../../src/tokenize';

/** 去掉標籤、解 XML 實體 */
export const plain = (s: string): string => s
  .replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export interface TocRow { depth: number; tag: string; label: string; va: number; vaEnd: number }
export interface Hit { line: number; va: number; text: string }

export class AdbEngine {
  readonly reader: AdbReader;
  readonly mapper: VaPaMapper;
  readonly file: string;
  private search_: SearchSession | null = null;

  private constructor(reader: AdbReader, mapper: VaPaMapper, file: string) {
    this.reader = reader;
    this.mapper = mapper;
    this.file = file;
  }

  static async open(file: string): Promise<AdbEngine> {
    const reader = await AdbReader.open(new SyncIO(file));
    const mapper = new VaPaMapper(reader);
    await mapper.init();
    return new AdbEngine(reader, mapper, file);
  }

  get title(): string { return this.reader.header.dbcname || this.reader.header.dbname; }
  get lines(): number { return this.reader.header.lineCount; }
  get dbname(): string { return this.reader.header.dbname; }
  get tags(): string[] { return (this.reader.containers.get('tags')?.names ?? []).filter((n) => !n.startsWith('/')); }

  /** 一行原文（含標籤） */
  raw(line: number): Promise<string> { return this.mapper.lineText(line); }
  /** 一行純文字 */
  async line(line: number): Promise<string> { return plain(await this.mapper.lineText(line)); }

  /** 連續幾行的純文字（含頭尾） */
  async text(from: number, to: number): Promise<string[]> {
    const out: string[] = [];
    for (let i = from; i <= to && i < this.lines; i++) out.push(await this.line(i));
    return out;
  }

  /** 目錄樹；沒宣告 <樹> 回空陣列 */
  async toc(): Promise<TocRow[]> {
    const trees = await loadTrees(this.reader);
    if (!trees.length) return [];
    const nodes = (await loadTree(this.reader, trees[0])) as unknown as { depth?: number; tag: string; label?: string; va: number; vaEnd: number }[];
    const rows: TocRow[] = [];
    for (const n of nodes) {
      let label = n.label ?? '';
      if (!label) {
        const line = this.mapper.edgeLine(n.va);
        let t = (await this.mapper.lineText(line)).replace(new RegExp('^\\s*<' + n.tag + '(?=[\\s>])[^>]*>'), '');
        const close = t.indexOf('</' + n.tag + '>');
        if (close >= 0) t = t.slice(0, close);
        label = plain(t).trim();
      }
      rows.push({ depth: n.depth ?? 0, tag: n.tag, label, va: n.va, vaEnd: n.vaEnd });
    }
    return rows;
  }

  private async sess(): Promise<SearchSession> {
    if (!this.search_) { this.search_ = new SearchSession(this.reader); await this.search_.init(); }
    return this.search_;
  }

  /** 全文搜尋；回傳的 line 是行號（0 起算），同一行只留第一筆 */
  async search(query: string, limit = 20): Promise<{ total: number; ms: number; missing: string[]; hits: Hit[] }> {
    const s = await this.sess();
    const res = await s.search(query, 5000);
    const seen = new Set<number>();
    const hits: Hit[] = [];
    for (const h of res.hits) {
      const line = this.mapper.edgeLine(h.va);
      if (seen.has(line)) continue;
      seen.add(line);
      hits.push({ line, va: h.va, text: await this.line(line) });
      if (hits.length >= limit) break;
    }
    return { total: res.hits.length, ms: Math.round(res.ms), missing: res.missing, hits };
  }
}

/** 開一本 adb（等於 AdbEngine.open） */
export const openAdb = (file: string): Promise<AdbEngine> => AdbEngine.open(file);
