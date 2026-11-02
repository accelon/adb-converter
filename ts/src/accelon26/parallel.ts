/**
 * 平行段對讀（作者 2026-11-02）。
 *
 * 巴利藏的幾個庫用 `<段 n="12">` 當**跨庫對齊鍵**（同一個段號＝同一段原文的不同譯本）：
 * `ccc`（莊春江）、`cs-mm`（緬譯）、`hz`（杭州佛學院）、`kmj`（光明寺日譯）、
 * `pku`（法勝）、`sc`（SuttaCentral）、`xsq`（蕭式球）、`yh`（元亨）；`cs`、`cllk` 還沒做。
 *
 * 閱讀器看到 `<段 n="…">` 就長出一個可點的小晶片（`¶12`）；點它列出上表，
 * 選一個庫就打開那個庫的**同一個段**。
 *
 * 檔案怎麼找：已開啟的庫 → catalog（這個工作階段選過的）→ 桌面宿主 `ListAdbs`
 * （工作目錄／exe 旁）。都找不到就明確說「找不到 xxx.adb」並提示放在 exe 旁邊。
 */
import { AdbReader, type AdbSource } from './adb';
import { catalog, openCatalogEntry, openDbs, switchTo } from './dbs';
import { desktopSources } from './host';
import { mapper, openFile, reader, setStatus } from './viewer';
import { linkTo } from './link';
import { markLineRange, revealDocLine } from './doc-pane';
import { escapeHtml } from './viewer';

/** 同結構（同一個 `<段>` 編號系統）的庫；`ready:false` 是還沒做的 */
export interface ParallelDb {
  /** 檔名（不含 .adb） */
  file: string;
  label: string;
  ready: boolean;
}

export const PARALLEL_DBS: ParallelDb[] = [
  { file: 'ccc', label: '莊春江巴利藏中譯', ready: true },
  { file: 'cs-mm', label: '緬譯巴利藏', ready: true },
  { file: 'hz', label: '巴利佛典譯叢（杭州佛學院）', ready: true },
  { file: 'kmj', label: '光明寺日譯', ready: true },
  { file: 'pku', label: '法勝巴利佛典', ready: true },
  { file: 'sc', label: '巴利三藏（SuttaCentral）', ready: true },
  { file: 'xsq', label: '蕭式球譯四部尼柯耶', ready: true },
  { file: 'yh', label: '元亨南傳大藏經', ready: true },
  { file: 'cs', label: 'cs', ready: false },
  { file: 'cllk', label: 'cllk', ready: false },
];

const baseName = (n: string): string => n.replace(/\.adb$/i, '').toLowerCase();

/** 段號 → VA（每個 reader 只建一次） */
const segCache = new WeakMap<AdbReader, Map<string, number> | null>();

async function segmentIndex(r: AdbReader): Promise<Map<string, number> | null> {
  if (segCache.has(r)) return segCache.get(r)!;
  const tagsC = r.containers.get('tags');
  const ti = tagsC?.names.indexOf('段') ?? -1;
  if (!tagsC || ti < 0) { segCache.set(r, null); return null; }
  const av = await r.attributeValues('段.n').catch(() => null);
  if (!av || !av.pointers) { segCache.set(r, null); return null; }
  const vas = await r.decodeBlockList('tags', ti);
  const map = new Map<string, number>();
  for (let k = 0; k < av.values.length; k++) {
    const p = av.pointers[k];
    if (((p >>> 24) & 0xff) !== ti) continue;
    const va = vas[(p & 0xffffff) - 1];
    if (va == null) continue;
    const n = av.values[k];
    if (!map.has(n)) map.set(n, va);   // 同一個段號只取第一處
  }
  segCache.set(r, map);
  return map;
}

/** 這個庫有沒有 `<段>`（沒有的庫不長晶片、不進對讀） */
export async function hasSegments(r: AdbReader): Promise<boolean> {
  return !!(await segmentIndex(r));
}

/** 段號 → VA（找不到回 null） */
export async function segmentVa(r: AdbReader, n: string): Promise<number | null> {
  const idx = await segmentIndex(r);
  return idx?.get(n) ?? null;
}

/** 找出某個平行庫的檔案：已開啟 → catalog → 桌面宿主的清單 */
async function sourceOf(file: string): Promise<AdbSource | null> {
  const want = baseName(file);
  const slot = openDbs.find((d) => baseName(d.file.name) === want || d.name.toLowerCase() === want);
  if (slot) return slot.file;
  const e = catalog.find((x) => baseName(x.file.name) === want || (x.dbname ?? '').toLowerCase() === want);
  if (e) return e.file;
  const host = await desktopSources().catch(() => [] as AdbSource[]);
  return host.find((s) => baseName(s.name) === want) ?? null;
}

/** 目前開著的庫是不是這一個平行庫 */
function isCurrent(file: string): boolean {
  const want = baseName(file);
  return baseName(reader?.header.dbname ?? '') === want || baseName(openDbs.find((d) => d.id && d.core?.reader)?.file.name ?? '') === want;
}

/** 在 `file` 這個庫打開第 `n` 段 */
export async function openSegment(file: string, n: string): Promise<boolean> {
  const src = await sourceOf(file);
  if (!src) {
    setStatus(`找不到 ${file}.adb：請把它放在 exe 旁邊（或先用 📁 開啟一次）`, 'warn');
    return false;
  }
  // 已經開在同一庫同一段：不用重開
  if (reader && baseName(reader.header.dbname) === baseName(file)) {
    // 已開啟：直接跳
  } else {
    const slot = openDbs.find((d) => baseName(d.file.name) === baseName(file) || d.name.toLowerCase() === baseName(file));
    if (slot) switchTo(slot.id);
    else {
      const e = catalog.find((x) => baseName(x.file.name) === baseName(file));
      if (e) await openCatalogEntry(e);
      else await openFile(src);
    }
  }
  const r = reader;
  const m = mapper;
  if (!r || !m) return false;
  const va = await segmentVa(r, n);
  if (va == null) {
    setStatus(`${r.header.dbname} 沒有第 ${n} 段`, 'warn');
    return false;
  }
  await linkTo(va, '§' + n, 1, { mode: 'node', noMark: true, name: `第 ${n} 段` });
  const line = m.lineOfVa(va);
  // 段可能在這一頁之後（realm 是整個 `<檔>`）：先翻到那一行再塗色帶
  if (line >= 0) {
    await revealDocLine(line).catch(() => undefined);
    markLineRange(line, line);
  }
  setStatus(`${r.header.dbcname || r.header.dbname}：第 ${n} 段`, 'info');
  return true;
}

/* ------------------------------------------------------------------ 下拉 */

const MENU_ID = 'segMenu';
let menuFor = '';        // 「目前段號@錨點」用來判斷是否同一個晶片

function closeMenu(): void {
  document.getElementById(MENU_ID)?.remove();
  menuFor = '';
}

function menuEl(): HTMLElement {
  let el = document.getElementById(MENU_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = MENU_ID;
    el.className = 'segMenu';
    el.setAttribute('role', 'menu');
    document.body.appendChild(el);
  }
  return el;
}

/** 點 `<段>` 晶片：列出同結構的庫（作者 2026-11-02：先寫死這些） */
export function openSegmentMenu(anchor: HTMLElement, n: string): void {
  const key = n + '@' + (anchor.dataset.segKey ?? '');
  if (menuFor === key && document.getElementById(MENU_ID)) { closeMenu(); return; }
  const el = menuEl();
  menuFor = key;
  const cur = baseName(reader?.header.dbname ?? '');
  el.innerHTML = '<div class="segHead">第 ' + escapeHtml(n) + ' 段<span>選一個同結構的庫對讀</span></div>'
    + PARALLEL_DBS.map((d) => {
      const here = baseName(d.file) === cur;
      const cls = 'segRow' + (here ? ' cur' : '') + (d.ready ? '' : ' todo');
      return `<button type="button" class="${cls}" data-file="${escapeHtml(d.file)}" data-ready="${d.ready ? '1' : '0'}"`
        + (here || !d.ready ? ' aria-disabled="true"' : '') + '>'
        + `<span class="segName">${escapeHtml(d.label)}</span>`
        + `<span class="segFile">${escapeHtml(d.file)}.adb</span>`
        + (here ? '<span class="segTag">目前</span>' : d.ready ? '' : '<span class="segTag">還沒做</span>')
        + '</button>';
    }).join('');
  el.querySelectorAll<HTMLElement>('.segRow').forEach((row) => {
    row.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (row.getAttribute('aria-disabled') === 'true') return;
      const file = row.dataset.file ?? '';
      closeMenu();
      void openSegment(file, n);
    });
  });
  // 貼在晶片下方（寬度不夠就靠右）
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(r.bottom + 4) + 'px';
  el.hidden = false;
  anchor.dataset.segKey = key;
  // 點空白處／捲動／Esc 收起
  window.setTimeout(() => {
    const off = (ev: MouseEvent): void => {
      if ((ev.target as Element | null)?.closest?.('#' + MENU_ID) || (ev.target as Element | null)?.closest?.('.segChip')) return;
      closeMenu();
      document.removeEventListener('click', off, true);
    };
    document.addEventListener('click', off, true);
  }, 0);
}

let bound = false;

/** 文件區的委派監聽（只綁一次） */
export function initParallelSegments(): void {
  if (bound) return;
  bound = true;
  document.addEventListener('click', (ev) => {
    const chip = (ev.target as Element | null)?.closest?.('.segChip') as HTMLElement | null;
    if (!chip) return;
    ev.preventDefault();
    ev.stopPropagation();
    const n = chip.dataset.seg ?? '';
    if (n) openSegmentMenu(chip, n);
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.getElementById(MENU_ID)) { ev.stopPropagation(); closeMenu(); }
  }, true);
  document.addEventListener('scroll', () => { if (document.getElementById(MENU_ID)) closeMenu(); }, true);
  window.addEventListener('resize', () => { if (document.getElementById(MENU_ID)) closeMenu(); });
}
