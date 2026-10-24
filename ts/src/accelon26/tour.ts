/**
 * 操作導覽的播放器（作者 2026-10）。
 *
 * 一份劇本＝若干場景；每個場景＝一段說明文字 ＋ 一串指令。播放器把宏（`tour-data.ts`
 * 的 base64，見 `tour-format.ts`）解開，**照著做給使用者看**：
 *
 *   * 聚光燈（`#tourSpot`）壓暗全螢幕、只留目標那塊亮著；
 *   * 說明氣泡（`#tourBubble`）在下緣（目標在下半部時翻到上緣）；
 *   * 每一步之間**等條件成立**才往下走（不是固定 sleep）——開庫、目錄樹、
 *     清單分批掛載都是非同步的，固定 sleep 在慢機器上就是隨機失敗；
 *   * 一個場景做完就停住，由使用者按「下一個場景 →」決定要不要繼續。
 *
 * 這支不 import 任何面板模組（避免 ui → tour → ui 的循環）：需要的操作由
 * `initTour(app)` 注入，見 `ui.ts` 的 `TOUR_APP`。它只碰 DOM、localStorage、
 * 以及 `app.state()`（`api:` 條件用）。
 */
import { TOUR_BLOBS, TOUR_INDEX } from './tour-data';
import {
  decodeTour, fromBase64, OP,
  type Scene, type Step, type Tour, type TourMeta,
} from './tour-format';

/** ui.ts 注入的操作面（播放器只知道「有這些動作」，不知道它們怎麼實作） */
export interface TourApp {
  tab(col: 'L' | 'R', name: string): void;
  side(col: 'L' | 'R', on: boolean): void;
  /** 設定項；回傳 false ＝ 這個鍵不認得 */
  set(key: string, value: string): boolean;
  /** 白名單函式（openSettings / runSearchAll / dictLookup …） */
  call(name: string, arg: string): unknown;
  /** `__accelon26.state()` 的即時快照（`api:` 條件讀它） */
  state(): Record<string, unknown>;
}

type Phase = 'idle' | 'running' | 'waiting' | 'paused' | 'done';
type Wait = 'none' | 'next' | 'user' | 'cond' | 'pause';

const PKEY = (id: string) => `accelon26.tour.${id}`;

let app: TourApp | null = null;
let cur: { id: string; tour: Tour; scene: number; step: number } | null = null;
let seq = 0;
let phase: Phase = 'idle';
let waitKind: Wait = 'none';
let note = '';
let pointSel: string | null = null;
let failed: { scene: number; step: number; msg: string }[] = [];
/** 目前掛著的「等你決定」promise（按鈕點下去就 resolve） */
let pending: ((v: string) => void) | null = null;
let userDone = false;
let skipReq = false;
/** `停` 那一步被點到了嗎（作者 2026-10-18：點畫面任何地方就往下走） */
let tapped = false;
let raf = 0;
const cache = new Map<string, Tour>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/** querySelector 的安全版（選擇器寫錯不該讓整場導覽炸掉） */
function q(sel: string): HTMLElement | null {
  try { return document.querySelector<HTMLElement>(sel); } catch { return null; }
}

/** 元素「看得到」嗎：有面積、不是 visibility:hidden（在收起的欄／分頁裡就是 false） */
function visible(e: Element | null): boolean {
  if (!e) return false;
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
}

// ---------------------------------------------------------------- 條件語法
/** `api:路徑[=值]` / `count:選擇器 [op n]` / `text:選擇器=文字` / 選擇器；`!` 前置＝否定 */
export function evalCond(cond: string): boolean {
  let c = cond.trim();
  let neg = false;
  if (c.startsWith('!')) { neg = true; c = c.slice(1).trim(); }
  let yes = false;
  try {
    yes = atom(c);
  } catch {
    // 選擇器寫壞（`querySelectorAll` 會丟）不該讓整份導覽掛掉：當成「還沒成立」
    yes = false;
  }
  return neg ? !yes : yes;
}

function atom(c: string): boolean {
  if (c.startsWith('api:')) {
    const body = c.slice(4);
    const eq = body.indexOf('=');
    const path = (eq < 0 ? body : body.slice(0, eq)).trim();
    const want = eq < 0 ? null : body.slice(eq + 1).trim();
    let v: unknown;
    try {
      v = path.split('.').reduce<unknown>(
        (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), app?.state() ?? {},
      );
    } catch { v = undefined; }
    return want === null ? !!v : String(v) === want;
  }
  if (c.startsWith('count:')) {
    const m = /^(.*?)\s*(>=|<=|==|!=|>|<)\s*(\d+)$/.exec(c.slice(6).trim());
    if (m) {
      const n = document.querySelectorAll(m[1]).length;
      const k = Number(m[3]);
      switch (m[2]) {
        case '>=': return n >= k;
        case '<=': return n <= k;
        case '==': return n === k;
        case '!=': return n !== k;
        case '>': return n > k;
        default: return n < k;
      }
    }
    try { return document.querySelectorAll(c.slice(6).trim()).length > 0; } catch { return false; }
  }
  if (c.startsWith('text:')) {
    const body = c.slice(5);
    const eq = body.indexOf('=');
    if (eq < 0) return false;
    const e = q(body.slice(0, eq).trim());
    return !!e && (e.textContent ?? '').includes(body.slice(eq + 1).trim());
  }
  return visible(q(c));
}

// ------------------------------------------------------------------- 載入
function load(id: string): Tour | null {
  let t = cache.get(id);
  if (t) return t;
  const b64 = TOUR_BLOBS[id];
  if (!b64) return null;
  try {
    t = decodeTour(fromBase64(b64));
    cache.set(id, t);
    return t;
  } catch (e) {
    console.error('[tour] 宏解不開', e);
    return null;
  }
}

/** 上次看到第幾個場景（0 起算；沒有記錄＝0） */
export function tourProgress(id: string): number {
  try { return Math.max(0, Number(localStorage.getItem(PKEY(id)) ?? '0') || 0); } catch { return 0; }
}

function saveProgress(scene: number): void {
  if (!cur) return;
  try { localStorage.setItem(PKEY(cur.id), String(scene)); } catch { /* 無痕模式 */ }
}

// ------------------------------------------------------------------ 氣泡／聚光燈
const mdLite = (src: string): string => src
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .split(/\n{2,}/)
  .map((p) => '<p>' + p.replace(/\n/g, '<br>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>') + '</p>')
  .join('');

function setText(md: string): void {
  const e = el('tourText');
  if (e) e.innerHTML = mdLite(md);
}

function setNote(msg: string): void {
  note = msg;
  const e = el('tourNote');
  if (e) {
    e.textContent = msg;
    e.hidden = !msg;
  }
}

function pointAt(sel: string | null): void {
  pointSel = sel;
  layout();
}

/** 每一步都要重算：目標可能有動（捲動、清單延遲掛載、字級改變） */
function layout(): void {
  const spot = el('tourSpot');
  const bubble = el('tourBubble');
  if (!spot || !bubble || bubble.hidden) return;
  const target = pointSel ? q(pointSel) : null;
  const r = target ? target.getBoundingClientRect() : null;
  const has = !!r && r.width > 0 && r.height > 0;
  spot.hidden = !has;
  if (has && r) {
    const pad = 4;
    spot.style.left = Math.round(r.left - pad) + 'px';
    spot.style.top = Math.round(r.top - pad) + 'px';
    spot.style.width = Math.round(r.width + pad * 2) + 'px';
    spot.style.height = Math.round(r.height + pad * 2) + 'px';
    // 目標在下半部 → 氣泡翻到上緣，免得蓋住它
    const lower = r.top + r.height / 2 > window.innerHeight / 2;
    bubble.style.top = lower ? '18px' : '';
    bubble.style.bottom = lower ? '' : '18px';
  } else {
    bubble.style.top = '';
    bubble.style.bottom = '18px';
    if (pointSel) {
      if (!note.startsWith('⚠ 找不到')) setNote(`⚠ 找不到「${pointSel}」，或它目前看不到`);
    }
  }
  // 目標找到了就把「找不到」的提醒收掉（它可能只是慢一步掛上來）
  if (has && note.startsWith('⚠ 找不到')) setNote('');
}

function startRaf(): void {
  if (raf) return;
  const tick = (): void => { raf = requestAnimationFrame(tick); layout(); };
  raf = requestAnimationFrame(tick);
}

function stopRaf(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function showBubble(on: boolean): void {
  const b = el('tourBubble');
  if (b) b.hidden = !on;
  if (!on) {
    const s = el('tourSpot');
    if (s) s.hidden = true;
    stopRaf();
    return;
  }
  startRaf();
}

// -------------------------------------------------------------------- 按鈕
function show(id: string, on: boolean, label?: string): void {
  const b = el<HTMLButtonElement>(id);
  if (!b) return;
  b.hidden = !on;
  if (on && label) b.textContent = label;
}

function updateUi(): void {
  if (!cur) return;
  const sc = cur.tour.scenes[cur.scene];
  const where = el('tourWhere');
  if (where) where.textContent = `場景 ${cur.scene + 1} / ${cur.tour.scenes.length}`;
  const title = el('tourTitle');
  if (title) title.textContent = sc.title;
  const prog = el('tourProg');
  if (prog) prog.textContent = `${Math.min(cur.step, sc.steps.length)} / ${sc.steps.length}`;
  const last = cur.scene >= cur.tour.scenes.length - 1;
  show('tourNext', waitKind === 'next', last ? '完成 ✓' : '下一個場景 →');
  show('tourDone', waitKind === 'user');
  show('tourSkip', waitKind === 'user' || waitKind === 'cond' || waitKind === 'pause',
    waitKind === 'pause' ? '略過這步' : waitKind === 'cond' ? '略過等待' : '略過這步');
  show('tourReplay', waitKind !== 'none');
  // 作者 2026-10-18：「上一個場景」永遠在（第一個場景只是不能按），
  // 讓使用者隨時可以回頭看
  const prev = el<HTMLButtonElement>('tourPrev');
  if (prev) { prev.hidden = false; prev.disabled = cur.scene === 0; }
  const bubble = el('tourBubble');
  if (bubble) bubble.classList.toggle('paused', waitKind === 'pause');
}

function beginScene(sc: Scene): void {
  setText(sc.body);
  const title = el('tourTitle');
  if (title) title.textContent = sc.title;
  setNote('');
  pointSel = null;
  waitKind = 'none';
  phase = 'running';
  updateUi();
  layout();
}

/** 中斷目前掛著的等待（換場景／結束時叫） */
function interrupt(): void {
  const p = pending;
  pending = null;
  if (p) p('stop');
  userDone = false;
  skipReq = false;
}

function ask(kind: Wait): Promise<string> {
  waitKind = kind;
  phase = kind === 'next' ? 'waiting' : 'running';
  updateUi();
  return new Promise<string>((res) => { pending = (v) => { pending = null; res(v); }; });
}

function fail(msg: string): 'pause' {
  note = msg;
  if (cur) failed.push({ scene: cur.scene, step: cur.step, msg });
  setNote(msg);
  return 'pause';
}

// ------------------------------------------------------------------- 執行
async function exec(st: Step, my: number): Promise<'ok' | 'skip' | 'pause'> {
  const a = st.args;
  switch (st.op) {
    case OP.text:
      setText(a[0]);
      return 'ok';
    case OP.point:
      pointAt(a[0]);
      return 'ok';
    case OP.unpoint:
      pointAt(null);
      return 'ok';
    case OP.click: {
      const e = q(a[0]);
      if (!visible(e)) return fail(`找不到「${a[0]}」（或它目前看不到）`);
      e!.click();
      await sleep(60);
      return 'ok';
    }
    case OP.type: {
      const e = q(a[0]) as HTMLInputElement | null;
      if (!e) return fail(`找不到輸入框「${a[0]}」`);
      e.focus();
      e.value = a[1] ?? '';
      e.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(60);
      return 'ok';
    }
    case OP.key: {
      const target = a[1] ? q(a[1]) : document.activeElement;
      if (!target) return fail(`找不到「${a[1] ?? '目前焦點'}」`);
      target.dispatchEvent(new KeyboardEvent('keydown', { key: a[0], bubbles: true, cancelable: true }));
      await sleep(60);
      return 'ok';
    }
    case OP.wait:
      await sleep(Number(a[0]) || 0);
      return 'ok';
    case OP.waitFor:
      return waitCond(a[0], Number(a[1]) || 5000, my);
    case OP.tab:
      app?.tab(a[0] as 'L' | 'R', a[1]);
      await sleep(120);
      return 'ok';
    case OP.side:
      app?.side(a[0] as 'L' | 'R', a[1] === 'on');
      await sleep(120);
      return 'ok';
    case OP.set:
      if (!app?.set(a[0], a[1] ?? '')) return fail(`不認得的設定「${a[0]}」`);
      await sleep(120);
      return 'ok';
    case OP.call:
      try {
        await app?.call(a[0], a[1] ?? '');
      } catch (e) {
        return fail(`${a[0]} 失敗：${(e as Error)?.message ?? e}`);
      }
      return 'ok';
    case OP.user:
      return waitUser(a[0], a[1] ?? '', my);
    case OP.tap:
      return waitTap(a[0] ?? '', my);
    case OP.require:
      return waitCond(a[0], 120000, my, `需要：${a[0]}`);
    case OP.skipIf:
      if (evalCond(a[0])) { note = `（本場景不適用：${a[0]}）`; return 'skip'; }
      return 'ok';
    default:
      return fail(`未知指令 ${st.op}`);
  }
}

/** 輪詢到條件成立；使用者可以按「略過」 */
async function waitCond(cond: string, timeout: number, my: number, hint = ''): Promise<'ok' | 'pause'> {
  if (evalCond(cond)) return 'ok';
  waitKind = 'cond';
  updateUi();
  const t0 = performance.now();
  while (my === seq) {
    if (skipReq) { skipReq = false; setNote(`（跳過等待：${cond}）`); return 'ok'; }
    if (evalCond(cond)) { setNote(''); return 'ok'; }
    const waited = performance.now() - t0;
    if (waited > timeout) return fail(`等不到「${cond}」（${Math.round(timeout)} ms）`);
    setNote(`${hint || '等'}：${cond}…`);
    await sleep(100);
  }
  return 'ok';
}

/** 等使用者自己做完（或條件先成立） */
async function waitUser(text: string, cond: string, my: number): Promise<'ok' | 'pause'> {
  setText(text);
  if (cond && evalCond(cond)) { setText(text); return 'ok'; }
  waitKind = 'user';
  updateUi();
  while (my === seq) {
    if (userDone) { userDone = false; return 'ok'; }
    if (skipReq) { skipReq = false; return 'ok'; }
    if (cond && evalCond(cond)) return 'ok';
    await sleep(120);
  }
  return 'ok';
}

/**
 * 停在這裡，等使用者**在畫面任何地方點一下**（作者 2026-10-18）。
 *
 * 為什麼要有這一步：介紹介面的場景如果自動跑完，小白根本來不及看第二眼。
 * 這一種等待沒有按鈕可以按（就只有「點畫面任何地方」），所以氣泡會寫一行提示；
 * 鍵盤的空白／→／Enter 也算（`onKey` 會設 `tapped`）。
 */
async function waitTap(hint: string, my: number): Promise<'ok'> {
  tapped = false;
  waitKind = 'tap';
  setNote(hint || '（點畫面任何地方，或按空白鍵，繼續）');
  updateUi();
  while (my === seq) {
    if (tapped) { tapped = false; setNote(''); return 'ok'; }
    await sleep(80);
  }
  return 'ok';
}

// ------------------------------------------------------------------ 主流程
/**
 * 從第 `from` 個場景開始播（省略＝從上次看到的地方接）。
 * 換場景／重播都是「重新開一場」，不維護半途的堆疊：導覽不需要更深的状态機。
 */
export async function play(id: string, from?: number): Promise<void> {
  if (!app) return;
  const tour = load(id);
  if (!tour) { openTourMenu(); return; }
  interrupt();
  seq++;
  const my = seq;
  const start = Math.max(0, Math.min(from ?? tourProgress(id), tour.scenes.length - 1));
  cur = { id, tour, scene: start, step: 0 };
  failed = [];
  note = '';
  closeTourMenu();
  showBubble(true);
  // 播放器自己理論上不會丟（每一種失敗都在 exec 裡接住），但真的丟了也要看得到，
  // 不能變成一個沒人處理的 rejected promise。
  loop(my).catch((e) => {
    if (my !== seq) return;
    fail(`導覽中斷：${(e as Error)?.message ?? e}`);
    phase = 'paused';
    waitKind = 'pause';
    updateUi();
  });
}

async function loop(my: number): Promise<void> {
  outer: while (my === seq && cur) {
    const sc = cur.tour.scenes[cur.scene];
    if (!sc) { finish(); return; }
    beginScene(sc);
    while (cur.step < sc.steps.length) {
      const r = await exec(sc.steps[cur.step], my);
      if (my !== seq) return;
      if (r === 'skip') { cur.scene++; cur.step = 0; continue outer; }
      if (r === 'pause') {
        const act = await ask('pause');
        if (my !== seq) return;
        if (act === 'stop') return stopTour();
        if (act === 'replay') { cur.step = 0; beginScene(sc); updateUi(); continue; }
        // 'next'（＝略過這步）
      }
      cur.step++;
      updateUi();
    }
    // 一個場景做完：停住，等使用者決定
    phase = 'waiting';
    waitKind = 'next';
    setText(sc.body);
    setNote('');
    saveProgress(cur.scene);
    updateUi();
    const act = await ask('next');
    if (my !== seq) return;
    if (act === 'stop') return stopTour();
    if (act === 'replay') { void play(cur.id, cur.scene); return; }
    if (act === 'prev') { void play(cur.id, Math.max(0, cur.scene - 1)); return; }
    cur.scene++;
    cur.step = 0;
  }
  if (cur) cur.scene = cur.tour.scenes.length;
}

function finish(): void {
  phase = 'done';
  waitKind = 'next';
  pointSel = null;
  layout();
  const title = el('tourTitle');
  if (title) title.textContent = '導覽結束';
  setText('這些都可以在設置（🔧）裡隨時改回來。想再看一次：左上角 **accelon26** →「▶ 操作導覽」。');
  setNote('');
  if (cur) saveProgress(cur.tour.scenes.length - 1);
  const next = el<HTMLButtonElement>('tourNext');
  if (next) { next.hidden = false; next.textContent = '再看一次'; }
  show('tourDone', false);
  show('tourSkip', false);
  show('tourReplay', false);
  const prev = el<HTMLButtonElement>('tourPrev');
  if (prev) prev.hidden = true;
  pending = null;
}

export function stopTour(): void {
  interrupt();
  seq++;
  cur = null;
  phase = 'idle';
  waitKind = 'none';
  note = '';
  pointSel = null;
  showBubble(false);
}

// ------------------------------------------------------------------- 選單
function renderMenu(): void {
  const list = el('tourList');
  if (!list) return;
  list.innerHTML = TOUR_INDEX.map((t: TourMeta) => {
    const done = tourProgress(t.id);
    const label = done > 0 && done < t.scenes ? `繼續（${done + 1} / ${t.scenes}）` : '開始';
    return `<div class="tourRow" data-id="${t.id}">`
      + `<div class="tourName">${t.title}</div>`
      + `<div class="tourIntro">${t.intro}</div>`
      + `<div class="tourMeta">${t.scenes} 個場景 · ${t.steps} 步${t.require ? ' · 需要 ' + t.require : ''}</div>`
      + `<div class="tourActs"><button type="button" class="primary" data-play="1">${label}</button>`
      + (done > 0 ? '<button type="button" data-restart="1">從頭</button>' : '')
      + '</div></div>';
  }).join('');
  list.querySelectorAll<HTMLElement>('.tourRow').forEach((row) => {
    const id = row.dataset.id ?? '';
    row.querySelector<HTMLElement>('[data-play]')?.addEventListener('click', () => { void play(id); });
    row.querySelector<HTMLElement>('[data-restart]')?.addEventListener('click', () => { void play(id, 0); });
  });
}

export function openTourMenu(): void {
  if (cur) stopTour();          // 播放中再開選單 ＝ 先收掉導覽，再挑一份
  const box = el('tourBox');
  const back = el('tourBackdrop');
  if (box) box.hidden = false;
  if (back) back.hidden = false;
  renderMenu();
}

/**
 * 「關於」裡的「▶ 操作導覽」（作者 2026-10-18：入口從頂欄的 🎬 搬進來）。
 * 只有一份劇本就直接播（從上次看到的地方接），多份才開選單讓使用者挑。
 */
export function startTour(restart = false): void {
  const first = TOUR_INDEX[0];
  if (TOUR_INDEX.length === 1 && first) void play(first.id, restart ? 0 : undefined);
  else openTourMenu();
}

export function closeTourMenu(): void {
  const box = el('tourBox');
  const back = el('tourBackdrop');
  if (box) box.hidden = true;
  if (back) back.hidden = true;
}

export function tourMenuOpen(): boolean {
  return el('tourBox')?.hidden === false;
}

// -------------------------------------------------------------------- 鍵盤
const modalOpen = (): boolean => ['settingsBox', 'allSearchBox', 'aboutBox']
  .some((id) => el(id)?.hidden === false);

function onKey(ev: KeyboardEvent): void {
  // 有彈窗時讓彈窗自己處理 Esc（導覽不搶）
  if (ev.key === 'Escape') {
    if (modalOpen()) return;
    if (tourMenuOpen()) { ev.preventDefault(); ev.stopPropagation(); closeTourMenu(); return; }
    if (cur) { ev.preventDefault(); ev.stopPropagation(); stopTour(); }
    return;
  }
  if (!cur) return;
  if (ev.key === 'ArrowRight' || ev.key === ' ' || ev.key === 'Enter') {
    // `停` 那一步：空白／→／Enter 也算「點了一下畫面」
    if (waitKind === 'tap') {
      ev.preventDefault();
      ev.stopPropagation();
      tapped = true;
      return;
    }
    if (waitKind !== 'next') return;
    ev.preventDefault();
    ev.stopPropagation();
    if (phase === 'done') void play(cur.id, 0);
    else pending?.('next');
    return;
  }
  if (ev.key === 'ArrowLeft' && cur.scene > 0) {
    ev.preventDefault();
    ev.stopPropagation();
    void play(cur.id, Math.max(0, cur.scene - 1));
  }
}

// --------------------------------------------------------------------- 接線
export function initTour(a: TourApp): void {
  app = a;
  el('tourClose')?.addEventListener('click', () => closeTourMenu());
  el('tourBackdrop')?.addEventListener('click', () => closeTourMenu());
  el('tourX')?.addEventListener('click', () => stopTour());
  el('tourNext')?.addEventListener('click', () => {
    if (phase === 'done' && cur) { void play(cur.id, 0); return; }
    pending?.('next');
  });
  el('tourPrev')?.addEventListener('click', () => { if (cur) void play(cur.id, Math.max(0, cur.scene - 1)); });
  el('tourReplay')?.addEventListener('click', () => { if (cur) void play(cur.id, cur.scene); });
  el('tourDone')?.addEventListener('click', () => { userDone = true; });
  el('tourSkip')?.addEventListener('click', () => {
    if (waitKind === 'pause') { pending?.('next'); return; }
    skipReq = true;
  });
  // 「停」那一步：點畫面任何地方就往下走（導覽自己的按鈕不算，它們各有各的意思）
  document.addEventListener('click', (ev) => {
    if (waitKind !== 'tap') return;
    const t = ev.target as HTMLElement | null;
    if (t?.closest?.('#tourBubble, #tourBox, #tourBackdrop')) return;
    tapped = true;
  }, true);
  // window 的 capture 比 document 的 capture 先收到：導覽的鍵盤優先於其他 Esc 處理
  window.addEventListener('keydown', onKey, true);
  renderMenu();
}

/** 診斷／測試用（`__accelon26.tourState()`） */
export function tourState(): Record<string, unknown> {
  const bubble = el('tourBubble');
  const spot = el('tourSpot');
  const target = pointSel ? q(pointSel) : null;
  const br = bubble ? bubble.getBoundingClientRect() : null;
  const sr = spot && !spot.hidden ? spot.getBoundingClientRect() : null;
  const tr = target ? target.getBoundingClientRect() : null;
  return {
    id: cur?.id ?? null,
    scene: cur?.scene ?? -1,
    scenes: cur?.tour.scenes.length ?? 0,
    step: cur?.step ?? -1,
    steps: cur ? cur.tour.scenes[cur.scene]?.steps.length ?? 0 : 0,
    phase,
    waitKind,
    note,
    point: pointSel,
    failed: failed.slice(),
    progress: cur ? tourProgress(cur.id) : 0,
    bubble: {
      visible: !!bubble && !bubble.hidden,
      rect: br && br.width ? { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) } : null,
      text: el('tourText')?.textContent?.slice(0, 120) ?? '',
      where: el('tourWhere')?.textContent ?? '',
      buttons: ['tourNext', 'tourPrev', 'tourReplay', 'tourDone', 'tourSkip']
        .filter((id) => el(id)?.hidden === false),
    },
    spot: {
      visible: !!sr,
      rect: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
      target: tr ? { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height) } : null,
      overlapTarget: !!sr && !!tr
        && !(sr.right < tr.left || sr.left > tr.right || sr.bottom < tr.top || sr.top > tr.bottom),
    },
    tours: TOUR_INDEX.map((t) => ({ id: t.id, title: t.title, scenes: t.scenes, steps: t.steps })),
  };
}
