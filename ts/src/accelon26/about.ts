/**
 * 「軟件說明（About）」—— 點左上角的 `accelon26` 彈出到正中間（作者 2026-10）。
 *
 * 內容比照一般桌面軟件的 About：左上角大 logo、大標題「開放古籍平台」、
 * 小字「Accelon3 跨平台平替」、官網、建置時間、執行環境、程式檔位置。
 *
 * **更新檢查**：開啟時才檢查（沒有背景輪詢）。判定依據只有一個 ——「比目前這支
 * 程式的建置時間晚」。
 *   * 桌面版：`main.AdbHost.CheckUpdate`（Go 層拿線上 exe 的 Last-Modified 比
 *     `main.AdbHost.AppInfo` 的 buildTime）。有新版 → 顯示「下載更新」按鈕（走
 *     `InstallUpdate`：下載到暫存、啟動新 exe、自己結束，所以**執行中的程式不會被
 *     直接改寫**）。
 *   * 網頁版：沒有 exe 可以換，只能重新載入頁面。這裡會 best-effort 抓
 *     `https://shutonggui.cn/accelon26/version.json`（`{ "buildTime": "…" }`，
 *     需要網站加上 CORS 標頭）；抓不到就顯示「無法檢查更新」，不擋任何操作。
 *
 * 這一支只碰 DOM 與 host.ts，不 import viewer（避免 viewer → ui → about 的循環）。
 */
import { desktopAppInfo, desktopCheckUpdate, desktopInstallUpdate, desktopOpenExternal } from './host';
import type { DesktopAppInfo } from './host';
import { startTour } from './tour';

export const ABOUT_SITE = 'https://shutonggui.cn/accelon26/';

/** 「留言給作者」的頁面（作者 2026-10-18）：官網上的表單，留言直接寄到作者信箱。 */
export const MESSAGE_URL = ABOUT_SITE + 'message.html';

/**
 * 「啟動時顯示本頁面」（作者 2026-10-18）：預設**開**。
 * 這一頁現在是首頁兼入口（操作導覽的按鈕在這裡），所以第一次打開就會看到它；
 * 讀者勾掉之後就不再自動彈出（`0`）。
 */
const STARTUP_KEY = 'accelon26.about.startup';

export function aboutStartupOn(): boolean {
  try { return localStorage.getItem(STARTUP_KEY) !== '0'; } catch { return true; }
}

function setAboutStartup(on: boolean): void {
  try { localStorage.setItem(STARTUP_KEY, on ? '1' : '0'); } catch { /* 無痕模式 */ }
}

/**
 * 未來（回到 Go／桌面版時）網頁版要比對的版本資訊位置：
 * `{ "buildTime": "2026-10-17T05:15:00Z" }`，伺服器要給 CORS。目前網頁版不做更新。
 */
export const VERSION_MANIFEST = ABOUT_SITE + 'version.json';

type Phase = 'idle' | 'checking' | 'latest' | 'found' | 'unknown';

export interface AboutState {
  open: boolean;
  phase: Phase;
  message: string;
  /** 有沒有「下載更新」按鈕 */
  canInstall: boolean;
  /** 目前執行的是什麼（桌面版／網頁版） */
  mode: string;
  buildTime: string;
  buildText: string;
  remote: string;
  exe: string;
  /** 「啟動時顯示本頁面」開著嗎 */
  startup: boolean;
}

const state: AboutState = {
  open: false, phase: 'idle', message: '', canInstall: false,
  mode: '', buildTime: '', buildText: '', remote: '', exe: '', startup: true,
};

let desktopInfo: DesktopAppInfo | null = null;
let checking = false;

/** 測試／診斷用 */
export function aboutState(): AboutState {
  return { ...state, startup: aboutStartupOn() };
}

const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function localBuild(): { buildTime: string; buildTimeText: string } {
  const b = (window as unknown as { __ACCELON_BUILD__?: { buildTime?: string; buildTimeText?: string } }).__ACCELON_BUILD__;
  return { buildTime: b?.buildTime ?? '', buildTimeText: b?.buildTimeText ?? '' };
}

function show(open: boolean): void {
  const box = el<HTMLElement>('aboutBox');
  const back = el<HTMLElement>('aboutBackdrop');
  if (!box || !back) return;
  box.hidden = !open;
  back.hidden = !open;
  state.open = open;
  if (open) {
    // 大 logo：直接借用 favicon 的 data URI（不再重複內嵌 19 KiB）
    const logo = el<HTMLImageElement>('aboutLogo');
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (logo && icon?.href) { logo.src = icon.href; logo.hidden = false; }
    // 「啟動時顯示本頁面」的勾選狀態每次都從存檔還原
    const startup = el<HTMLInputElement>('aboutStartup');
    state.startup = aboutStartupOn();
    if (startup) startup.checked = state.startup;
    el<HTMLElement>('aboutClose')?.focus();
  }
}

export function closeAbout(): void {
  show(false);
}

/** 更新狀態那一行 */
function setUpdate(phase: Phase, message: string, canInstall = false): void {
  state.phase = phase;
  state.message = message;
  state.canInstall = canInstall;
  const msg = el<HTMLElement>('aboutUpdateMsg');
  if (msg) msg.textContent = message;
  const row = msg?.parentElement ?? null;
  row?.classList.toggle('found', phase === 'found');
  const btn = el<HTMLButtonElement>('aboutInstall');
  if (btn) btn.hidden = !canInstall;
}

function fillMeta(mode: string, buildText: string, exe: string): void {
  state.mode = mode;
  state.buildText = buildText;
  state.exe = exe;
  const b = el<HTMLElement>('aboutBuild');
  if (b) b.textContent = buildText || '未標記建置時間';
  const m = el<HTMLElement>('aboutMode');
  if (m) m.textContent = mode;
  const x = el<HTMLElement>('aboutExe');
  if (x) x.textContent = exe || '（單檔 HTML，沒有程式檔）';
}

/**
 * 遠端建置時間比本地晚嗎？（桌面版由 Go 判斷；這裡留給未來的 version.json 用）
 */
export function isNewerBuild(remote: string, local: string): boolean {
  const r = Date.parse(remote);
  const l = Date.parse(local);
  if (!Number.isFinite(r) || !Number.isFinite(l)) return false;
  return r > l;
}

/** 桌面版：問宿主「線上有沒有比這支 exe 新的版本」 */
async function checkDesktop(info: DesktopAppInfo): Promise<void> {
  state.buildTime = info.buildTime;
  const mode = info.platform === 'darwin' ? '桌面版（macOS）' : '桌面版（accelon26.exe）';
  fillMeta(mode, info.buildTimeText, info.exePath);
  const fresh = await desktopCheckUpdate();
  if (!fresh) { setUpdate('unknown', '無法檢查更新（宿主沒有回應）'); return; }
  desktopInfo = fresh;
  state.remote = fresh.remoteBuildTime;
  if (fresh.updateAvailable) {
    setUpdate('found', `發現新版本（${fresh.remoteBuildTime.slice(0, 16).replace('T', ' ')}），目前是 ${fresh.buildTimeText}。`, true);
  } else if (fresh.checkOK) {
    setUpdate('latest', `已是最新版本（build ${fresh.buildTimeText}）`);
  } else if (fresh.noSelfUpdate) {
    // macOS：不做自動更新（換的是整個 .app）。這不是「檢查失敗」，按鈕改成開官網。
    setUpdate('unknown', `${fresh.note || '這個平台不支援自動更新'}（目前 build ${fresh.buildTimeText}）`, true);
  } else if (fresh.devBuild) {
    setUpdate('unknown', fresh.note || '這是開發者本機建置的 exe，不檢查更新');
  } else if (!fresh.dirWritable) {
    setUpdate('unknown', fresh.note || '程式所在資料夾不可寫，無法自動更新');
  } else {
    // 檢查失敗（404、斷網、伺服器沒給版本資訊）：**不可以**說「已是最新」（作者 2026-10）。
    setUpdate('unknown', `無法檢查更新：${fresh.note || '連不上更新伺服器'}`);
  }
}

/**
 * 網頁版：沒有 exe 可以換，也就沒有自動更新（作者 2026-10：自動更新等回到 Go／
 * 桌面版再做）。所以這裡不連網，直接告訴讀者重新載入即可。
 */
async function checkWeb(): Promise<void> {
  const local = localBuild();
  state.buildTime = local.buildTime;
  fillMeta('網頁版（單檔 HTML）', local.buildTimeText, '');
  setUpdate('latest', '網頁版沒有自動更新：重新載入頁面即可取得最新版（自動更新隨桌面版提供）');
}

/** 開啟 About；順便（重新）檢查更新 */
export async function openAbout(): Promise<void> {
  show(true);
  if (checking) return;
  checking = true;
  setUpdate('checking', '檢查更新中…');
  try {
    desktopInfo = await desktopAppInfo();
    if (desktopInfo) await checkDesktop(desktopInfo);
    else await checkWeb();
  } catch (e) {
    setUpdate('unknown', `無法檢查更新（${(e as Error)?.message ?? '未知錯誤'}）`);
  } finally {
    checking = false;
  }
}

/** 「下載更新」按鈕：桌面版走宿主的下載＋換檔＋重啟；網頁版／macOS 版開官網 */
async function install(): Promise<void> {
  // macOS 版沒有自動更新（換的是整個 .app）：直接開官網，讓使用者自己下載新版。
  if (desktopInfo?.noSelfUpdate) {
    await openInBrowser(ABOUT_SITE);
    return;
  }
  if (desktopInfo) {
    const remote = desktopInfo.remoteBuildTime.slice(0, 16).replace('T', ' ');
    const ok = window.confirm(`發現新版本（${remote}），目前執行的是 ${desktopInfo.buildTimeText}。\n\n確定要更新嗎？\n更新完成後 accelon26 會自動重新啟動。`);
    if (!ok) return;
    setUpdate('checking', '正在下載新版本…');
    const res = await desktopInstallUpdate();
    if (!res || !res.ok) {
      setUpdate('found', `更新失敗：${res?.error ?? '沒有回應'}`, true);
      return;
    }
    setUpdate('checking', '更新完成，正在重新啟動…');
    return;
  }
  window.open(ABOUT_SITE, '_blank', 'noopener');
}

/**
 * 用系統預設瀏覽器開外部網址（作者 2026-10-18）。桌面版交給宿主（WebView2 的
 * target=_blank 只會開一個內嵌視窗，不是使用者要的）；網頁版就一般的新視窗。
 */
async function openInBrowser(url: string): Promise<void> {
  const handled = await desktopOpenExternal(url);
  if (handled) return;
  window.open(url, '_blank', 'noopener');
}

/**
 * 留言頁的網址：帶上**這一版的版本號**（作者 2026-10-18），方便作者追查問題。
 * 桌面版帶 build（RFC3339）＋ buildText（給人看的）；網頁版只帶 from=web。
 */
async function messagePageURL(): Promise<string> {
  const info = desktopInfo ?? (await desktopAppInfo().catch(() => null));
  const local = localBuild();
  const build = info?.buildTime ?? local.buildTime ?? '';
  const text = info?.buildTimeText ?? local.buildTimeText ?? '';
  const u = new URL(MESSAGE_URL);
  u.searchParams.set('from', info ? 'desktop' : 'web');
  if (build) u.searchParams.set('build', build);
  if (text) u.searchParams.set('buildText', text);
  return u.toString();
}

/** 接上事件（boot 時呼叫一次） */
export function initAbout(): void {
  el<HTMLElement>('brand')?.addEventListener('click', () => { void openAbout(); });
  el<HTMLElement>('aboutClose')?.addEventListener('click', () => closeAbout());
  el<HTMLElement>('aboutBackdrop')?.addEventListener('click', () => closeAbout());
  el<HTMLElement>('aboutInstall')?.addEventListener('click', () => { void install(); });
  // 「留言給作者」：在微信旁邊，開官網的留言頁（新視窗／系統瀏覽器），順便帶上版本號
  el<HTMLElement>('aboutMessage')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    void messagePageURL().then((url) => openInBrowser(url));
  });
  // 「啟動時顯示本頁面」：勾選狀態立即生效並存起來
  el<HTMLInputElement>('aboutStartup')?.addEventListener('change', (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    state.startup = on;
    setAboutStartup(on);
  });
  // 「▶ 操作導覽」：關掉這一頁，直接開始播（作者 2026-10-18）
  el<HTMLElement>('aboutTour')?.addEventListener('click', () => {
    closeAbout();
    startTour();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.open) { ev.stopPropagation(); closeAbout(); }
  }, true);
}

/**
 * 開機時要不要自動顯示這一頁（作者 2026-10-18：預設要）。
 * boot() 在最後呼叫，所以 `#aboutLogo` 之類的節點都已經在了。
 */
export function showAboutOnStartup(): void {
  if (!aboutStartupOn()) return;
  void openAbout();
}
