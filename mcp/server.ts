/**
 * accelon26 adb MCP — 把 `.adb` 的讀取／搜尋引擎包成 MCP 伺服器。
 *
 *   往後只要是「讀 adb」，AI 直接呼叫這裡的工具即可，不必再翻 ADBEngine 原始碼：
 *     adb_list    列出可用的 .adb
 *     adb_info    檔頭（書名／行數／VA 上限／標籤數／文件數／資源數／容器）
 *     adb_tags    標籤清單＋各標籤實例數
 *     adb_toc     目錄樹（depth／tag／label／va／vaEnd）
 *     adb_search  全文搜尋（走 adb 內建詞索引；空白＝AND，連寫＝詞組）
 *     adb_read    讀某幾行（預設去標籤；搜尋命中後取上下文用）
 *
 *   設計：
 *   - 零依賴、純 Bun：不 import @modelcontextprotocol/sdk，自己講 stdio 上的
 *     newline-delimited JSON-RPC 2.0（本 repo 全專案無 npm 依賴，保持一致）。
 *   - 同時支援 MCP **2026-07-28（無狀態）** 與 **舊握手（initialize）**：
 *       * `server/discover`（新規範 MUST）與 `initialize`（舊 client）都答；
 *       * 結果一律附 `resultType:"complete"`（新 client 要求，舊 client 忽略無害）；
 *       * `tools/list`／`tools/call` 是共同基礎，兩代 client 都靠它。
 *     版本採**回顯**（echo）：用 client 要求的那一版回覆，不認識才退回最新正式版。
 *   - 只讀：不改 adb、不匯出、不寫檔。
 *   - 重用 `ts/tools/adb-skill/engine.ts`（與 accelon26 閱讀器同一套讀取層），
 *     所以行號、VA、搜尋結果都與閱讀器一致。
 *
 *   執行（stdio）：
 *     bun run d:\2026\adb-converter\mcp\server.ts
 *   adb 搜尋目錄（依序找 `<name>.adb`）：
 *     env ADB_MCP_DIRS（用 ; 或路径分隔符分隔），預設 D:\accelon3 ＋ repo 根目錄。
 *   除錯輸出全部走 stderr；stdout 只有 JSON-RPC。
 */
import { readdirSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { openAdb, type AdbEngine } from '../ts/tools/adb-skill/engine.ts';

// ───────────────────────── 協議常量 ─────────────────────────

/** 最新正式版（2026-07-28）。舊版一律接受回顯。 */
const LATEST_PROTOCOL = '2026-07-28';
/** server/discover 可宣告的全部版本（含仍在使用的握手世代）。 */
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', LATEST_PROTOCOL];
/** 从此版本起为无状态：结果必须带 resultType。 */
const STATELESS_FROM = '2026-07-28';

const SERVER_INFO = { name: 'accelon26-adb', title: 'accelon26 adb reader', version: '1.0.0' } as const;

/** 目前这轮对话协商到的协议版本（initialize / _meta 会改写它）。 */
let protocolVersion = LATEST_PROTOCOL;

const isNew = (): boolean => protocolVersion >= STATELESS_FROM;

/** 给结果补 resultType（新规范）；旧版 client 会忽略这个字段。 */
const withResultType = <T extends Record<string, unknown>>(r: T): T & { resultType: 'complete' } =>
  isNew() ? { ...r, resultType: 'complete' as const } : r;

// ───────────────────────── adb 目錄與解析 ─────────────────────────

/** 依序搜尋 `<name>.adb` 的目錄（去重、存在的優先，但保留給 list 掃）。 */
const adbDirs: string[] = (() => {
  const env = process.env.ADB_MCP_DIRS ?? process.env.ADB_MCP_DIR ?? '';
  const raw = env ? env.split(/;|:/).map((s) => s.trim()).filter(Boolean) : [];
  const repoRoot = dirname(import.meta.dir); // .../adb-converter（本檔在 adb-converter/mcp/）
  const def = ['D:\\accelon3', repoRoot];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...raw, ...def]) {
    const k = resolve(d);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
})();

/** 已開過的 adb 快取：absPath → engine（同檔只開一次；開檔 26–60 ms）。 */
const cache = new Map<string, Promise<AdbEngine>>();

/** 把 `<db>`（13j ／ 13j.adb ／ 絕對路徑）解析成實際檔案，找不到回 null。 */
function resolvePath(db: string): string | null {
  if (!db) return null;
  const exact = isAbsolute(db) ? db : resolve(db);
  if (existsSync(exact)) return exact;
  const withExt = exact.endsWith('.adb') ? exact : exact + '.adb';
  if (existsSync(withExt)) return withExt;
  const bare = basename(withExt);
  for (const dir of adbDirs) {
    const p = join(dir, bare);
    if (existsSync(p)) return p;
  }
  return null;
}

/** lazy 開檔並快取。 */
function getEngine(absPath: string): Promise<AdbEngine> {
  let e = cache.get(absPath);
  if (!e) { e = openAdb(absPath); cache.set(absPath, e); }
  return e;
}

/** 解析 + 開檔；失敗拋中文錯誤（tools/call 會包成 isError）。 */
async function open(db: string): Promise<{ eng: AdbEngine; file: string }> {
  const abs = resolvePath(db);
  if (!abs) throw new Error(`找不到 adb：「${db}」。用 adb_list 看有哪些庫，或檢查 ADB_MCP_DIRS（目前：${adbDirs.join('、')}）。`);
  return { eng: await getEngine(abs), file: abs };
}

// ───────────────────────── 工具定義 ─────────────────────────

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

interface ToolResult { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError?: boolean }

/** 包成 MCP CallToolResult：一份給模型看（text），一份給程式用（structuredContent）。 */
function ok(text: string, structured: unknown): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

const TOOL_DEFS = [
  {
    name: 'adb_list',
    title: '列出 adb 庫',
    description: '列出搜尋目錄（ADB_MCP_DIRS，預設 D:\\accelon3 ＋ repo 根）裡所有可用的 .adb。不傳參數。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'adb_info',
    title: 'adb 檔頭',
    description: '回一本 adb 的檔頭：書名（title/dbname）、行數、VA 上限、標籤數、文件數、資源數、容器清單。讀 adb 前先 info。',
    inputSchema: {
      type: 'object',
      properties: { db: { type: 'string', description: '庫名或路徑，例 13j、taisho、D:\\accelon3\\cyd.adb' } },
      required: ['db'],
      additionalProperties: false,
    },
  },
  {
    name: 'adb_tags',
    title: '標籤清單',
    description: '回一本 adb 的標籤（tag）名稱與每個標籤的實例數（開標籤計數）。用來判斷可以用哪些 <標籤> 做結構化檢索。',
    inputSchema: {
      type: 'object',
      properties: { db: { type: 'string' } },
      required: ['db'],
      additionalProperties: false,
    },
  },
  {
    name: 'adb_toc',
    title: '目錄樹',
    description: '回 adb 的目錄樹（第一棵 <樹>）。每列：depth、tag、label、va、vaEnd。沒有 <樹> 宣告的庫（多半是詞典）回空，改用 adb_search／adb_info。',
    inputSchema: {
      type: 'object',
      properties: {
        db: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 5000, description: '最多回幾列，預設 200。' },
      },
      required: ['db'],
      additionalProperties: false,
    },
  },
  {
    name: 'adb_search',
    title: '全文搜尋',
    description: '走 adb 內建詞索引的全文搜尋。空白分開＝每個詞都要出現（AND）；連寫＝詞組（字序相連、可跨硬換行）。支援 +／-／* 與 . 萬用字元。回 total（全部命中數）、missing（索引裡沒有的詞）、hits[{line,va,text}]。line 是行號（0 起算，與閱讀器狀態列一致），拿 line 給 adb_read 取上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        db: { type: 'string' },
        query: { type: 'string', description: '查詢字串，例「涅槃」「君子終日乾乾」「乾 -坤」。' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '回前幾筆命中，預設 20（引擎內部最多掃 5000）。' },
      },
      required: ['db', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'adb_read',
    title: '讀某幾行',
    description: '讀 adb 的連續幾行（行號 0 起算）。預設去掉標籤的純文字；raw=true 回原始標記。只讀需要的行，不要用本工具整本抽取。',
    inputSchema: {
      type: 'object',
      properties: {
        db: { type: 'string' },
        from: { type: 'integer', minimum: 0, description: '起始行號。' },
        to: { type: 'integer', minimum: 0, description: '迄行號（含），省略＝只讀 from 那一行。' },
        raw: { type: 'boolean', description: 'true＝保留標籤的原文，預設 false。' },
      },
      required: ['db', 'from'],
      additionalProperties: false,
    },
  },
] as const;

/** 每本 adb 的標籤實例數：直接讀 tags 容器名表（開標籤不含前置 '/'）。 */
function tagCounts(eng: AdbEngine): { tag: string; count: number }[] {
  const c = eng.reader.containers.get('tags');
  const names = c?.names ?? [];
  // tags 容器每個開標籤是一個條目；'/' 開頭是閉標籤。實例數＝同名開標籤條目數。
  const m = new Map<string, number>();
  for (const n of names) {
    if (n.startsWith('/')) continue;
    m.set(n, (m.get(n) ?? 0) + 1);
  }
  return [...m.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

// ───────────────────────── 工具實作 ─────────────────────────

async function callTool(name: string, a: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'adb_list': {
      const dirs = adbDirs.map((d) => {
        let files: string[] = [];
        let error: string | undefined;
        try {
          files = readdirSync(d).filter((f) => /\.adb$/i.test(f)).sort((x, y) => x.localeCompare(y, 'en'));
        } catch (e) { error = (e as Error).message; }
        return { dir: d, exists: existsSync(d), count: files.length, files, error };
      });
      const total = dirs.reduce((s, d) => s + d.count, 0);
      const text = dirs
        .map((d) => `${d.dir}${d.exists ? '' : '（不存在）'}：${d.count} 本${d.error ? `（${d.error}）` : ''}\n${d.files.map((f) => '  ' + f).join('\n')}`)
        .join('\n\n');
      return ok(`${total} 本 .adb（搜尋目錄：${adbDirs.join('、')}）\n\n${text || '（沒有）'}`, { dirs, total, searchDirs: adbDirs });
    }
    case 'adb_info': {
      const { eng, file } = await open(String(a.db ?? ''));
      const h = eng.reader.header;
      const info = {
        file: basename(file),
        title: eng.title,
        dbname: h.dbname,
        dbcname: h.dbcname,
        lines: eng.lines,
        maxVA: h.maxBlockOffset,
        tags: eng.tags.length,
        tagNames: eng.tags,
        docs: (await eng.reader.documents()).length,
        resources: eng.reader.containers.get('resources')?.count ?? 0,
        containers: eng.reader.order,
      };
      const text = [
        `書名：${info.title}（dbname=${info.dbname}）`,
        `行數：${info.lines.toLocaleString('en-US')}　VA 上限：${info.maxVA.toLocaleString('en-US')}`,
        `標籤：${info.tags}　文件：${info.docs}　資源：${info.resources}`,
        `容器：${info.containers.join('、')}`,
        `標籤名：${info.tagNames.join('、')}`,
      ].join('\n');
      return ok(text, info);
    }
    case 'adb_tags': {
      const { eng, file } = await open(String(a.db ?? ''));
      const counts = tagCounts(eng);
      const text = `${basename(file)}：${counts.length} 個標籤\n` +
        counts.map((c) => `  ${c.tag}\t${c.count.toLocaleString('en-US')}`).join('\n');
      return ok(text, { file: basename(file), tags: counts });
    }
    case 'adb_toc': {
      const { eng } = await open(String(a.db ?? ''));
      const limit = clamp(Number(a.limit ?? 200) || 200, 1, 5000);
      const rows = await eng.toc();
      const shown = rows.slice(0, limit);
      const text = rows.length
        ? shown.map((r) => `${'  '.repeat(r.depth)}${r.tag} ${r.label}  [va ${r.va}…${r.vaEnd}]`).join('\n') +
          (rows.length > limit ? `\n（還有 ${rows.length - limit} 列，用 limit 放大）` : '')
        : '（這個庫沒有 <樹> 宣告，改用 adb_search／adb_info）';
      return ok(`${rows.length} 個節點\n${text}`, { total: rows.length, truncated: rows.length > limit, rows: shown });
    }
    case 'adb_search': {
      const { eng } = await open(String(a.db ?? ''));
      const query = String(a.query ?? '').trim();
      if (!query) throw new Error('adb_search 需要 query（例：query="涅槃"）。');
      const limit = clamp(Number(a.limit ?? 20) || 20, 1, 500);
      const r = await eng.search(query, limit);
      const text = `「${query}」命中 ${r.total.toLocaleString('en-US')} 筆（${r.ms} ms）` +
        (r.missing.length ? `\n索引裡沒有：${r.missing.join('、')}` : '') +
        '\n' + r.hits.map((h) => `[行 ${h.line}] ${h.text}`).join('\n');
      return ok(text, { query, total: r.total, ms: r.ms, missing: r.missing, hits: r.hits });
    }
    case 'adb_read': {
      const { eng } = await open(String(a.db ?? ''));
      const total = eng.lines;
      const from = clamp(Number(a.from ?? 0) || 0, 0, Math.max(0, total - 1));
      const to = a.to === undefined ? from : clamp(Number(a.to), from, total - 1);
      if (to - from > 5000) throw new Error(`一次最多讀 5000 行（要 ${to - from + 1} 行）。請縮小範圍或用 adb_search 定位。`);
      const raw = !!a.raw;
      const lines: { line: number; text: string }[] = [];
      for (let i = from; i <= to; i++) {
        lines.push({ line: i, text: raw ? await eng.raw(i) : await eng.line(i) });
      }
      return ok(lines.map((l) => `${l.line}: ${l.text}`).join('\n'), { from, to, raw, lines });
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

// ───────────────────────── JSON-RPC 骨架 ─────────────────────────

interface RpcError { code: number; message: string; data?: unknown }
class JsonRpcError extends Error { constructor(public rpc: RpcError) { super(rpc.message); } }
const badReq = (message: string, data?: unknown): JsonRpcError => new JsonRpcError({ code: -32600, message, data });
const notFound = (m: string): JsonRpcError => new JsonRpcError({ code: -32601, message: `Method not found: ${m}` });
const invalid = (message: string, data?: unknown): JsonRpcError => new JsonRpcError({ code: -32602, message, data });
const internal = (message: string, data?: unknown): JsonRpcError => new JsonRpcError({ code: -32603, message, data });

const CAPS = { tools: { listChanged: false } } as const;

/** 從 2026-07-28 的 per-request `_meta` 取版本／能力（無狀態路徑）。 */
function applyReqMeta(meta: unknown): void {
  if (!meta || typeof meta !== 'object') return;
  const m = meta as Record<string, unknown>;
  const v = m['io.modelcontextprotocol/protocolVersion'];
  if (typeof v === 'string') adoptVersion(v);
}

/** 版本協商：回顯 client 要的那版（合法日期格式）；不認識才退回最新正式版。 */
function adoptVersion(requested: unknown): void {
  if (typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested)) protocolVersion = requested;
  else protocolVersion = LATEST_PROTOCOL;
}

/** 單一請求 → result（或拋 JsonRpcError）。回 undefined = 通知，不回應。 */
async function handle(method: string, params: Record<string, unknown> | undefined, id: unknown): Promise<unknown> {
  // 通知：無 id，不該回 response。
  if (id === undefined || id === null) return undefined;

  switch (method) {
    case 'initialize': {
      adoptVersion(params?.protocolVersion);
      return withResultType({
        protocolVersion,
        capabilities: CAPS,
        serverInfo: SERVER_INFO,
        instructions: '讀 accelon .adb：先 adb_list / adb_info，再 adb_search 定位，需要原文用 adb_read。全程只讀。',
      });
    }
    case 'server/discover': {
      applyReqMeta(params?.['_meta']);
      return withResultType({
        supportedVersions: SUPPORTED_PROTOCOLS,
        defaultVersion: protocolVersion,
        capabilities: CAPS,
        serverInfo: SERVER_INFO,
        instructions: '讀 accelon .adb：先 adb_list / adb_info，再 adb_search 定位，需要原文用 adb_read。全程只讀。',
      });
    }
    case 'ping':
      return withResultType({});
    case 'tools/list': {
      return withResultType({
        tools: TOOL_DEFS.map((t) => ({
          name: t.name,
          title: 'title' in t ? t.title : undefined,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        ...(isNew() ? { ttlMs: 3_600_000, cacheScope: 'public' as const } : {}),
      });
    }
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!TOOL_DEFS.some((t) => t.name === name)) throw invalid(`未知工具：${name}`);
      try {
        const res = await callTool(name, args);
        return withResultType(res);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return withResultType({ content: [{ type: 'text', text: `錯誤：${msg}` }], isError: true });
      }
    }
    // 本 server 不提供 resources／prompts。
    case 'resources/list':
    case 'prompts/list':
      return withResultType(isNew() && method.startsWith('resources') ? { resources: [], ttlMs: 3_600_000, cacheScope: 'public' } : method.startsWith('resources') ? { resources: [] } : { prompts: [] });
    default:
      throw notFound(method);
  }
}

// ───────────────────────── stdio 傳輸（NDJSON） ─────────────────────────

/** 寫一則 JSON-RPC 訊息：確保序列化後不殘留裸換行（NDJSON 一行一訊息）。 */
function send(obj: Record<string, unknown>): void {
  let s = JSON.stringify(obj);
  // 任何 U+2028/U+2029/換行已在字串值內被 JSON 跳脱；這裡只是最後防呆。
  s = s.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  process.stdout.write(s + '\n');
}

const log = (...x: unknown[]): void => process.stderr.write(`[adb-mcp] ${x.join(' ')}\n`);

async function dispatch(msg: Record<string, unknown>): Promise<void> {
  const id = msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? undefined) as Record<string, unknown> | undefined;
  let result: unknown;
  let error: RpcError | undefined;
  try {
    result = await handle(method, params, id);
  } catch (e) {
    if (e instanceof JsonRpcError) error = e.rpc;
    else error = internal(e instanceof Error ? e.message : String(e));
    log('error', method, error.code, error.message);
  }
  if (result === undefined && !error) return; // 通知：不回應
  if (error) send({ jsonrpc: '2.0', id: id ?? null, error });
  else send({ jsonrpc: '2.0', id: id as string | number, result: result ?? {} });
}

function main(): void {
  log(`ready · ${TOOL_DEFS.length} tools · searchDirs: ${adbDirs.join(' | ')}`);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      void dispatch(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

main();
