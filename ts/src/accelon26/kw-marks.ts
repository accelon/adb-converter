/**
 * 「這一批關鍵字各自是什麼顏色」的共享狀態。
 *
 * summary.ts 在搜尋落地時把詞組寫進來，paint.ts 在畫本文時讀它 —— 兩邊都要知道
 * 「緣起」是 0 號色、「性空」是 1 號色，而這兩個模組之間本來沒有 import 關係
 * （paint ← doc-pane ← link ← summary 會繞一圈），所以放在這個小模組裡。
 */
import { clauseHue } from './query';

export interface KwMark {
  /** 要塗的文字（詞組原文，例如「緣起」） */
  text: string;
  /** HSV 色相 0..360 */
  hue: number;
}

let marks: KwMark[] = [];

/** 搜尋結果更新時呼叫；沒有詞組（單字查詢）就清空，行為與以前一樣。 */
export function setKwMarks(next: KwMark[]): void {
  marks = next;
}

export function kwMarks(): KwMark[] {
  return marks;
}

/** 依詞組總數分配色相（0 號＝紅、往後轉） */
export function hueFor(index: number, total: number): number {
  return clauseHue(index, total);
}

/** `mark.kw` 的樣式用 `--hue`；回傳可直接放進 style 屬性的字串 */
export function hueStyle(hue: number): string {
  return `--hue:${Math.round(hue)}`;
}
