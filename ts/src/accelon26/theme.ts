/**
 * 主題（作者 2026-10-18）：**暗色系（預設）**、亮色系、春綠、秋黃。
 *
 * 只換 CSS 變數（`html[data-theme]`，見 accelon26.template.html），不動版面，所以
 * 切換不用重繪；選擇存在 `localStorage['accelon26.theme']`。載入時 <head> 有一小段
 * 先行套用的 script，避免先畫暗底再跳亮底。
 */
export type ThemeName = 'dark' | 'light' | 'eye' | 'autumn';

const KEY = 'accelon26.theme';

/** 給狀態列用的中文名 */
export const THEME_LABEL: Record<ThemeName, string> = {
  dark: '暗色系', light: '亮色系', eye: '春綠', autumn: '秋黃',
};

function stored(): ThemeName {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'eye' || v === 'autumn' || v === 'dark') return v;
  } catch { /* 私密模式 */ }
  return 'dark';
}

let current: ThemeName = stored();

export function themeOf(): ThemeName {
  return current;
}

/**
 * 圖表顏色反轉（原「SVG 反轉」；作者 2026-10-31／2026-11-02）。
 * fuyan／ys 的圖是黑墨白底，暗色模式看不見；SVG 與 PNG 圖版都要反轉。
 * 只作用在「圖」（`svg.figureSvg`／`img.figureImg` 與看圖視窗），
 * 不動跟著字色走的 `inlineSvg`。預設開；只有暗色系（`dark`）才生效。
 */
const SVG_KEY = 'accelon26.svgInvert';

export function svgInvertOn(): boolean {
  try { return localStorage.getItem(SVG_KEY) !== 'off'; } catch { return true; }
}

export function setSvgInvert(on: boolean): void {
  try { localStorage.setItem(SVG_KEY, on ? 'on' : 'off'); } catch { /* 私密模式 */ }
  applySvgInvert();
}

export function applySvgInvert(): void {
  const on = current === 'dark' && svgInvertOn();
  document.documentElement.classList.toggle('svg-invert', on);
}

function paint(): void {
  const root = document.documentElement;
  if (current === 'dark') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', current);
  applySvgInvert();
  for (const b of document.querySelectorAll<HTMLElement>('#themeSeg button')) {
    const on = b.dataset.theme === current;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

export function setTheme(name: ThemeName): void {
  current = name;
  try { localStorage.setItem(KEY, name); } catch { /* 私密模式 */ }
  paint();
}

/** 接上設置頁的三個按鈕（boot 時呼叫一次）；onPick 用完可以顯示狀態訊息。 */
export function initTheme(onPick?: (name: ThemeName) => void): void {
  paint();
  document.querySelectorAll<HTMLElement>('#themeSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      const name = b.dataset.theme as ThemeName;
      if (name === current) return;
      setTheme(name);
      onPick?.(name);
    });
  });
}
