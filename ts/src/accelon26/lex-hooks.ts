/**
 * lex 分頁與 ui.ts 之間的鉤子（避免 lex-pane ↔ ui 的循環 import）。
 * ui.ts 開機時注入「把右欄切到詞分頁」的動作。
 */
export const setLexHooks: { current: (() => void) | null } = { current: null };
