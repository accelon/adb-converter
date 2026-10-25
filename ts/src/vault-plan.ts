/**
 * An Obsidian vault → the lines of an Accelon3 database.
 *
 * Runtime neutral (no fs, no path module, no Buffer): the same planner is used by
 * the CLI (`tools/md2adb.ts`, where Bun reads the zip) and by the viewer's
 * 「加入 Obsidian」 (where the browser reads a dropped folder or zip). Keeping ONE
 * planner is what makes the two produce the same database.
 *
 * The shape it recognises (the 論語句讀新詮 vault, which is also the general
 * "book of chapters + dictionary of characters" shape):
 *
 *   01-〈學而篇〉/01-01第一章.md      one file = one 章, the directory = one 篇
 *   仁.md                             one file = one 字典 entry (字)
 *   *.png                             attached images (also `![](data:…)`)
 *   .obsidian/**, *.json              ignored
 *
 * Mapping:
 *   directory `NN-〈X篇〉`   → <篇 t="章">X第N</篇>        (tree tier 1)
 *   file `NN-MM第一章.md`   → <章>第一章</章>             (tree tier 2)
 *   root `字.md`            → <字>字</字>                 (dictionary, under a 字詞 篇)
 *   [[字]] / [[字|顯示]]    → <聯 n="字">顯示</聯>
 *   ![[x.png]] / ![](…)     → <圖 n="x.png"/>             (inline image)
 *   【原文】…                → verbatim text
 *   blank line              → blank line (paragraph break)
 *
 * `<隱><樹 s="*" t="篇">目錄</樹></隱>` creates the 目錄 pane; the `t=` on 篇/字
 * both declares the child tier and (in Accelon3) registers those tags as *cached*,
 * which is where the tree rows get their labels from without re-reading the text.
 *
 * Markdown is prose, so it can contain characters that are structural in Accelon3
 * markup (`<`, `>`, `&`). They are written as XML entities (`&lt;`, `&gt;`,
 * `&amp;`) — the format's own escape — instead of rejecting the whole vault.
 */
import { encodeXmlAttr, encodeXmlText } from './xml-entities';

export interface VaultFile {
  /** path inside the vault, '/' separated, no leading slash */
  path: string;
  /** markdown text (UTF-8) for .md files */
  text?: string;
  /** raw bytes for attachments */
  bytes?: Uint8Array;
}

export interface VaultImage {
  name: string;
  bytes: Uint8Array;
}

export interface VaultPlan {
  /** the database text, one entry per line */
  lines: string[];
  resources: VaultImage[];
  stats: {
    title: string;
    chapters: number;
    pian: number;
    entries: number;
    images: number;
    vaultImages: number;
    referenced: number;
    skipped: number;
  };
  warnings: string[];
}

export interface VaultOptions {
  /** the display name (defaults to the vault folder name, if the caller knows it) */
  title?: string;
  /**
   * Pack EVERY picture in the vault, not only the referenced ones (default true):
   * a vault has small unused glyph images that the author will reference later,
   * and 2 MB of them is cheaper than a rebuild.
   */
  allImages?: boolean;
}

const CHAPTER_RE = /^(\d+)-〈(.+?)〉\/(\d+)-(\d+)([^/]*)\.md$/;
const ROOT_NOTE_RE = /^([^/]+)\.md$/;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

const CN_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
export function cnNum(n: number): string {
  if (n <= 10) return n === 10 ? '十' : CN_DIGITS[n];
  if (n < 20) return '十' + CN_DIGITS[n - 10];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return CN_DIGITS[tens] + '十' + (ones ? CN_DIGITS[ones] : '');
}

function baseName(p: string): string {
  const at = p.lastIndexOf('/');
  return at < 0 ? p : p.slice(at + 1);
}

function extName(p: string): string {
  const b = baseName(p);
  const at = b.lastIndexOf('.');
  return at <= 0 ? '' : b.slice(at).toLowerCase();
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 → bytes without Buffer/atob (works in Bun and in the browser) */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64.indexOf(clean[i]);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

interface Chapter {
  pian: string;
  pianIndex: number;
  chapterLabel: string;
  order: number;
  lines: string[];
}
interface Entry {
  label: string;
  lines: string[];
}

/** collects the images a note references (data URIs are added on the way) */
interface ImageBag {
  /** name → bytes, for every picture the plan may pack */
  all: Map<string, Uint8Array>;
  /** names actually referenced by `<圖>` */
  used: Set<string>;
  dataUriSeq: number;
}

/**
 * The inline constructs the planner understands, in priority order:
 *   ![[image]] …   attachment (before the generic markdown image)
 *   ![](url) …     markdown image / data URI
 *   [[entry]] …    entry link (not preceded by `!`)
 * Everything between matches is plain text and gets XML-escaped.
 */
const INLINE_RE = /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|!\[[^\]]*\]\(([^)]+)\)|(?<!!)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

/** `![](data:image/png;base64,…)` → a packed `<圖>` */
function dataUriImage(target: string, stem: string, bag: ImageBag): string | null {
  const m = /^data:image\/([a-z+]+);base64,([\s\S]*)$/i.exec(target);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const ext = kind === 'svg+xml' ? 'svg' : kind === 'jpeg' ? 'jpg' : kind;
  const name = `${stem}-img${String(bag.dataUriSeq++).padStart(2, '0')}.${ext}`;
  bag.all.set(name, base64ToBytes(m[2]));
  bag.used.add(name);
  return `<圖 n="${encodeXmlAttr(name)}"/>`;
}

function inline(line: string, stem: string, bag: ImageBag, warnings: string[]): string {
  let out = '';
  let last = 0;
  INLINE_RE.lastIndex = 0;
  for (const m of line.matchAll(INLINE_RE)) {
    out += encodeXmlText(line.slice(last, m.index));
    last = m.index + m[0].length;

    // attachments: ![[name.png]] / ![[name.png|alt]]
    if (m[1] !== undefined) {
      const p = m[1].trim();
      if (!IMAGE_EXT.has(extName(p))) {
        warnings.push(`![[${p}]] is not an image, left as text`);
        out += encodeXmlText(m[0]);
      } else {
        const name = baseName(p);
        bag.used.add(name);
        out += `<圖 n="${encodeXmlAttr(name)}"/>`;
      }
      continue;
    }

    // markdown image links: data URIs and files that really are in the vault
    if (m[3] !== undefined) {
      let p = m[3].trim().replace(/^<|>$/g, '');
      const data = dataUriImage(p, stem, bag);
      if (data) {
        out += data;
        continue;
      }
      try {
        p = decodeURIComponent(p);
      } catch {
        /* keep the raw text */
      }
      if (!IMAGE_EXT.has(extName(p))) {
        out += encodeXmlText(m[0]);
      } else {
        const name = baseName(p);
        bag.used.add(name);
        out += `<圖 n="${encodeXmlAttr(name)}"/>`;
      }
      continue;
    }

    // entry links: [[字]] / [[字|顯示]] / [[字#anchor]]
    if (m[4] !== undefined) {
      const t = m[4].trim();
      const shown = (m[5] ?? t).trim();
      out += `<聯 n="${encodeXmlAttr(t)}">${encodeXmlText(shown)}</聯>`;
      continue;
    }

    out += encodeXmlText(m[0]);
  }
  out += encodeXmlText(line.slice(last));
  return out.replace(/[ \t]+$/, '');
}

function noteLines(text: string, stem: string, bag: ImageBag, warnings: string[]): string[] {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const out = clean.split('\n').map((line) => inline(line, stem, bag, warnings));
  // no trailing blank lines: the last line of a note is its own text
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/**
 * Turn the vault's files into database lines + the pictures to pack.
 *
 * Throws only when the vault has no markdown notes at all; everything else that
 * cannot be mapped becomes a warning so a whole vault never fails on one note.
 * Markup characters in prose are XML-escaped, not rejected.
 */
export function planVault(files: readonly VaultFile[], opts: VaultOptions = {}): VaultPlan {
  const warnings: string[] = [];
  const bag: ImageBag = { all: new Map(), used: new Set(), dataUriSeq: 0 };

  for (const f of files) {
    if (!f.bytes) continue;
    const name = baseName(f.path);
    if (bag.all.has(name)) warnings.push(`duplicate image name ${name} (the last one wins)`);
    bag.all.set(name, f.bytes);
  }
  const vaultImages = bag.all.size;

  const chapters: Chapter[] = [];
  const entries: Entry[] = [];
  let skipped = 0;

  for (const f of files) {
    if (f.text === undefined) continue;
    const cm = CHAPTER_RE.exec(f.path);
    if (cm) {
      const [, pianNo, pianName, , chapNo, rest] = cm;
      const label = rest.trim() || `第${cnNum(Number(chapNo))}章`;
      chapters.push({
        pian: pianName.replace(/篇$/, ''),
        pianIndex: Number(pianNo),
        chapterLabel: label,
        order: Number(pianNo) * 10000 + Number(chapNo),
        lines: noteLines(f.text, `v${pianNo}-${chapNo}`, bag, warnings),
      });
      continue;
    }
    const rm = ROOT_NOTE_RE.exec(f.path);
    if (rm) {
      entries.push({ label: rm[1], lines: noteLines(f.text, `c${rm[1]}`, bag, warnings) });
      continue;
    }
    skipped++;
  }
  chapters.sort((a, b) => a.order - b.order);
  entries.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  if (!chapters.length && !entries.length) throw new Error('no markdown notes found in the vault');

  const title = opts.title?.trim() || 'Obsidian 筆記';

  const lines: string[] = [];
  lines.push(`<集 t="集">${encodeXmlText(title)}</集>`);
  lines.push(`<隱><樹 s="*" t="篇">目錄</樹></隱>`);

  let lastPian = -1;
  for (const c of chapters) {
    if (c.pianIndex !== lastPian) {
      if (lastPian >= 0) lines.push('');
      lines.push(`<篇 t="章">${encodeXmlText(c.pian)}第${cnNum(c.pianIndex)}</篇>`);
      lastPian = c.pianIndex;
    }
    lines.push(`<章>${encodeXmlText(c.chapterLabel)}</章>`);
    for (const l of c.lines) lines.push(l);
  }

  if (entries.length) {
    lines.push('');
    lines.push(`<篇 t="字">字詞</篇>`);
    for (const e of entries) {
      lines.push(`<字>${encodeXmlText(e.label)}</字>`);
      for (const l of e.lines) lines.push(l);
    }
  }

  // which pictures go into the database
  const resources: VaultImage[] = [];
  const packAll = opts.allImages !== false;
  const names = packAll ? [...bag.all.keys()] : [...bag.used];
  for (const name of names) {
    const bytes = bag.all.get(name);
    if (!bytes) {
      warnings.push(`image ${name} is referenced but missing from the vault`);
      continue;
    }
    resources.push({ name, bytes });
  }
  if (packAll) {
    for (const name of bag.used) if (!bag.all.has(name)) warnings.push(`image ${name} is referenced but missing from the vault`);
  }

  return {
    lines,
    resources,
    stats: {
      title,
      chapters: chapters.length,
      pian: new Set(chapters.map((c) => c.pianIndex)).size,
      entries: entries.length,
      images: resources.length,
      vaultImages,
      referenced: bag.used.size,
      skipped,
    },
    warnings,
  };
}

/** `NN-MM章.md` style names are what the chapter label comes from; exposed for tests */
export function parseChapterPath(path: string): { pianIndex: number; pianName: string; chapterLabel: string } | null {
  const m = CHAPTER_RE.exec(path);
  if (!m) return null;
  return { pianIndex: Number(m[1]), pianName: m[2], chapterLabel: m[5].trim() || `第${m[4]}章` };
}
