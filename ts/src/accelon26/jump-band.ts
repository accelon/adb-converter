/**
 * 「跳至」的色帶狀態（作者 2026-10-28）。
 *
 * 大正藏引用「2，206a15-b13」＝從 a 欄第 15 行到 b 欄第 13 行，跳過去以後整段塗色。
 * 狀態放在這個沒有 import 的小模組，是因為 doc-pane（畫）、xref（算行號）、
 * scopes（跳至分頁）三家都要用，任兩家互相 import 就會成環。
 */
let range: { from: number; to: number } | null = null;

export function setJumpRange(from: number | null, to?: number): void {
  range = from === null ? null : { from, to: Math.max(from, to ?? from) };
}

export function jumpRange(): { from: number; to: number } | null {
  return range;
}

/** 這一行在不在色帶裡（畫每一行的時候問一次） */
export function inJumpRange(no: number): boolean {
  return !!range && no >= range.from && no <= range.to;
}
