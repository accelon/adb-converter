/**
 * XML repair pass for the text of one document.
 *
 * The stored text of an .adb is a *fragment*: `檔` is used as an unclosed
 * document separator (46 databases), there are stray / mismatched close tags
 * (18 thousand across the corpus), bare `&` (12 thousand), `<` without `>`,
 * unquoted or valueless attributes, and tags left open at the end of the text.
 * This module rewrites one document into well formed XML while recording what
 * it changed, so the result can be checked with a real XML parser and the
 * changes can be reported.
 *
 * Repairs (all counted in RepairStats):
 *   - bare `&`                -> &amp;           (not part of an entity)
 *   - `<` without `>`         -> &lt;            (never a tag)
 *   - stray close tag         -> dropped         (name not open anywhere)
 *   - mismatched close tag    -> the open tags above it are closed first
 *   - attributes              -> valueless gets "", unquoted gets quoted,
 *                                `&`, `<`, `"` inside values are escaped
 *   - tags still open at the end -> closed in reverse order
 */

export interface RepairStats {
  amp: number;
  lt: number;
  attrEmpty: number;
  attrQuoted: number;
  attrEscaped: number;
  insertedClose: number;
  droppedStray: number;
  closedAtEnd: number;
  /** XML illegal characters dropped (C0 controls except tab/LF/CR, U+FFFE, U+FFFF) */
  controls: number;
  /** lone surrogates replaced by U+FFFD */
  surrogates: number;
  badNames: string[];
  /** original element/attribute name -> sanitised name (for the inverse) */
  renamed: Record<string, string>;
}

export function emptyStats(): RepairStats {
  return {
    amp: 0,
    lt: 0,
    attrEmpty: 0,
    attrQuoted: 0,
    attrEscaped: 0,
    insertedClose: 0,
    droppedStray: 0,
    closedAtEnd: 0,
    controls: 0,
    surrogates: 0,
    badNames: [],
    renamed: {},
  };
}

/**
 * Entities that may stay as they are: the five predefined ones and numeric
 * references. Everything else (`&QT-FB5C;`, `&kxr-00851;`, `&lac-space;` ...)
 * is a *source specific* entity that a standalone document cannot resolve, so
 * it must be escaped as `&amp;...` or expat/browsers reject the file.
 */
const ENTITY = /^&(#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);/;

/**
 * Characters allowed in an element/attribute name. The list is deliberately
 * conservative: names that are legal under the XML 1.0 fifth edition name rules
 * are still rejected by older-but-widespread parsers (Python's expat, for one),
 * and some databases use punctuation as a tag name (yinshun.adb has a tag named
 * U+FF61, the halfwidth ideographic full stop). Anything outside this list is
 * escaped as `_uXXXX` so the output parses everywhere, and the mapping is kept
 * in the manifest so it can be undone.
 */
export function isSafeNameCodePoint(cp: number, first: boolean): boolean {
  if (cp >= 0x41 && cp <= 0x5a) return true; // A-Z
  if (cp >= 0x61 && cp <= 0x7a) return true; // a-z
  if (!first && cp >= 0x30 && cp <= 0x39) return true; // 0-9
  if (cp === 0x2d || cp === 0x2e || cp === 0x5f) return true; // - . _
  if (cp >= 0x00c0 && cp <= 0x024f) return true; // latin extended
  if (cp >= 0x0370 && cp <= 0x04ff) return true; // greek, cyrillic
  if (cp >= 0x0530 && cp <= 0x058f) return true; // armenian
  if (cp >= 0x05d0 && cp <= 0x05ea) return true; // hebrew
  if (cp >= 0x0620 && cp <= 0x064a) return true; // arabic
  if (cp >= 0x0900 && cp <= 0x097f) return true; // devanagari
  if (cp >= 0x0e00 && cp <= 0x0e7f) return true; // thai
  if (cp >= 0x0f00 && cp <= 0x0fff) return true; // tibetan
  if (cp >= 0x1000 && cp <= 0x109f) return true; // myanmar
  if (cp >= 0x3040 && cp <= 0x30ff) return true; // hiragana, katakana
  if (cp >= 0x3400 && cp <= 0x4dbf) return true; // CJK ext A
  if (cp >= 0x4e00 && cp <= 0x9fff) return true; // CJK unified
  if (cp >= 0xac00 && cp <= 0xd7a3) return true; // hangul syllables
  if (cp >= 0xf900 && cp <= 0xfaff) return true; // CJK compatibility ideographs
  if (cp >= 0x20000 && cp <= 0x2fa1f) return true; // CJK ext B and beyond
  return false;
}

export function sanitizeName(name: string, stats: RepairStats): string {
  let out = '';
  let changed = false;
  let first = true;
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    if (isSafeNameCodePoint(cp, first)) {
      out += ch;
      first = false;
    } else {
      out += `_u${cp.toString(16)}`;
      changed = true;
      first = false;
    }
  }
  if (out === '') {
    out = '_empty';
    changed = true;
  }
  // a name must not start with a digit; the loop already escapes digits in the
  // first position, so this is only a safety net
  if (!isSafeNameCodePoint(out.codePointAt(0)!, true)) {
    out = '_' + out;
    changed = true;
  }
  if (changed) stats.renamed[name] = out;
  return out;
}

/** End of the tag starting at `start` (index of '>'), quote aware; -1 if none. */
export function findTagEnd(text: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') return i;
    if (c === '<') return -1;
  }
  return -1;
}

/** Escape the characters that are not allowed raw inside an attribute value. */
function escapeAttrValue(value: string, stats: RepairStats): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '&') {
      const m = ENTITY.exec(value.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length - 1;
      } else {
        out += '&amp;';
        stats.attrEscaped++;
      }
    } else if (c === '<') {
      out += '&lt;';
      stats.attrEscaped++;
    } else if (c === '"') {
      out += '&quot;';
      stats.attrEscaped++;
    } else {
      out += c;
    }
  }
  return out;
}

/** A tag whose name is obviously damaged: the indexer treated such text as junk. */
export function isGarbageTag(raw: string): boolean {
  const selfClosing = raw.endsWith('/');
  const body = selfClosing ? raw.slice(0, -1) : raw;
  if (body.startsWith('/')) {
    const name = body.slice(1).trim();
    return name === '' || name.length > 64 || /["'=<>&]/.test(name);
  }
  const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
  if (!m) return true;
  const name = m[1];
  if (name.length > 64 || /["'=<>&?]/.test(name)) return true;
  // the rest may only be whitespace and attr="value" pairs; anything else means
  // the markup is damaged (`<??t="...`, an unclosed quote that swallowed text)
  const residue = m[2].replace(/\s+[^\s=/>]+\s*(?:=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?/g, ' ');
  return residue.trim() !== '';
}

/** True when the repaired fragment is not a single well formed root element. */
export function needsRoot(text: string): boolean {
  let depth = 0;
  let roots = 0;
  let textOutside = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '&') {
      const m = ENTITY.exec(text.slice(i));
      if (depth === 0) textOutside = true;
      i += m ? m[0].length : 1;
      continue;
    }
    if (c !== '<') {
      if (depth === 0 && c.trim() !== '') textOutside = true;
      i++;
      continue;
    }
    if (text.startsWith('<!--', i) || text.startsWith('<![CDATA[', i) || text.startsWith('<?', i) || text.startsWith('<!', i)) {
      const stop = text.startsWith('<!--', i) ? '-->' : text.startsWith('<![CDATA[', i) ? ']]>' : '>';
      const end = text.indexOf(stop, i);
      i = end < 0 ? text.length : end + stop.length;
      if (depth === 0) textOutside = true;
      continue;
    }
    const end = findTagEnd(text, i);
    if (end < 0) {
      i++;
      continue;
    }
    const raw = text.slice(i + 1, end);
    if (isGarbageTag(raw)) {
      // damaged markup (an unclosed quote swallowed following text, or a name
      // full of quotes/equals): keep it as text instead of inventing an element
      out.push('&lt;');
      stats.lt++;
      i++;
      continue;
    }
    i = end + 1;
    if (raw.startsWith('/')) {
      if (depth > 0) depth--;
      continue;
    }
    if (raw.endsWith('/')) {
      if (depth === 0) roots++;
      continue;
    }
    if (depth === 0) roots++;
    depth++;
  }
  return roots !== 1 || textOutside;
}

/**
 * Remove characters XML cannot represent: C0 controls other than tab, LF and CR,
 * the non characters U+FFFE/U+FFFF, and lone surrogates (which a UTF-8 encoder
 * would turn into U+FFFD anyway). Sources converted from Big5/GB contain such
 * bytes, and a single one makes the whole file unparseable.
 */
export function stripIllegalChars(text: string, stats: RepairStats): string {
  let out = '';
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      stats.controls++;
      changed = true;
      continue;
    }
    if (c === 0xfffe || c === 0xffff) {
      stats.controls++;
      changed = true;
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
        continue;
      }
      stats.surrogates++;
      changed = true;
      out += '\ufffd';
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      stats.surrogates++;
      changed = true;
      out += '\ufffd';
      continue;
    }
    out += text[i];
  }
  void changed;
  return out;
}

/** Rebuild one tag with normalised attributes. */
function normaliseTag(raw: string, stats: RepairStats): string {
  const selfClosing = raw.endsWith('/');
  const body = selfClosing ? raw.slice(0, -1) : raw;
  const isClose = body.startsWith('/');
  if (isClose) return `</${sanitizeName(body.slice(1).trim(), stats)}>`;

  const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
  if (!m) return `<${raw}>`;
  const rawName = m[1];
  const name = sanitizeName(rawName, stats);
  if (name !== rawName && !stats.badNames.includes(rawName)) stats.badNames.push(rawName);
  const rest = m[2];

  let out = `<${name}`;
  const attrs = /\s+([^\s=/>]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
  let a: RegExpExecArray | null;
  let any = false;
  let needsFix = false;
  while ((a = attrs.exec(rest))) {
    any = true;
    const attrName = sanitizeName(a[1], stats);
    let value = a[2];
    if (value === undefined) {
      stats.attrEmpty++;
      needsFix = true;
      out += ` ${attrName}=""`;
      continue;
    }
    if (value.startsWith('"')) {
      const inner = value.slice(1, -1);
      const escaped = escapeAttrValue(inner, stats);
      if (escaped !== inner) needsFix = true;
      out += ` ${attrName}="${escaped}"`;
    } else if (value.startsWith("'")) {
      const inner = value.slice(1, -1);
      const escaped = escapeAttrValue(inner, stats);
      if (escaped !== inner) needsFix = true;
      stats.attrQuoted++;
      out += ` ${attrName}="${escaped}"`;
    } else {
      stats.attrQuoted++;
      needsFix = true;
      out += ` ${attrName}="${escapeAttrValue(value, stats)}"`;
    }
  }
  if (!needsFix && name === rawName && !(/\s{2,}/.test(rest) && false)) {
    // nothing to repair (and the name did not need sanitising): keep the tag
    // exactly as it was written, so a rebuild reproduces the source text
    return `<${raw}>`;
  }
  if (!any && rest.trim()) {
    // unparsable leftovers: escape them so the tag stays well formed
    out += rest.replace(/[<&"]/g, (c) => (c === '<' ? '&lt;' : c === '&' ? '&amp;' : '&quot;')).replace(/\s+$/, '');
  }
  out += selfClosing ? '/>' : '>';
  return out;
}

/**
 * Repair the text of one document. `wrap` adds a synthetic root element when
 * the fragment has several top level elements (databases without `檔`).
 */
export function repairDocument(
  text: string,
  stats: RepairStats = emptyStats(),
  wrap?: { name: string; attributes?: Record<string, string> } | null,
): string {
  const out: string[] = [];
  const stack: string[] = [];
  let i = 0;

  const closeOpen = (upto?: string): void => {
    while (stack.length && stack[stack.length - 1] !== upto) {
      out.push(`</${stack.pop()}>`);
      stats.insertedClose++;
    }
  };

  while (i < text.length) {
    const c = text[i];
    if (c === '&') {
      const m = ENTITY.exec(text.slice(i));
      if (m) {
        out.push(m[0]);
        i += m[0].length;
      } else {
        out.push('&amp;');
        stats.amp++;
        i++;
      }
      continue;
    }
    if (c !== '<') {
      // copy a run of plain text
      let j = i;
      while (j < text.length && text[j] !== '<' && text[j] !== '&') j++;
      out.push(text.slice(i, j));
      i = j;
      continue;
    }

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      if (end < 0) {
        out.push('&lt;');
        stats.lt++;
        i++;
      } else {
        out.push(text.slice(i, end + 3));
        i = end + 3;
      }
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i);
      if (end < 0) {
        out.push('&lt;');
        stats.lt++;
        i++;
      } else {
        out.push(text.slice(i, end + 3));
        i = end + 3;
      }
      continue;
    }
    if (text.startsWith('<?', i)) {
      // only a processing instruction when the target is a valid XML name;
      // damaged text like `<??t="...` must not be copied through
      const target = /^<\?([^\s?>]*)/.exec(text.slice(i))?.[1] ?? '';
      const valid =
        target !== '' &&
        [...target].every((ch, k) => isSafeNameCodePoint(ch.codePointAt(0)!, k === 0));
      if (!valid) {
        out.push('&lt;');
        stats.lt++;
        i++;
        continue;
      }
      const end = text.indexOf('?>', i);
      if (end < 0) {
        out.push('&lt;');
        stats.lt++;
        i++;
      } else if (/^xml$/i.test(target) && i !== 0) {
        // an XML declaration is only allowed at the very start of a document;
        // one embedded in the text (garbage in some databases) is escaped
        out.push('&lt;');
        stats.lt++;
        i++;
      } else {
        out.push(text.slice(i, end + 2));
        i = end + 2;
      }
      continue;
    }
    if (text.startsWith('<!', i)) {
      const end = text.indexOf('>', i);
      if (end < 0) {
        out.push('&lt;');
        stats.lt++;
        i++;
      } else {
        out.push(text.slice(i, end + 1));
        i = end + 1;
      }
      continue;
    }

    const end = findTagEnd(text, i);
    if (end < 0) {
      out.push('&lt;');
      stats.lt++;
      i++;
      continue;
    }
    const raw = text.slice(i + 1, end);
    if (isGarbageTag(raw)) {
      // damaged markup: keep it as plain text, do not skip past it
      out.push('&lt;');
      stats.lt++;
      i++;
      continue;
    }
    i = end + 1;

    if (raw.startsWith('/')) {
      const name = sanitizeName(raw.slice(1).trim(), stats);
      if (stack.includes(name)) {
        closeOpen(name); // close the tags that were left open above it
        stack.pop();
        out.push(`</${name}>`);
      } else {
        stats.droppedStray++; // nothing to close: drop the stray tag
      }
      continue;
    }
    if (raw.endsWith('/')) {
      out.push(normaliseTag(raw, stats));
      continue;
    }
    const tag = normaliseTag(raw, stats);
    out.push(tag);
    const name = /^<([^\s/>]+)/.exec(tag)?.[1];
    if (name && !tag.endsWith('/>')) stack.push(name);
  }

  closeOpen(undefined);
  const tail = stripIllegalChars(out.join(''), stats);
  if (!wrap) return tail;
  const attrs = Object.entries(wrap.attributes ?? {})
    .map(([k, v]) => ` ${k}="${escapeAttrValue(v, emptyStats())}"`)
    .join('');
  return `<${wrap.name}${attrs}>${tail}</${wrap.name}>`;
}
