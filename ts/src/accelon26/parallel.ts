/**
 * 平行段落對讀（作者 2026-11-02；2026-11-02 晚改成「由 adb 自己宣告平行群」）。
 *
 * 每個庫用 `<段 n="12">` 當**跨庫對齊鍵**（同一個段號＝同一段原文的不同譯本或不同語區）。
 * 閱讀器看到 `<段 n="…">` 就長出可點的小晶片（`¶12`），點它列出**同一群**的庫。
 *
 * 群怎麼決定（作者 2026-11-02 指示：不要寫死在程式裡）：
 *   每個 adb 的 `00.xml` 第一行是 `<檔 n="…"><集 …>…</集>…</檔>`，
 *   在 `<集>` 上宣告一個屬性 **`p`**＝**上游／基準庫的 dbname**：
 *
 *     ccc.adb   → <集 p="cs">       （莊春江譯，對齊上游 cs）
 *     cs.adb    → <集 p="cs">       （基準庫自己也寫自己的名字，表示「我是這一群的根」）
 *     sa.adb    → <集 p="sa">       （吠陀梵語原文是基準）
 *     en.adb    → <集 p="sa">
 *     zh.adb    → <集 p="sa">
 *
 *   群＝「`集.p` 相同的所有 adb」。同一個段號在不同群之間**沒有意義**，所以一定要分群，
 *   否則點《原人歌》的 ¶3 會冒出巴利三藏的譯本（2026-11-02 的實際 bug）。
 *
 * 沒有宣告 `p` 的舊庫：只有下面 `LEGACY_PALI` 這幾個（尚未重建的巴利譯本）沿用舊清單，
 * 其餘一律視為「沒有平行群」，晶片點下去會明說原因——不猜、不亂連。
 *
 * 檔案怎麼找：已開啟的庫 → catalog（這個工作階段選過的）→ 桌面宿主 `ListAdbs`
 * （工作目錄／exe 旁）。都找不到就明確說「找不到 xxx.adb」並提示放在 exe 旁邊。
 */
import { AdbReader, BlobIO, type AdbSource } from './adb';
import { catalog, openCatalogEntry, openDbs, switchTo } from './dbs';
import { desktopSources } from './host';
import { mapper, openFile, reader, setStatus } from './viewer';
import { linkTo } from './link';
import { markLineRange, revealDocLine } from './doc-pane';
import { escapeHtml } from './viewer';

/** 同結構（同一個 `<段>` 編號系統）的庫；`ready:false` 是還沒做的（只有舊清單在用） */
export interface ParallelDb {
  /** 檔名（不含 .adb） */
  file: string;
  label: string;
  ready: boolean;
}

/** 群組屬性：`<集 p="…">` */
export const GROUP_ATTR = '集.p';

/**
 * 舊庫的退路：這些 adb 還沒有 `<集 p>`（重建時才會寫進去），先照舊清單走，
 * 免得使用者手上的巴利譯本突然不能對讀。**只有這幾個名字會走退路。**
 */
export const LEGACY_PALI: ParallelDb[] = [
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

/** 舊名（給 ui.ts 的除錯 API 與相容用）；新程式請用 `parallelGroup()` */
export const PARALLEL_DBS = LEGACY_PALI;

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

/* ------------------------------------------------------------ 平行群 */

/** 一個群的成員 */
export interface GroupMember extends ParallelDb {
  /** 群根（dbname === 群鍵） */
  base?: boolean;
}

/** 讀一個 reader 的 `<集 p="…">`（沒有回空字串） */
export async function groupKeyOf(r: AdbReader): Promise<string> {
  const av = await r.attributeValues(GROUP_ATTR).catch(() => null);
  if (!av || !av.values) return '';
  for (const v of av.values) {
    const t = (v ?? '').trim();
    if (t) return t;
  }
  return '';
}

/** 探測結果快取（同一個 dbname 一個工作階段只開一次） */
const probeCache = new Map<string, { group: string; label: string } | null>();

/** 找一個庫的檔案：已開啟 → catalog → 桌面清單（同 sourceOf） */
async function probeOf(db: string): Promise<{ group: string; label: string } | null> {
  const key = baseName(db);
  if (probeCache.has(key)) return probeCache.get(key)!;
  let out: { group: string; label: string } | null = null;
  try {
    const live = openDbs
      .map((d) => (d.core as { reader?: AdbReader } | null | undefined)?.reader)
      .find((x): x is AdbReader => !!x && baseName(x.header.dbname ?? '') === key);
    if (live) {
      out = { group: await groupKeyOf(live), label: live.header.dbcname || live.header.dbname || key };
    } else {
      const src = await sourceOf(key);
      if (src) {
        const r = await AdbReader.open(new BlobIO(src));
        out = { group: await groupKeyOf(r), label: r.header.dbcname || r.header.dbname || key };
      }
    }
  } catch {
    out = null;
  }
  probeCache.set(key, out);
  return out;
}

/** 可能的候選庫（開著的、這個工作階段選過的、exe 旁邊的） */
async function candidateNames(): Promise<string[]> {
  const set = new Set<string>();
  for (const d of openDbs) set.add(baseName(d.file.name));
  for (const e of catalog) set.add(baseName(e.file.name));
  for (const s of await desktopSources().catch(() => [] as AdbSource[])) set.add(baseName(s.name));
  return [...set].filter(Boolean);
}

const groupCache = new Map<string, Promise<GroupMember[]>>();

/**
 * 解析目前的庫所屬的平行群。
 *
 * - 有 `<集 p="…">`：群＝所有宣告同一個 `p` 的庫（含根自己），根排最前面。
 * - 沒有 `p`、名字在 `LEGACY_PALI` 裡：回舊清單（`legacy:true`），讓還沒重建的巴利譯本照舊可用。
 * - 其他：回空清單 → 晶片會明說「這個庫沒有宣告平行群」，不會亂連到別的群。
 */
export async function parallelGroup(
  r: AdbReader,
  dbName?: string,
): Promise<{ key: string; legacy: boolean; members: GroupMember[] }> {
  const self = baseName(dbName || r.header.dbname || '');
  const key = await groupKeyOf(r);
  if (!key) {
    if (LEGACY_PALI.some((d) => baseName(d.file) === self)) {
      return { key: '', legacy: true, members: LEGACY_PALI.map((d) => ({ ...d })) };
    }
    return { key: '', legacy: false, members: [] };
  }
  const cached = groupCache.get(key);
  if (cached) return { key, legacy: false, members: await cached };
  const task = (async (): Promise<GroupMember[]> => {
    const names = new Set<string>([key, self, ...(await candidateNames())]);
    const members: GroupMember[] = [];
    for (const n of names) {
      if (!n) continue;
      if (n === self) {
        members.push({ file: self, label: r.header.dbcname || self, ready: true, base: self === key });
        continue;
      }
      const info = await probeOf(n);
      if (!info || info.group !== key) continue;
      members.push({ file: n, label: info.label || n, ready: true, base: n === key });
    }
    if (!members.some((m) => m.base)) {
      // 根不在手邊：列出來但標「找不到」，比默默消失好
      members.push({ file: key, label: key, ready: false, base: true });
    }
    members.sort((a, b) => Number(!!b.base) - Number(!!a.base) || a.label.localeCompare(b.label));
    return members;
  })();
  groupCache.set(key, task);
  return { key, legacy: false, members: await task };
}

/** 清掉探測快取（重建 adb 之後想立刻看到新宣告時用） */
export function invalidateParallelCache(): void {
  probeCache.clear();
  groupCache.clear();
}

/* ------------------------------------------------------------------ 下拉 */

const MENU_ID = 'segMenu';
let menuFor = '';        // 「目前段號@錨點」用來判斷是不是同一個晶片

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

/** 把選單貼在晶片下方（寬度不夠就靠右） */
function placeMenu(el: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(r.bottom + 4) + 'px';
  el.hidden = false;
}

/** 點 `<段>` 晶片：列出**同一個平行群**的庫（群由 `<集 p>` 宣告，不是寫死的清單） */
export async function openSegmentMenu(anchor: HTMLElement, n: string): Promise<void> {
  const key = n + '@' + (anchor.dataset.segKey ?? '');
  if (menuFor === key && document.getElementById(MENU_ID)) { closeMenu(); return; }
  const el = menuEl();
  menuFor = key;
  const r = reader;
  if (!r) return;
  const cur = baseName(r.header.dbname ?? '');
  el.innerHTML = `<div class="segHead">第 ${escapeHtml(n)} 段<span>正在找同群的庫…</span></div>`;
  placeMenu(el, anchor);

  let key2 = '';
  let legacy = false;
  let list: GroupMember[] = [];
  try {
    const g = await parallelGroup(r, r.header.dbname ?? '');
    key2 = g.key;
    legacy = g.legacy;
    list = g.members;
  } catch { /* 探測失敗就當沒有群 */ }
  if (menuFor !== key) return; // 使用者已經點了別處

  const head = legacy
    ? '選一個同結構的庫對讀'
    : key2
      ? `平行群「${escapeHtml(key2)}」`
      : '這個庫沒有宣告平行群';
  const hint = legacy
    ? '（舊清單：這個庫還沒宣告 &lt;集 p&gt;）'
    : key2
      ? '選一個庫，跳到同一個段'
      : '在 00.xml 的 &lt;集&gt; 加 p="上游 dbname"';

  const rows = list.length
    ? list.map((d) => {
        const here = baseName(d.file) === cur;
        const cls = 'segRow' + (here ? ' cur' : '') + (d.ready ? '' : ' todo');
        return `<button type="button" class="${cls}" data-file="${escapeHtml(d.file)}" data-ready="${d.ready ? '1' : '0'}"`
          + (here || !d.ready ? ' aria-disabled="true"' : '') + '>'
          + `<span class="segName">${escapeHtml(d.label)}</span>`
          + `<span class="segFile">${escapeHtml(d.file)}.adb</span>`
          + (here ? '<span class="segTag">目前</span>' : d.base ? '<span class="segTag">基準</span>' : d.ready ? '' : '<span class="segTag">找不到</span>')
          + '</button>';
      }).join('')
    : `<div class="segNote">這個庫沒有 &lt;集 p="…"&gt; 宣告，所以不知道要跟誰對讀。<br>例：&lt;集 p="sa"&gt;…&lt;/集&gt;（上游／基準庫的 dbname）。</div>`;

  el.innerHTML = `<div class="segHead">第 ${escapeHtml(n)} 段<span>${head} · ${hint}</span></div>${rows}`;

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
  placeMenu(el, anchor);
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
    if (n) void openSegmentMenu(chip, n);
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.getElementById(MENU_ID)) { ev.stopPropagation(); closeMenu(); }
  }, true);
  document.addEventListener('scroll', () => { if (document.getElementById(MENU_ID)) closeMenu(); }, true);
  window.addEventListener('resize', () => { if (document.getElementById(MENU_ID)) closeMenu(); });
}
