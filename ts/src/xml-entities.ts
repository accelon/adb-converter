/**
 * XML entities in Accelon3 text.
 *
 * Accelon3 markup is line based XML: `<`, `>` and `&` are structural, so a note
 * that talks ABOUT markup (Obsidian notes often contain `<br>`, `a & b`, `->`)
 * cannot carry those characters literally. The format's answer is the usual XML
 * one — put `&lt;`, `&gt;`, `&amp;` in the source — and the viewer decodes them
 * when it draws text / labels. `tools/xml-lint.ts` accepts exactly this form
 * (a bare `&` is its `entity` issue).
 *
 * Encoding is split in two because attribute values also need `"` escaped.
 */

const TEXT_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

const ATTR_ESCAPES: Record<string, string> = {
  ...TEXT_ESCAPES,
  '"': '&quot;',
};

/** Escape text that goes between tags. */
export function encodeXmlText(s: string): string {
  return s.replace(/[&<>]/g, (c) => TEXT_ESCAPES[c]!);
}

/** Escape a value that goes inside a double-quoted attribute. */
export function encodeXmlAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ATTR_ESCAPES[c]!);
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** `&amp;` / `&#38;` / `&#x26;` → the character. Unknown entities stay as-is. */
const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;

/**
 * Decode ONE level of XML entities. Decoding is deliberately not recursive:
 * `&amp;lt;` is the text `&lt;`, which is what the author typed when they wrote
 * `&amp;lt;` in the vault.
 */
export function decodeXmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY_RE, (m, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named) return NAMED[named]!;
    const cp = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? '', 16);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
    try {
      return String.fromCodePoint(cp);
    } catch {
      return m;
    }
  });
}
