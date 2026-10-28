/**
 * 大徐本《說文解字》參考資料（给 swjzz 核對說文片段、给 swjzzsrc 建「說文解字」書）。
 *
 * 來源：shuowen.org 的開放資料 <https://github.com/shuowenjiezi/shuowen>（Apache-2.0），
 * 一萬多個 JSON、一字一檔，`explanation` 是大徐本說文、`duan_notes` 是段注（分段對齊）。
 *
 * 這裡只抽「核對用得到的欄位」，輸出一個 JSON：
 *   { "一": { e: "說文本文", v: "01", r: "一", p: "於悉切", x: "徐鉉注", vars: [{h,e}] }, … }
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

export interface ShiwenVariant {
  /** 重文的字頭 */
  h: string;
  /** 重文的說文本文（例如「古文一。」） */
  e: string;
}
export interface ShiwenEntry {
  /** 原資料的 id（只有正條有；重文是 0）——建書時按它排序 */
  i: number;
  /** 大徐本說文本文（不含徐鉉注） */
  e: string;
  /** 卷（篇）號，"01"…"14" */
  v: string;
  /** 部首 */
  r: string;
  /** 反切 */
  p: string;
  /** 徐鉉注 */
  x: string;
  /** 重文 */
  vars: ShiwenVariant[];
}
export type ShiwenRef = Record<string, ShiwenEntry>;

/**
 * 同一個字的異體寫法（段玉裁好古字，大徐本用通行字）。
 *
 * 只收「同一個字的不同寫法」——不涉及通假、古今字、也不碰會改變文意的字
 * （例如 大／太 是段玉裁真的改字，留在 `<說文異>` 裡才有意義）。
 */
const GLYPH_VARIANTS: Record<string, string> = {
  㠯: '以', 靑: '青', 朙: '明', 內: '内', 佀: '似', 葢: '蓋', 尙: '尚', 宫: '宮',
  眞: '真', 卽: '即', 旣: '既', 敎: '教', 皃: '貌', 幷: '并', 隷: '隸', 兌: '兑',
  冣: '最', 衺: '邪', 丗: '世', 竝: '並', 㒳: '兩', 從: '从', 㱕: '歸', 㱕: '歸',
  咊: '和', 麤: '粗', 麁: '粗', 㑹: '會', 會: '會', 昬: '昏', 煑: '煮', 冄: '冉',
  畱: '留', 㽞: '留', 彊: '強', 强: '強', 牀: '床', 窻: '窗', 牕: '窗', 隂: '陰',
  侌: '陰', 昜: '陽', 㫄: '旁', 㫺: '昔', 㱃: '飲', 㪿: '折', 襍: '雜', 㷠: '粦',
  彔: '录', 偁: '稱', 䛐: '詞', 矦: '侯', 㒨: '仙', 仝: '同', 凥: '居',
  䇂: '愆', 艹: '艸', 鼈: '鱉', 彘: '豕', 豓: '豔', 艷: '豔', 𠂹: '垂', 歬: '前', 亯: '享',
  䋣: '繁', 鬭: '鬥', 坙: '巠', 敶: '陳', 䟽: '疏', 疎: '疏', 冝: '宜', 宐: '宜',
};

/**
 * 比對用的正規化：去掉 accelon 標記、標點與空白，只留字，並把異體寫法歸一。
 * （段注本與大徐本的標點不同，不去標點幾乎每條都「對不上」。）
 */
export function normShiwen(s: string): string {
  const bare = s
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0020\u3000]/g, '')
    .replace(/[。，、；：！？「」『』（）〔〕【】〈〉《》…—－·．﹒﹔﹐]/g, '');
  let out = '';
  for (const ch of bare) out += GLYPH_VARIANTS[ch] ?? ch;
  return out;
}

/** 把 shuowen.org 的 data/*.json 目錄讀成一份參考表。 */
export function buildShiwenRef(dataDir: string): { ref: ShiwenRef; files: number } {
  const ref: ShiwenRef = {};
  let files = 0;
  for (const f of readdirSync(dataDir)) {
    if (!f.endsWith('.json')) continue;
    const e = JSON.parse(readFileSync(`${dataDir}/${f}`, 'utf8')) as {
      wordhead?: string; explanation?: string; volume?: string; radical?: string;
      id?: number; pronunciation?: string; xuan_note?: string;
      variants?: { wordhead?: string; explanation?: string }[];
    };
    const head = e.wordhead ?? '';
    if (!head || ref[head]) continue;
    ref[head] = {
      i: Number(e.id ?? 0) || 0,
      e: e.explanation ?? '',
      v: e.volume ?? '',
      r: e.radical ?? '',
      p: e.pronunciation ?? '',
      x: e.xuan_note ?? '',
      vars: (e.variants ?? [])
        .filter((v) => v.wordhead)
        .map((v) => ({ h: v.wordhead!, e: v.explanation ?? '' })),
    };
    for (const v of e.variants ?? []) {
      if (v.wordhead && !ref[v.wordhead]) {
        ref[v.wordhead] = { i: 0, e: v.explanation ?? '', v: e.volume ?? '', r: e.radical ?? '', p: '', x: '', vars: [] };
      }
    }
    files++;
  }
  return { ref, files };
}

export function loadShiwenRef(path: string): ShiwenRef {
  return JSON.parse(readFileSync(path, 'utf8')) as ShiwenRef;
}
export function saveShiwenRef(path: string, ref: ShiwenRef): void {
  writeFileSync(path, JSON.stringify(ref), 'utf8');
}
