/**
 * 詞級醒目提示（2026-11-04）：`vedic.adb` 的 `<詞 w="1">` 與 `#N`／`#詞`。
 *
 * 位址的 `#` 只是「這一句裡的第幾個詞」，不影響 VA；所以 `anchorVa()` 會先切掉它。
 * 這個模組只處理「已經畫好的 DOM」：找 `.word[data-w]`、加 `.word-hl`、捲到它。
 * 不 import 任何 accelon26 模組，避免把 DOM 邏輯又綁回 reader。
 */

/** `rv.10.90.3:1#puruṣa` → `{ base: 'rv.10.90.3:1', key: 'puruṣa' }`。 */
export function splitWordKey(addr: string | null | undefined): { base: string; key: string } {
  const s = addr ?? '';
  const at = s.indexOf('#');
  if (at < 0) return { base: s, key: '' };
  return { base: s.slice(0, at), key: decodeKey(s.slice(at + 1)) };
}

function decodeKey(raw: string): string {
  const s = raw.trim();
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 去變音符號（NFD → 去 combining marks → 只留 A-Za-z → lowercase）。 */
export function foldWord(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toLowerCase();
}

/**
 * 在 `root`（通常是 `#docText` 或右欄 `#textBody`）裡把 `addr` 的 `#key` 反白。
 *
 * - 數字：該行第 N 個 `.word[data-w]`（1 起）。
 * - 字串：去變音符號後先 startsWith、再 includes；中文直接 includes。
 * - 找不到就安靜回 null，不清掉其他標記、不 throw。
 *
 * `line` 有給時只在該 `.docLine` 裡找（`:句#N` 的 N 是句內序號）。
 */
export function highlightWordIn(
  root: ParentNode | null | undefined,
  addr: string | null | undefined,
  line?: number,
): HTMLElement | null {
  if (!root) return null;
  const key = splitWordKey(addr).key;
  // 先清掉同一個容器裡上一次的詞級反白；不要碰搜尋的 <mark>。
  root.querySelectorAll?.('.word-hl').forEach((el) => el.classList.remove('word-hl'));
  if (!key) return null;

  const lineEl = line != null && line >= 0
    ? root.querySelector?.(`#L${line}`) as HTMLElement | null
    : null;
  const scope: ParentNode = lineEl ?? root;
  const words = [...(scope.querySelectorAll?.<HTMLElement>('.word[data-w]') ?? [])];
  if (!words.length) return null;

  let target: HTMLElement | null = null;
  if (/^\d+$/.test(key)) {
    target = words[Number(key) - 1] ?? null;
  } else {
    const k = foldWord(key);
    if (k) {
      target = words.find((w) => foldWord(w.textContent ?? '').startsWith(k)) ?? null;
      if (!target) target = words.find((w) => foldWord(w.textContent ?? '').includes(k)) ?? null;
    }
    if (!target) target = words.find((w) => (w.textContent ?? '').includes(key)) ?? null;
  }
  if (!target) return null;
  target.classList.add('word-hl');
  target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  return target;
}
