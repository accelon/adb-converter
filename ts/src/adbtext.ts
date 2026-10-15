/**
 * Extract the text lines of an .adb using the delphi text model (physical
 * address grid, per block NUL termination, leading CR/LF skipped, code units
 * concatenated unchanged). Shared by the index comparison and the XML linter.
 */
import { closeSync, openSync, statSync } from 'node:fs';
import {
  blockOffsetByName,
  blockRange,
  decodePackedList,
  packedListSize,
  parseBlockSet,
  parseHeader,
  readAt,
  FILE_HEADER_SIZE,
  type AdbHeader,
  type BlockSet,
} from './format';
import { createDecoder } from './bz2';
import { decodeChunk } from './decode';
import { LineSplitter } from './textstream';

export interface AdbText {
  path: string;
  size: number;
  header: AdbHeader;
  srcBlockSize: number;
  sources: BlockSet;
  tables: BlockSet;
  outer: BlockSet;
  /** every line of the database text, in order */
  lines: string[];
  /** tables/lines.physical (cumulative byte end offset per line) */
  linesPhysical: number[];
  /** tables/lines.virtual (VA at the end of each line) */
  linesVirtual: number[];
  /** table accessor: reads a packed list block of the tables container */
  table: (name: string) => number[];
  /** names of the `tags` container = the tag names declared for this build */
  tagNames: string[];
  /** names of the `tokens` container = the token keys in the index */
  tokenNames: string[];
  /** hit list of one tag of the `tags` container */
  tagHits: (i: number) => number[];
  close: () => void;
}

export function readAdbText(path: string): AdbText {
  const fd = openSync(path, 'r');
  const size = statSync(path).size;
  const header = parseHeader(readAt(fd, 0, FILE_HEADER_SIZE));
  if (!header) {
    closeSync(fd);
    throw new Error(`${path}: not an Accelon3 .adb file`);
  }
  const S = header.srcBlockSize || 16384;
  const outer = parseBlockSet(fd, FILE_HEADER_SIZE);
  const sources = parseBlockSet(fd, blockOffsetByName(outer, 'source'));
  const tables = parseBlockSet(fd, blockOffsetByName(outer, 'tables'));

  const table = (name: string): number[] => {
    const at = blockOffsetByName(tables, name);
    return at ? decodePackedList(readAt(fd, at, packedListSize(fd, at))) : [];
  };
  const linesPhysical = table('lines.physical');
  const linesVirtual = table('lines.virtual');
  const namesOf = (container: string): string[] => {
    const at = blockOffsetByName(outer, container);
    return at ? parseBlockSet(fd, at).names : [];
  };
  const tagsAt = blockOffsetByName(outer, 'tags');
  const tagsBlock = tagsAt ? parseBlockSet(fd, tagsAt) : null;
  const tagNames = tagsBlock ? tagsBlock.names : [];
  const tokenNames = namesOf('tokens');
  /** hit list (virtual addresses) of the tag at block index i of the tags container */
  const tagHits = (i: number): number[] => {
    if (!tagsBlock || i < 0 || i >= tagsBlock.count) return [];
    const r = blockRange(tagsBlock, i);
    return r.end > r.start ? decodePackedList(readAt(fd, r.start, r.end - r.start)) : [];
  };

  const parts: string[] = [];
  const splitter = new LineSplitter(
    linesPhysical,
    { pushText: (s: string) => parts.push(s) },
    1 << 22,
    { stripNul: true, skipCrLf: true, keepBom: true },
  );
  const { decoder } = createDecoder('auto');
  const scratch = { buf: new Uint8Array(S * 4) };
  const n = sources.count;
  for (let first = 0; first < n; first += 64) {
    const last = Math.min(n, first + 64) - 1;
    const start = blockRange(sources, first).start;
    const end = blockRange(sources, last).end;
    const src = new Uint8Array(readAt(fd, start, end - start));
    const ends: number[] = [];
    for (let k = first; k <= last; k++) ends.push(blockRange(sources, k).end - start);
    const { out } = decodeChunk(
      decoder,
      { src, ends, hint: S, firstBlock: first, blockCount: n, model: 'delphi' },
      scratch,
    );
    splitter.push(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  }
  splitter.finish();
  decoder.close();

  return {
    path,
    size,
    header,
    srcBlockSize: S,
    sources,
    tables,
    outer,
    lines: parts.join('').split('\n'),
    linesPhysical,
    linesVirtual,
    table,
    tagNames,
    tokenNames,
    tagHits,
    close: () => closeSync(fd),
  };
}
