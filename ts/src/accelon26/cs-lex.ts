/**
 * cs-lex.adb 的讀取與詞形還原（2026-11-03）。
 *
 * 只依賴 adb／vapa，供 reading-pane 與測試使用；不碰 DOM、不碰 CM6。
 * 詞條格式：`<條 w="lemma" iast="…">`（舊版 `<塊>` 也吃），後面接
 * `sc-en：…／yh：…／kmj：…` 幾行譯詞。
 */
import { AdbReader, BlobIO } from './adb';
import { VaPaMapper } from './vapa';

export interface LexEntry {
  lemma: string;
  iast: string;
  by: Record<string, string[]>;
}

/** 開發伺服器（http/https）才有 `/adb/cs-lex.adb`；file:// 與桌面版回 null。 */
export async function openCsLex(): Promise<AdbReader | null> {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
  const r = await fetch('/adb/cs-lex.adb');
  if (!r.ok) return null;
  return AdbReader.open(new BlobIO(new Blob([await r.arrayBuffer()])));
}

export async function parseCsLex(r: AdbReader): Promise<Map<string, LexEntry>> {
  const m = new VaPaMapper(r);
  await m.init();
  const lines: string[] = [];
  for (let i = 0; i < m.lineCount; i++) lines.push((await m.lineText(i)).trim());
  // cs-lex 的詞條是 `<條 w="lemma" iast="…">`（不在目錄樹上）；舊版用 `<塊>`。
  // 有 `<條>` 就只認 `<條>`，免得把帶 w 的經文 `<塊>` 當成詞條。
  const hasTiao = lines.some((s) => /^<條(?=[\s>])/.test(s));
  const entryRe = hasTiao
    ? /^<條(?=[\s>])[^>]*\bw="([^"]*)"/
    : /^<塊(?=[\s>])[^>]*\bw="([^"]*)"/;
  const out = new Map<string, LexEntry>();
  let cur: LexEntry | null = null;
  for (const raw of lines) {
    if (!raw) continue;
    const b = entryRe.exec(raw);
    if (b) {
      const lemma = b[1].trim();
      const iast = /\biast="([^"]*)"/.exec(raw)?.[1] ?? '';
      cur = { lemma, iast, by: {} };
      if (lemma) out.set(lemma.toLowerCase(), cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^([a-z-]+)：(.+)$/.exec(raw);
    if (!kv) continue;
    cur.by[kv[1]] = kv[2].split(/[、,]/).map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

const ENDINGS = ['ānaṃ', 'assa', 'āya', 'esu', 'āni', 'ena', 'ehi', 'ebhi', 'smiṃ', 'smā', 'mhā',
  'anti', 'enti', 'onti', 'eyya', 'uṃ', 'aṃ', 'ā', 'ī', 'ū', 'e', 'o', 'a', 'i', 'u', 'ṃ', 's'];

/** 表面詞 → 詞庫 lemma；先查原形，再試常見屈折字尾。查不到回空字串。 */
export function lemmaOf(lex: Map<string, LexEntry> | null, word: string): string {
  const w = word.toLowerCase();
  if (lex?.has(w)) return w;
  for (const end of ENDINGS) {
    if (w.length > end.length + 2 && w.endsWith(end)) {
      const base = w.slice(0, -end.length);
      if (lex?.has(base)) return base;
    }
  }
  return '';
}
