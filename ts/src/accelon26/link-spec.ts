/**
 * `<聯>`／`<_名>` 的連結規格（2026-11-06 refactor）。
 *
 * 這裡只把 tag + 屬性正規化，不碰 DOM、不查詞頭。
 * renderer 依 LinkSpec 長 <a data-link="…">；click 由 link.ts／xref.ts 分流。
 *
 *   <_名>詞條</_名>        entry；目標是標籤文字；另開分頁
 *   <聯 n="詞條">…</聯>    entry；目標是 n；預設同頁（可用 newtab="1"）
 *   <聯 i="db?page#a-b" q j> xref；i 優先於 n
 *   <_聯>                   同 <聯>（底線＝零 VA，不影響行為）
 *   <節聯 n="T1579-1#kpD03-001">…</節聯>     node；同庫節點錨點（捲動過去，不嵌入）
 *   <節聯 i="db?W-V#kp">…</節聯>            node；跨庫（db 從 i 拆出）
 */
export type LinkKind = 'entry' | 'xref' | 'node';

export interface EntryLinkSpec {
  kind: 'entry';
  /** 空字串＝用連結文字當目標（`_名`） */
  target: string;
  newTab: boolean;
  /** 同形詞編號（`<聯 n="阿房" a="2">`）；只影響目標，不進連結文字。 */
  homograph?: string;
}

export interface XrefLinkSpec {
  kind: 'xref';
  target: string;
  quote?: string;
  range?: string;
}

/** `<節聯>`：點擊＝捲動到通用節點錨點（頁 id／塊.段／NS#值 都由 anchorVa 解析）。 */
export interface NodeLinkSpec {
  kind: 'node';
  /** 錨點本體（`W-V#kp`／`W#kp`／頁 id…） */
  target: string;
  /** 空字串＝目前庫；`i="db?anchor"` 時為 db */
  db: string;
  newTab: boolean;
}

export type LinkSpec = EntryLinkSpec | XrefLinkSpec | NodeLinkSpec;

/** 這個 tag 是否屬於 link model。 */
export function isLinkTag(name: string): boolean {
  return name === '聯' || name === '_聯' || name === '_名' || name === '節聯' || name === '_節聯';
}

export function parseLinkSpec(name: string, get: (name: string) => string): LinkSpec | null {
  const tag = name.startsWith('_') ? name.slice(1) : name;

  if (tag === '節聯') {
    const i = get('i');
    if (i) {
      const q = i.indexOf('?');
      return { kind: 'node', db: q >= 0 ? i.slice(0, q) : '', target: q >= 0 ? i.slice(q + 1) : i, newTab: get('newtab') === '1' };
    }
    const n = get('n');
    if (!n) return null;
    return { kind: 'node', db: '', target: n, newTab: get('newtab') === '1' };
  }

  if (tag === '名') {
    // `_名` 的目標預設是內文；若建置端給了 n，以 n 為準。
    return { kind: 'entry', target: get('n'), newTab: true, homograph: get('a').trim() || undefined };
  }

  if (tag !== '聯') return null;

  const xref = get('i');
  if (xref) {
    return {
      kind: 'xref',
      target: xref,
      quote: get('q') || undefined,
      range: get('j') || undefined,
    };
  }

  const target = get('n');
  if (!target) return null;
  return {
    kind: 'entry',
    target,
    newTab: get('newtab') === '1' || get('newtab') === 'true',
    homograph: get('a').trim() || undefined,
  };
}
