/**
 * 更新鏡像（作者 2026-10-29）。
 *
 * 主站 https://shutonggui.cn/accelon26/（大陸）＋鏡像 https://nissaya.cn/accelon26/
 * （境外）。大陸使用者一般連不到 nissaya.cn；海外使用者連鏡像比較快。
 *
 * 模式（存在 settings.json 的 `updateMirror`）：
 *   auto      自動：同時量兩站的延遲（Go 的 HEAD，2 秒上限）。鏡像明顯較快才切過去；
 *             只有鏡像連得上（主站掛了）也切；兩站都連不上就留在主站。
 *   primary   固定主站
 *   overseas  固定鏡像
 *
 * 選好以後呼叫 Go 的 SetUpdateMirror()：**exe 更新與 adb manifest 都從同一個站**。
 * 設定頁「更新 → 鏡像站」可以改；改了立刻重新探測、重新檢查（不用重開程式）。
 *
 * 為什麼用延遲而不是 IP 地理資料庫：不必把使用者的 IP 送到第三方、不怕 API 被牆，
 * 而且「連不上 nissaya.cn」本身就是最準的訊號（國內使用者）。
 */
import {
  desktopHost, desktopProbeMirror, desktopSetUpdateMirror, desktopUpdateMirror,
  type DesktopMirrorProbe,
} from './host';
import { initSettings, saveSettingsSoon } from './settings';
import { extraSetting, setExtraSetting } from './tag-style';
import { refreshDesktopUpdate } from './update-ui';

export type MirrorMode = 'auto' | 'primary' | 'overseas';
export type MirrorId = 'primary' | 'overseas';

export interface MirrorDef {
  id: MirrorId;
  base: string;
  host: string;
  label: string;
}

export const MIRRORS: Record<MirrorId, MirrorDef> = {
  primary: {
    id: 'primary',
    base: 'https://shutonggui.cn/accelon26/',
    host: 'shutonggui.cn',
    label: '大陸主站',
  },
  overseas: {
    id: 'overseas',
    base: 'https://nissaya.cn/accelon26/',
    host: 'nissaya.cn',
    label: '境外鏡像',
  },
};

const KEY = 'updateMirror';
const PROBE_MS = 2000;

let mode: MirrorMode = 'auto';
let base = MIRRORS.primary.base;
let resolvedBy: 'auto' | 'fixed' | 'default' = 'default';
let initPromise: Promise<void> | null = null;
let probing = false;
let lastError = '';
let seq = 0;
let lastProbe: { primary?: DesktopMirrorProbe; overseas?: DesktopMirrorProbe } = {};
const listeners: (() => void)[] = [];

export function mirrorMode(): MirrorMode { return mode; }
export function currentMirrorBase(): string { return base; }
export function currentMirror(): MirrorDef {
  return base.startsWith(MIRRORS.overseas.base) ? MIRRORS.overseas : MIRRORS.primary;
}
export function mirrorForBase(b: string): MirrorDef {
  return b.startsWith(MIRRORS.overseas.base) ? MIRRORS.overseas : MIRRORS.primary;
}
export function mirrorLabel(): string { return currentMirror().label; }
export function otherMirrorBase(): string {
  return currentMirror().id === 'primary' ? MIRRORS.overseas.base : MIRRORS.primary.base;
}
export function isKnownMirrorBase(b: string): boolean {
  return b === MIRRORS.primary.base || b === MIRRORS.overseas.base;
}

/** 設定／測試用：目前狀態。 */
export function mirrorState(): Record<string, unknown> {
  return {
    mode, base, mirror: currentMirror().id, host: currentMirror().host,
    resolvedBy, probing, error: lastError,
    probe: {
      primary: lastProbe.primary ?? null,
      overseas: lastProbe.overseas ?? null,
    },
  };
}

/** 改設定或自動探測完成後，通知（adb 更新要重新讀清單）。 */
export function onMirrorApplied(fn: () => void): void { listeners.push(fn); }

function notify(): void {
  for (const fn of listeners) { try { fn(); } catch { /* 不讓一個 listener 擋住其他 */ } }
}

function normalizeMode(v: unknown): MirrorMode {
  return v === 'primary' || v === 'overseas' || v === 'auto' ? v : 'auto';
}

function readSavedMode(): MirrorMode {
  try { return normalizeMode(extraSetting(KEY)); } catch { return 'auto'; }
}

/** 開機呼叫一次；`checkAdbUpdates()` 會先 await 它，才去抓 manifest。 */
export function ensureMirrorReady(): Promise<void> {
  return initUpdateMirror();
}

/** 只初始化一次（boot 與 adb 更新都會呼叫；重複呼叫不能重複探測）。 */
export function initUpdateMirror(): Promise<void> {
  if (!initPromise) initPromise = runInitUpdateMirror();
  return initPromise;
}

async function runInitUpdateMirror(): Promise<void> {
  try {
    try { await initSettings(); } catch { /* 讀不到就全部預設 */ }
    const saved = readSavedMode();
    await applyMode(saved, { persist: false, silent: true });
  } catch (e) {
    // 鏡像只是「去哪下載」的偏好；初始化失敗不可以擋住閱讀，留在主站就好。
    lastError = '鏡像初始化失敗：' + String((e as Error)?.message ?? e);
    console.error('mirror init failed', e);
  } finally {
    probing = false;
    renderMirrorUi();
  }
}

/**
 * 套用模式：auto 會探測兩站；固定模式直接套。
 * `persist`：使用者改設定時寫回 settings.json。
 */
export async function applyMode(next: MirrorMode, opts: { persist?: boolean; silent?: boolean } = {}): Promise<void> {
  const my = ++seq;
  mode = normalizeMode(next);
  lastError = '';
  if (opts.persist) {
    setExtraSetting(KEY, mode);
    saveSettingsSoon();
  }

  const host = await desktopHost();
  if (my !== seq) return;
  if (!host) {
    // 網頁版沒有宿主可以換檔；設定照樣記得（換到桌面版時沿用），但只影響顯示。
    base = mode === 'auto' ? MIRRORS.primary.base : MIRRORS[mode as MirrorId].base;
    resolvedBy = mode === 'auto' ? 'default' : 'fixed';
    renderMirrorUi();
    if (!opts.silent) notify();
    return;
  }

  if (mode === 'auto') {
    probing = true;
    renderMirrorUi();
    const [p, m] = await Promise.all([
      desktopProbeMirror(MIRRORS.primary.base, PROBE_MS),
      desktopProbeMirror(MIRRORS.overseas.base, PROBE_MS),
    ]);
    if (my !== seq) return;      // 期間使用者又改了一次
    lastProbe = { primary: p, overseas: m };
    probing = false;
    // 鏡像要「明顯」比主站快才切（避免兩站差不多時每次啟動跳來跳去）；
    // 只有鏡像連得上（主站掛了）也切；兩站都不通就留在主站。
    const pick: MirrorId = m.ok && (!p.ok || m.ms + 50 < p.ms) ? 'overseas' : 'primary';
    base = MIRRORS[pick].base;
    resolvedBy = 'auto';
    if (!p.ok && !m.ok) lastError = '兩站都連不上，先留在主站';
    else if (p.ok && m.ok) lastError = '';
  } else {
    base = MIRRORS[mode as MirrorId].base;
    resolvedBy = 'fixed';
    probing = false;
  }

  const ok = await desktopSetUpdateMirror(base);
  if (!ok) {
    lastError = '無法套用鏡像設定（宿主沒有回應）';
    base = MIRRORS.primary.base;
  }
  if (my !== seq) return;
  // Go 層的「目前站」可能因為設定失敗而不同步，讀回來校正。
  const actual = await desktopUpdateMirror().catch(() => '');
  if (actual && actual !== base) base = actual;
  renderMirrorUi();
  if (!opts.silent) notify();     // 開機時由 bootDesktop 在 catalog 好了以後自己檢查
  void refreshDesktopUpdate();   // 換站後立刻重看 exe 有沒有新版
}

/** 設定頁用：使用者選了某個模式。 */
export async function setMirrorMode(next: MirrorMode): Promise<void> {
  await applyMode(next, { persist: true });
}

/** 設定頁用：重新探測（自動模式）。 */
export async function reprobeMirror(): Promise<void> {
  if (mode === 'auto') await applyMode('auto', { persist: false });
  else await applyMode(mode, { persist: false });
}

// ---- 設定頁 --------------------------------------------------------------------

let uiInited = false;

export function initUpdateMirrorUi(): void {
  if (uiInited) return;
  uiInited = true;
  const sel = document.getElementById('setMirror') as HTMLSelectElement | null;
  if (sel) {
    sel.addEventListener('change', () => {
      void setMirrorMode(normalizeMode(sel.value));
    });
  }
  document.getElementById('setMirrorProbe')?.addEventListener('click', () => { void reprobeMirror(); });
  renderMirrorUi();
}

function probeText(p?: DesktopMirrorProbe): string {
  if (!p) return '—';
  if (!p.ok) return '連不上';
  return p.ms + ' ms';
}

export function renderMirrorUi(): void {
  const sel = document.getElementById('setMirror') as HTMLSelectElement | null;
  if (sel && sel.value !== mode) sel.value = mode;
  const status = document.getElementById('setMirrorStatus');
  if (!status) return;
  const cur = currentMirror();
  if (probing) {
    status.textContent = '正在探測兩站速度…';
    return;
  }
  let text: string;
  if (mode === 'auto') {
    text = `自動：目前用 ${cur.label}（${cur.host}）`;
    if (lastProbe.primary && lastProbe.overseas) {
      text += `｜主站 ${probeText(lastProbe.primary)}、鏡像 ${probeText(lastProbe.overseas)}`;
    }
    text += '。大陸通常連不到鏡像，會留在主站。';
  } else {
    text = `固定：${cur.label}（${cur.host}）`;
  }
  if (lastError) text += '｜' + lastError;
  status.textContent = text;
}
