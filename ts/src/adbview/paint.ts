/**
 * 「塗紅」——painting the current hit inside the document pane.
 *
 * Split out of viewer.ts: the mark logic is self-contained (it only reads the DOM
 * rows and the mapper's spans) and it is the part that changes most often, because
 * every database drifts differently.
 *
 *   markPhraseInLine  paint a phrase by TEXT inside one rendered line
 *   markPhraseOnPage  the same, scanning the whole page (fgdict's drift)
 *   paintHit          the entry point: decide what to paint for the pinned hit
 */
import { mapper } from './viewer';
import { docSession, scheduleCursorSync, scrollToVa } from './doc-pane';

function markPhraseInLine(line: number | undefined, phrase: string | undefined, va: number): boolean {
  if (line === undefined || !phrase) return false;
  const node = document.getElementById('L' + line)?.querySelector<HTMLElement>('.lineText')?.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const text = node.textContent ?? '';
  const at = text.indexOf(phrase);
  if (at < 0) return false;
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + phrase.length);
  const mark = document.createElement('mark');
  mark.className = 'docHit';
  mark.dataset.va = String(va);
  try {
    range.surroundContents(mark);
  } catch {
    return false;
  }
  mark.scrollIntoView({ block: 'center' });
  return true;
}

/**
 * Paint `phrase` in the rendered page, starting at `fromLine` and wrapping once.
 *
 * `markPhraseInLine` only looks at the one line the link computed, and on a database
 * whose VA walk drifts (fgdict) that line can be the segment's heading rather than
 * the hit's own line — the query would then silently stay unpainted. The page is
 * always the page that holds the hit, so searching it finds the phrase.
 */
function markPhraseOnPage(phrase: string | undefined, va: number, fromLine: number): boolean {
  if (!phrase) return false;
  const rows = [...document.querySelectorAll<HTMLElement>('#docText .docLine')];
  if (!rows.length) return false;
  const lineOf = (el: HTMLElement) => Number((el.id || '').replace(/^L/, ''));
  const start = Math.max(0, rows.findIndex((r) => lineOf(r) === fromLine));
  for (let i = start; i < rows.length; i++) if (markPhraseInLine(lineOf(rows[i]), phrase, va)) return true;
  for (let i = 0; i < start; i++) if (markPhraseInLine(lineOf(rows[i]), phrase, va)) return true;
  return false;
}

async function paintHit(va: number, units?: number): Promise<void> {
  const s = docSession();
  if (!mapper || !s) return;
  // A node-label link (名詞 / 原書分頁) names the node itself, so marking its text in
  // the line the reader was sent to is walk-independent — and on a drifting database
  // (fgdict) it is the ONLY correct answer: the span path painted an unrelated
  // character on the right line. Search hits and token clicks keep the span path,
  // where the token name can differ from the source text (yinshun normalizes) and
  // the same phrase may occur several times in one line.
  // 原書分頁 only jumps: the `<頁>` marker is a milestone, not a hit, so nothing is
  // painted (linkTo has already scrolled its line into view).
  if (s.pinned?.noMark) return;
  if (s.pinned?.exact) {
    const phrase = s.pinned.phrase ?? s.pinned.token;
    if (markPhraseInLine(s.pinned.line, phrase, va)) return;
    // the linked line can be the segment's heading (fgdict drift): the page holds the
    // hit, so look for the phrase on the page before giving up on marking it
    if (markPhraseOnPage(phrase, va, s.pinned.line)) return;
  }
  let spans = units && units > 1 ? await mapper.phraseSpans(va, units) : await mapper.lineSpans(va);
  if (!spans.length) {
    // A heading TAG carries no inline text span (lineSpans skips tags), so a
    // directory click on `<戊 u="文">` would produce no mark AND no scroll.
    const el = await mapper.elementAt(va);
    if (el?.element.line !== undefined) scrollToVa(va);
    return;
  }
  // The page is chosen by the LINK (linkTo follows the hit explicitly), never by
  // the painter: if the hit is not on the page now on screen, there is simply
  // nothing to mark. Moving the page here made 上一頁／下一頁 impossible.
  if (spans.some((x) => !document.getElementById('L' + x.line))) {
    // The walk's spans can disagree with the line table (fgdict drifts by >1000 VA,
    // so its element lookup returns the wrong text). The reader was sent to the
    // table line, so mark the searched phrase inside THAT line instead.
    markPhraseInLine(s.pinned?.line, s.pinned?.phrase ?? s.pinned?.token, va);
    return;
  }
  let firstMark: HTMLElement | null = null;
  for (const sp of spans) {
    const row = document.getElementById('L' + sp.line);
    const span = row?.querySelector<HTMLElement>('.lineText');
    if (!span) continue;
    const textNode = span.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
    const text = textNode.textContent ?? '';
    const start = Math.max(0, Math.min(text.length, sp.start));
    const end = Math.max(start, Math.min(text.length, sp.end));
    if (end <= start) continue;
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const mark = document.createElement('mark');
    mark.className = 'docHit';
    mark.dataset.va = String(va);
    try {
      range.surroundContents(mark);
    } catch {
      continue;
    }
    if (!firstMark) firstMark = mark;
  }
  (firstMark ?? document.getElementById('L' + (spans[0]?.line ?? 0)))?.scrollIntoView({ block: 'center' });
  scheduleCursorSync();
}

export { markPhraseInLine, markPhraseOnPage, paintHit };
