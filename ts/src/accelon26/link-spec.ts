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
 */
export type LinkKind = 'entry' | 'xref';

export interface EntryLinkSpec {
  kind: 'entry';
  /** 空字串＝用連結文字當目標（`_名`） */
  target: string;
  newTab: boolean;
}

export interface XrefLinkSpec {
  kind: 'xref';
  target: string;
  quote?: string;
  range?: string;
}

export type LinkSpec = EntryLinkSpec | XrefLinkSpec;

/** 這個 tag 是否屬於 link model。 */
export function isLinkTag(name: string): boolean {
  return name === '聯' || name === '_聯' || name === '_名';
}

export function parseLinkSpec(name: string, get: (name: string) => string): LinkSpec | null {
  const tag = name.startsWith('_') ? name.slice(1) : name;

  if (tag === '名') {
    // `_名` 的目標預設是內文；若建置端給了 n，以 n 為準。
    return { kind: 'entry', target: get('n'), newTab: true };
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
  };
}
