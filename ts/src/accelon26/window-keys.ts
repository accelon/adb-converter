/**
 * 桌面版的視窗操作鍵：**F11 切換全螢幕、Esc 離開全螢幕**。
 *
 * 為什麼需要：第一次啟動是全螢幕，而 Wails 的全螢幕（WS_POPUP）**沒有標題列**，
 * 所以沒有這兩個鍵使用者就關不掉、也回不到可以縮放的視窗（作者 2026-10 指出的問題）。
 * 網頁版沒有宿主，這支全部是 no-op。
 */
import { desktopIsFullscreen, desktopToggleFullscreen } from './host';

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

/** 啟動時呼叫一次：**一律**裝上 F11／Esc（不管現在是不是全螢幕），全螢幕時再提示怎麼回視窗。 */
export async function initDesktopWindowKeys(): Promise<void> {
  window.addEventListener('keydown', onKeyDown, true);   // capture：先於其他 Esc 處理
  fullscreenNow = await desktopIsFullscreen();
  if (fullscreenNow) showHint('全螢幕中：按 Esc 或 F11 回到視窗（Alt+F4 關閉）');
}

function onKeyDown(ev: KeyboardEvent): void {
  if (ev.key === 'F11' || ev.code === 'F11') {
    ev.preventDefault();
    void desktopToggleFullscreen().then((full) => {
      fullscreenNow = full;
      if (full) showHint('全螢幕中：按 Esc 或 F11 回到視窗（Alt+F4 關閉）');
      else hideHint();
    });
    return;
  }
  if ((ev.key === 'Escape' || ev.key === 'Esc') && fullscreenNow) {
    // 只有全螢幕時才攔：平常的 Esc 行為（關閉下拉、不清輸入）完全不受影響
    ev.preventDefault();
    ev.stopPropagation();
    void desktopToggleFullscreen().then((full) => {
      fullscreenNow = full;
      hideHint();
    });
  }
}
