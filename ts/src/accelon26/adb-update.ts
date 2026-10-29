/**
 * 公開資料庫（.adb）的版本與更新（作者 2026-10-29）。
 *
 * 作者要求：**adb 也像 exe 一樣維護版本更新** —— 每一次建置都記下 buildTime／sha256／
 * 改版說明；使用者看得到「從我這一版到最新版之間每一次改變」，要不要更新由使用者決定。
 *
 * 清單：`<站>/accelon26/adb/manifest.json`（schema 2）
 *   { file, name, size, sha256, buildTime, notes, history: [
 *       { buildTime, sha256, size, notes }, … 由新到舊 ] }
 *
 * 比對：本機 sha256 在 history 裡找到哪一版，只列出**比它新**的每一版說明；
 * 本機版本不在記錄中（自己重建的）也會說清楚，只顯示最新一版說明。
 *
 * 更新：按「更新」才會下載；進度條、隨時放棄，先寫同目錄暫存檔，驗證失敗／放棄都
 * 只刪暫存檔，原檔不動；全部驗過才由 Go 原子替換。
 *
 * 對話盒有兩個頁籤：「可更新」與「版本記錄」——後者列出每個已安裝公開資料庫的
 * 完整版本歷史，不必等有新版才看得到。
 */
import { $, escapeHtml, fmtBytes, openFile } from './viewer';
import {
  activeSlot, catalog, closeDb, openDbs, replaceCatalogFile, setDbTabsExtra,
  type CatalogEntry,
} from './dbs';
import {
  desktopAdbDownloadStatus, desktopAdbManifestUrl, desktopCancelAdbDownload,
  desktopFetchText, desktopFileSha256, desktopSources, desktopStartAdbDownload,
} from './host';
import { editCount, findSession, sourceKey } from './edit-session';
import { ensureMirrorReady, MIRRORS, isKnownMirrorBase } from './mirror';

export interface ManifestVersion {
  /** 這一版的建置時間（RFC3339；本機檔案時間） */
  buildTime?: string;
  sha256?: string;
  size?: number;
  /** 這一版改了什麼 */
  notes?: string[];
}

export interface ManifestDb {
  file: string;
  name?: string;
  size: number;
  sha256?: string;
  buildTime?: string;
  /** 檔案日期 YYYY-MM-DD（舊清單才有；新清單用 buildTime） */
  date?: string;
  notes?: string[];
  /** 由新到舊的每一次建置（schema 2） */
  history?: ManifestVersion[];
  /** available／wip（施工中）／revision（整修中） */
  status?: string;
  statusLabel?: string;
  statusNote?: string;
  /** false＝manifest 有記錄，但官網／桌面版都不提供下載 */
  downloadable?: boolean;
  /** 有「改版說明」頁時附上的檔名（tx.html…） */
  doc?: string;
}

interface Manifest {
  schema?: number;
  generated?: string;
  dbs?: ManifestDb[];
}

type Phase = 'idle' | 'downloading' | 'done' | 'error' | 'cancelled';
type Tab = 'updates' | 'history';

export interface UpdateItem {
  m: ManifestDb;
  entry: CatalogEntry;
  /** 由新到舊的版本（history；舊清單只有一版） */
  versions: ManifestVersion[];
  /** 本機 sha256 在 versions 的哪一格；-1＝不在記錄中（自己重建的／讀不到） */
  localIndex: number;
  /** 本機版本比最新版舊（不代表可以下載：施工中或 >30 MB 時 hasUpdate=false） */
  behind: boolean;
  hasUpdate: boolean;
  downloadable: boolean;
  /** 超過 30 MB 的底座：可整檔下載，但不列入「全部更新」 */
  large: boolean;
  status: string;
  statusNote: string;
  phase: Phase;
  received: number;
  total: number;
  error?: string;
  /** bytes／秒（輪詢時算的，僅供顯示） */
  speed: number;
  downloadId?: string;
}

const POLL_MS = 150;
/** 30 MB 是「大底座」的分界：仍可整檔下載，但只隨 CBETA 換版等重大更新，且不列入全部更新。 */
export const LARGE_ADB_BYTES = 30 * 1024 * 1024;
const RECHECK_MS = 6 * 60 * 60 * 1000;

let manifestUrl = '';
let checking = false;
let checkedAt = 0;
let loadError = '';
let items: UpdateItem[] = [];
let open = false;
let tab: Tab = 'updates';
let activeFile = '';
let queueRunning = false;
let notice = '';
let button: HTMLButtonElement | null = null;
const hashCache = new Map<string, string>();
// 同一個檔案（路徑＋大小＋時間）算過一次 sha 就記住；下次啟動不必再讀 300 MB 底座。
const HASH_STORE = 'accelon26.adbUpdate.sha.v1';
let hashStore: Record<string, string> | null = null;
function loadHashStore(): Record<string, string> {
  if (hashStore) return hashStore;
  try { hashStore = JSON.parse(localStorage.getItem(HASH_STORE) || '{}') as Record<string, string>; }
  catch { hashStore = {}; }
  return hashStore;
}
function saveHashStore(): void {
  try { localStorage.setItem(HASH_STORE, JSON.stringify(hashStore ?? {})); } catch { /* 無痕模式 */ }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const normPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const samePath = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && normPath(a) === normPath(b);
const updates = (): UpdateItem[] => items.filter((i) => i.hasUpdate);
/** 「全部更新」只跑 <30 MB 的庫；大型底座由使用者個別按「下載整檔」。 */
const bulkUpdates = (): UpdateItem[] => updates().filter((i) => !i.large);

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** RFC3339 → 本地「2026-10-29 09:30」；只有日期就照原樣。 */
function fmtBuild(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 除錯／測試用：目前看到的版本狀態。 */
export function adbUpdateState(): Record<string, unknown> {
  return {
    open,
    tab,
    checking,
    manifestUrl,
    checkedAt,
    error: loadError,
    count: updates().length,
    total: items.length,
    activeFile,
    items: items.map((it) => ({
      file: it.m.file, name: it.m.name ?? '', phase: it.phase,
      received: it.received, total: it.total, error: it.error ?? '',
      path: it.entry.file.path ?? '',
      hasUpdate: it.hasUpdate,
      behind: it.behind,
      downloadable: it.downloadable,
      large: it.large,
      status: it.status,
      statusNote: it.statusNote,
      localIndex: it.localIndex,
      localBuild: it.localIndex >= 0 ? (it.versions[it.localIndex].buildTime ?? '') : '',
      latestBuild: it.versions[0]?.buildTime ?? '',
      versions: it.versions.length,
    })),
  };
}

// ---- 找本機對應的檔案 ----------------------------------------------------------

/** 清單的檔名 → 這個工作階段看過的 adb（桌面版才有 path）。 */
function entryOf(file: string): CatalogEntry | null {
  const want = file.toLowerCase();
  const hits = catalog.filter((e) => !!e.file.path && baseName(e.file.path!).toLowerCase() === want);
  if (!hits.length) return null;
  // 同一檔名出現在兩個資料夾時，優先挑已經開啟的那一個
  return hits.find((e) => openDbs.some((s) => samePath(s.file.path, e.file.path))) ?? hits[0];
}

/** 本機 sha256（桌面版走 Go；算過就快取，換檔後 size/mtime 會變、自然重算）。 */
async function localSha(entry: CatalogEntry): Promise<string | null> {
  const path = entry.file.path;
  if (!path) return null;
  const key = normPath(path) + '|' + entry.file.size + '|' + entry.file.lastModified;
  const hit = hashCache.get(key) ?? loadHashStore()[key];
  if (hit) { hashCache.set(key, hit); return hit; }
  const sha = await desktopFileSha256(path);
  if (sha) {
    hashCache.set(key, sha);
    loadHashStore()[key] = sha;
    saveHashStore();
  }
  return sha;
}

/** manifest 的一本 → 由新到舊的版本（舊清單沒有 history 就自己補一版）。 */
function versionsOf(db: ManifestDb): ManifestVersion[] {
  const list: ManifestVersion[] = Array.isArray(db.history) && db.history.length
    ? db.history.filter((v) => !!v && (v.sha256 || v.buildTime))
    : [{ buildTime: db.buildTime, sha256: db.sha256, size: db.size, notes: db.notes ?? [] }];
  // manifest 的 history 契約就是「由新到舊」；不要按 buildTime 重排——
  // 回退到舊版時內容的 buildTime 比較舊，但它才是現在線上那一版。
  return list;
}

/** 依 manifest 建立每一本的版本狀態（含沒有更新的），供兩個頁籤使用。 */
async function findItems(m: Manifest): Promise<UpdateItem[]> {
  const out: UpdateItem[] = [];
  for (const db of m.dbs ?? []) {
    if (!db || !db.file) continue;
    const entry = entryOf(db.file);
    if (!entry) continue;                    // 沒有的庫不提示（更新只針對已有的檔案）
    const versions = versionsOf(db);
    const latest = versions[0] ?? { sha256: db.sha256, size: db.size };
    const latestSha = (latest.sha256 ?? '').toLowerCase();
    const localSize = entry.file.size;
    const latestSize = latest.size ?? db.size;
    // 只有「大小與最新版相同」才需要算 sha256（同大小可能是內容不同的重建）。
    // 大小不同就已經是不同版本；若歷史裡剛好只有一個同大小的版本，直接用它當本機版本，
    // 不必為 300 MB 的底座每次啟動都讀一遍。
    const sameSize = versions
      .map((v, i) => ({ v, i }))
      .filter((x) => x.v.size === localSize);
    let sha: string | null = null;
    let localIndex = -1;
    if (localSize === latestSize) {
      sha = await localSha(entry);
      if (sha) localIndex = versions.findIndex((v) => (v.sha256 ?? '').toLowerCase() === sha);
    } else if (sameSize.length === 1) {
      localIndex = sameSize[0].i;    // 大小已能唯一對到某一版，不必算 sha
    }
    const behind = localSize !== latestSize
      ? true
      : (sha ? sha !== latestSha : false);
    const total = latestSize || entry.file.size;
    const status = db.status || 'available';
    // 施工中／整修中的庫：manifest 仍記錄版本，但不提供下載。
    // 超過 30 MB 的底座仍可整檔下載，只是不列入「全部更新」。
    const downloadable = db.downloadable !== false && status === 'available';
    const hasUpdate = behind && downloadable;
    const large = total > LARGE_ADB_BYTES;
    out.push({
      m: { ...db, name: db.name || entry.name, size: total },
      entry, versions, localIndex, behind, hasUpdate, status,
      statusNote: db.statusNote || '',
      downloadable, large,
      phase: 'idle', received: 0, total, speed: 0,
    });
  }
  // 有更新的排前面，其餘照清單次序
  return out.sort((a, b) => Number(b.hasUpdate) - Number(a.hasUpdate));
}

/** 從本機版本到最新版之間的每一版（不含本機那一版）。 */
function changesOf(it: UpdateItem): ManifestVersion[] {
  if (!it.hasUpdate) return [];
  if (it.localIndex > 0) return it.versions.slice(0, it.localIndex);
  if (it.localIndex === 0) return [];
  return it.versions.slice(0, 1);      // 本機版本不在記錄中：只顯示最新一版
}

// ---- 檢查 ----------------------------------------------------------------------

export async function checkAdbUpdates(force = false): Promise<void> {
  if (checking || activeFile) return;   // 下載中不重讀清單（會把正在下載的那一列換掉）
  if (!force && checkedAt && Date.now() - checkedAt < 60_000) return;
  checking = true;
  loadError = '';
  paintAll();
  try {
    await ensureMirrorReady();       // 先讓鏡像設定就緒，才知道要去哪一站拿 manifest
    const url = await desktopAdbManifestUrl();
    if (!url) { items = []; return; }        // 網頁版：沒有宿主，不做更新
    manifestUrl = url;
    let text = await desktopFetchText(url);
    if (!text) {
      // 目前這一站連不上時，換另一站拿「同一份清單」（國內／國外都可能遇到單站故障）。
      const alt = alternateManifest(url);
      if (alt) {
        const altText = await desktopFetchText(alt);
        if (altText) { text = altText; manifestUrl = alt; }
      }
    }
    if (!text) {
      loadError = '連不上更新伺服器（官網可能很慢或暫時離線）';
      checkedAt = Date.now();
      return;
    }
    let m: Manifest;
    try {
      m = JSON.parse(text) as Manifest;
    } catch {
      loadError = '更新清單格式不對（manifest.json 壞了）';
      checkedAt = Date.now();
      return;
    }
    const found = await findItems(m);
    // 檢查的過程中使用者可能已經按了下載；那時不要覆蓋 items（下載進度綁在舊物件上）。
    if (!activeFile) items = found;
    checkedAt = Date.now();
  } catch (e) {
    loadError = '檢查更新失敗：' + String((e as Error)?.message ?? e);
    checkedAt = Date.now();
  } finally {
    checking = false;
    paintAll();
  }
}

// ---- #dbTabs 的按鈕 ------------------------------------------------------------

function paintButton(): void {
  const box = document.getElementById('dbTabs');
  if (!box) return;
  const ups = updates();
  // 沒有安裝任何公開資料庫就不顯示；有安裝就一直留一顆「資料庫版本」，
  // 沒新版時也能看版本記錄（作者：讓使用者知道每一次改變）。
  if (!items.length) {
    button?.remove();
    button = null;
    return;
  }
  if (!button || !button.isConnected) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'adbUpBtn';
    button.id = 'adbUpBtn';
    button.addEventListener('click', () => { void openAdbUpdateDialog(); });
  }
  const n = ups.length;
  button.classList.toggle('plain', n === 0);
  button.innerHTML = n
    ? '<span class="adbUpNew">New</span><span class="adbUpLabel">資料庫更新</span>'
      + '<span class="adbUpCount">' + n + '</span>'
    : '<span class="adbUpLabel">資料庫版本</span>';
  button.title = n
    ? `有 ${n} 個資料庫可以更新：${ups.map((i) => i.m.name || i.m.file).join('、')}（點一下看每一版的改變）`
    : `已安裝 ${items.length} 個公開資料庫；點一下看版本記錄`;
  box.appendChild(button);
}

function paintAll(): void {
  paintButton();
  if (open) renderDialog();
}

// ---- 對話盒 --------------------------------------------------------------------

function dialogEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export async function openAdbUpdateDialog(): Promise<void> {
  open = true;
  tab = 'updates';
  notice = '';
  const box = dialogEl<HTMLElement>('adbUpdateBox');
  const back = dialogEl<HTMLElement>('adbUpdateBackdrop');
  if (box) box.hidden = false;
  if (back) back.hidden = false;
  renderDialog();
  await checkAdbUpdates();      // 60 秒內用剛檢查過的結果，不必每次重算 6 個 sha256
  if (open) renderDialog();
}

export function closeAdbUpdateDialog(): void {
  if (activeFile) {
    const name = items.find((i) => i.m.file === activeFile)?.m.name ?? activeFile;
    if (!window.confirm(`「${name}」還在下載。\n\n放棄這次更新嗎？（原本的 adb 不會更動）`)) return;
    void cancelActive();
  }
  open = false;
  const box = dialogEl<HTMLElement>('adbUpdateBox');
  const back = dialogEl<HTMLElement>('adbUpdateBackdrop');
  if (box) box.hidden = true;
  if (back) back.hidden = true;
  paintAll();
}

function notesList(notes: string[] | undefined, cls: string): string {
  if (!notes?.length) return '<p class="adbUpNoNotes">（這一版沒有附改版說明）</p>';
  return `<ul class="${cls}">` + notes.map((n) => '<li>' + escapeHtml(n) + '</li>').join('') + '</ul>';
}

function changesHtml(it: UpdateItem): string {
  const changes = changesOf(it);
  return '<div class="adbUpChanges">'
    + changes.map((v) => '<div class="adbUpVer">'
      + `<span class="vdate">${escapeHtml(fmtBuild(v.buildTime))}</span>`
      + notesList(v.notes, 'adbUpNotes')
      + '</div>').join('')
    + '</div>';
}

function historyHtml(it: UpdateItem): string {
  const n = it.versions.length;
  const list = it.versions.map((v, i) => {
    const tags: string[] = [];
    if (i === 0) tags.push('<span class="adbUpHistTag">最新</span>');
    if (i === it.localIndex) tags.push('<span class="adbUpHistTag cur">目前</span>');
    return '<li><span class="adbUpHistDate">' + escapeHtml(fmtBuild(v.buildTime)) + '</span>'
      + tags.join('')
      + notesList(v.notes, 'adbUpHistNotes')
      + '</li>';
  }).join('');
  return `<details class="adbUpDetails"><summary>版本記錄（${n} 版）</summary>`
    + `<ol class="adbUpHistList">${list}</ol></details>`;
}

function rowHtml(it: UpdateItem): string {
  const m = it.m;
  const name = escapeHtml(m.name || m.file);
  const latest = it.versions[0];
  const local = it.localIndex >= 0 ? it.versions[it.localIndex] : null;
  const oldSize = it.entry.file.size;
  const sizes = oldSize && oldSize !== m.size
    ? `${fmtBytes(oldSize)} <span class="adbUpArrow">→</span> <b>${fmtBytes(m.size)}</b>`
    : fmtBytes(m.size);
  const doc = m.doc
    ? ` · <a href="${escapeHtml(m.doc)}" target="_blank" rel="noopener" class="adbUpDoc">改版說明</a>`
    : '';
  const blockedStatus = it.status === 'wip'
    ? '施工中 · 暫不提供下載'
    : it.status === 'revision'
      ? '整修中 · 暫不提供下載'
      : '暫不提供下載';
  const status = it.hasUpdate
    ? (local
      ? `本機 <b>${escapeHtml(fmtBuild(local.buildTime))}</b> → 最新 <b>${escapeHtml(fmtBuild(latest?.buildTime))}</b>`
      : `本機版本不在記錄中 · 最新 <b>${escapeHtml(fmtBuild(latest?.buildTime))}</b>`)
    : it.downloadable
      ? `已是最新（${escapeHtml(fmtBuild(latest?.buildTime))}）`
      : blockedStatus;
  const blockedNote = !it.downloadable
    ? `<p class="adbUpWip">${escapeHtml(it.statusNote || '這個資料庫暫時不提供下載；版本記錄仍保留。')}</p>`
    : '';
  const largeNote = it.downloadable && it.large
    ? `<p class="adbUpWip">大型底座（${fmtBytes(m.size)}）：可整檔下載，但只在 CBETA 換版等重大更新時才更新；不列入「全部更新」。</p>`
    : '';
  const prog = it.phase === 'downloading';
  const done = it.phase === 'done';
  let msg = '';
  if (it.phase === 'error') msg = '<div class="adbUpMsg err">' + escapeHtml(it.error || '更新失敗') + '</div>';
  else if (it.phase === 'cancelled') msg = '<div class="adbUpMsg">已放棄；原本的 adb 沒有更動。</div>';
  else if (done) msg = '<div class="adbUpMsg ok">✓ 已更新</div>';
  const action = !it.hasUpdate || done || prog ? '' :
    `<button type="button" class="mini adbUpGo" data-up="${escapeHtml(m.file)}">${it.phase === 'idle' ? (it.large ? '下載整檔' : '更新') : '重試'}</button>`;
  const pct = it.total > 0 ? Math.min(100, Math.round(it.received / it.total * 100)) : 0;
  return `<div class="adbUpRow${done ? ' done' : ''}" data-file="${escapeHtml(m.file)}">`
    + '<div class="adbUpHead">'
    + `<div class="adbUpName">${name}<span class="file">${escapeHtml(m.file)}</span></div>`
    + `<div class="adbUpDate">最新 ${escapeHtml(fmtBuild(latest?.buildTime))}</div>`
    + '</div>'
    + `<div class="adbUpMeta">${status} · ${sizes}${doc}</div>`
    + blockedNote
    + largeNote
    + (it.hasUpdate ? changesHtml(it) : '')
    + msg
    + historyHtml(it)
    + '<div class="adbUpAct">' + action + '</div>'
    + `<div class="adbUpProg"${prog ? '' : ' hidden'}>`
    + '<div class="adbUpTrack"><i style="width:' + pct + '%"></i></div>'
    + '<div class="adbUpNums"><span class="pct">' + pct + '%</span>'
    + `<span class="bytes">${fmtBytes(it.received)} / ${fmtBytes(it.total)}</span>`
    + `<span class="speed">${it.speed > 0 ? fmtBytes(it.speed) + '/s' : ''}</span>`
    + `<button type="button" class="mini adbUpCancel" data-cancel="${escapeHtml(m.file)}">放棄</button>`
    + '</div></div>'
    + '</div>';
}

function renderDialog(): void {
  const list = dialogEl<HTMLElement>('adbUpdateList');
  const sub = dialogEl<HTMLElement>('adbUpdateSub');
  const status = dialogEl<HTMLElement>('adbUpdateStatus');
  const all = dialogEl<HTMLButtonElement>('adbUpdateAll');
  const tabUp = dialogEl<HTMLElement>('adbUpTabUpdates');
  const tabHist = dialogEl<HTMLElement>('adbUpTabHistory');
  const tabCount = dialogEl<HTMLElement>('adbUpTabCount');
  if (!list) return;
  const ups = updates();
  const blocked = items.filter((i) => !i.downloadable).length;
  if (sub) {
    sub.textContent = checking ? '檢查中…'
      : loadError ? loadError
        : `${ups.length} 個可以更新 · 已安裝 ${items.length} 個公開資料庫${blocked ? ` · ${blocked} 個施工中／需離線更新` : ''}`;
    sub.classList.toggle('err', !!loadError);
  }
  if (tabCount) tabCount.textContent = String(ups.length);
  tabUp?.classList.toggle('active', tab === 'updates');
  tabHist?.classList.toggle('active', tab === 'history');

  const shown = tab === 'history' ? items : ups;
  if (!shown.length) {
    list.innerHTML = checking
      ? '<p class="dim">正在讀版本清單…</p>'
      : loadError
        ? `<p class="dim">${escapeHtml(loadError)}</p><p class="dim">按「重新檢查」再試一次。</p>`
        : tab === 'history'
          ? '<p class="dim">這個資料夾裡沒有公開資料庫。</p>'
          : blocked
            ? `<p class="dim">沒有可下載的更新；有 ${blocked} 個資料庫施工中／超過 30 MB，按「版本記錄」可以看。</p>`
            : '<p class="dim">沒有需要更新的資料庫；按「版本記錄」可以看每一版的改變。</p>';
  } else {
    list.innerHTML = shown.map(rowHtml).join('');
  }
  if (status) {
    if (activeFile) {
      const it = items.find((i) => i.m.file === activeFile);
      status.textContent = it ? `正在下載《${it.m.name || it.m.file}》…（下載期間請不要編輯這個庫）` : '';
    } else if (notice) status.textContent = notice;
    else if (loadError) status.textContent = loadError;
    else if (tab === 'history') status.textContent = `${items.length} 個已安裝的公開資料庫；版本由新到舊，預設收合。`;
    else if (ups.length) status.textContent = '下載來源 ' + (manifestHost() || '官網') + '（設置 → 更新可切換鏡像）；按「放棄」隨時取消，原本的 adb 不會被更動。';
    else status.textContent = '';
  }
  if (all) {
    all.disabled = !ups.length || !!activeFile || queueRunning || tab !== 'updates';
    all.textContent = ups.length ? `全部更新（${ups.length}）` : '全部更新';
  }
}

/** 只更新某一列的進度（不重畫整個對話盒，捲動位置才不會跳）。 */
function paintProgress(it: UpdateItem): void {
  const row = document.querySelector<HTMLElement>(`.adbUpRow[data-file="${CSS.escape(it.m.file)}"]`);
  if (!row) return;
  const pct = it.total > 0 ? Math.min(100, Math.round(it.received / it.total * 100)) : 0;
  const bar = row.querySelector<HTMLElement>('.adbUpTrack i');
  if (bar) bar.style.width = pct + '%';
  const p = row.querySelector<HTMLElement>('.pct');
  if (p) p.textContent = pct + '%';
  const b = row.querySelector<HTMLElement>('.bytes');
  if (b) b.textContent = `${fmtBytes(it.received)} / ${fmtBytes(it.total)}`;
  const s = row.querySelector<HTMLElement>('.speed');
  if (s) s.textContent = it.speed > 0 ? fmtBytes(it.speed) + '/s' : '';
}

// ---- 下載 ----------------------------------------------------------------------

function downloadUrl(file: string): string {
  return manifestUrl.replace(/[^/]*$/, '') + encodeURIComponent(file);
}

/** manifest 所在站（下載 adb 也從同一站）。 */
function manifestHost(): string {
  try { return new URL(manifestUrl).host; } catch { return ''; }
}

/** 這份 manifest 若不是設定的那一站，試另一站的同名清單（選填）。 */
function alternateManifest(url: string): string {
  const base = url.replace(/manifest\.json$/, '');
  if (!isKnownMirrorBase(base)) return '';       // 測試／自架網址：不亂連正式站
  const other = base === MIRRORS.primary.base ? MIRRORS.overseas.base : MIRRORS.primary.base;
  return other + 'adb/manifest.json';
}

async function cancelActive(): Promise<void> {
  const it = items.find((i) => i.m.file === activeFile);
  if (!it?.downloadId) return;
  await desktopCancelAdbDownload(it.downloadId);
}

async function pollDownload(it: UpdateItem): Promise<void> {
  let lastAt = Date.now();
  let lastBytes = 0;
  for (;;) {
    await sleep(POLL_MS);
    if (!it.downloadId) return;
    const st = await desktopAdbDownloadStatus(it.downloadId);
    if (!st) {
      it.phase = 'error';
      it.error = '讀不到下載進度（程式可能重新啟動了）';
      return;
    }
    it.received = st.received;
    it.total = st.total || it.m.size;
    const now = Date.now();
    if (now - lastAt >= 300) {
      it.speed = Math.max(0, (st.received - lastBytes) * 1000 / (now - lastAt));
      lastAt = now;
      lastBytes = st.received;
    }
    paintProgress(it);
    if (st.state === 'done') { it.phase = 'done'; return; }
    if (st.state === 'cancelled') { it.phase = 'cancelled'; return; }
    if (st.state === 'error') { it.phase = 'error'; it.error = st.error || '更新失敗'; return; }
  }
}

/** 換檔成功後：更新 catalog、必要時重新開啟這個庫。 */
async function afterReplaced(it: UpdateItem): Promise<string> {
  const path = it.entry.file.path!;
  const fresh = (await desktopSources()).find((s) => samePath(s.path, path));
  if (fresh) replaceCatalogFile(path, fresh);
  const slot = openDbs.find((d) => samePath(d.file.path, path));
  if (slot && fresh) {
    // 更新的是「背景」的那個庫：不要把它切到前景。關掉舊 slot（它的 mmap 已被 Go
    // 解除），下次從清單開啟就會讀到新檔。
    if (activeSlot()?.id !== slot.id) {
      closeDb(slot.id);
      return '已更新（下次開啟時載入新版）';
    }
    // 更新的是目前這個庫：不先 closeDb——那會把介面清成「尚未開啟資料庫」，
    // 中間的文件分頁與閱讀位置也會消失。直接 openFile 新檔：庫名相同時
    // registerOpenDb 會取代舊 slot；庫名不同時再把舊 slot 收掉（新庫已 active）。
    const oldId = slot.id;
    const res = await openFile(fresh);
    if (res === 'opened') {
      const old = openDbs.find((d) => d.id === oldId);
      if (old) closeDb(oldId);
      return '已更新並重新載入';
    }
    return '已更新（請重新開啟這個庫）';
  }
  return '已更新';
}

async function startOne(file: string): Promise<void> {
  if (activeFile) return;
  const it = items.find((i) => i.m.file === file);
  if (!it || !it.hasUpdate || it.phase === 'downloading' || it.phase === 'done') return;
  const path = it.entry.file.path;
  if (!path) { it.phase = 'error'; it.error = '網頁版沒有宿主，不能自動換檔'; renderDialog(); return; }

  // 有未產生的修訂就先擋下來：更新會換掉檔案，修訂會跟著消失。
  const n = editCount(findSession(sourceKey(it.entry.file)));
  if (n > 0) {
    it.phase = 'error';
    it.error = `這個資料庫有 ${n} 頁修訂還沒存檔；請先按磁片圖示產生新的 adb，再更新。`;
    renderDialog();
    return;
  }

  it.phase = 'downloading';
  it.received = 0;
  it.total = it.m.size;
  it.speed = 0;
  it.error = '';
  activeFile = file;
  notice = '';
  renderDialog();
  try {
    const id = await desktopStartAdbDownload(
      downloadUrl(file), path, it.m.sha256 ?? '', it.m.size,
    );
    if (!id) throw new Error('宿主沒有回應');
    it.downloadId = id;
    await pollDownload(it);
    if (it.phase === 'done') {
      const how = await afterReplaced(it);
      it.phase = 'done';
      it.hasUpdate = false;
      it.localIndex = 0;                    // 換上的就是最新一版
      setStatusLine(`✓《${it.m.name || file}》${how}`);
      checkedAt = 0;                       // 下一次檢查重新讀清單
      renderDialog();
      paintButton();
      return;
    }
    if (it.phase === 'cancelled') setStatusLine('已放棄；原本的 adb 沒有更動。');
    else if (it.phase === 'error') setStatusLine('更新失敗：' + (it.error || ''));
  } catch (e) {
    it.phase = 'error';
    it.error = String((e as Error)?.message ?? e);
    setStatusLine('更新失敗：' + it.error);
  } finally {
    activeFile = '';
    it.downloadId = undefined;
    renderDialog();
  }
}

function setStatusLine(msg: string): void {
  notice = msg;
  const el = dialogEl<HTMLElement>('adbUpdateStatus');
  if (el) el.textContent = msg;
}

async function startAll(): Promise<void> {
  if (activeFile || queueRunning) return;
  const todo = bulkUpdates();
  if (!todo.length) {
    notice = '沒有小於 30 MB 的可更新庫；大型底座請個別按「下載整檔」。';
    renderDialog();
    return;
  }
  queueRunning = true;
  renderDialog();
  try {
    for (const it of todo) {
      if (!open) break;
      if (!it.hasUpdate || it.phase === 'done') continue;
      await startOne(it.m.file);
      if (it.hasUpdate) break;            // 取消或失敗：停在這裡，不要接著下一個
    }
  } finally {
    queueRunning = false;
    renderDialog();
  }
}

// ---- 接線 ----------------------------------------------------------------------

export function initAdbUpdate(): void {
  setDbTabsExtra(paintButton);
  dialogEl<HTMLElement>('adbUpdateClose')?.addEventListener('click', () => closeAdbUpdateDialog());
  dialogEl<HTMLElement>('adbUpdateBackdrop')?.addEventListener('click', () => closeAdbUpdateDialog());
  dialogEl<HTMLElement>('adbUpdateLater')?.addEventListener('click', () => closeAdbUpdateDialog());
  dialogEl<HTMLElement>('adbUpdateAll')?.addEventListener('click', () => { void startAll(); });
  dialogEl<HTMLElement>('adbUpdateCheck')?.addEventListener('click', () => { void checkAdbUpdates(true); });
  dialogEl<HTMLElement>('adbUpTabs')?.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-adbtab]')?.dataset.adbtab;
    if (t === 'updates' || t === 'history') {
      tab = t;
      renderDialog();
    }
  });
  const list = dialogEl<HTMLElement>('adbUpdateList');
  if (list) {
    list.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const up = t.closest<HTMLElement>('[data-up]')?.dataset.up;
      if (up) { void startOne(up); return; }
      const cancel = t.closest<HTMLElement>('[data-cancel]')?.dataset.cancel;
      if (cancel) { void cancelActive(); }
    });
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open) {
      ev.stopPropagation();
      closeAdbUpdateDialog();
    }
  }, true);
  window.setInterval(() => { void checkAdbUpdates(); }, RECHECK_MS);
  paintButton();
}

/** 診斷／測試用：不開對話盒也能直接觸發檢查。 */
export { paintButton as paintAdbUpdateButton };
