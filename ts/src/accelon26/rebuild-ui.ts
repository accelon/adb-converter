/**
 * 「產生新 ADB」對話框與流程（file:// 版）。
 */
import type { AdbReader, AdbSource } from './adb';
import { applyEdits, diffPage, discardAll, editCount, findSession, makeRevision, revertRevision, sourceKey, type DbEditSession } from './edit-session';
import { buildAdb, readAllLines } from './rebuild-browser';
import { allRevisions, extraRevisions } from './revisions-store';
import { desktopHost, desktopOverwriteAdb } from './host';
import { sha256Hex } from './sha256';

export interface RebuildHooks {
  status?: (msg: string, kind?: 'info' | 'err' | 'busy') => void;
  openFile?: (file: AdbSource) => void | Promise<void>;
  /**
   * 桌面版覆蓋原檔之後，重新開啟那個檔案（作者 2026-10-27）。
   * 回傳 false 表示沒有重新載入（UI 要提示使用者自己重開）。
   */
  reloadPath?: (path: string) => Promise<boolean> | boolean;
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
  const close = el('editModalClose'); if (close) close.onclick = closeModal;
  const backdrop = el('editModalBackdrop'); if (backdrop) backdrop.onclick = closeModal;
  const cancel = el('editModalCancel') as HTMLButtonElement | null;
  if (cancel && !cancel.onclick) cancel.onclick = closeModal;
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
  const imported = extraRevisions(reader).length;
  if ((!es || n === 0) && imported === 0) { closeModal(); return; }
  const revs = await allRevisions(reader);
  const desktopPath = slot.file.path && (await desktopHost()) ? slot.file.path : '';
  const filename = baseName(reader, slot) + '-' + (n ? 'v' + (revs.length + 1) : 'imported') + '.adb';
  const intro = n
    ? '共 <b>' + n + '</b> 頁修訂，將重建整份 adb 並' + (desktopPath ? '<b>覆蓋原檔</b>。' : '下載。')
    : '匯入的 <b>' + imported + '</b> 筆 revisions 將寫入 adb（本文不變）並' + (desktopPath ? '<b>覆蓋原檔</b>。' : '下載。');
  showModal('<p class="big">' + intro + '</p>'
    + (n ? editSummary(es) : '<p class="dim">沒有文字修訂；只把 revisions 容器寫進輸出檔。</p>')
    + (desktopPath
      ? '<p class="dim">原檔：<b>' + esc(desktopPath) + '</b>。重建後直接覆蓋這個檔案（不是另存新檔）。</p>'
      : '<p class="dim">輸出檔名：<b>' + esc(filename) + '</b>。標籤語法問題不會阻止重建（照原樣寫入）。</p>'),
    () => { closeModal(); onGo(); });
  const go = el('editModalGo') as HTMLButtonElement | null;
  if (go) go.textContent = desktopPath ? '覆蓋原檔' : '產生並下載';
  const cancelText = el('editModalCancel') as HTMLButtonElement | null;
  if (cancelText) cancelText.textContent = '取消';
  const close = el('editModalClose'); if (close) close.onclick = closeModal;
  const cancel = el('editModalCancel'); if (cancel) cancel.onclick = closeModal;
  const back = el('editModalBackdrop'); if (back) back.onclick = closeModal;
}


export interface RollbackResult { bytes: Uint8Array; filename: string; revisionId: string; }

/** Rebuild the version BEFORE the latest revision (download only). */
export async function rollbackLatest(reader: AdbReader, slot: RebuildSlot, hooks: RebuildHooks = {}): Promise<RollbackResult | null> {
  if (reader.header.size > 50 * 1024 * 1024) {
    hooks.status?.('這個 adb 超過 50 MB，網頁版暫不支援回滾', 'err');
    return null;
  }
  const revs = await allRevisions(reader);
  if (!revs.length) { hooks.status?.('這個 adb 沒有修訂紀錄', 'err'); return null; }
  const latest = JSON.parse(new TextDecoder().decode(revs[revs.length - 1].blob));
  if (latest?.format !== 'accelon26-revision/1') { hooks.status?.('最新的修訂紀錄格式不認得', 'err'); return null; }
  const current = await readAllLines(reader);
  const previous = revertRevision(current, latest);
  const es = findSession(sourceKey(slot.file));
  progress('回滾：重建上一版…', 0.02);
  const bytes = await buildAdb({
    reader, lines: previous, baseLines: current, edits: [],
    key: (es?.key ?? 'rollback') + '#rollback:' + latest.id,
    extraRevisions: extraRevisions(reader),
    keepRevisions: revs.length - 1,
    progress: (phase, done, total) => progress(phase + ' ' + done + '/' + total, total ? 0.02 + 0.9 * (done / total) : 0.5),
  });
  progressDone();
  const filename = baseName(reader, slot) + '-rollback-' + latest.id + '.adb';
  hooks.status?.('已產生回滾檔 ' + filename + '（' + (bytes.length / 1048576).toFixed(2) + ' MiB）', 'info');
  return { bytes, filename, revisionId: latest.id };
}

export async function rollbackAndDownload(reader: AdbReader, slot: RebuildSlot, hooks: RebuildHooks = {}): Promise<void> {
  const revs = await allRevisions(reader);
  if (!revs.length) return;
  const latest = revs[revs.length - 1];
  if (!window.confirm('要退回 ' + latest.id + ' 之前的版本嗎？會下載一份回滾後的 adb（目前檔案不會被改動）。')) return;
  progress('回滾：準備中…', 0.01);
  try {
    const res = await rollbackLatest(reader, slot, hooks);
    if (!res) { progressDone(); return; }
    const url = downloadAdb(res.bytes, res.filename);
    showModal('<p class="big">✓ 已下載回滾檔 <b>' + esc(res.filename) + '</b></p>'
      + '<p class="dim">內容已回到 ' + esc(res.revisionId) + ' 之前的版本；這個檔案不再包含那一筆修訂。</p>'
      + '<p><a class="mini" href="' + url + '" download="' + esc(res.filename) + '">再下載一次</a></p>',
      () => { closeModal(); });
    const go = el('editModalGo') as HTMLButtonElement | null;
    if (go) go.textContent = '關閉';
    const cancel = el('editModalCancel') as HTMLButtonElement | null;
    if (cancel) {
      cancel.textContent = '開啟新檔';
      cancel.onclick = () => {
        closeModal();
        const file = new File([res.bytes as unknown as BlobPart], res.filename, { type: 'application/octet-stream', lastModified: Date.now() }) as unknown as AdbSource;
        void hooks.openFile?.(file);
      };
    }
  } catch (e) {
    progressDone();
    hooks.status?.('回滾失敗：' + (e as Error).message, 'err');
    showModal('<p style="color:var(--err)"><b>回滾失敗</b></p><p>' + esc((e as Error).message) + '</p>', closeModal);
  }
}

export interface RunResult { bytes: Uint8Array; filename: string; revisionId: string; pages: number; }

/** Build the new adb. Does NOT download; the caller decides. */
export async function runRebuild(reader: AdbReader, slot: RebuildSlot, hooks: RebuildHooks = {}): Promise<RunResult | null> {
  if (reader.header.size > 50 * 1024 * 1024) {
    hooks.status?.('這個 adb 超過 50 MB，網頁版暫不支援重建', 'err');
    return null;
  }
  const es = findSession(sourceKey(slot.file));
  const imported = extraRevisions(reader);
  const hasEdits = !!es && es.edits.size > 0;
  if (!hasEdits && !imported.length) return null;
  const baseLines = await readAllLines(reader);
  const merged = hasEdits ? applyEdits(baseLines, es!.edits.values()) : baseLines;
  const revs = await allRevisions(reader);
  const parent = revs.length ? revs[revs.length - 1].id : null;
  const id = hasEdits ? 'v' + (revs.length + 1) : (parent || 'imported');
  let revision: ReturnType<typeof makeRevision> | undefined;
  if (hasEdits) {
    revision = makeRevision(es!, {
      name: slot.name, size: slot.file.size, lineCount: baseLines.length, headerCrc: reader.header.crc32,
    }, id, parent);
    const digest = await sha256Hex(JSON.stringify(revision));
    if (digest) revision.hash = 'sha256:' + digest;
  }
  progress('重建：建立索引與內文…', 0.02);
  const bytes = await buildAdb({
    reader, lines: merged, baseLines, edits: hasEdits ? [...es!.edits.values()] : [], key: es?.key ?? ('import:' + sourceKey(slot.file)), revision,
    extraRevisions: imported,
    progress: (phase, done, total) => progress(phase + ' ' + done + '/' + total, total ? 0.02 + 0.9 * (done / total) : 0.5),
  });
  progress('寫出檔案…', 0.97);
  const filename = baseName(reader, slot) + '-' + (hasEdits ? id : 'imported') + '.adb';
  if (es) es.revisions = revs.length + (hasEdits ? 1 : 0);
  progressDone();
  hooks.status?.('已產生 ' + filename + '（' + (bytes.length / 1048576).toFixed(2) + ' MiB，' + (hasEdits ? es!.edits.size + ' 頁修訂' : '只寫入匯入 revisions') + '）', 'info');
  return { bytes, filename, revisionId: id, pages: hasEdits ? es!.edits.size : 0 };
}

/** The whole user-facing flow: confirm → build → download → offer to open. */
export async function rebuildAndDownload(reader: AdbReader, slot: RebuildSlot, hooks: RebuildHooks = {}): Promise<void> {
  const es = findSession(sourceKey(slot.file));
  if ((!es || !es.edits.size) && !extraRevisions(reader).length) return;
  await openRebuildDialog(reader, slot, async () => {
    progress('準備中…', 0.01);
    try {
      const res = await runRebuild(reader, slot, hooks);
      if (!res) { progressDone(); return; }
      // 桌面版：直接覆蓋原檔（作者 2026-10-27）。宿主先解除 mmap，才不會像
      // WebView 下載那樣「檔案被鎖住 → 要使用者換資料夾」。
      const path = slot.file.path;
      if (path && await desktopHost()) {
        const w = await desktopOverwriteAdb(path, res.bytes);
        progressDone();
        if (w?.ok) {
          const es2 = findSession(sourceKey(slot.file));
          if (es2) discardAll(es2);            // 修訂已寫進新檔，別讓 closeDb 再問一次
          const reloaded = await hooks.reloadPath?.(w.path ?? path);
          const name = (w.path ?? path).split(/[\\/]/).pop() || res.filename;
          showModal('<p class="big">✓ 已覆蓋 <b>' + esc(name) + '</b></p>'
            + '<p class="dim">' + (res.pages ? res.pages + ' 頁修訂已寫入 revisions 容器。' : '匯入的 revisions 已寫入原檔。') + '</p>'
            + (reloaded
              ? '<p class="dim">已重新載入新檔。</p>'
              : '<p class="dim">請重新開啟這個 adb，才會看到新內容。</p>'),
            () => { closeModal(); });
          const go = el('editModalGo') as HTMLButtonElement | null;
          if (go) go.textContent = '關閉';
          const cancel = el('editModalCancel') as HTMLButtonElement | null;
          if (cancel) { cancel.textContent = '關閉'; cancel.onclick = closeModal; }
          return;
        }
        const why = w?.error ?? '宿主沒有回應';
        const url = downloadAdb(res.bytes, res.filename);
        showModal('<p style="color:var(--err)"><b>無法覆蓋原檔</b></p><p>' + esc(why) + '</p>'
          + '<p>修訂已重建完成，已改為下載；請另存到別的資料夾。</p>'
          + '<p><a class="mini" href="' + url + '" download="' + esc(res.filename) + '">再下載一次</a></p>',
          () => { closeModal(); });
        const go = el('editModalGo') as HTMLButtonElement | null;
        if (go) go.textContent = '關閉';
        const cancel = el('editModalCancel') as HTMLButtonElement | null;
        if (cancel) { cancel.textContent = '關閉'; cancel.onclick = closeModal; }
        return;
      }
      const url = downloadAdb(res.bytes, res.filename);
      progressDone();
      showModal('<p class="big">✓ 已下載 <b>' + esc(res.filename) + '</b></p>'
        + '<p class="dim">' + (res.pages ? res.pages + ' 頁修訂已寫入 revisions 容器。' : '匯入的 revisions 已寫入輸出檔。') + '原始庫仍保持原樣（修訂只是暫存在瀏覽器）。</p>'
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


