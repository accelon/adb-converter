/**
 * 閱讀狀態的匯出／載入（作者 2026-11-01）。
 *
 * 目的：**讀者回報問題時，作者要能重現他看到的畫面**。所以匯出的東西比「 Bookmarks」
 * 多很多：開著的 adb、本文分頁（realm／頁碼／釘選的命中）、捲動位置、
 * **本文的選取區**，以及當下的介面狀態與診斷數字。
 *
 * 格式（JSON，`format: 'accelon26-readstate'`）：
 *   name／exportedAt／userId／app／ui／dbs／tabs／active／diagnostics
 * 檔名：`<修訂者 ID><純數字日期時間>.json`（本地時區，例：`sukhanika20261101150312.json`）。
 *
 * 載入時只還原「看得到的東西」：開庫→選分頁→頁碼→釘選→選取區，
 * 外加影響畫面的閱讀開關（原書分行／頁碼／繁簡／術語／字級）。
 * **不改**主題、進階模式、標籤樣式（那些是這台機器的偏好，不是閱讀狀態）。
 */
import { openFile, reader, statusText } from './viewer';
import {
  activeDocCtx, applyDocSelection, boundsOfRealm, captureDocSelection, ctxOf, docActive, docSession,
  docTabs, ensurePage, pageBounds, readDocFont, readSideFont, renderRawOn, sessionFor, setDocActive,
  setDocFont, setHardBreaks, setLineTip, setPageMarks, setRenderRaw, setSideFont, setSimMode,
  setTermMode, setTrailMax, sharedDocTabsOn, simModeOf, termModeOf, hardBreaksOn, pageMarksOn,
  lineTipEnabled, trailMaxOf, type DocSelection,
} from './doc-pane';
import { activeSlot, catalog, openDbs, switchTo, type DbSlot } from './dbs';
import { resolveDocCtx } from './doc-ctx';
import { desktopHost, desktopSources } from './host';
import { openDbRecs, type OpenDbRec } from './open-set';
import { getUserId } from './user-id';

export const READ_STATE_FORMAT = 'accelon26-readstate';
export const READ_STATE_VERSION = 1;

export interface ReadStateDb extends OpenDbRec {
  /** 在 dbTabs 的位置（0＝最左） */
  order: number;
  active: boolean;
  /** 這一庫有幾個本文分頁 */
  tabs: number;
  dbcname?: string;
}

export interface ReadStateTab {
  i: number;
  active: boolean;
  db: string;
  dbId: number;
  name: string;
  realm: { from: number; to: number };
  page: number;
  pages: number;
  firstLine: number;
  lastLine: number;
  pinned: unknown;
  history: string | null;
  editing: boolean;
  showDiff: boolean;
  scrollTop: number | null;
}

export interface ReadState {
  format: string;
  version: number;
  name: string;
  exportedAt: string;
  userId: string;
  app: Record<string, unknown>;
  ui: Record<string, unknown>;
  dbs: ReadStateDb[];
  tabs: ReadStateTab[];
  active: {
    tab: number;
    db: string;
    name: string;
    realm: { from: number; to: number };
    page: number;
    pages: number;
    firstLine: number;
    lastLine: number;
    pinned: unknown;
    scrollTop: number;
    /** ★ 本文的選取區（行號＋行內第幾個漢字＋選到的文字） */
    selection: DocSelection | null;
    /** 選取區那一頁的文字（前 3 行，方便作者一眼看出在哪） */
    pageHead?: string[];
  } | null;
  diagnostics: Record<string, unknown>;
}

/** 設定頁／狀態列要顯示的額外資訊（由 ui.ts 註冊，避免 read-state → ui 的循環） */
export interface ReadStateUiInfo {
  leftTab?: string | null;
  rightTab?: string | null;
  cols?: unknown;
  theme?: string;
  advanced?: boolean;
  build?: string;
  backend?: string;
  searchQuery?: string;
  hitTotal?: number;
  snippetScope?: unknown;
  cursorNode?: unknown;
  lastLink?: unknown;
  pagerLog?: string[];
  dbLog?: string[];
  dirActive?: number;
  docRows?: number;
  marks?: number;
}

let uiInfo: (() => ReadStateUiInfo) | null = null;
export function setReadStateUiInfo(fn: (() => ReadStateUiInfo) | null): void { uiInfo = fn; }

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 本地時區的 `yyyyMMddHHmmss`（純數字；作者要求檔名不要有分隔符） */
export function stampLocal(d = new Date()): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 本地時區、帶時差的 ISO 時間（人看的時間要跟使用者一致） */
export function isoLocal(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** 檔名：`<修訂者 ID><yyyyMMddHHmmss>.json`（ID 去掉檔案系統不行的字元） */
export function readStateFileName(userId: string, d = new Date()): string {
  const who = (userId || '').trim().replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'anon';
  return who + stampLocal(d) + '.json';
}

const scrollTopOf = (): number =>
  document.querySelector<HTMLElement>('#docText .docBody')?.scrollTop ?? 0;

/** 目前這一頁的前幾行（純文字，去掉標籤） */
function pageHeadLines(n = 3): string[] {
  return [...document.querySelectorAll<HTMLElement>('#docText .docLine')]
    .slice(0, n)
    .map((el) => (el.querySelector('.lineText')?.textContent ?? '').trim().slice(0, 120))
    .filter(Boolean);
}

/** 收集成一份可以直接寫進檔案的物件 */
export function buildReadState(name: string, now = new Date()): ReadState {
  const info = (() => { try { return uiInfo?.() ?? {}; } catch { return {} as ReadStateUiInfo; } })();
  const userId = getUserId();
  const activeId = activeSlot()?.id ?? 0;
  const dbs: ReadStateDb[] = openDbRecs().map((r, i) => {
    const slot = openDbs[i];
    const rec = r as ReadStateDb;
    rec.order = i;
    rec.active = !!slot && slot.id === activeId;
    rec.tabs = slot ? docTabs.filter((t) => ctxOf(t)?.dbId === slot.id).length : 0;
    rec.dbcname = slot ? ((slot.core as { reader?: { header: { dbcname?: string } } } | null)?.reader?.header.dbcname ?? '') : '';
    return rec;
  });

  const tabs: ReadStateTab[] = docTabs.map((t, i) => {
    const ctx = ctxOf(t);
    const b = boundsOfRealm(ctx, t.realm);
    return {
      i,
      active: i === docActive,
      db: ctx?.dbName ?? '',
      dbId: ctx?.dbId ?? 0,
      name: t.name,
      realm: { from: t.realm.from, to: t.realm.to },
      page: t.page,
      pages: pageBounds(ctx, t.realm, t.page).pages,
      firstLine: b.first,
      lastLine: b.last,
      pinned: t.pinned ?? null,
      history: t.history?.revisionId ?? null,
      editing: !!t.editing,
      showDiff: !!t.showDiff,
      scrollTop: typeof t.scrollTop === 'number' ? t.scrollTop : null,
    };
  });

  const s = docSession();
  const sctx = ctxOf(s);
  const sb = s ? boundsOfRealm(sctx, s.realm) : null;
  const active: ReadState['active'] = s && sctx && sb
    ? {
      tab: docActive,
      db: sctx.dbName,
      name: s.name,
      realm: { from: s.realm.from, to: s.realm.to },
      page: s.page,
      pages: pageBounds(sctx, s.realm, s.page).pages,
      firstLine: sb.first,
      lastLine: sb.last,
      pinned: s.pinned ?? null,
      scrollTop: scrollTopOf(),
      selection: captureDocSelection(),
      pageHead: pageHeadLines(),
    }
    : null;

  const nav = navigator as unknown as { userAgent?: string; language?: string };
  return {
    format: READ_STATE_FORMAT,
    version: READ_STATE_VERSION,
    name: (name || '').trim().slice(0, 80) || '閱讀狀態',
    exportedAt: isoLocal(now),
    userId,
    app: {
      build: info.build ?? '',
      backend: info.backend ?? '',
      url: typeof location !== 'undefined' ? location.href : '',
      userAgent: nav.userAgent ?? '',
      language: nav.language ?? '',
      screen: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}` : '',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      advanced: !!info.advanced,
      theme: info.theme ?? '',
      db: reader?.header.dbname ?? null,
      dbcname: reader?.header.dbcname ?? null,
    },
    ui: {
      leftTab: info.leftTab ?? null,
      rightTab: info.rightTab ?? null,
      cols: info.cols ?? null,
      docFont: readDocFont(),
      sideFont: { left: readSideFont('left'), right: readSideFont('right') },
      hardBreaks: hardBreaksOn(),
      pageMarks: pageMarksOn(),
      renderRaw: renderRawOn(),
      simMode: simModeOf(),
      termMode: termModeOf(),
      lineTip: lineTipEnabled(),
      trailMax: trailMaxOf(),
      sharedDocTabs: sharedDocTabsOn(),
    },
    dbs,
    tabs,
    active,
    diagnostics: {
      status: statusText(),
      searchQuery: info.searchQuery ?? '',
      hitTotal: info.hitTotal ?? 0,
      snippetScope: info.snippetScope ?? null,
      cursorNode: info.cursorNode ?? null,
      lastLink: info.lastLink ?? null,
      pagerLog: info.pagerLog ?? [],
      dbLog: info.dbLog ?? [],
      dirActive: info.dirActive ?? 0,
      docRows: info.docRows ?? 0,
      marks: info.marks ?? 0,
      tabCount: docTabs.length,
      openDbs: openDbs.length,
    },
  };
}

function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 匯出（回傳檔名與內容，測試不用真的下載） */
export function exportReadState(name: string): { filename: string; json: string; state: ReadState } {
  const now = new Date();
  const state = buildReadState(name, now);
  const filename = readStateFileName(state.userId, now);
  const json = JSON.stringify(state, null, 2);
  downloadText(json, filename);
  return { filename, json, state };
}

/* ---------------------------------------------------------------- 載入 */

export interface LoadResult {
  ok: boolean;
  error?: string;
  /** 套用了哪些東西（給狀態列看） */
  applied?: string[];
  /** 找不到的庫／分頁（不影響其他部分） */
  missing?: string[];
}

/**
 * 這筆紀錄是不是這個 slot。
 *
 * **只比名字，不比路徑**（作者 2026-11-01「adb 跟著 exe 走」）：先比檔頭 dbname，
 * 再比庫名／檔名，最後才用「大小」當線索（換版會變，所以只當補充）。
 */
const recMatches = (rec: OpenDbRec, slot: DbSlot): boolean => {
  const core = slot.core as { reader?: { header: { dbname?: string } } } | null;
  const dbname = core?.reader?.header.dbname ?? '';
  if (rec.dbname && dbname && rec.dbname === dbname) return true;
  if (rec.name && slot.name === rec.name) return true;
  if (rec.name && slot.file.name === rec.name) return true;
  return rec.size !== undefined && slot.file.size === rec.size && slot.name === rec.name;
};

/** 找到那個庫的 slot；沒有就 null */
function slotFor(rec: OpenDbRec): DbSlot | null {
  return openDbs.find((d) => recMatches(rec, d)) ?? null;
}

/** 這個庫還沒開：能開就開（catalog 裡的 File 優先，桌面版再從 exe 旁的清單找） */
async function ensureOpen(rec: OpenDbRec): Promise<DbSlot | null> {
  const have = slotFor(rec);
  if (have) return have;
  const same = (s: AdbSource): boolean =>
    s.name === rec.name && (rec.size === undefined || s.size === rec.size);
  // 1) catalog 裡同一個（網頁版這裡還握著 File/Blob）
  const hit = catalog.find((e) => same(e.file) || e.name === rec.name) ?? null;
  if (hit) {
    await openFile(hit.file);
    const s = slotFor(rec);
    if (s) return s;
  }
  // 2) 桌面版：從 exe 旁重新列出
  if (await desktopHost().catch(() => false)) {
    const srcs = await desktopSources().catch(() => [] as Awaited<ReturnType<typeof desktopSources>>);
    const src = srcs.find(same) ?? null;
    if (src) {
      await openFile(src);
      const s = slotFor(rec);
      if (s) return s;
    }
  }
  return slotFor(rec);
}

/** 讀一個檔案並還原；回傳套用了哪些東西 */
export async function loadReadStateFile(file: File): Promise<LoadResult> {
  let data: any;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: '不是有效的 JSON 檔' };
  }
  return applyReadState(data);
}

/** 檢查是不是本程式的閱讀狀態（format／version） */
export function validateReadState(data: any): LoadResult {
  if (!data || typeof data !== 'object') return { ok: false, error: '不是有效的閱讀狀態' };
  if (data.format !== READ_STATE_FORMAT) return { ok: false, error: '不是 accelon26 的閱讀狀態檔' };
  if (Number(data.version) > READ_STATE_VERSION) {
    return { ok: false, error: `這個檔是 v${data.version}，比這個程式新；請更新 accelon26` };
  }
  return { ok: true };
}

/** 把一份閱讀狀態套上去（載入檔案／測試共用） */
export async function applyReadState(data: any): Promise<LoadResult> {
  const valid = validateReadState(data);
  if (!valid.ok) return valid;
  const applied: string[] = [];
  const missing: string[] = [];

  // 1) 開庫（紀錄裡的順序由左到右；openFile 會 unshift，所以反著開）
  //    只認名字（`file` 是舊版欄位，也讀得進來）
  const recs: ReadStateDb[] = Array.isArray(data.dbs)
    ? data.dbs
      .filter((d: any) => d && (typeof d.name === 'string' || typeof d.file === 'string'))
      .map((d: any) => ({ ...d, name: String(d.name ?? d.file ?? '') }))
    : [];
  const slots: { rec: ReadStateDb; slot: DbSlot }[] = [];
  for (const rec of [...recs].reverse()) {
    const slot = await ensureOpen(rec as OpenDbRec);
    if (slot) slots.push({ rec, slot });
    else missing.push(rec.name);
  }
  if (!slots.length) return { ok: false, error: '這個狀態裡的 adb 都找不到（需要同一個庫）' };
  applied.push('adb ' + slots.length + ' 個');

  // 2) 回到存檔時的 active 庫
  const activeRec = recs.find((r) => r.active);
  const activeSlotMatch = activeRec ? slots.find((x) => x.rec === activeRec) : null;
  if (activeSlotMatch) switchTo(activeSlotMatch.slot.id);

  // 3) 閱讀開關（會影響看到的畫面，所以還原；主題／進階／標籤樣式不動）
  const ui = data.ui ?? {};
  let touched = false;
  if (typeof ui.hardBreaks === 'boolean') { setHardBreaks(ui.hardBreaks); touched = true; }
  if (typeof ui.pageMarks === 'boolean') setPageMarks(ui.pageMarks);
  if (typeof ui.renderRaw === 'boolean') setRenderRaw(ui.renderRaw);
  if (ui.simMode === 0 || ui.simMode === 1 || ui.simMode === 2) setSimMode(ui.simMode);
  if (typeof ui.termMode === 'string') setTermMode(ui.termMode);
  if (typeof ui.lineTip === 'boolean') setLineTip(ui.lineTip);
  if (typeof ui.trailMax === 'number') setTrailMax(ui.trailMax);
  if (typeof ui.docFont === 'number') setDocFont(ui.docFont);
  if (ui.sideFont && typeof ui.sideFont === 'object') {
    if (typeof ui.sideFont.left === 'number') setSideFont('left', ui.sideFont.left);
    if (typeof ui.sideFont.right === 'number') setSideFont('right', ui.sideFont.right);
  }
  if (touched || ui.pageMarks !== undefined) applied.push('閱讀開關');

  // 4) 本文分頁：找同一個庫＋同一個 realm 的分頁，沒有就開一個
  const act = data.active;
  if (!act) {
    applied.push('沒有本文分頁');
    return { ok: true, applied, missing };
  }
  const rec = recs.find((r) => r.dbname === act.db) ?? recs.find((r) => r.name === act.db)
    ?? slots[0]?.rec;
  const slot = rec ? slots.find((x) => x.rec === rec)?.slot ?? slotFor(rec) : null;
  if (!slot) { missing.push(String(act.db ?? '')); return { ok: true, applied, missing }; }
  if (activeSlot()?.id !== slot.id) switchTo(slot.id);
  const ctx = resolveDocCtx(slot.id) ?? activeDocCtx();
  if (!ctx) return { ok: false, error: '找不到這個庫的 reader（請重開 adb）' };

  const realm = act.realm && Number.isFinite(act.realm.from) && Number.isFinite(act.realm.to)
    ? { from: Number(act.realm.from), to: Number(act.realm.to) }
    : null;
  if (!realm || realm.to <= realm.from) return { ok: false, error: '狀態裡沒有有效的本文範圍' };

  let s = docTabs.find((t) => ctxOf(t)?.dbId === ctx.dbId
    && t.realm.from === realm.from && t.realm.to === realm.to) ?? null;
  if (!s) {
    s = sessionFor(ctx, realm, String(act.name || '閱讀狀態'), true);
  }
  s.ctx = ctx;
  s.name = String(act.name || s.name);
  s.history = undefined;
  s.page = Math.max(0, Number(act.page) || 0);
  s.showDiff = false;
  const pin = act.pinned && typeof act.pinned === 'object' ? act.pinned as { va?: number; line?: number } : null;
  // 釘選的命中整個帶回來（token／phrase／units 決定要不要塗紅、塗幾個字）
  s.pinned = pin && Number.isFinite(pin.va)
    ? { ...(pin as { va: number; text?: string; token?: string; units?: number; line: number; exact?: boolean; phrase?: string; noMark?: boolean }), text: (pin as { text?: string }).text ?? '', token: (pin as { token?: string }).token ?? '', units: Math.max(1, Number((pin as { units?: number }).units) || 1), line: Math.max(0, Number(pin.line) || 0) }
    : null;
  const idx = docTabs.indexOf(s);
  if (idx >= 0) setDocActive(idx);
  await ensurePage(s, s.pinned?.line);
  applied.push('本文分頁');

  // 5) 捲動位置 → 選取區
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  if (body && Number.isFinite(act.scrollTop)) body.scrollTop = Number(act.scrollTop);
  const sel = act.selection as DocSelection | null;
  if (sel && Number.isFinite(sel.fromLine)) {
    const okSel = applyDocSelection(sel, { scroll: false });
    applied.push(okSel ? '選取區' : '選取區（這一頁找不到，已略過）');
    if (okSel && body && Number.isFinite(act.scrollTop)) body.scrollTop = Number(act.scrollTop);
  }
  return { ok: true, applied, missing };
}
