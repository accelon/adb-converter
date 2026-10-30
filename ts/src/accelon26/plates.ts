/**
 * 原書圖版網址（2026-10-30）。
 *
 *   大正藏：DIA 的 uViewer
 *     https://dia.dila.edu.tw/uv3/index.html?id=Tv05p0002
 *     `T` ＋ `v` ＋ 冊（2 位）＋ `p` ＋ 頁（4 位）；v01 就是第一冊。
 *
 *   高麗藏：東國大學 KABC 的 viewer
 *     https://kabc.dongguk.edu/viewer/view?dataId=ABC_IT_K0647_T_001&imgId=017_0815_c
 *     dataId = ABC_IT_K ＋ 經號（4 位）＋ _T_ ＋ 卷（3 位）
 *     imgId  = 冊（3 位）_ 頁（4 位）_ 欄（a/b/c）
 *
 * 少數大經在 KABC 被切成 a/b/c/d 幾個 dataId（經號後綴），卷參數要扣掉偏移：
 * 大般若 0001 每 150 卷一段；0648、0952 各只有 b 段，偏移 25、170
 * （見 tripitaka-migrator 的 src/scrape/scrapg.ts）。
 */
import { desktopOpenExternal } from './host';

export interface KPlatePos {
  kvol: number;
  page: number;
  /** 0=a … 6=g */
  col: number;
  ksutra: string;
  kjuan: number;
}

const COL = 'abcdefg';

/**
 * 大正藏圖版（DIA）：冊、頁，並用 hash 指到 a/b/c 欄（2026-10-30）。
 *
 * DIA 的 uViewer 是 OpenSeadragon，網址後面的 hash 可以指定視窗：
 *
 *   #?c=0&m=0&s=0&cv=10&xywh=x,y,w,h
 *
 * w=2236、h=837 是 1080p 下剛好一欄（作者實測）；y 取三等分（去掉上下空白）：
 * a=214、b=1001、c=1783，x 固定 0。
 */
const T_COL_Y = [214, 1001, 1783];

export function taishoPlateUrl(vol: number, page: number, col?: number): string {
  const base = `https://dia.dila.edu.tw/uv3/index.html?id=Tv${String(vol).padStart(2, '0')}p${String(page).padStart(4, '0')}`;
  if (col == null) return base;
  const y = T_COL_Y[col];
  if (y == null) return base;
  return `${base}#?c=0&m=0&s=0&cv=10&xywh=0%2C${y}%2C2236%2C837`;
}

/** KABC 的 dataId 後綴與卷參數偏移（只有這三部被切開）。 */
const K_SPLIT: Record<string, { suffix: string; offset: number }[]> = {
  '0001': [{ suffix: 'a', offset: 0 }, { suffix: 'b', offset: 150 }, { suffix: 'c', offset: 300 }, { suffix: 'd', offset: 450 }],
  '0648': [{ suffix: 'a', offset: 0 }, { suffix: 'b', offset: 25 }],
  '0952': [{ suffix: 'a', offset: 0 }, { suffix: 'b', offset: 170 }],
};

export function kabcDataId(ksutra: string, kjuan: number): { dataId: string; juan: number } {
  const sutra = ksutra.padStart(4, '0');
  const splits = K_SPLIT[sutra];
  let suffix = '';
  let offset = 0;
  if (splits) {
    for (const s of splits) if (kjuan - s.offset >= 1) { suffix = s.suffix; offset = s.offset; }
  }
  return { dataId: `ABC_IT_K${sutra}${suffix}`, juan: Math.max(1, kjuan - offset) };
}

/** 高麗藏圖版（KABC）：經號、卷、冊、頁、欄。 */
export function goryeoPlateUrl(p: KPlatePos): string {
  const { dataId, juan } = kabcDataId(p.ksutra, p.kjuan);
  const col = COL[p.col] ?? 'a';
  return 'https://kabc.dongguk.edu/viewer/view'
    + `?dataId=${dataId}_T_${String(juan).padStart(3, '0')}`
    + `&imgId=${String(p.kvol).padStart(3, '0')}_${String(p.page).padStart(4, '0')}_${col}`;
}

/** 桌面版交給宿主開系統瀏覽器；網頁版就一般新視窗。 */
export async function openExternalUrl(url: string): Promise<void> {
  if (await desktopOpenExternal(url)) return;
  window.open(url, '_blank', 'noopener');
}
