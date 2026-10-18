/**
 * The DESKTOP HOST (Wails3), when there is one.
 *
 * The shipped product is a single HTML file opened from `file://`: the reader picks
 * .adb files and everything is read through `Blob.slice()`. The DESKTOP build serves
 * this same page from a very thin Go host that mmaps the .adb files sitting in the
 * working directory — which is why starting the exe already lists every database
 * beside it (headers are read, the bodies stay on disk until a database is opened).
 *
 * This module is the ONLY place that knows the host exists. It hands the rest of the
 * viewer ordinary `AdbSource` objects (the same shape a picked `File` has), so no
 * pane, tree or tab code ever branches on "am I in the desktop build?".
 */
import { type AdbSource } from './adb';

/** what the Go host reports for one .adb (headers only) */
interface HostAdb {
  path: string; name: string; dbname: string; dbcname: string; size: number; modified: number;
}

interface HostCall { ByName(name: string, ...args: unknown[]): Promise<unknown>; }

let call: HostCall | null = null;
let probed = false;
let probe: Promise<HostCall | null> | null = null;   // 進行中的探測（共用，避免競態）
/** why the host is absent (diagnostics: state().host) — a silently empty dropdown is a bug */
let lastError = '';
let lastCount = 0;

/**
 * Load the Wails runtime lazily — from `file://` there simply is none. The import is
 * built through `new Function` so the bundler does not try to resolve a path that only
 * exists inside the desktop host.
 */
async function hostCall(): Promise<HostCall | null> {
  // 一次就夠：**共用同一個 promise**，否則同時進來的第二個呼叫會在探測還沒完成時
  // 看到 probed=true、call=null，誤判成「沒有宿主」（曾因此讓下拉變空）。
  if (!probe) probe = probeHost();
  return await probe;
}

async function probeHost(): Promise<HostCall | null> {
  probed = true;
  try {
    const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<Record<string, any>>;
    const mod = await dynamicImport('/wails/runtime.js');
    const c = mod?.Call as HostCall | undefined;
    if (c && typeof c.ByName === 'function') call = c;
  } catch (e) {
    // ordinary browser build (or an older host): stay file-based
    call = null;
    lastError = String((e as Error)?.message ?? e);
  }
  return call;
}

/** true when a desktop host is answering (only used for diagnostics) */
export async function desktopHost(): Promise<boolean> { return !!(await hostCall()); }

const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;

/** base64 → bytes (the host sends base64: a byte array would become ~6× JSON) */
function decodeBase64(b64: string): Uint8Array {
  if (fromBase64) return fromBase64.call(Uint8Array, b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hostRead(path: string, offset: number, length: number): Promise<Uint8Array> {
  const c = await hostCall();
  if (!c || length <= 0) return new Uint8Array(0);
  const b64 = await c.ByName('main.AdbHost.ReadBase64', path, offset, length) as string;
  return decodeBase64(b64 || '');
}

/**
 * One bzip2 source block, decompressed AND decoded in Go (one call) — see
 * wails/decompress.go: Go's compress/bzip2 is the 「有 Go 版就用 Go」 path.
 */
async function hostDecompressText(path: string, offset: number, length: number): Promise<string> {
  const c = await hostCall();
  if (!c) return '';
  const text = await c.ByName('main.AdbHost.DecompressText', path, offset, length) as string;
  return typeof text === 'string' ? text : '';
}

/**
 * A token's posting list, decoded in Go straight out of the mapping
 * (main.AdbHost.Postings — the packed varint list never crosses the boundary).
 */
async function hostPostings(path: string, token: string): Promise<number[]> {
  const c = await hostCall();
  if (!c) return [];
  const out = await c.ByName('main.AdbHost.Postings', path, token) as number[] | null;
  return out ?? [];
}

/**
 * 查詢後端（Go 版，作者 2026-10）：查詢字串 → 每個詞組的命中（`wails/query.go`）。
 *
 * 這是**唯一**的宿主查詢入口（舊的 `SearchTokens` 已移除）：接受完整查詢語法
 * （空白／`+`／`-`／`*`／`.`），也接受變體組（繁簡通檢）；檔案分段與 BM25 仍由
 * TS 的 `rankClauses()` 做，所以兩邊（Go／純 TS）結果一致 ——
 * 共用的測試集在 `ts/test/shared/search-cases.json`。
 */
async function hostSearchQuery(path: string, query: string, maxHits: number, groups: string[]): Promise<unknown> {
  const c = await hostCall();
  if (!c) return null;
  return await c.ByName('main.AdbHost.SearchQuery', path, query, maxHits, groups);
}

// ---- 桌面版自己的資訊與線上更新（作者 2026-10） ----------------------------------
//
// UI 只看到「建置時間」與「有沒有新版」這些事實；下載、換檔、重啟都在 Go 層
// （wails/update.go），UI 不需要知道。

/** 桌面宿主回報的應用資訊（wails/update.go 的 AppInfo）。 */
export interface DesktopAppInfo {
  name: string;
  /** 建置時間（RFC3339；左上角 hover hint 就是用這個） */
  buildTime: string;
  /** 給人看的本地時間，例如 2026-10-16 21:30 */
  buildTimeText: string;
  buildSource: string;
  exePath: string;
  exeDir: string;
  /** 平台（windows／darwin；網頁版沒有這個欄位） */
  platform?: string;
  dirWritable: boolean;
  canUpdate: boolean;
  /**
   * 這個平台沒有「換掉自己」的自動更新（macOS：換的是整個 .app，牽涉簽章與公證）。
   * true 時 About 要說「請到官網下載新版」，而不是「檢查失敗」。
   */
  noSelfUpdate?: boolean;
  devBuild: boolean;
  updateURL: string;
  updateAvailable: boolean;
  remoteBuildTime: string;
  lastCheck: string;
  /** 真的拿到線上的版本時間；false 時要看 note（檢查失敗，不可以說「已是最新」） */
  checkOK: boolean;
  note: string;
  /** 非空＝這次是被更新後重啟的，值是舊版的建置時間（用來顯示改版說明） */
  updatedFrom: string;
}

/** 一版的功能說明（wails/release_notes.json）。 */
export interface DesktopReleaseNote { buildTime: string; title: string; items: string[] }

/** 目前執行檔的資訊（不連網，用背景檢查的快取結果）。 */
export async function desktopAppInfo(): Promise<DesktopAppInfo | null> {
  const c = await hostCall();
  if (!c) return null;
  return await c.ByName('main.AdbHost.AppInfo') as DesktopAppInfo | null;
}

/** 立刻檢查一次線上版本（使用者主動確認時用）。 */
export async function desktopCheckUpdate(): Promise<DesktopAppInfo | null> {
  const c = await hostCall();
  if (!c) return null;
  return await c.ByName('main.AdbHost.CheckUpdate') as DesktopAppInfo | null;
}

/** 下載並安裝新版；成功時這個行程會被新的取代。 */
export async function desktopInstallUpdate(): Promise<{ ok: boolean; error?: string } | null> {
  const c = await hostCall();
  if (!c) return null;
  return await c.ByName('main.AdbHost.InstallUpdate') as { ok: boolean; error?: string } | null;
}

/** 比 since（舊版建置時間）新的改版說明。 */
export async function desktopReleaseNotes(since: string): Promise<DesktopReleaseNote[]> {
  const c = await hostCall();
  if (!c) return [];
  const notes = await c.ByName('main.AdbHost.ReleaseNotes', since) as DesktopReleaseNote[] | null;
  return notes ?? [];
}

/** 目前是不是全螢幕（桌面版才有；網頁版永遠 false）。 */
export async function desktopIsFullscreen(): Promise<boolean> {
  const c = await hostCall();
  if (!c) return false;
  return !!(await c.ByName('main.AdbHost.IsFullscreen'));
}

/** 切換全螢幕（Esc／F11）。回傳切換後是不是全螢幕。 */
export async function desktopToggleFullscreen(): Promise<boolean> {
  const c = await hostCall();
  if (!c) return false;
  return !!(await c.ByName('main.AdbHost.ToggleFullscreen'));
}

/**
 * 用系統的預設瀏覽器開網址（作者 2026-10-18：「留言給作者」）。
 * 沒有宿主（網頁版）或開啟失敗就回 false，讓 UI 自己退回 window.open。
 */
export async function desktopOpenExternal(url: string): Promise<boolean> {
  const c = await hostCall();
  if (!c) return false;
  try {
    return (await c.ByName('main.AdbHost.OpenExternal', url)) === true;
  } catch {
    return false;
  }
}

/** 一則 adb 的「字數」＝ source 容器解壓後的 UTF-16 code unit 總數（桌面版走 Go，一次掃完）。 */
export async function desktopCharCount(path: string): Promise<number | null> {
  const c = await hostCall();
  if (!c) return null;
  try {
    const n = await c.ByName('main.AdbHost.SourceCharCount', path);
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

/** one host file, in the shape the rest of the viewer already understands */
function hostSource(e: HostAdb): AdbSource {
  const name = e.name || e.dbcname || e.dbname || e.path;
  return {
    name,
    path: e.path,
    size: e.size,
    lastModified: e.modified,
    slice(start: number, end: number) {
      return {
        arrayBuffer: async (): Promise<ArrayBuffer> => {
          const u8 = await hostRead(e.path, start, Math.max(0, end - start));
          return u8.buffer as ArrayBuffer;
        },
      };
    },
    // native bzip2: the host does both the decompression and the UTF-16 decoding
    decompressText: (offset: number, length: number) => hostDecompressText(e.path, offset, length),
    // index queries: postings, the phrase AND and the grouping all happen in Go
    postings: (token: string) => hostPostings(e.path, token),
    // 完整查詢語法（多詞組／運算子／萬用字元）的 Go 後端；變體組由 TS 傳进来聯集
    searchQuery: (query: string, maxHits: number, groups: string[] = []) => hostSearchQuery(e.path, query, maxHits, groups),
  };
}

/**
 * Every .adb the host found next to the executable (working directory), as ordinary
 * sources. Returns [] on `file://`, so the caller can treat "no desktop" and "no
 * databases yet" the same way.
 */
export async function desktopSources(): Promise<AdbSource[]> {
  const c = await hostCall();
  if (!c) return [];
  try {
    const list = await c.ByName('main.AdbHost.ListAdbs') as HostAdb[] | null;
    const out = (list ?? []).filter((e) => e && e.path).map(hostSource);
    lastCount = out.length;
    lastError = '';
    return out;
  } catch (e) {
    lastError = String((e as Error)?.message ?? e);
    return [];
  }
}

/** diagnostics for state(): is a host answering, how many databases, and why not */
export const hostState = () => ({ available: !!call, listed: lastCount, error: lastError });
