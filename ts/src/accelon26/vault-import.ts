/**
 * 「加入 Obsidian」：把一個 Obsidian vault（資料夾或 .zip）變成 .adb，就地加入閱讀器。
 *
 * 為什麼在瀏覽器裡做：同一份單檔 HTML 要能在 `file://`、http 與桌面版（Wails）都
 * 能轉，不能呼叫 Bun。索引器（src/index-builder.ts）、容器寫入器（adb-bytes.ts）與
 * bzip2 wasm（src/bzip2-wasm.ts）本來就為了「網頁版重建 adb」而打包進來了，這裡只是
 * 換一個入口：vault → XML 行（src/vault-plan.ts，與 CLI 共用）→ adb 位元組。
 *
 * 流程：選 vault → 讀檔 → 排好目錄（順便知道幾章幾字幾張圖）→ **問檔名** → 建庫 → 存檔。
 * 檔名由使用者輸入（`.adb` 可省略，中文也可以）；adb 檔頭裡的 dbname 只能是 ASCII，
 * 所以中文檔名會記成 `adb`，畫面上看到的庫名仍然是書名（dbcname）。
 *
 * 產物去哪裡：
 *   * 網頁版（file://／http）→ 觸發瀏覽器下載（預設落在「下載」資料夾），
 *     同時把這份 adb 加入本次工作階段的資料庫清單並打開。
 *   * 桌面版（Wails）→ 交給宿主寫到**執行檔旁邊**（main.AdbHost.SaveAdb），
 *     再重新列一次工作目錄，adb 清單立刻看得到。
 */
import { authorAdbBytes } from '../author-core';
import { bz2Compress } from '../bzip2-wasm';
import { inflateRaw } from '../inflate';
import { scanZip } from '../zip-dir';
import { planVault, type VaultFile, type VaultPlan } from '../vault-plan';
import { normalizeVaultName, suggestStem, type VaultFileName } from '../vault-name';
import { refreshHostDbs, setVaultAddHandlers } from './dbs';
import { desktopHost, desktopSaveAdb } from './host';
import { sha256Hex } from './sha256';
import { openFile, setStatus } from './viewer';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
let busy = false;
/** the last successful build (diagnostics: the smoke test compares it with the CLI) */
let lastBuild: { name: string; dbname: string; bytes: number; sha256: string; tokens: number; lines: number } | null = null;

/* ------------------------------------------------------------------ 檔名 */

/* ------------------------------------------------------------------ 問檔名 */

const $id = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/**
 * 顯示檔名對話框。回傳使用者輸入的字串（已通過 normalizeVaultName），取消回 null。
 * Enter＝建立、Esc＝取消；輸入時即時顯示「.adb 可省略」與庫名提示。
 */
export function askVaultName(opts: { title: string; suggested: string; summary?: string }): Promise<string | null> {
  const box = $id('vaultNameBox');
  const back = $id('vaultNameBackdrop');
  const input = $id<HTMLInputElement>('vaultNameInput');
  const hint = $id('vaultNameHint');
  const intro = $id('vaultNameIntro');
  const okBtn = $id<HTMLButtonElement>('vaultNameOk');
  const cancelBtn = $id<HTMLButtonElement>('vaultNameCancel');
  if (!box || !back || !input || !hint || !okBtn || !cancelBtn) return Promise.resolve(null);

  if (intro) {
    intro.textContent = opts.summary
      ? `${opts.title}：${opts.summary}。請輸入檔名（.adb 可省略）。`
      : `把「${opts.title}」轉成 .adb。請輸入檔名（.adb 可省略）。`;
  }
  input.value = opts.suggested;
  hint.className = '';
  hint.textContent = '';

  return new Promise<string | null>((resolve) => {
    let done = false;

    const liveHint = (): void => {
      const n = normalizeVaultName(input.value);
      if (!input.value.trim()) { hint.className = ''; hint.textContent = '　'; return; }
      if (!n) { hint.className = 'err'; hint.textContent = '檔名不能只用符號'; return; }
      hint.className = '';
      // 中文檔名：檔頭只存 ASCII，說清楚庫名會變成什麼
      hint.textContent = n.dbname === n.stem
        ? `會寫出 ${n.file}`
        : `會寫出 ${n.file}；adb 檔頭（庫名）只存英數，這裡記為「${n.dbname}」`;
    };

    const close = (value: string | null): void => {
      if (done) return;
      done = true;
      box.hidden = true;
      back.hidden = true;
      input.oninput = null;
      input.onkeydown = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      back.onclick = null;
      box.onkeydown = null;
      resolve(value);
    };

    const submit = (): void => {
      const n = normalizeVaultName(input.value);
      if (!n) { hint.className = 'err'; hint.textContent = '請輸入檔名（例如 lunyu）'; input.focus(); return; }
      close(input.value);
    };

    input.oninput = liveHint;
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); submit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(null); }
    };
    okBtn.onclick = (ev) => { ev.preventDefault(); submit(); };
    cancelBtn.onclick = (ev) => { ev.preventDefault(); close(null); };
    back.onclick = () => close(null);
    // Esc 在對話框任何位置都算取消（焦點可能在按鈕上）
    box.onkeydown = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(null); }
    };

    box.hidden = false;
    back.hidden = false;
    liveHint();
    input.focus();
    input.select();
  });
}

/* ------------------------------------------------------------------ 讀 vault */

async function readVaultZip(file: File): Promise<{ files: VaultFile[]; label: string; hint: string }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = scanZip(buf);
  const files: VaultFile[] = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const parts = e.name.split('/');
    const rel = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
    if (!rel || rel.split('/').some((p) => p === '.obsidian' || p === '.git' || p === '.trash')) continue;
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    const payload = buf.subarray(e.dataStart, e.dataStart + e.compSize);
    const bytes = e.method === 8 ? inflateRaw(payload) : payload.slice();
    if (ext === '.md') files.push({ path: rel, text: new TextDecoder('utf-8').decode(bytes) });
    else if (IMAGE_EXT.has(ext)) files.push({ path: rel, bytes });
  }
  const tops = new Set(entries.map((e) => e.name.split('/')[0]));
  const label = tops.size === 1 ? [...tops][0] : file.name.replace(/\.zip$/i, '');
  return { files, label, hint: file.name };
}

async function readVaultDir(list: FileList): Promise<{ files: VaultFile[]; label: string; hint: string }> {
  const files: VaultFile[] = [];
  let label = '';
  for (const f of Array.from(list)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (!label) label = rel.split('/')[0];
    if (rel.split('/').some((p) => p === '.obsidian' || p === '.git')) continue;
    const inner = rel.split('/').length > 1 ? rel.split('/').slice(1).join('/') : rel;
    const ext = inner.slice(inner.lastIndexOf('.')).toLowerCase();
    if (ext === '.md') files.push({ path: inner, text: await f.text() });
    else if (IMAGE_EXT.has(ext)) files.push({ path: inner, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return { files, label: label || 'Obsidian', hint: '' };
}

/* ------------------------------------------------------------------ 建庫與存檔 */

function download(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes.slice()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke late: Chromium starts the download synchronously but reads the blob after
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function buildAndSave(plan: VaultPlan, title: string, name: VaultFileName, t0: number): Promise<void> {
  const st = plan.stats;
  setStatus(`加入 Obsidian：${st.chapters} 章、${st.entries} 字、${st.images} 張圖 → ${name.file}，開始建索引…`);
  for (const w of plan.warnings.slice(0, 3)) console.warn('[obsidian]', w);

  const out = await authorAdbBytes({
    dbname: name.dbname,
    dbcname: title,
    lines: plan.lines,
    resources: plan.resources,
    compress: (b) => bz2Compress(b, 9),
    onProgress: (phase, done, total) => setStatus(`加入 Obsidian（${name.file}）：${phase} ${done}/${total}`),
  });
  const bytes = out.bytes;
  lastBuild = { name: name.file, dbname: name.dbname, bytes: bytes.length, sha256: await sha256Hex(bytes), tokens: out.tokens, lines: out.lines };

  const host = await desktopHost();
  const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
  if (host) {
    // 桌面版：寫到執行檔旁邊，然後重列工作目錄（「更新 adb 清單」）
    const res = await desktopSaveAdb(name.file, bytes);
    if (res && res.ok && res.path) {
      const srcs = await refreshHostDbs();
      const target = srcs.find((s) => s.path && res.path && s.path.toLowerCase() === res.path.toLowerCase())
        ?? srcs.find((s) => s.name === title);
      if (target) await openFile(target);
      setStatus(
        `已存到執行檔旁：${res.path}（${st.chapters} 章、${st.entries} 字、${st.images} 張圖，${secs()} 秒）` +
          (res.note ? '｜' + res.note : ''),
        'info',
      );
    } else {
      setStatus('寫入失敗：' + (res?.error ?? '宿主沒有回應'), 'err');
    }
    return;
  }
  // 網頁版：下載（預設落在「下載」資料夾），並把這一份加入清單直接開起來
  download(bytes, name.file);
  const file = new File([bytes.slice()], name.file, { type: 'application/octet-stream', lastModified: Date.now() });
  await openFile(file);
  setStatus(
    `已下載 ${name.file}（${st.chapters} 章、${st.entries} 字、${st.images} 張圖，` +
      `${(bytes.length / 1048576).toFixed(2)} MiB，${secs()} 秒）；已加入 adb 清單並開啟`,
    'info',
  );
}

/** 讀完 → 問檔名 → 建庫。取消就什麼都不寫。 */
async function importVault(loaded: { files: VaultFile[]; label: string; hint: string }): Promise<void> {
  // 瀏覽器的檔案選擇有時會把同一次選擇觸發兩次 change：第二次直接略過（不要閃提示）
  if (busy) { console.warn('[obsidian] import already running, ignoring the second trigger'); return; }
  busy = true;
  const t0 = performance.now();
  try {
    setStatus('加入 Obsidian：整理筆記與圖片…');
    const title = loaded.label.replace(/《|》/g, '') || 'Obsidian';
    const plan = planVault(loaded.files, { title, allImages: true });
    const st = plan.stats;
    const raw = await askVaultName({
      title,
      suggested: suggestStem(loaded.label, loaded.hint),
      summary: `${st.chapters} 章、${st.entries} 字、${st.images} 張圖`,
    });
    if (raw === null) { setStatus('已取消「加入 Obsidian」', 'info'); return; }
    const name = normalizeVaultName(raw);
    if (!name) { setStatus('檔名無效，已取消', 'err'); return; }
    await buildAndSave(plan, title, name, t0);
  } catch (e) {
    setStatus('加入 Obsidian 失敗：' + ((e as Error)?.message ?? String(e)), 'err');
    console.error(e);
  } finally {
    busy = false;
  }
}

/** wire the 📁 menu rows and the two hidden inputs (called once from boot) */
export function initVaultImport(): void {
  setVaultAddHandlers({
    dir: () => {
      const input = document.getElementById('vaultDir') as HTMLInputElement | null;
      if (!input) return;
      input.value = '';
      input.click();
    },
    zip: () => {
      const input = document.getElementById('vaultZip') as HTMLInputElement | null;
      if (!input) return;
      input.value = '';
      input.click();
    },
  });

  const zipInput = document.getElementById('vaultZip') as HTMLInputElement | null;
  if (zipInput) {
    zipInput.addEventListener('change', () => {
      const f = zipInput.files?.[0];
      if (!f) return;
      setStatus('加入 Obsidian：讀取 ' + f.name + '…');
      void readVaultZip(f).then(importVault).catch((e) => setStatus('讀取 zip 失敗：' + e.message, 'err'));
    });
  }

  const dirInput = document.getElementById('vaultDir') as HTMLInputElement | null;
  if (dirInput) {
    dirInput.addEventListener('change', () => {
      const list = dirInput.files;
      if (!list || !list.length) return;
      setStatus('加入 Obsidian：讀取資料夾…');
      void readVaultDir(list).then(importVault).catch((e) => setStatus('讀取資料夾失敗：' + e.message, 'err'));
    });
  }
}

/** diagnostics for the smoke test */
export function vaultImportState(): { busy: boolean; last: typeof lastBuild; dialogOpen: boolean } {
  const box = document.getElementById('vaultNameBox');
  return { busy, last: lastBuild, dialogOpen: !!box && !box.hidden };
}
