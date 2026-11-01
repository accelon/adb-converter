/**
 * 視窗操作鍵：**F11 切換全螢幕、Esc 離開全螢幕**。
 *
 * 桌面版（Wails）：全螢幕時 WS_POPUP **沒有標題列**，所以需要這兩個鍵回到可以縮放、
 * 可以關閉的視窗（作者 2026-10 指出的問題）。啟動時不再預設全螢幕（作者 2026-10-23），
 * 但 F11 仍然可以切換。
 *
 * 網頁版（file://／http）：沒有宿主，改用瀏覽器的 Fullscreen API
 * （作者 2026-10-31：F11 也要能切換全螢幕）。Esc 由瀏覽器自己離開全螢幕，
 * 這裡只同步狀態與提示。
 */
import { desktopIsFullscreen, desktopToggleFullscreen, hostState } from './host';

const HINT_MS = 7000;

/** 目前是不是全螢幕。Escape 必須**同步**判斷，否則其他 Esc 處理會先跑掉。 */
let fullscreenNow = false;

let hint: HTMLElement | null = null;
let hintTimer = 0;

function showHint(text: string): void {
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'fsHint';
    hint.className = 'fsHint';
    const span = document.createElement('span');
    span.className = 'fsHintText';
    const close = document.createElement('button');
    close.textContent = '知道了';
    close.onclick = () => hideHint();
    hint.append(span, close);
    document.body.appendChild(hint);
  }
  const span = hint.querySelector('.fsHintText');
  if (span) span.textContent = text;
  hint.classList.remove('gone');
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hideHint(), HINT_MS);
}

function hideHint(): void {
  if (!hint) return;
  hint.classList.add('gone');
}

const isDesktop = (): boolean => hostState().available;

/** 切換全螢幕；桌面版交給宿主，網頁版用 Fullscreen API。回傳切換後是不是全螢幕。 */
async function toggleFullscreen(): Promise<boolean> {
  if (isDesktop()) {
    fullscreenNow = await desktopToggleFullscreen();
    return fullscreenNow;
  }
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      fullscreenNow = false;
    } else {
      await document.documentElement.requestFullscreen();
      fullscreenNow = !!document.fullscreenElement;
    }
  } catch {
    // 瀏覽器不允許（例如 iframe 沒有 allowfullscreen）就維持原狀，不要冒錯
  }
  return fullscreenNow;
}

function hintText(): string {
  return isDesktop()
    ? '全螢幕中：按 Esc 或 F11 回到視窗（Alt+F4 關閉）'
    : '全螢幕中：按 F11 或 Esc 離開全螢幕';
}

/** 啟動時呼叫一次：**一律**裝上 F11／Esc（不管現在是不是全螢幕）。 */
export async function initDesktopWindowKeys(): Promise<void> {
  window.addEventListener('keydown', onKeyDown, true);   // capture：先於其他 Esc 處理
  fullscreenNow = isDesktop() ? await desktopIsFullscreen() : !!document.fullscreenElement;
  // 網頁版：瀏覽器自己的 Esc／全螢幕鍵也會改變狀態，同步回來
  document.addEventListener('fullscreenchange', () => {
    if (isDesktop()) return;
    fullscreenNow = !!document.fullscreenElement;
    if (!fullscreenNow) hideHint();
  });
  if (fullscreenNow) showHint(hintText());
}

function onKeyDown(ev: KeyboardEvent): void {
  if (ev.key === 'F11' || ev.code === 'F11') {
    ev.preventDefault();
    void toggleFullscreen().then((full) => {
      fullscreenNow = full;
      if (full) showHint(hintText());
      else hideHint();
    });
    return;
  }
  if ((ev.key === 'Escape' || ev.key === 'Esc') && fullscreenNow) {
    // 只有全螢幕時才攔：平常的 Esc 行為（關閉下拉、不清輸入）完全不受影響
    ev.preventDefault();
    ev.stopPropagation();
    void toggleFullscreen().then((full) => {
      fullscreenNow = full;
      hideHint();
    });
  }
}
