/**
 * 標籤樣式（作者 2026-10-22）：設置 → 標籤樣式 的資料模型與顏色推算。
 *
 * 這個模組只管「資料」：哪個標籤／群組被設成什麼、合併後的顏色／大小／字型。
 * 真正的讀寫在 `settings.ts`（localStorage／宿主），畫面在 `ui.ts`，套用到本文在
 * `render_accelon3.ts`／`scopes.ts`／`doc-pane.ts`。
 *
 * 規則（作者 2026-10-22 定案）：
 *   * 一般標籤：此資料庫 → 全域 → auto（tagStyleOf() 回 null 就是 auto）。
 *   * 天干地支：**同一個設定、22 層**；只有一筆群組設定，22 個字的顏色由底色
 *     每層色相 +30° 推算（rampColor），不存個別字。
 *   * `settings.json` 的 adb 鍵＝**adb 檔名**；重建 adb 不會動到設定。
 *   * 只存「有自訂」的條目；大小是相對本文的百分比（50–300）。
 */

export const SETTINGS_FORMAT = 'accelon26-settings';
export const SETTINGS_VERSION = 1;
export const SIZE_MIN = 50;
export const SIZE_MAX = 300;
export const GROUP_ID = '天干地支';
/** 「本文」列在 tagStyle.body；不是真正的標籤（避免和 <文> 混淆） */
export const BODY_KEY = '__body__';

/** 天干（10）＋地支（12），順序就是 22 層的色相順序 */
export const GROUP_TAGS = [
  '甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸',
  '子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥',
] as const;

/** 預設清單裡的結構標籤（實際的「此庫其他」由目錄樹補上；作者 2026-10-22 追加文項部經） */
export const STRUCTURAL_TAGS = ['書', '篇', '章', '節', '詞', '文', '項', '部', '經'] as const;

/** 標籤的預設字型（作者 2026-10-22：<經> 缺省用楷體；使用者自訂字型可以蓋掉） */
export const DEFAULT_TAG_FONTS: Record<string, string> = { 經: '楷體' };

export function defaultFontOf(tag: string): string | null {
  return DEFAULT_TAG_FONTS[tag] ?? null;
}

/** 本文的字型堆疊（與 doc-pane.ts 的 DOC_TEXT_FAMILY 一致） */
const BODY_STACK = "'Microsoft JhengHei', 'Segoe UI', system-ui, sans-serif";
/** 「楷體」不是一個每個系統都有的家族名：Windows 用標楷體／楷體，其他系統再退回本文 */
const KAI_STACK = "'DFKai-SB', 'KaiTi', '楷體'";

/**
 * font-family 的 CSS 值（單引號：呼叫端可能把它放進 HTML 的 style="…"）。
 * 這裡也處理「楷體」的跨平台堆疊；第一種 → 第二種 → 本文。
 */
export function fontFamilyOf(s: { font?: string | null; font2?: string | null }): string {
  const clean = (x: string) => x.replace(/['"\\]/g, '');
  const list: string[] = [];
  if (s.font === '楷體') list.push(KAI_STACK);
  else if (s.font) list.push(`'${clean(s.font)}'`);
  if (s.font2) list.push(`'${clean(s.font2)}'`);
  list.push(BODY_STACK);
  return list.join(', ');
}

export interface TagStyle {
  color?: string;
  size?: number;
  font?: string;
  font2?: string;
}

/** 一個 profile 的自訂條目（tags：一般標籤；groups：天干地支；body：本文的顏色／字型） */
export interface TagStyleProfile {
  tags: Record<string, TagStyle>;
  groups: Record<string, TagStyle>;
  body?: TagStyle;
}

export interface AdbProfile {
  name?: string;
  tagStyle?: TagStyleProfile;
}

export interface SettingsFile {
  format: string;
  version: number;
  updated?: string;
  profiles: {
    global?: { tagStyle?: TagStyleProfile };
    adb?: Record<string, AdbProfile>;
  };
  [extra: string]: unknown;
}


const emptyProfile = (): TagStyleProfile => ({ tags: {}, groups: {} });

let globalProfile: TagStyleProfile = emptyProfile();
let adbProfiles: Record<string, AdbProfile> = {};
let activeFile = '';
let activeName = '';
/** settings.json 頂層不認得的欄位：原樣保留，存回去時不丟 */
let extraTop: Record<string, unknown> = {};
let loaded = false;

const listeners: (() => void)[] = [];
const dbListeners: (() => void)[] = [];
/** 設定變更：ui.ts 用它重繪本文／目錄／breadcrumb */
export function onTagStyleChange(fn: () => void): void {
  listeners.push(fn);
}
/** 換庫（只給「本文的 per-adb 樣式」等輕量更新用；不重繪本文／目錄） */
export function onActiveDbChange(fn: () => void): void {
  dbListeners.push(fn);
}
/** 通知一次（拖動滑桿時先用 silent 寫入，放開再通知） */
export function notifyTagStyles(): void {
  notify();
}
function notify(): void {
  for (const fn of listeners) fn();
}

/* ---------------------------------------------------------------- 查詢 */

export function isLoaded(): boolean { return loaded; }

export function isGroup(key: string): boolean { return key === GROUP_ID; }

/** 這個標籤是不是天干地支的成員（回 0..21，不是就 -1） */
export function memberIndex(tag: string): number {
  return (GROUP_TAGS as readonly string[]).indexOf(tag);
}

export function isKnownTag(tag: string): boolean {
  return (STRUCTURAL_TAGS as readonly string[]).includes(tag) || memberIndex(tag) >= 0;
}

export function activeDb(): { file: string; name: string } {
  return { file: activeFile, name: activeName };
}

/** 換庫：設定頁的「此資料庫」跟著切；畫面上的本文由 openFile／restoreCore 自己重繪。
 *  **不**在這裡 notify 樣式聽眾（會重繪本文與目錄，換庫時狀態還沒準備好）；
 *  只通知「換庫聽眾」，讓本文的 per-adb 樣式（顏色／字型）即時套上。 */
export function setActiveDb(file: string, name: string): void {
  const f = file || '';
  const n = name || '';
  if (f === activeFile && n === activeName) return;
  activeFile = f;
  activeName = n;
  for (const fn of dbListeners) fn();
}

export function profileOf(scope: 'global' | 'adb'): TagStyleProfile {
  if (scope === 'global') return globalProfile;
  const p = adbProfiles[activeFile];
  return p?.tagStyle
    ? { tags: p.tagStyle.tags ?? {}, groups: p.tagStyle.groups ?? {}, body: p.tagStyle.body }
    : emptyProfile();
}

/** 這一層自己的條目（沒有就 undefined）；BODY_KEY 是本文字色／字型 */
export function entryOf(scope: 'global' | 'adb', key: string): TagStyle | undefined {
  const p = profileOf(scope);
  if (key === BODY_KEY) return p.body;
  return isGroup(key) ? p.groups[key] : p.tags[key];
}

export type StyleSource = 'adb' | 'adbGroup' | 'global' | 'globalGroup';

export interface EffectiveEntry {
  entry: TagStyle;
  source: StyleSource;
  /** 來源群組（天干地支） */
  group?: string;
}

/**
 * 合併後「這一層」的條目：一般標籤＝此庫→全域；天干地支成員＝此庫群組→全域群組；
 * BODY_KEY＝此庫本文→全域本文。沒有自訂就回 null（auto）。
 */
export function effectiveEntry(tag: string): EffectiveEntry | null {
  if (tag === BODY_KEY) {
    const a = adbProfiles[activeFile]?.tagStyle?.body;
    if (a) return { entry: a, source: 'adb' };
    const b = globalProfile.body;
    if (b) return { entry: b, source: 'global' };
    return null;
  }
  // 天干地支「群組本身」也是在 groups 裡（沒有 tag 條目）
  if (isGroup(tag)) {
    const a = adbProfiles[activeFile]?.tagStyle?.groups?.[tag];
    if (a) return { entry: a, source: 'adbGroup', group: tag };
    const b = globalProfile.groups[tag];
    if (b) return { entry: b, source: 'globalGroup', group: tag };
    return null;
  }
  const g = memberIndex(tag) >= 0 ? GROUP_ID : null;
  if (g) {
    const a = adbProfiles[activeFile]?.tagStyle?.groups?.[g];
    if (a) return { entry: a, source: 'adbGroup', group: g };
    const b = globalProfile.groups[g];
    if (b) return { entry: b, source: 'globalGroup', group: g };
    return null;
  }
  const a = adbProfiles[activeFile]?.tagStyle?.tags?.[tag];
  if (a) return { entry: a, source: 'adb' };
  const b = globalProfile.tags[tag];
  if (b) return { entry: b, source: 'global' };
  return null;
}

/** 本文的自訂樣式（沒有就 null＝主題字色／本文預設字型／文件字級） */
export function bodyStyleOf(): { color: string | null; font: string | null; font2: string | null; size: number | null } | null {
  const eff = effectiveEntry(BODY_KEY);
  if (!eff) return null;
  const e = eff.entry;
  return {
    color: e.color || null,
    font: e.font === undefined ? null : e.font,
    font2: e.font2 === undefined ? null : e.font2,
    size: e.size === undefined || e.size === null ? null : clampBodySize(e.size),
  };
}

/** 自訂樣式（缺的欄位＝auto；整個 null＝這個標籤沒有自訂） */
export interface ResolvedStyle {
  /** null＝用主題的 tag 色；天干地支一定有（由底色推算） */
  color: string | null;
  /** null＝用依層次算出來的大小 */
  size: number | null;
  /** null／空字串＝本文的字型 */
  font: string | null;
  font2: string | null;
}

export function tagStyleOf(tag: string, _depth?: number): ResolvedStyle | null {
  const eff = effectiveEntry(tag);
  if (!eff) return null;
  const e = eff.entry;
  const i = memberIndex(tag);
  return {
    color: i >= 0 ? rampColor(e.color || '#e0a54a', i) : (e.color || null),
    size: e.size === undefined || e.size === null ? null : clampSize(e.size),
    font: e.font === undefined ? null : e.font,
    font2: e.font2 === undefined ? null : e.font2,
  };
}

/** 只取顏色（目錄色點／breadcrumb 用；沒有自訂就 null） */
export function tagColorOf(tag: string): string | null {
  const s = tagStyleOf(tag);
  return s ? s.color : null;
}

/* ---------------------------------------------------------------- 修改 */

function clampSize(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 100;
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(v)));
}

/** 本文的字級是 pt（8–30），和標籤的百分比不同 */
function clampBodySize(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 12;
  return Math.max(8, Math.min(30, Math.round(v)));
}

/** 設定／刪除一層的條目（entry=null 就是重設）。成員標籤不能單獨設定。 */
export function setEntry(scope: 'global' | 'adb', key: string, entry: TagStyle | null, opts: { silent?: boolean } = {}): void {
  if (scope === 'adb' && !activeFile) return;
  if (memberIndex(key) >= 0) return;          // 天干地支只有群組
  if (scope === 'global') {
    applyTo(globalProfile, key, entry);
    if (!opts.silent) notify();
    return;
  }
  const p = adbProfiles[activeFile] ?? (adbProfiles[activeFile] = {});
  p.name = p.name || activeName;
  const st = p.tagStyle ?? (p.tagStyle = { tags: {}, groups: {} });
  st.tags ??= {};
  st.groups ??= {};
  applyTo(st, key, entry);
  if (!opts.silent) notify();
}

function applyTo(profile: TagStyleProfile, key: string, entry: TagStyle | null): void {
  if (key === BODY_KEY) {
    if (!entry) { delete profile.body; return; }
    const body: TagStyle = {};
    if (entry.color) body.color = entry.color;
    if (entry.font !== undefined) body.font = entry.font;
    if (entry.font2 !== undefined) body.font2 = entry.font2;
    if (entry.size !== undefined && entry.size !== null) body.size = clampBodySize(entry.size);
    profile.body = body;
    if (!Object.keys(body).length) delete profile.body;
    return;
  }
  const bag = isGroup(key) ? profile.groups : profile.tags;
  if (!entry) { delete bag[key]; return; }
  const next: TagStyle = { ...entry };
  // 只給有寫 size 的條目夾範圍；沒寫＝auto，不要偷偷變成 100%（作者 2026-10-22）
  if (entry.size === undefined || entry.size === null) delete next.size;
  else next.size = clampSize(entry.size);
  bag[key] = next;
}

/* ---------------------------------------------------------------- 顏色：天干地支 22 層 */

export interface Hsl { h: number; s: number; l: number }

export function hexToHsl(hex: string): Hsl {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return { h: 0, s: 60, l: 60 };
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h, s: s * 100, l: l * 100 };
}

export function hslCss({ h, s, l }: Hsl): string {
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
}

/** 第 i 層（0 起算）的顏色：底色每層色相 +30°（S／L 不變） */
export function rampColor(baseHex: string, i: number): string {
  const hsl = hexToHsl(baseHex);
  return hslCss({ ...hsl, h: hsl.h + 30 * i });
}

/** 22 層的色票（設定頁的階梯） */
export function rampColors(baseHex: string): string[] {
  return GROUP_TAGS.map((_, i) => rampColor(baseHex, i));
}

/** 色相 +30° 的文字說明（給提示用） */
export function rampNote(baseHex: string): string {
  const hsl = hexToHsl(baseHex);
  return `底色 ${baseHex}（H ${hsl.h.toFixed(0)}°／S ${hsl.s.toFixed(0)}%／L ${hsl.l.toFixed(0)}%），每層 +30°`;
}

/* ---------------------------------------------------------------- 檔案 */

function cleanStyle(v: unknown): TagStyle | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out: TagStyle = {};
  const color = typeof o.color === 'string' ? o.color.trim() : '';
  if (/^#[0-9a-f]{6}$/i.test(color)) out.color = color.toLowerCase();
  if (typeof o.size === 'number' || typeof o.size === 'string') out.size = clampSize(o.size);
  if (typeof o.font === 'string') out.font = o.font;
  if (typeof o.font2 === 'string') out.font2 = o.font2;
  // 完全空的條目不要（避免 settings.json 長一堆 {} ）
  return Object.keys(out).length ? out : null;
}

function cleanBody(v: unknown): TagStyle | undefined {
  const s = cleanStyle(v);
  if (!s) return undefined;
  if (s.size !== undefined) s.size = clampBodySize(s.size);   // 本文的 size 是 pt（8–30）
  return Object.keys(s).length ? s : undefined;
}

function profileEmpty(p: TagStyleProfile): boolean {
  return Object.keys(p.tags).length === 0 && Object.keys(p.groups).length === 0 && !p.body;
}

function cleanProfile(v: unknown): TagStyleProfile {
  const out = emptyProfile();
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  const tags = (o.tags ?? {}) as Record<string, unknown>;
  const groups = (o.groups ?? {}) as Record<string, unknown>;
  for (const [k, val] of Object.entries(tags)) {
    if (memberIndex(k) >= 0) continue;        // 天干地支只認群組
    const s = cleanStyle(val);
    if (s) out.tags[k] = s;
  }
  for (const [k, val] of Object.entries(groups)) {
    if (!isGroup(k)) continue;
    const s = cleanStyle(val);
    if (s) out.groups[k] = s;
  }
  const body = cleanBody(o.body);
  if (body) out.body = body;
  return out;
}

export interface ParseResult {
  ok: boolean;
  error?: string;
  file?: SettingsFile;
  version?: number;
}

/** 讀進來的一份 settings.json（會做 format／version 檢查；未知欄位保留） */
export function parseSettings(text: string): ParseResult {
  extraTop = {};
  let obj: unknown;
  try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: '不是合法的 JSON' }; }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '不是 settings 物件' };
  const o = obj as Record<string, unknown>;
  if (o.format !== SETTINGS_FORMAT) return { ok: false, error: '不是 accelon26-settings' };
  const version = Number(o.version);
  if (!Number.isFinite(version) || version < 1) return { ok: false, error: '版本號不正確' };
  if (version > SETTINGS_VERSION) return { ok: false, error: `這個設定檔是 v${version}，比這個程式新；請更新 accelon26` };
  const profiles = (o.profiles ?? {}) as Record<string, unknown>;
  const global = (profiles.global ?? {}) as Record<string, unknown>;
  const globalStyle = (global.tagStyle ?? {}) as Record<string, unknown>;
  const adbRaw = (profiles.adb ?? {}) as Record<string, unknown>;
  const file: SettingsFile = {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    updated: typeof o.updated === 'string' ? o.updated : undefined,
    profiles: {
      global: { tagStyle: cleanProfile(globalStyle) },
      adb: {},
    },
  };
  for (const [key, val] of Object.entries(adbRaw)) {
    if (!val || typeof val !== 'object') continue;
    const v = val as Record<string, unknown>;
    const st = (v.tagStyle ?? {}) as Record<string, unknown>;
    const p: AdbProfile = { name: typeof v.name === 'string' ? v.name : undefined, tagStyle: cleanProfile(st) };
    const empty = profileEmpty(p.tagStyle!);
    if (!empty || p.name) file.profiles.adb[key] = p;
  }
  // 未知的 top-level 欄位留著（匯入→再匯出不會丟）
  for (const k of Object.keys(o)) {
    if (!['format', 'version', 'updated', 'profiles'].includes(k)) extraTop[k] = o[k];
  }
  return { ok: true, file, version };
}

/** 把 parsed 的內容套進記憶體（取代 global/adb；active 不變） */
export function applySettingsFile(file: SettingsFile, opts: { merge?: boolean } = {}): void {
  if (!opts.merge) {
    globalProfile = cleanProfile(file.profiles.global?.tagStyle ?? {});
    adbProfiles = {};
    for (const [k, v] of Object.entries(file.profiles.adb ?? {})) {
      const p: AdbProfile = { name: v.name, tagStyle: cleanProfile(v.tagStyle ?? {}) };
      const empty = profileEmpty(p.tagStyle!);
      if (!empty || p.name) adbProfiles[k] = p;
    }
  } else {
    mergeProfile(globalProfile, cleanProfile(file.profiles.global?.tagStyle ?? {}));
    for (const [k, v] of Object.entries(file.profiles.adb ?? {})) {
      const p = adbProfiles[k] ?? (adbProfiles[k] = { tagStyle: emptyProfile() });
      p.name = v.name ?? p.name;
      mergeProfile(p.tagStyle ?? (p.tagStyle = emptyProfile()), cleanProfile(v.tagStyle ?? {}));
    }
  }
  loaded = true;
  notify();
}

function mergeProfile(dst: TagStyleProfile, src: TagStyleProfile): void {
  Object.assign(dst.tags, src.tags);
  Object.assign(dst.groups, src.groups);
  if (src.body) dst.body = { ...(dst.body ?? {}), ...src.body };
}

/** 清空（測試／全部重設） */
export function resetTagStyles(): void {
  globalProfile = emptyProfile();
  adbProfiles = {};
  extraTop = {};
  notify();
}

/** 這台機器現在要寫出去的 settings.json 內容（只留有自訂的條目） */
export function toSettingsFile(): SettingsFile {
  const global: TagStyleProfile = cleanProfile(globalProfile);
  const adb: Record<string, AdbProfile> = {};
  for (const [k, v] of Object.entries(adbProfiles)) {
    const st = cleanProfile(v.tagStyle ?? emptyProfile());
    // 只存有自訂的庫；只剩 name、沒有任何條目時也不用留（重建 adb 靠檔名，不靠 name）
    if (!profileEmpty(st)) adb[k] = { name: v.name || undefined, tagStyle: st };
  }
  const profiles: SettingsFile['profiles'] = {};
  if (!profileEmpty(global)) profiles.global = { tagStyle: global };
  if (Object.keys(adb).length) profiles.adb = adb;
  return {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...extraTop,
    profiles,
  };
}

/** 目前這台機器的計數（設定頁的橫幅用） */
export function counts(): { global: number; adb: number } {
  const g = globalProfile;
  const a = adbProfiles[activeFile]?.tagStyle;
  return {
    global: Object.keys(g.tags).length + Object.keys(g.groups).length + (g.body ? 1 : 0),
    adb: a ? Object.keys(a.tags ?? {}).length + Object.keys(a.groups ?? {}).length + (a.body ? 1 : 0) : 0,
  };
}
