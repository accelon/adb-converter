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
/** why the host is absent (diagnostics: state().host) — a silently empty dropdown is a bug */
let lastError = '';
let lastCount = 0;

/**
 * Load the Wails runtime lazily — from `file://` there simply is none. The import is
 * built through `new Function` so the bundler does not try to resolve a path that only
 * exists inside the desktop host.
 */
async function hostCall(): Promise<HostCall | null> {
  if (probed) return call;
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
 * The whole index query in ONE call: token lookups (Go decodes their posting lists in
 * parallel), the phrase AND and the grouping statistics (wails/search.go). Only the
 * hits and the group counts come back — the posting lists stay in Go.
 */
async function hostSearchTokens(path: string, tokens: string[], groupTag: string, maxHits: number): Promise<unknown> {
  const c = await hostCall();
  if (!c) return null;
  return await c.ByName('main.AdbHost.SearchTokens', path, tokens, groupTag, maxHits);
}

/** one host file, in the shape the rest of the viewer already understands */
function hostSource(e: HostAdb): AdbSource {
  const name = e.name || e.dbcname || e.dbname || e.path;
  return {
    name,
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
    searchTokens: (tokens: string[], groupTag: string, maxHits: number) => hostSearchTokens(e.path, tokens, groupTag, maxHits),
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
