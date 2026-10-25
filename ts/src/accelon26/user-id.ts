/** 修訂者 ID：存在 localStorage，About 頁輸入；沒有 ID 不允許編輯。 */
const KEY = 'accelon26.editorId';

export function getUserId(): string {
  try { return (localStorage.getItem(KEY) || '').trim().slice(0, 64); } catch { return ''; }
}

export function setUserId(id: string): string {
  const v = String(id || '').trim().slice(0, 64);
  try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* 無痕 */ }
  return v;
}
