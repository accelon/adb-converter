/**
 * 「產生新 ADB」對話框與流程（file:// 版）。
 */
import type { AdbReader, AdbSource } from './adb';
import { applyEdits, diffPage, editCount, findSession, makeRevision, sourceKey, type DbEditSession } from './edit-session';
import { buildAdb, readAllLines, readRevisions } from './rebuild-browser';

export interface RebuildHooks {
  status?: (msg: string, kind?: 'info' | 'err' | 'busy') => void;
  openFile?: (file: AdbSource) => void | Promise<void>;
}

export interface RebuildSlot { id: number; name: string; file: AdbSource; }

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
function el(id: string): HTMLElement | null { return document.getElementById(id); }

function showModal(html: string, onGo: () => void): void {
  const body = el('editModalBody');
  if (body) body.innerHTML = html;
  const back = el('editModalBackdrop'); if (back) back.hidden = false;
  const box = el('editModal'); if (box) box.hidden = false;
  const go = el('editModalGo') as HTMLButtonElement | null;
  if (go) go.onclick = onGo;
}
function closeModal(): void {
  const a = el('editModalBackdrop'); if (a) a.hidden = true;
  const m = el('editModal'); if (m) m.hidden = true;
}

function progress(text: string, frac: number): void {
  const box = el('editProgress'); if (box) box.hidden = false;
  const t = el('editProgressText'); if (t) t.textContent = text;
  const bar = el('editProgressBar'); if (bar) bar.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
}
function progressDone(): void {
  const box = el('editProgress'); if (box) box.hidden = true;
}

function baseName(reader: AdbReader, slot: RebuildSlot): string {
  const raw = reader.header.dbname || slot.name || 'adb';
  return raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\.adb$/i, '');
}

export function downloadAdb(bytes: Uint8Array, filename: string): string {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  return url;
}

function editSummary(es: DbEditSession): string {
  const rows = [...es.edits.values()].sort((a, b) => a.first - b.first).map((e) => {
    const d = diffPage(e);
    return '<li>行 ' + (e.first + 1) + '–' + (e.last + 1) + '（' + esc(e.docName || '本文') + '）：' + d.changes.length + ' 處修改</li>';
  }).join('');
  return '<ul>' + rows + '</ul>';
}

export async function openRebuildDialog(reader: AdbReader, slot: RebuildSlot, onGo: () => void): Promise<void> {
  const es = findSession(sourceKey(slot.file));
  const n = editCount(es);
  if (!es || n === 0) { closeModal(); return; }
  const revs = await readRevisions(reader);
  const filename = baseName(reader, slot) + '-v' + (revs.length + 1) + '.adb';
  showModal('<p class="big">共 <b>' + n + '</b> 頁修訂，將重建整份 adb 並下載。</p>'
    + editSummary(es)
    + '<p class="dim">輸出檔名：<b>' + esc(filename) + '</b>。標籤語法問題不會阻止重建（照原樣寫入）。</p>',
    () => { closeModal(); onGo(); });
  const go = el('editModalGo') as HTMLButtonElement | null;
  if (go) go.textContent = '產生並下載';
  const cancelText = el('editModalCancel') as HTMLButtonElement | null;
  if (cancelText) cancelText.textContent = '取消';
  const close = el('editModalClose'); if (close) close.onclick = closeModal;
  const cancel = el('editModalCancel'); if (cancel) cancel.onclick = closeModal;
  const back = el('editModalBackdrop'); if (back) back.onclick = closeModal;
}

export interface RunResult { bytes: Uint8Array; filename: string; revisionId: string; pages: number; }

/** Build the new adb. Does NOT download; the caller decides. */
export async function runRebuild(reader: AdbReader, slot: RebuildSlot, hooks: RebuildHooks = {}): Promise<RunResult | null> {
  if (reader.header.size > 50 * 1024 * 1024) {
    hooks.status?.('這個 adb 超過 50 MB，網頁版暫不支援重建', 'err');
    return null;
  }
  const es = findSession(sourceKey(slot.file));
  if (!es || !es.edits.size) return null;
  const baseLines = await readAllLines(reader);
  const merged = applyEdits(baseLines, es.edits.values());
  const revs = await readRevisions(reader);
  const parent = revs.length ? revs[revs.length - 1].id : null;
  const id = 'v' + (revs.length + 1);
  const revision = makeRevision(es, {
    name: slot.name, size: slot.file.size, lineCount: baseLines.length, headerCrc: reader.header.crc32,
  }, id, parent);
  progress('重建：建立索引與內文…', 0.02);
  const bytes = await buildAdb({
    reader, lines: merged, baseLines, edits: [...es.edits.values()], key: es.key, revision,
    progress: (phase, done, total) => progress(phase + ' ' + done + '/' + total, total ? 0.02 + 0.9 * (done / total) : 0.5),
  });
  progress('寫出檔案…', 0.97);
  const filename = baseName(reader, slot) + '-' + id + '.adb';
  es.revisions = revs.length + 1;
  progressDone();
  hooks.status?.('已產生 ' + filename + '（' + (bytes.length / 1048576).toFixed(2) + ' MiB，' + es.edits.size + ' 頁修訂）', 'info');
  return { bytes, filename, revisionId: id, pages: es.edits.size };
}

/** The whole user-facing flow: confirm → build → download → offer to open. */
export async function rebuildAndDownload(reader: AdbReader, slot: RebuildSlot, hooks: RebuildHooks = {}): Promise<void> {
  const es = findSession(sourceKey(slot.file));
  if (!es || !es.edits.size) return;
  await openRebuildDialog(reader, slot, async () => {
    progress('準備中…', 0.01);
    try {
      const res = await runRebuild(reader, slot, hooks);
      if (!res) { progressDone(); return; }
      const url = downloadAdb(res.bytes, res.filename);
      progressDone();
      showModal('<p class="big">✓ 已下載 <b>' + esc(res.filename) + '</b></p>'
        + '<p class="dim">' + res.pages + ' 頁修訂已寫入 revisions 容器。原始庫仍保持原樣（修訂只是暫存在瀏覽器）。</p>'
        + '<p><a class="mini" href="' + url + '" download="' + esc(res.filename) + '">再下載一次</a></p>',
        () => { closeModal(); });
      const go = el('editModalGo') as HTMLButtonElement | null;
      if (go) go.textContent = '關閉';
      const cancel = el('editModalCancel') as HTMLButtonElement | null;
      if (cancel) {
        cancel.textContent = '開啟新檔';
        cancel.onclick = () => {
          closeModal();
          const file = new File([res.bytes as unknown as BlobPart], res.filename, {
            type: 'application/octet-stream', lastModified: Date.now(),
          }) as unknown as AdbSource;
          void hooks.openFile?.(file);
        };
      }
    } catch (e) {
      progressDone();
      hooks.status?.('重建失敗：' + (e as Error).message, 'err');
      showModal('<p style="color:var(--err)"><b>重建失敗</b></p><p>' + esc((e as Error).message) + '</p>', closeModal);
      const go = el('editModalGo') as HTMLButtonElement | null;
      if (go) go.textContent = '關閉';
    }
  });
}


