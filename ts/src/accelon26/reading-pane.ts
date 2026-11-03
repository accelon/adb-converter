/**
 * 精讀模式（作者 2026-11-03）：🙏 按鈕／F4 切換，**正文區**換成唯讀 CodeMirror（ruby 在字上方），
 * accelon26 的原有布局（左欄目錄、右欄頁籤）不變。
 *
 * 依賴紀律（2026-11-03 教訓）：這個檔**只 import 低階模組**（adb／vapa），
 * 不 import doc-pane／viewer／dbs／ui——那些會跟 ui 形成循環，boot 會中途死掉。
 * doc-pane 用 `window.__readingMount` 呼叫；其餘狀態走 `window`。
 */
import { AdbReader, BlobIO } from './adb';
import { VaPaMapper } from './vapa';

declare const CM: any;

interface LexEntry { lemma: string; iast: string; by: Record<string, string[]> }

let view: any = null;
let lex: Map<string, LexEntry> | null = null;
let lexLoading: Promise<void> | null = null;
let rubyOn = true;

export function readingModeOn(): boolean {
  return document.body.classList.contains('reading');
}

/* ------------------------------------------------------------ 詞庫（cs-lex） */

async function openLex(): Promise<AdbReader | null> {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
  const r = await fetch('/adb/cs-lex.adb');
  if (!r.ok) return null;
  return AdbReader.open(new BlobIO(new Blob([await r.arrayBuffer()])));
}

async function parseLex(r: AdbReader): Promise<Map<string, LexEntry>> {
  const m = new VaPaMapper(r);
  await m.init();
  const out = new Map<string, LexEntry>();
  let cur: LexEntry | null = null;
  for (let i = 0; i < m.lineCount; i++) {
    const raw = (await m.lineText(i)).trim();
    if (!raw) continue;
    const b = /^<塊(?=[\s>])[^>]*\bw="([^"]*)"/.exec(raw);
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

function loadLexicon(): Promise<void> {
  if (lexLoading) return lexLoading;
  lexLoading = (async () => {
    try {
      const r = await openLex();
      if (!r) return;
      lex = await parseLex(r);
    } catch { /* 沒有詞庫就沒有 ruby */ }
  })();
  return lexLoading;
}

/* ------------------------------------------------------------ 詞形 → lemma */

const ENDINGS = ['ānaṃ', 'assa', 'āya', 'esu', 'āni', 'ena', 'ehi', 'ebhi', 'smiṃ', 'smā', 'mhā',
  'anti', 'enti', 'onti', 'eyya', 'uṃ', 'aṃ', 'ā', 'ī', 'ū', 'e', 'o', 'a', 'i', 'u', 'ṃ', 's'];

function lemmaOf(word: string): string {
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

/* ------------------------------------------------------------ 渲染 */

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

interface Hit { from: number; to: number; word: string; ruby: string; lemma: string }

function hitsFor(text: string): Hit[] {
  if (!rubyOn || !lex) return [];
  const out: Hit[] = [];
  const re = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF][A-Za-z\u00C0-\u024F\u1E00-\u1EFF'’]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const word = m[0];
    const lemma = lemmaOf(word);
    if (!lemma) continue;
    const entry = lex.get(lemma);
    if (!entry) continue;
    // 作者 2026-11-03：ruby 顯示 **IAST 轉寫**（lemma 本身就是 IAST），不顯示譯詞
    out.push({ from: m.index, to: m.index + word.length, word, ruby: entry.iast || entry.lemma, lemma });
  }
  return out;
}

function rubyDecorations(hits: Hit[]): any {
  const cls = class extends CM.WidgetType {
    constructor(private hit: Hit) { super(); }
    toDOM(): HTMLElement {
      const el = document.createElement('ruby');
      el.className = 'rdRuby';
      el.dataset.word = this.hit.word;
      el.appendChild(document.createTextNode(this.hit.word));
      const rt = document.createElement('rt');
      rt.textContent = this.hit.ruby;
      el.appendChild(rt);
      return el;
    }
  };
  const b = new CM.RangeSetBuilder();
  for (const h of hits) b.add(h.from, h.to, CM.Decoration.replace({ widget: new cls(h) }));
  return b.finish();
}

/** 由 doc-pane 呼叫：把正文畫成唯讀 CM6（ruby 在字上方），掛在 #docText。 */
export function mountReadingDoc(sel: string, lines: readonly string[]): void {
  const host = document.querySelector(sel) as HTMLElement | null;
  if (!host) return;
  const text = lines.map(stripTags).join('\n');
  host.innerHTML = '';
  if (view) { try { view.destroy(); } catch { /* ignore */ } view = null; }
  if (!CM?.EditorView) { host.textContent = text; return; }
  const exts: any[] = [CM.EditorState.readOnly.of(true), CM.EditorView.lineWrapping];
  const hits = hitsFor(text);
  if (hits.length) exts.push(CM.EditorView.decorations.of(rubyDecorations(hits)));
  view = new CM.EditorView({ state: CM.EditorState.create({ doc: text, extensions: exts }), parent: host });
  if (!lex && !lexLoading) void loadLexicon().then(() => { if (readingModeOn()) rerender(); });
}

function rerender(): void {
  window.dispatchEvent(new CustomEvent('accelon26:rerender'));
}

/* ------------------------------------------------------------ 模式切換 */

function toolbar(): HTMLElement {
  let bar = document.getElementById('rdToolbar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'rdToolbar';
  bar.className = 'rdToolbar';
  bar.hidden = true;
  bar.innerHTML = '<b>精讀</b> '
    + '<span>ruby：IAST</span> '
    + '<label><input type="checkbox" id="rdOn" checked> 顯示</label>';
  const host = document.getElementById('docText');
  if (host?.parentElement) host.parentElement.insertBefore(bar, host);
  else document.body.appendChild(bar);
  bar.querySelector('#rdOn')?.addEventListener('change', (ev) => {
    rubyOn = (ev.target as HTMLInputElement).checked;
    rerender();
  });
  return bar;
}

export function toggleReadingMode(): void {
  const on = !readingModeOn();
  document.body.classList.toggle('reading', on);
  const bar = toolbar();
  bar.hidden = !on;
  if (on) void loadLexicon().then(() => rerender());
  rerender();
}

export function closeReadingMode(): void {
  if (!readingModeOn()) return;
  document.body.classList.remove('reading');
  const bar = document.getElementById('rdToolbar');
  if (bar) bar.hidden = true;
  rerender();
}

/* ------------------------------------------------------------ 自己接（不從 ui import，避免循環） */

if (typeof document !== 'undefined') {
  const start = (): void => {
    const btn = document.getElementById('readingBtn');
    if (btn) btn.addEventListener('click', () => toggleReadingMode());
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'F4' || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || ev.defaultPrevented) return;
      ev.preventDefault();
      toggleReadingMode();
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

// doc-pane 用 `window.__readingMount` 呼叫（避免它 import 這個檔造成循環）
(window as unknown as { __readingMount?: unknown }).__readingMount = mountReadingDoc;
