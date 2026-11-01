/**
 * 時間顯示的純函式（作者 2026-10-31：下載 adb 時要顯示「還要多久」）。
 * 放在獨立的小模組，測試不必拉進 DOM。
 */

/**
 * 剩餘時間：用數字加「時／分／秒」表示。
 *   1時02分03秒、12分03秒、3秒
 * 少於 1 小時不顯示「0時」，少於 1 分鐘不顯示「0分」。
 */
export function fmtEta(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  if (h > 0) return `${h}時${two(m)}分${two(s)}秒`;
  if (m > 0) return `${m}分${two(s)}秒`;
  return `${s}秒`;
}

/** 下載剩餘時間：速度或總量還不知道就回空字串（不要顯示亂跳的數字）。 */
export function etaOf(received: number, total: number, speed: number): string {
  if (!(speed > 0) || !(total > 0) || received >= total) return '';
  return fmtEta((total - received) / speed);
}
