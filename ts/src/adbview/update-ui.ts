/**
 * 桌面版的「左上角提示」：建置時間 hover hint、有新版的閃動、更新後的改版說明。
 *
 * 這一支是 UI 與桌面宿主之間的唯一橋樑（呼叫 host.ts），但它只處理「顯示」與
 * 「使用者確認」，下載／換檔／重啟都在 Go 層（wails/update.go）。網頁版沒有宿主，
 * 這裡全部是 no-op —— 左上角就只是一行標題。
 */
import { desktopAppInfo, desktopCheckUpdate, desktopInstallUpdate, desktopReleaseNotes } from './host';
import type { DesktopAppInfo } from './host';

const POLL_MS = 10 * 60 * 1000;   // 背景檢查在 Go 層（啟動一次、之後每 6 小時）；這裡只是偶爾看一下快取

function brandEl(): HTMLElement | null {
  return document.getElementById('brand');
}

/** 左上角的 hover hint：建置時間（以及為什麼不檢查更新）。 */
export function showBrandBuildTime(info: DesktopAppInfo): void {
  const el = brandEl();
  if (!el) return;
  el.title = brandTitle(info);
}

/** hover hint 的文字：建置時間 + （有新版時的）更新提示。 */
function brandTitle(info: DesktopAppInfo, update = false): string {
  const parts = ['accelon26', `built ${info.buildTimeText}`];
  if (info.buildSource === 'file') parts.push('（檔案時間，非發佈建置）');
  if (update) {
    parts.push(`有新版本：線上 ${info.remoteBuildTime.slice(0, 16).replace('T', ' ')} — 點這裡更新`);
  } else if (info.note) {
    parts.push(info.note);
  }
  return parts.join(' · ');
}

/** 有新版本：閃動 ＋ 點擊問使用者要不要更新。 */
export function flashUpdate(info: DesktopAppInfo, onStatus?: (msg: string, kind?: 'info' | 'err' | 'busy') => void): void {
  const el = brandEl();
  if (!el || !info.updateAvailable) return;
  el.classList.add('update');
  el.title = brandTitle(info, true);   // 建置時間要留著，再加上更新提示
  el.onclick = () => { void promptUpdate(info, onStatus); };
}

/** 點下左上角之後：確認 → 下載安裝（Go 層）→ 成功時行程會被新版取代。 */
async function promptUpdate(info: DesktopAppInfo, onStatus?: (msg: string, kind?: 'info' | 'err' | 'busy') => void): Promise<void> {
  const el = brandEl();
  const remote = info.remoteBuildTime.slice(0, 16).replace('T', ' ');
  const ok = window.confirm(`發現新版本（${remote}），目前執行的是 ${info.buildTimeText}。\n\n確定要更新嗎？\n更新完成後 accelon26 會自動重新啟動。`);
  if (!ok) return;
  el?.classList.remove('update');
  onStatus?.('正在下載新版本…', 'busy');
  const res = await desktopInstallUpdate();
  if (!res || !res.ok) {
    onStatus?.(`更新失敗：${res?.error ?? '沒有回應'}`, 'err');
    el?.classList.add('update');   // 讓使用者還能再試一次
    return;
  }
  onStatus?.('更新完成，正在重新啟動…', 'busy');
}

/** 更新後第一次啟動：把這一版新增／改進的功能顯示一次。 */
export async function showReleaseNotes(since: string): Promise<void> {
  if (!since) return;
  const notes = await desktopReleaseNotes(since);
  if (!notes.length) return;
  const box = document.createElement('div');
  box.id = 'notesBox';
  const h2 = document.createElement('h2');
  h2.textContent = notes.length === 1 ? (notes[0].title || '改版說明') : '改版說明';
  box.appendChild(h2);
  for (const n of notes) {
    if (notes.length > 1 && n.title) {
      const t = document.createElement('div');
      t.className = 'ver';
      t.textContent = n.title;
      box.appendChild(t);
    } else if (n.buildTime) {
      const t = document.createElement('div');
      t.className = 'ver';
      t.textContent = `build ${n.buildTime.slice(0, 16).replace('T', ' ')}`;
      box.appendChild(t);
    }
    const ul = document.createElement('ul');
    for (const item of n.items ?? []) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  const close = document.createElement('button');
  close.textContent = '知道了';
  close.onclick = () => box.remove();
  box.appendChild(close);
  document.body.appendChild(box);
  close.focus();
}

/**
 * 桌面版啟動時呼叫一次：hover hint、更新提示、更新後的改版說明。
 * 之後每 POLL_MS 看一下 Go 層背景檢查的結果（不主動連網）。
 */
export async function initDesktopBrand(onStatus?: (msg: string, kind?: 'info' | 'err' | 'busy') => void): Promise<void> {
  const info = await desktopAppInfo();
  if (!info) return;
  showBrandBuildTime(info);
  if (info.updatedFrom) void showReleaseNotes(info.updatedFrom);
  if (info.updateAvailable) flashUpdate(info, onStatus);
  window.setInterval(() => {
    void (async () => {
      const now = await desktopAppInfo();
      if (!now) return;
      showBrandBuildTime(now);
      if (now.updateAvailable && !brandEl()?.classList.contains('update')) flashUpdate(now, onStatus);
    })();
  }, POLL_MS);
  void desktopCheckUpdate;   // 需要時（例如選單）可以主動檢查；平常不必
}
