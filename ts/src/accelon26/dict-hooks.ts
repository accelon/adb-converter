/**
 * 詞典分頁與 ui.ts 之間的鉤子（避免 dict-pane ↔ ui 的循環 import）。
 * ui.ts 開機時注入「把右欄切到詞典分頁」的動作。
 */
export const setDictHooks: { current: (() => void) | null } = { current: null };
