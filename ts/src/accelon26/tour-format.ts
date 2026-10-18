/**
 * 「操作導覽」的宏腳本格式（作者 2026-10）。
 *
 * 三層東西，各有各的檔案：
 *   1. 劇本 `.tour`（人寫的，Markdown 方言）—— 見 `ts/tour/*.tour`
 *   2. 宏（這一支：二進位 ＋ base64，人不可讀）—— 由 `ts/tools/build-tours.ts` 產生
 *   3. 播放器（`tour.ts`）—— 解開宏，一步一步做
 *
 * 為什麼要編譯成二進位，而不是把劇本原樣塞進 HTML？
 *   * 單檔 HTML 在 file:// 下 **fetch 不到旁邊的檔案**（見 page-build.ts 的說明），
 *     所以宏只能內嵌；內嵌的東西越緊湊越好。
 *   * 播放器與劇本語法解耦：改 DSL 不必動播放器，只要格式版本對得上。
 *   * 產品不會因為有人手滑編輯資料而壞掉 —— 這是「妨礙順手改」，不是防破解
 *     （誰都能 base64 解回來，別把它當加密）。
 *
 * 格式（little-endian）：
 *
 *   "AC26T"          5 bytes    magic
 *   u8               1          格式版本（TOUR_FMT）
 *   u8               1          旗標（保留，目前 0）
 *   u32              4          後面 payload 的 CRC32（改壞了要能說人話）
 *   str id | str title | str intro | str require
 *   u16              2          場景數
 *     每個場景：str title | str 說明(Markdown) | u16 步驟數
 *       每個步驟：u8 opcode | u8 參數個數 | 參數 × str
 *
 *   str = u16 位元組長度 ＋ UTF-8 bytes（上限 65535 —— 單一說明文字不可能更長）
 *
 * 數字一律當「字串」存（"400"），播放器自己 Number()。少一種編碼型別，就少一處錯。
 */

export const TOUR_MAGIC = 'AC26T';

/** 格式版本。**動了編碼方式就要 +1**，舊播放器會拒絕而不是亂播。 */
export const TOUR_FMT = 1;

/** 單一指令。名字是小寫英文，劇本裡可以用中文別名（見 build-tours.ts 的 ALIAS）。 */
export const OP = {
  /** 換氣泡文字（場景中途分兩段講） */
  text: 1,
  /** 聚光燈照到某個元素 */
  point: 2,
  /** 收掉聚光燈 */
  unpoint: 3,
  /** el.click() */
  click: 4,
  /** 設值 ＋ 派送 input 事件（走真實的 debounce 路徑） */
  type: 5,
  /** 在指定元素（預設 activeElement）上派送 keydown */
  key: 6,
  /** 單純停一下，讓眼睛跟上 */
  wait: 7,
  /** 輪詢到條件成立 */
  waitFor: 8,
  /** 切換某一欄的分頁 */
  tab: 9,
  /** 顯示／收起某一欄 */
  side: 10,
  /** 設定項（advanced / variants / pagemarks / simmode / hardbreaks / raw） */
  set: 11,
  /** 白名單函式（openSettings / runSearchAll / dictLookup …） */
  call: 12,
  /** 等使用者自己做完（附完成條件） */
  user: 13,
  /** 條件不成立就停在這裡等（資料庫沒開、不是桌面版…） */
  require: 14,
  /** 條件成立就整場跳過 */
  skipIf: 15,
} as const;

export type OpCode = (typeof OP)[keyof typeof OP];

/** opcode → 名字（錯誤訊息與測試用） */
export const OP_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(OP).map(([k, v]) => [v, k]),
);

/** 劇本裡的一步。`args` 的內容由 `op` 決定，見上面 OP 的註解。 */
export interface Step {
  op: number;
  args: string[];
}

/** 一個場景：一段說明文字 ＋ 一串指令。 */
export interface Scene {
  title: string;
  /** Markdown（只支援 **粗體**、`等寬`、空行分段） */
  body: string;
  steps: Step[];
}

/** 選單用的摘要（`tour-data.ts` 的 TOUR_INDEX；播放器不播放也能列出清單） */
export interface TourMeta {
  id: string;
  title: string;
  intro: string;
  scenes: number;
  steps: number;
  /** 檔案頭的 @require（例：`db=13j`）；空字串＝沒有要求 */
  require: string;
  /** 宏的位元組數（診斷用：多大一坨塞進 HTML） */
  bytes: number;
}

/** 一整份劇本。 */
export interface Tour {
  id: string;
  title: string;
  intro: string;
  /** 檔案頭的 `@require`（例：`db=13j`）；空字串＝沒有要求 */
  require: string;
  scenes: Scene[];
}

// ------------------------------------------------------------------ byte I/O
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

class Writer {
  private b: number[] = [];
  u8(v: number): void { this.b.push(v & 0xff); }
  u16(v: number): void { this.b.push(v & 0xff, (v >> 8) & 0xff); }
  u32(v: number): void {
    this.b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  }
  raw(a: Uint8Array): void { for (const x of a) this.b.push(x); }
  str(s: string): void {
    const u = enc.encode(s);
    if (u.length > 0xffff) throw new Error(`字串太長（${u.length} bytes，上限 65535）：${s.slice(0, 20)}…`);
    this.u16(u.length);
    this.raw(u);
  }
  bytes(): Uint8Array { return new Uint8Array(this.b); }
}

class Reader {
  i = 0;
  constructor(private readonly d: Uint8Array) {}
  u8(): number { return this.d[this.i++] ?? 0; }
  u16(): number {
    const v = (this.d[this.i] ?? 0) | ((this.d[this.i + 1] ?? 0) << 8);
    this.i += 2;
    return v;
  }
  u32(): number {
    const v = ((this.d[this.i] ?? 0) | ((this.d[this.i + 1] ?? 0) << 8)
      | ((this.d[this.i + 2] ?? 0) << 16) | ((this.d[this.i + 3] ?? 0) << 24)) >>> 0;
    this.i += 4;
    return v;
  }
  raw(n: number): Uint8Array {
    const r = this.d.subarray(this.i, this.i + n);
    this.i += n;
    return r;
  }
  str(): string { return dec.decode(this.raw(this.u16())); }
  ascii(n: number): string { return String.fromCharCode(...this.raw(n)); }
  get eof(): boolean { return this.i >= this.d.length; }
}

// -------------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------ 編碼／解碼
/** 劇本 → 二進位宏。空場景與未知 opcode 在這裡就擋掉（播放器不必再防）。 */
export function encodeTour(t: Tour): Uint8Array {
  const body = new Writer();
  body.str(t.id);
  body.str(t.title);
  body.str(t.intro ?? '');
  body.str(t.require ?? '');
  body.u16(t.scenes.length);
  for (const sc of t.scenes) {
    body.str(sc.title);
    body.str(sc.body ?? '');
    body.u16(sc.steps.length);
    for (const st of sc.steps) {
      body.u8(st.op);
      body.u8(st.args.length);
      for (const a of st.args) body.str(a);
    }
  }
  const payload = body.bytes();
  const out = new Writer();
  out.raw(enc.encode(TOUR_MAGIC));
  out.u8(TOUR_FMT);
  out.u8(0);
  out.u32(crc32(payload));
  out.raw(payload);
  return out.bytes();
}

/** 二進位宏 → 劇本。任何不一致都丟出「人話」錯誤（播放器接住後顯示在氣泡裡）。 */
export function decodeTour(bytes: Uint8Array): Tour {
  const r = new Reader(bytes);
  const magic = r.ascii(5);
  if (magic !== TOUR_MAGIC) throw new Error(`不是導覽宏（magic=${JSON.stringify(magic)}）`);
  const fmt = r.u8();
  if (fmt !== TOUR_FMT) throw new Error(`導覽宏格式版本 ${fmt}，這支程式只認得 ${TOUR_FMT}（請更新 accelon26）`);
  r.u8();                                  // flags，保留
  const want = r.u32();
  const got = crc32(bytes.subarray(r.i));  // payload 從這裡開始
  if (want !== got) throw new Error(`導覽宏損壞（CRC ${got.toString(16)} ≠ ${want.toString(16)}）`);
  const tour: Tour = {
    id: r.str(), title: r.str(), intro: r.str(), require: r.str(),
    scenes: [],
  };
  const n = r.u16();
  for (let i = 0; i < n; i++) {
    const sc: Scene = { title: r.str(), body: r.str(), steps: [] };
    const m = r.u16();
    for (let j = 0; j < m; j++) {
      const op = r.u8();
      const argc = r.u8();
      const args: string[] = [];
      for (let k = 0; k < argc; k++) args.push(r.str());
      if (!OP_NAME[op]) throw new Error(`場景 ${i + 1} 第 ${j + 1} 步：未知指令 ${op}`);
      sc.steps.push({ op, args });
    }
    tour.scenes.push(sc);
  }
  if (!r.eof) throw new Error(`導覽宏尾端有 ${bytes.length - r.i} bytes 多餘資料`);
  return tour;
}

// ------------------------------------------------------------------- base64
/** 二進位 → base64（瀏覽器與 Bun 都有 btoa；分塊避免 spread 爆堆疊） */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** base64 → 二進位 */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
