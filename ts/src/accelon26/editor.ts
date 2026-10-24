/**
 * CodeMirror 6 編輯器（file:// 版）：標籤塗紅、成對刪除、貼上 tag 包住選取文字。
 *
 * CM6 由 tools/build-codemirror.ts 打包成 vendor/codemirror/codemirror.js，
 * 以 window.CM 提供；viewer bundle 不直接 import npm 套件。
 */
import { findTagEnd, isGarbageTag } from '../xmlrepair';
import { parseTag } from '../tokenize';

interface Tag {
  start: number;
  end: number;
  name: string;
  shortName: string;
  kind: 'open' | 'close' | 'both';
  /** index of the matching tag, when there is one */
  pair: number;
}

export interface PageEditor {
  view: any;
  getLines(): string[];
  focus(): void;
  destroy(): void;
}

export interface EditorHooks {
  onChange?: () => void;
  /** status line for blocked/wrapped operations */
  onNotice?: (msg: string) => void;
}

function scanTags(text: string): Tag[] {
  const tags: Tag[] = [];
  let i = 0;
  while ((i = text.indexOf('<', i)) >= 0) {
    const end = findTagEnd(text, i);
    if (end < 0) { i++; continue; }
    const raw = text.slice(i + 1, end);
    if (!isGarbageTag(raw)) {
      try {
        const t = parseTag(raw);
        tags.push({ start: i, end: end + 1, name: t.name, shortName: t.shortName, kind: t.kind, pair: -1 });
      } catch { /* skip malformed */ }
    }
    i = end + 1;
  }
  // pair open/close by name with a stack (nearest matching open wins)
  const stack: number[] = [];
  for (let k = 0; k < tags.length; k++) {
    const t = tags[k];
    if (t.kind === 'open') stack.push(k);
    else if (t.kind === 'close') {
      for (let s = stack.length - 1; s >= 0; s--) {
        const oi = stack[s];
        if (tags[oi].shortName === t.shortName) {
          tags[oi].pair = k;
          t.pair = oi;
          stack.splice(s, 1);
          break;
        }
      }
    }
  }
  return tags;
}

const TAG_CLASS = 'cm-tag';
const BAD_CLASS = 'cm-tag-bad';

function buildDecorations(CM: any, text: string): { deco: any; tags: Tag[] } {
  const tags = scanTags(text);
  const b = new CM.RangeSetBuilder();
  for (const t of tags) {
    let cls = TAG_CLASS;
    if (t.pair < 0 && t.kind !== 'both') cls += ' ' + BAD_CLASS;
    if (t.kind === 'close') cls += ' cm-tag-close';
    if (t.kind === 'both') cls += ' cm-tag-self';
    b.add(t.start, t.end, CM.Decoration.mark({ class: cls }));
  }
  return { deco: b.finish(), tags };
}

function tagAt(tags: Tag[], from: number, to: number): Tag[] {
  const hit: Tag[] = [];
  for (const t of tags) {
    // only a changed range that actually covers '<' or '>' deletes the tag
    if ((from <= t.start && t.start < to) || (from <= t.end - 1 && t.end - 1 < to)) hit.push(t);
  }
  return hit;
}

/** Expand a deletion that removes a tag bracket to the whole tag (and its pair). */
function expandDeletion(text: string, tags: Tag[], changes: any): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  changes.iterChangedRanges((fromA: number, toA: number) => {
    if (toA <= fromA) return;
    const hit = tagAt(tags, fromA, toA);
    if (!hit.length) return;
    // Keep the user's own selection too: deleting "text <b>more</b>" must remove
    // "text " as well, not only the tag pair.
    ranges.push({ from: fromA, to: toA });
    for (const t of hit) {
      ranges.push({ from: t.start, to: t.end });
      if (t.pair >= 0) ranges.push({ from: tags[t.pair].start, to: tags[t.pair].end });
    }
  });
  if (!ranges.length) return [];
  // merge overlapping/adjacent ranges
  ranges.sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

function parseClipboardTag(raw: string): { open: string; close: string } | null {
  const s = raw.trim();
  if (!s.startsWith('<') || !s.endsWith('>')) return null;
  const closeM = /^<\s*\/\s*([^\s>]+)\s*>$/.exec(s);
  if (closeM) return { open: '<' + closeM[1] + '>', close: '</' + closeM[1] + '>' };
  const m = /^<\s*([^\s/>]+)([\s\S]*?)(\/?)\s*>$/.exec(s);
  if (!m) return null;
  const name = m[1];
  const attrs = m[2].replace(/\s*\/\s*$/, '');
  const open = '<' + name + attrs + '>';
  return { open, close: '</' + name + '>' };
}

export function mountPageEditor(parent: HTMLElement, lines: string[], hooks: EditorHooks = {}): PageEditor {
  const CM = (globalThis as any).CM;
  if (!CM) throw new Error('CodeMirror bundle 未載入（window.CM）');
  const { EditorState, EditorView, StateField, Annotation, keymap, lineNumbers,
    highlightActiveLine, highlightActiveLineGutter, drawSelection, history, historyKeymap,
    defaultKeymap, indentWithTab } = CM;
  const TAG_DELETE = Annotation.define();

  const tagField = StateField.define({
    create(state: any) { return buildDecorations(CM, state.doc.toString()); },
    update(value: any, tr: any) {
      if (!tr.docChanged) return value;
      return buildDecorations(CM, tr.state.doc.toString());
    },
    provide(field: any) {
      return EditorView.decorations.from(field, (v: any) => v.deco);
    },
  });

  const filter = EditorState.transactionFilter.of((tr: any) => {
    if (!tr.docChanged) return tr;
    if (tr.annotation(TAG_DELETE)) return tr;
    const tags: Tag[] = tr.startState.field(tagField).tags;
    const expand = expandDeletion(tr.startState.doc.toString(), tags, tr.changes);
    if (!expand.length) return tr;
    // A pure deletion becomes one transaction that removes the whole tag pair.
    // If the user was also inserting text, the tag deletion still wins (the
    // requirement is "delete < or > = delete the whole tag").
    const spec = {
      changes: expand.map((r) => ({ from: r.from, to: r.to, insert: '' })),
      selection: { anchor: expand[0].from },
      scrollIntoView: true,
      userEvent: 'delete.tag',
      annotations: TAG_DELETE.of(true),
    };
    hooks.onNotice?.('已刪除整個標籤（成對標籤一起刪）');
    return tr.startState.update(spec);
  });

  const paste = EditorView.domEventHandlers({
    paste(event: ClipboardEvent, view: any) {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      const pair = parseClipboardTag(text);
      const sel = view.state.selection.main;
      if (!pair || sel.empty) return false;
      event.preventDefault();
      view.dispatch({
        changes: [
          { from: sel.from, insert: pair.open },
          { from: sel.to, insert: pair.close },
        ],
        selection: { anchor: sel.from + pair.open.length, head: sel.to + pair.open.length },
        userEvent: 'input.paste.wrap',
      });
      hooks.onNotice?.('已用 ' + pair.open + ' … ' + pair.close + ' 包住選取文字');
      return true;
    },
  });

  const theme = EditorView.theme({
    '&': {
      height: '100%', fontSize: 'var(--fsdoc)', backgroundColor: 'var(--bg)', color: 'var(--fg)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: "'Microsoft JhengHei', 'Segoe UI', system-ui, sans-serif",
      lineHeight: '1.85',
    },
    '.cm-content': { caretColor: 'var(--accent)', padding: '4px 0 40vh' },
    '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--dim)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(90,169,255,.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(90,169,255,.10)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(90,169,255,.25)' },
  });

  const state = EditorState.create({
    doc: lines.join('\n'),
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      tagField,
      filter,
      paste,
      theme,
      EditorView.updateListener.of((u: any) => {
        if (u.docChanged) hooks.onChange?.();
      }),
    ],
  });
  const view = new EditorView({ state, parent });
  view.focus();
  return {
    view,
    getLines: () => view.state.doc.toString().split('\n'),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
