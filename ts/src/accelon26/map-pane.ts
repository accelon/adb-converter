/**
 * 左欄「對照」分頁：高麗藏 ⇄ 大正藏 位置換算（2026-10-30）。
 *
 * 資料在 `goryeo_taisho.adb`：
 *   align/posmap  兩藏逐字對照表（原本內嵌在 goryeo.adb）
 *   map/index     6,357 卷的經號／卷號／卷題／起訖（選擇清單用）
 *   檔頭 `<樹 m="taisho">` 宣告這個分頁；`m` 的值是預設的來源側。
 *
 * 三種用法：
 *   1. 開著 goryeo_taisho.adb：左欄「對照」列出 6,357 卷，可以選，也可以直接輸入位址。
 *   2. 讀大正藏時：選取區選單多出「看大正藏圖版」；有對照表時還有「看高麗藏圖版」。
 *   3. 讀高麗藏時：對照表有序號，一樣可以換到（或看）大正藏的位置。
 *
 * 換址本身不需要經文：位址 → 行 → 漢字位移 → 對應段 → 另一側位移 → 位址
 * （posmap.ts）。經文只在「在大正藏／高麗藏開啟」時才需要。
 */
import { AdbReader, BlobIO } from './adb';
import { catalog, openDbs } from './dbs';
import { $, escapeHtml, mapper, reader, session, setStatus } from './viewer';
import {
  addressOfSeq, formatAddress, loadPosMap, parseLooseAddress, type Address, type PosMap, type Side,
} from './posmap';
import { loadMapIndex, type MapRow } from './map-index';
import { anchorVa, openCharPosition, openInMain, pageIdAtVa, parseCharPosition, readerFor, type CharPosition } from './xref';
import { goryeoPlateUrl, kabcDataId, taishoPlateUrl } from './plates';
import { markLineRange } from './doc-pane';

const MAP_DB = 'goryeo_taisho';
const COL = 'abcdefg';
const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 這個庫是不是兩藏之一（位址換算只對 T／K 有意義）。 */
export function mapSideOf(r: AdbReader | null): Side | null {
  const name = r?.header.dbname ?? '';
  if (name === 'taisho') return 'T';
  if (name === 'goryeo') return 'K';
  return null;
}

// ---------------------------------------------------------------- 對照表的來源

let fileCache: { key: string; r: AdbReader } | null = null;

/**
 * 對照表所在的 adb：先看目前這個庫（舊 goryeo.adb 仍有 align），再看開著的
 * goryeo_taisho，最後從 catalog（桌面版列出的資料夾）直接開檔。
 */
export async function mapReader(): Promise<AdbReader | null> {
  if (reader?.containers.get('align')) return reader;
  const live = await readerFor(MAP_DB).catch(() => null);
  if (live?.containers.get('align')) return live;
  const base = (n: string) => n.replace(/\.adb$/i, '').toLowerCase();
  const slot = openDbs.find((d) => d.name === MAP_DB || base(d.file.name) === MAP_DB);
  const slotReader = (slot?.core as { reader?: AdbReader } | undefined)?.reader;
  if (slotReader?.containers.get('align')) return slotReader;
  const e = catalog.find((x) => x.name === MAP_DB || base(x.file.name) === MAP_DB);
  if (!e) return null;
  if (fileCache?.key === e.key) return fileCache.r;
  const r = await AdbReader.open(new BlobIO(e.file));
  fileCache = { key: e.key, r };
  return r;
}

let pmCache: { r: AdbReader; pm: PosMap } | null = null;

/** 對照表（沒有 goryeo_taisho.adb 就回 null）。 */
export async function mapPosMap(): Promise<PosMap | null> {
  const r = await mapReader();
  if (!r) return null;
  if (pmCache?.r === r) return pmCache.pm;
  const pm = await loadPosMap(r);
  pmCache = { r, pm };
  return pm;
}

let rowsCache: { r: AdbReader; rows: MapRow[] } | null = null;

/** 卷目錄（只有 goryeo_taisho.adb 有 map 容器）。 */
export async function mapRows(): Promise<MapRow[]> {
  const r = (reader?.containers.get('map') ? reader : null) ?? await mapReader();
  if (!r) return [];
  if (rowsCache?.r === r) return rowsCache.rows;
  const rows = (await loadMapIndex(r)) ?? [];
  rowsCache = { r, rows };
  return rows;
}

// ---------------------------------------------------------------- 位址換算

export interface ConvertOut {
  input: string;
  from: Address;
  t: Address | null;
  k: Address | null;
  tsutra: string;
  tjuan: number;
  ksutra: string;
  kjuan: number;
  exact: boolean;
  note: string;
  row?: MapRow;
}

function rowFor(rows: MapRow[], tsutra: string, tjuan: number): MapRow | undefined {
  return rows.find((x) => x.tsutra === tsutra && x.tjuan === tjuan);
}

/** 一位址 → 另一側（找不到對照就回 null，附原因）。 */
export async function convertAddress(addr: Address): Promise<ConvertOut | { error: string }> {
  const pm = await mapPosMap();
  if (!pm) return { error: '找不到對照表：請先開啟 goryeo_taisho.adb。' };
  const r = pm.convert(addr);
  if (!r.ok) return { error: r.note || '此位址不在對照範圍內。' };
  const rows = await mapRows();
  return {
    input: formatAddress(addr),
    from: addr, t: r.t, k: r.k,
    tsutra: r.tsutra, tjuan: r.tjuan, ksutra: r.ksutra, kjuan: r.kjuan,
    exact: r.exact, note: r.note,
    row: rowFor(rows, r.tsutra, r.tjuan),
  };
}

/** 文字輸入 → 位址 → 另一側。輸入可以省略藏別、欄、行（預設 a 欄第 1 行）。 */
export async function convertText(text: string, defaultSide: Side = 'T'): Promise<ConvertOut | { error: string }> {
  const addr = parseLooseAddress(text, defaultSide);
  if (!addr) return { error: `位址看不懂：「${text}」。例：T05p0002c0405、K01p0001a0105、5p2c。` };
  return convertAddress(addr);
}

/**
 * 本文目前位置 → 位址。
 *
 * 位址的頁／欄取自最近的 `<頁 id="NpMc">`；欄內的「第幾個字」用漢字位移算，
 * 不用 adb 行號：兩藏的斷行不同（大正藏 adb 與對照表用的 SAT 文字行界也不完全
 * 一樣），頁／欄是共通的，欄內第幾個漢字才是穩定座標。再由對照表的幾何把
 * 「欄內第幾個字」換成該側的 pcl 行號與行內偏置。
 *
 * 頁標記不一定在行首：卷首是 `…<卷>卷題</卷><頁 id="…"/>`，卷題就是這一欄的
 * 第 1 行；一般情形標記後面才是這一欄的字。
 */
export async function addressAtLine(line: number, hanPrefix = 0): Promise<Address | null> {
  const r = reader;
  const side = mapSideOf(r);
  if (!r || !side || !mapper) return null;
  const lines = mapper.linesVirtual;
  if (!lines?.length || line < 0 || line >= lines.length) return null;
  const va = lines[line];
  if (va == null) return null;
  const rawLine = await r.physicalText(mapper.lineStartOf(line), mapper.lineStartOf(line + 1));
  // 這一行的頁標記：卷首行是 `<段/><書>…</書><卷>卷題</卷><頁 id="…"/>`，
  // 行的 VA 在頁標記之前，pageIdAtVa 會指到上一頁，所以行內有標記就用它。
  let pageId = '';
  for (const mm of rawLine.matchAll(/<頁 id="([^"]+)"/g)) pageId = mm[1];
  if (!pageId) pageId = await pageIdAtVa(va);
  const m = /^(\d{1,3})p(\d{1,4})([a-g])?$/i.exec(pageId);
  if (!m) { console.debug('map: no page id', { line, pageId, rawLine: rawLine.slice(0, 60) }); return null; }
  const vol = Number(m[1]);
  const page = Number(m[2]);
  const col = m[3] ? m[3].toLowerCase().charCodeAt(0) - 97 : 0;
  const pageVa = await anchorVa(r, pageId);
  if (pageVa == null) { console.debug('map: anchor missing', pageId); return null; }
  // 標記可能在上一行的結尾（VA 剛好等於那一行的結尾時 lineOfVa 會指到下一行）
  let markLine = mapper.lineOfVa(pageVa);
  const markerText = `<頁 id="${pageId}"`;
  const hasMarker = async (i: number): Promise<boolean> => i >= 0
    && (await r.physicalText(mapper.lineStartOf(i), mapper.lineStartOf(i + 1))).includes(markerText);
  if (!(await hasMarker(markLine))) {
    if (await hasMarker(markLine - 1)) markLine -= 1;
    else { console.debug('map: marker line not found', { pageId, line }); return null; }
  }
  if (line < markLine) { console.debug('map: line before mark', { line, markLine }); return null; }
  const markText = pageId && line === markLine ? rawLine
    : await r.physicalText(mapper.lineStartOf(markLine), mapper.lineStartOf(markLine + 1));
  const at = markText.indexOf(`<頁 id="${pageId}"`);
  let startHan = 0;
  if (at >= 0) {
    const close = markText.indexOf('>', at);
    const before = markText.slice(0, at);
    const body = close >= 0 ? markText.slice(close + 1) : '';
    const hanBefore = hanCount(before);
    const hanAfter = hanCount(body);
    const title = /<卷(?:\s[^>]*)?>([^<]*)<\/卷>\s*$/.exec(before);
    const juanHan = title ? [...title[1]].filter((c) => HAN_RE.test(c)).length : 0;
    // 這一欄的字從這一行第幾個漢字開始
    startHan = hanAfter > 0 ? hanBefore : Math.max(0, hanBefore - juanHan);
  }
  // 這一欄第幾個漢字（頁標記那一行起算）
  let colChar = 0;
  if (line === markLine) {
    colChar = Math.max(0, hanPrefix - startHan);
  } else {
    colChar = hanCount(markText) - startHan;
    for (let i = markLine + 1; i < line; i++) {
      colChar += hanCount(await r.physicalText(mapper.lineStartOf(i), mapper.lineStartOf(i + 1)));
    }
    colChar += hanPrefix;
  }
  const pm = await mapPosMap();
  const pos = pm?.columnLineOf(side, vol, page, col, colChar);
  if (!pos) return { side, vol, page, col, line: 1, off: 0 };
  return { side, vol, page, col, line: pos.line, off: pos.off };
}

const hanCount = (s: string): number => [...s.replace(/<[^>]*>/g, '')].filter((c) => HAN_RE.test(c)).length;

/** 頁 id（`5p2c`）→ 位址（行、字由呼叫端補）。 */
export function addressFromPageId(pageId: string, side: Side): Address | null {
  const m = /^(\d{1,3})p(\d{1,4})([a-g])?$/i.exec(pageId);
  if (!m) return null;
  return {
    side, vol: Number(m[1]), page: Number(m[2]),
    col: m[3] ? m[3].toLowerCase().charCodeAt(0) - 97 : 0, line: 1, off: 0,
  };
}

/** 頁 id（`5p2c`）→ 大正藏圖版網址；讀 taisho 時不必等換址就有。 */
export function taishoPlateForPageId(pageId: string): string {
  const a = addressFromPageId(pageId, 'T');
  return a ? taishoPlateUrl(a.vol, a.page, a.col) : '';
}

// ---------------------------------------------------------------- 圖版

export interface PlateLinks { taisho?: string; goryeo?: string }

/**
 * 高麗藏 adb 自己就帶了 KABC 需要的經號與卷：`<書 id="K0647V17">` 是經號 0647、
 * 第 17 冊；`<卷 n="1">` 是卷號。所以讀 goryeo.adb 時，不必有對照表也能看高麗藏圖版。
 */
async function goryeoIdsAtVa(va: number): Promise<{ ksutra: string; kvol: number; kjuan: number } | null> {
  const r = reader;
  if (!r || r.header.dbname !== 'goryeo') return null;
  const book = await instanceAttrAt(r, '書', 'id', va);
  const m = /^K(\d{4})V(\d{2,3})$/.exec(book);
  if (!m) return null;
  const juan = Number(await instanceAttrAt(r, '卷', 'n', va));
  if (!juan) return null;
  return { ksutra: m[1], kvol: Number(m[2]), kjuan: juan };
}

/** 某個 VA 之前最近一個 `<tag>` 實例的 `attr` 值。 */
async function instanceAttrAt(
  r: AdbReader, tag: string, attr: string, va: number,
): Promise<string> {
  const tc = r.containers.get('tags');
  const at = tc?.names.indexOf(tag) ?? -1;
  if (!tc || at < 0) return '';
  const av = await r.attributeValues(`${tag}.${attr}`);
  if (!av?.values.length) return '';
  const vas = await r.decodeBlockList('tags', at);
  let lo = 0, hi = vas.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (vas[mid] <= va) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return '';
  if (!av.pointers) return av.values[ans] ?? '';
  for (let j = 0; j < av.pointers.length; j++) {
    if (((av.pointers[j] & 0xffffff) - 1) === ans) return av.values[j];
  }
  return '';
}

/** 這個位址的大正藏／高麗藏圖版網址（能確定的才給）。 */
export async function plateLinks(addr: Address, va?: number): Promise<PlateLinks> {
  const out: PlateLinks = {};
  if (addr.side === 'T') {
    out.taisho = taishoPlateUrl(addr.vol, addr.page, addr.col);
    const pm = await mapPosMap();
    const r = pm?.convert(addr);
    if (r?.ok && r.k) {
      out.goryeo = goryeoPlateUrl({ kvol: r.k.vol, page: r.k.page, col: r.k.col, ksutra: r.ksutra, kjuan: r.kjuan });
    }
    return out;
  }
  const pm = await mapPosMap();
  const r = pm?.convert(addr);
  if (r?.ok) {
    if (r.t) out.taisho = taishoPlateUrl(r.t.vol, r.t.page, r.t.col);
    if (r.k) out.goryeo = goryeoPlateUrl({ kvol: r.k.vol, page: r.k.page, col: r.k.col, ksutra: r.ksutra, kjuan: r.kjuan });
    return out;
  }
  // 沒有對照表：高麗藏自己就能給 KABC 的經號與卷
  if (va != null) {
    const ids = await goryeoIdsAtVa(va);
    if (ids) {
      out.goryeo = goryeoPlateUrl({
        kvol: ids.kvol, page: addr.page, col: addr.col, ksutra: ids.ksutra, kjuan: ids.kjuan,
      });
    }
  }
  return out;
}

/** 選取位置（本文行號＋行內漢字數）→ 圖版網址。 */
export async function plateLinksAtLine(line: number, hanPrefix: number): Promise<PlateLinks> {
  const addr = await addressAtLine(line, hanPrefix);
  if (!addr) return {};
  const va = mapper?.linesVirtual?.[line];
  return plateLinks(addr, va);
}

// ---------------------------------------------------------------- 開啟另一藏

const DBNAME: Record<Side, string> = { T: 'taisho', K: 'goryeo' };

/**
 * 在**中間**開啟另一藏（2026-10-30）：
 * 中間一次只顯示一個庫，所以先切到那個庫（已開的分頁或 catalog），再跳到那一頁。
 * （原本用 openTaishoAt 會開在右欄，那是「參考」欄，讀者想在這裡讀正文。）
 */
export async function openSide(side: Side, addr: Address): Promise<void> {
  const db = DBNAME[side];
  const pageId = `${addr.vol}p${addr.page}${COL[addr.col] ?? 'a'}`;
  const ok = await openInMain(db, { anchor: pageId, label: pageId });
  if (!ok) setStatus(`請先開啟 ${db}.adb（或用 📁 選取），才能跳到 ${pageId}`, 'warn');
}

// ---------------------------------------------------------------- 分頁 UI

let inited = false;
let mapSide: Side = 'T';

/** `<樹 m="taisho">`：m 的值是預設來源側，也是分頁名稱的來源。 */
function declaredSide(): Side {
  const trees = (session?.trees ?? []) as { map?: string }[];
  const t = trees.find((x) => x.map);
  const v = (t?.map ?? '').toLowerCase();
  if (v === 'goryeo' || v === 'k') return 'K';
  return 'T';
}

// ---------------------------------------------------------------- 清單（2026-10-30 改版）
/**
 * 每一筆：「(藏別) 經名 卷N」＋右邊一顆「大正／高麗」。
 * 按經名就去圈字那一藏；按右邊那顆，去另一藏（對照）。
 * 位置查詢時，那一顆就是位置所在的那一藏（會帶到那個位置）。
 * 位置只在 hover 的 tooltip 出現（T01p0001 ⇄ K17p0815）。
 */
const SIDE_LABEL: Record<Side, string> = { T: '大正', K: '高麗' };
const SIDE_MARK: Record<Side, string> = { T: '大', K: '高' };

interface LineBand { from: number; to: number }

interface Hit {
  titleSide: Side;
  titleAddr: Address;
  title: string;
  juan: number;
  sutra: number;
  openSide: Side;
  openAddr: Address;
  pos: string;
  exact?: CharPosition;
  /** 位置查詢時，開到那一側要塗的行範圍（adb 行號） */
  titleBand?: LineBand;
  openBand?: LineBand;
}

let hits: Hit[] = [];

const otherSide = (s: Side): Side => (s === 'T' ? 'K' : 'T');

/** `T05p0001` 這種頁級位置（seq = 頁×1000＋欄×100＋行）。 */
function pageLabel(side: Side, vol: number, seq: number): string {
  return `${side}${String(vol).padStart(2, '0')}p${String(Math.floor(seq / 1000)).padStart(4, '0')}`;
}

/** 一筆對照記錄，從 `side` 這一側看。 */
/** 經名尾巴若已經帶「卷第一」，就不要和後面的「卷1」重複。 */
const cleanTitle = (s: string): string => s.replace(/卷(?:第)?[0-9０-９一二三四五六七八九十百千上下中]+$/, '').trim();

function rowHit(x: MapRow, side: Side): Hit {
  const openSide = otherSide(side);
  const tAddr = addressOfSeq('T', x.tvol, x.tstart);
  const kAddr = addressOfSeq('K', x.kvol, x.kstart);
  return {
    titleSide: side,
    titleAddr: side === 'T' ? tAddr : kAddr,
    title: cleanTitle((side === 'T' ? x.tTitle : x.kTitle) || `${side}${side === 'T' ? x.tsutra : x.ksutra}`),
    juan: side === 'T' ? x.tjuan : x.kjuan,
    sutra: Number(side === 'T' ? x.tsutra : x.ksutra),
    openSide,
    openAddr: openSide === 'T' ? tAddr : kAddr,
    pos: `${pageLabel('T', x.tvol, x.tstart)} ⇄ ${pageLabel('K', x.kvol, x.kstart)}`,
  };
}

/** 位址／字元級位置 → 兩筆（位置那一筆＋對照那一筆）。 */
async function positionHits(addr: Address, exact?: CharPosition, end?: Address | null): Promise<Hit[]> {
  const rows = await mapRows();
  const pm = await mapPosMap();
  const conv = pm?.convert(addr);
  const endConv = end && pm ? pm.convert(end) : null;
  const side = addr.side;
  const other = otherSide(side);

  /** 這一側要塗的行範圍：起點那一行，範圍查到終點（或頁／欄尾）。 */
  const bandOf = (s: Side, a: Address, e: Address | null): LineBand | undefined => {
    if (!pm) return undefined;
    const from = pm.lineOfAddress(s, a);
    if (from == null) return undefined;
    let to = from;
    if (e) {
      if (e.line === 0 && e.off === 0) {
        const last = pageColEndLine(pm, s, e);
        if (last != null) to = Math.max(from, last);
      } else {
        const l = pm.lineOfAddress(s, e);
        if (l != null) to = Math.max(from, l);
      }
    }
    return { from, to };
  };

  const endLevel = !!end && end.line === 0 && end.off === 0;   // 終點只給頁＋欄：到欄尾
  const tStart = side === 'T' ? addr : conv?.ok ? conv.t : null;
  const kStart = side === 'K' ? addr : conv?.ok ? conv.k : null;
  const tEnd = end ? (side === 'T' ? end : endConv?.ok ? endConv.t : null) : null;
  const kEnd = end ? (side === 'K' ? end : endConv?.ok ? endConv.k : null) : null;
  // 頁／欄級的位址（行 0、字 0）不要印成 `…a0000`，直接寫 `…a`。
  const addrLabel = (a: Address): string => (a.line === 0 && a.off === 0
    ? `${a.side}${String(a.vol).padStart(2, '0')}p${String(a.page).padStart(4, '0')}${COL[a.col] ?? 'a'}`
    : formatAddress(a));
  const dispEnd = (a: Address | null): Address | null => (a && endLevel ? { ...a, line: 0, off: 0 } : a);
  const tip = (a: Address | null, e: Address | null): string => {
    const head = a ? addrLabel(a) : '—';
    return e ? `${head} → ${addrLabel(e)}` : head;
  };
  const pos = `${tip(tStart, dispEnd(tEnd))} ⇄ ${tip(kStart, dispEnd(kEnd))}`;

  const x = conv?.ok ? rowFor(rows, conv.tsutra, conv.tjuan) : undefined;
  if (!x) {
    return [{
      titleSide: side, titleAddr: addr,
      title: `${side}${String(addr.vol).padStart(2, '0')}p${String(addr.page).padStart(4, '0')}`,
      juan: 0, sutra: 0, openSide: side, openAddr: addr, pos, exact,
      openBand: bandOf(side, addr, end ?? null),
    }];
  }
  const tAddr = addressOfSeq('T', x.tvol, x.tstart);
  const kAddr = addressOfSeq('K', x.kvol, x.kstart);
  const titleOf = (s: Side): string => cleanTitle(s === 'T' ? (x.tTitle || `T${x.tsutra}`) : (x.kTitle || `K${x.ksutra}`));
  const juanOf = (s: Side): number => (s === 'T' ? x.tjuan : x.kjuan);
  const otherAddr = side === 'T' ? conv!.k : conv!.t;
  let otherEnd = side === 'T' ? (endConv?.ok ? endConv.k : null) : (endConv?.ok ? endConv.t : null);
  if (otherEnd && endLevel) otherEnd = { ...otherEnd, line: 0, off: 0 };
  const out: Hit[] = [{
    titleSide: other, titleAddr: otherAddr ?? (other === 'T' ? tAddr : kAddr),
    title: titleOf(other), juan: juanOf(other),
    sutra: Number(other === 'T' ? x.tsutra : x.ksutra),
    openSide: side, openAddr: addr, pos, exact,
    openBand: bandOf(side, addr, end ?? null),
    titleBand: otherAddr ? bandOf(other, otherAddr, otherEnd) : undefined,
  }];
  if (otherAddr) {
    out.push({
      titleSide: side, titleAddr: side === 'T' ? tAddr : kAddr,
      title: titleOf(side), juan: juanOf(side),
      sutra: Number(side === 'T' ? x.tsutra : x.ksutra),
      openSide: other, openAddr: otherAddr, pos,
      openBand: bandOf(other, otherAddr, otherEnd),
      titleBand: bandOf(side, addr, end ?? null),
    });
  }
  return out;
}

/** 這一頁／欄的最後一行（下一頁／欄的第一行 − 1）。 */
function pageColEndLine(pm: PosMap, side: Side, a: Address): number | null {
  const next = a.col < 2 ? { page: a.page, col: a.col + 1 } : { page: a.page + 1, col: 0 };
  const f = pm.firstLineOf(side, a.vol, next.page, next.col);
  if (!f) return null;
  const line = pm.lineOfAddress(side, { ...a, page: next.page, col: next.col, line: f.line, off: 0 });
  return line == null ? null : line - 1;
}

/**
 * 範圍的終點：`0507`（同頁同欄，第 5 行第 7 字）、`c0507`、
 * `0002c0507`；只有頁＋欄（`0002c`）就是到那一欄尾。不能跨冊。
 */
function parseEndAddress(s: string, start: Address): Address | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  const colOf = (c: string): number => c.charCodeAt(0) - 97;
  let m = /^([0-9]{4})$/.exec(t);                    // 0507 → line 05 off 07
  if (m) return { ...start, line: Number(m[1].slice(0, 2)), off: Number(m[1].slice(2)) };
  m = /^([a-g])([0-9]{2})([0-9]{2})$/.exec(t);       // c0507
  if (m) return { ...start, col: colOf(m[1]), line: Number(m[2]), off: Number(m[3]) };
  m = /^([0-9]{1,4})([a-g])(?:([0-9]{2})([0-9]{2}))?$/.exec(t);  // 0002c / 0002c0507
  if (m) {
    return {
      ...start, vol: start.vol, page: Number(m[1]), col: colOf(m[2]),
      line: m[3] != null ? Number(m[3]) : 0,
      off: m[4] != null ? Number(m[4]) : 0,
    };
  }
  return null;
}

/** 數字／前綴／文字 → 一經一筆（沒指定卷就取最小卷）。 */
function searchHits(rows: MapRow[], opt: { needle?: string; sutra?: number; juan?: number | null; side?: Side }): Hit[] {
  const picked = new Map<string, { x: MapRow; side: Side }>();
  for (const x of rows) {
    for (const side of ['T', 'K'] as Side[]) {
      if (opt.side && side !== opt.side) continue;
      const sutra = Number(side === 'T' ? x.tsutra : x.ksutra);
      const juan = side === 'T' ? x.tjuan : x.kjuan;
      if (opt.sutra != null && sutra !== opt.sutra) continue;
      if (opt.juan != null && juan !== opt.juan) continue;
      if (opt.needle && !((side === 'T' ? x.tTitle : x.kTitle) || '').toLowerCase().includes(opt.needle)) continue;
      const key = side + ':' + sutra;
      const prev = picked.get(key);
      if (!prev) { picked.set(key, { x, side }); continue; }
      if (juan < (prev.side === 'T' ? prev.x.tjuan : prev.x.kjuan)) picked.set(key, { x, side });
    }
  }
  const list = [...picked.values()].map((p) => rowHit(p.x, p.side));
  list.sort((a, b) => a.sutra - b.sutra || a.juan - b.juan
    || (a.titleSide === b.titleSide ? 0 : a.titleSide === 'K' ? -1 : 1));
  return list;
}

function hitHtml(h: Hit, i: number): string {
  const mark = h.titleSide === 'T' ? 'mapMarkT' : 'mapMarkK';
  return `<div class="mapHit" data-i="${i}" title="${escapeHtml(h.pos)}">`
    + `<button type="button" class="mapHitName"><span class="mapMark ${mark}">${SIDE_MARK[h.titleSide]}</span>${escapeHtml(h.title)}`
    + (h.juan ? ` 卷${h.juan}` : '') + '</button>'
    + `<button type="button" class="mapHitOpen">${SIDE_LABEL[h.openSide]}</button>`
    + '</div>';
}

async function openHit(h: Hit, which: 'title' | 'open'): Promise<void> {
  (window as unknown as { __lastOpenHit?: unknown }).__lastOpenHit = { which, titleSide: h.titleSide, openSide: h.openSide, titleBand: h.titleBand ?? null, openBand: h.openBand ?? null };
  if (which === 'title') {          // 按經名：去圈字那一藏
    await openSide(h.titleSide, h.titleAddr);
    await applyBand(h.titleBand);
    return;
  }
  if (h.exact) {                    // 按右邊那顆：位置查詢就帶到那個位置
    if (!(await openCharPosition(h.exact))) setStatus('找不到這個位置', 'err');
    return;
  }
  await openSide(h.openSide, h.openAddr);
  await applyBand(h.openBand);
}

/** 開完頁以後把位置那幾行塗色帶（等那幾行畫出來）。 */
async function applyBand(band?: LineBand): Promise<void> {
  if (!band) return;
  for (let i = 0; i < 40 && !document.getElementById('L' + band.from); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  markLineRange(band.from, band.to);
}

const MAP_HELP = '<div class="mapHelp">'
  + '<p>輸入文字找經名；輸入數字找經號（大正、高麗一起找）。</p>'
  + '<p>前綴 <code>T</code>／<code>K</code> 只找那一藏；<code>T1.2</code> = 大正第 1 經第 2 卷。</p>'
  + '<p>也可以貼上位置（<code>T05p0002c0405</code>），或選取選單複製的字元級位置（<code>taisho?5p2c j=2-8</code>）。</p>'
  + '<p>位置也可以給範圍：<code>T05p0002c0405-0507</code>（同頁同欄到第 5 行第 7 字）或 <code>-0003a</code>（到那一欄尾）；跳過去會把那幾行塗色帶。</p>'
  + '<p>按經名就去圈字那一藏；按右邊的藏名，就去那一藏（對照）。滑過一筆可看位置。</p>'
  + '</div>';

export async function renderMap(): Promise<void> {
  const list = $('#mapList');
  if (!list) return;
  if (!reader) { list.innerHTML = '<p class="dim">尚未開啟資料庫。</p>'; return; }
  mapSide = declaredSide();
  const input = $('#mapQuery') as HTMLInputElement | null;
  const q = input?.value.trim() ?? '';
  if (!q) { hits = []; list.innerHTML = MAP_HELP; return; }
  const rows = await mapRows();
  if (!rows.length) {
    hits = [];
    list.innerHTML = '<p class="dim">這個庫沒有 <code>map</code> 對照資料；請開啟 <code>goryeo_taisho.adb</code>。</p>';
    return;
  }
  let out: Hit[] = [];
  const pos = parseCharPosition(q);
  if (pos) {
    const side: Side = pos.db === 'goryeo' ? 'K' : pos.db === 'taisho' ? 'T' : mapSide;
    const addr = addressFromPageId(pos.anchor, side);
    if (addr) out = await positionHits(addr, pos);
    else {
      out = [{
        titleSide: side, title: pos.anchor, juan: 0, sutra: 0, openSide: side,
        openAddr: { side, vol: 0, page: 0, col: 0, line: 0, off: 0 },
        pos: `${pos.db || side}?${pos.anchor}`, exact: pos,
      }];
    }
  } else {
    // `T05p0002c0405-0507`：`-` 後面是終點（同頁同欄的行．字，或頁＋欄），不能跨冊
    const cut = q.indexOf('-');
    const head = cut >= 0 ? q.slice(0, cut).trim() : q;
    const tail = cut >= 0 ? q.slice(cut + 1).trim() : '';
    const addr = parseLooseAddress(head, mapSide);
    const end = addr && tail ? parseEndAddress(tail, addr) : null;
    if (addr) out = await positionHits(addr, undefined, end);
    else {
      const m = /^([TK])?(\d+)(?:\.(\d+))?$/i.exec(q);
      out = m
        ? searchHits(rows, {
          side: m[1] ? (m[1].toUpperCase() as Side) : undefined,
          sutra: Number(m[2]),
          juan: m[3] != null ? Number(m[3]) : null,
        })
        : searchHits(rows, { needle: q.toLowerCase() });
    }
  }
  hits = out;
  if (!out.length) {
    list.innerHTML = `<p class="dim">找不到「${escapeHtml(q)}」。試試經名、經號（1）、經號.卷（1.2）或位置。</p>`;
    return;
  }
  list.innerHTML = out.map((h, i) => hitHtml(h, i)).join('');
}

export function initMap(): void {
  if (inited) return;
  inited = true;
  const input = $('#mapQuery') as HTMLInputElement | null;
  if (!input) return;
  // 清單的點擊用委派：換搜尋結果時不必重新綁
  const list = $('#mapList');
  if (list) {
    list.onclick = (ev) => {
      const row = (ev.target as Element | null)?.closest?.('.mapHit') as HTMLElement | null;
      if (!row) return;
      const h = hits[Number(row.dataset.i)];
      if (!h) return;
      // 右邊那顆→另一藏；經名（含圈字）→圈字那一藏
      const btn = (ev.target as Element | null)?.closest?.('.mapHitOpen');
      void openHit(h, btn ? 'open' : 'title');
    };
  }
  let t = 0;
  const run = () => void renderMap();
  input.oninput = () => { window.clearTimeout(t); t = window.setTimeout(run, 160); };
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter') { window.clearTimeout(t); void renderMap(); }
    if (ev.key === 'Escape') ev.preventDefault();
  };
  const clear = $('#mapClear') as HTMLButtonElement | null;
  if (clear) clear.onclick = () => { input.value = ''; run(); input.focus(); };
}

/** 測試／診斷用：把目前的對照狀態講清楚。 */
export async function mapState(): Promise<Record<string, unknown>> {
  const r = await mapReader();
  const rows = await mapRows();
  const pm = await mapPosMap();
  return { reader: r?.header.dbname ?? '', records: pm?.count ?? 0, rows: rows.length, side: declaredSide() };
}

/** 給書籤選單：位址 → KABC 的 dataId（測試用）。 */
export function kabcFor(ksutra: string, kjuan: number): { dataId: string; juan: number } {
  return kabcDataId(ksutra, kjuan);
}
