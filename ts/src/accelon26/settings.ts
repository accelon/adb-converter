/**
 * settings.json 的讀寫（作者 2026-10-22）。
 *
 * 位置：
 *   * 桌面版（exe）：exe 旁的 `settings.json`；那個資料夾不可寫才退到
 *     `os.UserConfigDir()/accelon26/settings.json`（Windows：`%APPDATA%\accelon26\`）。
 *     實際路徑由 Go 宿主決定（wails/settings.go），About 顯示的就是它。
 *   * 網頁版（file://、http）：`localStorage['accelon26.settings']`。
 *
 * 這裡只做「讀、寫、匯出、匯入」；資料模型在 tag-style.ts，畫面在 ui.ts。
 */
import {
  SETTINGS_VERSION, applySettingsFile, parseSettings, toSettingsFile, type ParseResult,
} from './tag-style';
import {
  desktopFonts, desktopHost, desktopLoadSettings, desktopSaveSettings, desktopSettingsInfo,
} from './host';

/** localStorage 的鍵（網頁版） */
export const SETTINGS_KEY = 'accelon26.settings';

export type SettingsKind = 'exe' | 'userconfig' | 'localStorage' | 'memory';

export interface SettingsLocation {
  kind: SettingsKind;
  /** 檔案路徑，或 `localStorage['accelon26.settings']` */
  path: string;
  writable: boolean;
  /** 退路的說明（顯示在設定頁／About） */
  note?: string;
}

let location: SettingsLocation | null = null;
let pending: Promise<void> | null = null;
let lastError = '';
let saveTimer = 0;

export function settingsError(): string { return lastError; }

/** 目前支援的 settings.json 格式版本（About／設定頁顯示） */
export function settingsVersion(): number { return SETTINGS_VERSION; }

export function settingsLocation(): SettingsLocation | null { return location; }

async function resolveLocation(): Promise<SettingsLocation> {
  if (await desktopHost()) {
    const info = await desktopSettingsInfo().catch(() => null);
    if (info) {
      return {
        kind: info.kind === 'userconfig' ? 'userconfig' : 'exe',
        path: info.path,
        writable: info.writable,
        note: info.note,
      };
    }
  }
  return { kind: 'localStorage', path: `localStorage['${SETTINGS_KEY}']`, writable: true };
}

/** 開機呼叫一次：決定位置、讀檔、套用到 tag-style（讀不到＝全部預設） */
export function initSettings(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    location = await resolveLocation();
    const text = await readText();
    if (!text) return;
    const r = parseSettings(text);
    if (r.ok && r.file) {
      applySettingsFile(r.file);
      lastError = '';
    } else {
      lastError = r.error || 'settings.json 讀取失敗';
    }
  })();
  return pending;
}

async function readText(): Promise<string> {
  if (!location) await initSettings();
  if (!location) return '';
  if (location.kind === 'exe' || location.kind === 'userconfig') {
    const r = await desktopLoadSettings().catch(() => null);
    if (!r) { lastError = '宿主沒有回應'; return ''; }
    if (!r.ok) { lastError = r.error || '讀取失敗'; return ''; }
    return r.text || '';
  }
  try {
    return localStorage.getItem(SETTINGS_KEY) || '';
  } catch {
    return '';
  }
}

/** 即時存（設定頁改一下就呼叫；內部 debounce） */
export function saveSettingsSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void saveSettings(); }, 250);
}

/** 立刻存；回傳是否成功（失敗會記在 settingsError()，UI 顯示） */
export async function saveSettings(): Promise<boolean> {
  clearTimeout(saveTimer);
  if (!location) await initSettings();
  if (!location) return false;
  const text = JSON.stringify(toSettingsFile(), null, 2) + '\n';
  if (location.kind === 'exe' || location.kind === 'userconfig') {
    const r = await desktopSaveSettings(text).catch(() => null);
    if (!r || !r.ok) {
      lastError = r?.error || '寫入 settings.json 失敗';
      return false;
    }
    location.writable = true;
    lastError = '';
    return true;
  }
  try {
    localStorage.setItem(SETTINGS_KEY, text);
    lastError = '';
    return true;
  } catch (e) {
    lastError = (e as Error).message || 'localStorage 寫入失敗';
    return false;
  }
}

/** 匯出檔案（設定頁／About 共用） */
export function exportSettingsFile(): void {
  const text = JSON.stringify(toSettingsFile(), null, 2) + '\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'accelon26-settings.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  version?: number;
  globalCount?: number;
  adbCount?: number;
}

/** 解析＋套用＋存檔（分享用的 settings.json） */
export async function importSettingsText(text: string, opts: { save?: boolean } = {}): Promise<ImportResult> {
  const r: ParseResult = parseSettings(text);
  if (!r.ok || !r.file) return { ok: false, error: r.error || '讀取失敗' };
  applySettingsFile(r.file, { merge: true });
  if (opts.save !== false) await saveSettings();
  const counts = (r.file.profiles.adb ? Object.keys(r.file.profiles.adb).length : 0);
  return { ok: true, version: r.version, globalCount: 1, adbCount: counts };
}

export async function importSettingsFile(file: File): Promise<ImportResult> {
  try {
    return await importSettingsText(await file.text());
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 桌面版的字型清單（exe 已安裝的字型）；網頁版回空陣列（UI 用內建清單） */
export async function installedFonts(): Promise<string[]> {
  if (!(await desktopHost())) return [];
  const list = await desktopFonts().catch(() => []);
  return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.trim()) : [];
}
