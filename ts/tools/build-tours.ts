/**
 * 劇本 ⟶ 宏腳本 的編譯器（作者 2026-10）。
 *
 *   bun run tools/build-tours.ts            # 編譯 ts/tour/*.tour → src/accelon26/tour-data.ts
 *   bun run tools/build-tours.ts --check    # 只驗證：產物是否與劇本同步（不過就 exit 1）
 *
 * 為什麼要有編譯這一步：
 *   * 劇本是給人寫的（Markdown 方言，可以有空行、中文、註解）；
 *     宏是給播放器讀的（二進位 ＋ base64，人不可讀）。
 *   * 編譯時就把錯擋掉：指令拼字、參數個數、`#id` 打錯、分頁名打錯、條件語法。
 *     **打錯的選擇器是導覽最常見的死法**，它不會讓程式壞掉，只會讓導覽默默指著空氣。
 *   * 產物進版控（和 variant-data.ts / simplified-data.ts 一樣）：建置不該依賴
 *     「前一步剛好跑過」，而 `--check` 負責抓「改了劇本忘了重編」。
 *
 * 劇本語法（六條）：
 *   1. `@id/@title/@intro/@require` —— 檔頭資訊（放第一個 `###` 之前）
 *   2. `### 標題` —— 開始一個場景
 *   3. `> 指令 參數` —— 一個動作；指令可以用中文（見 ALIAS）
 *   4. 其他每一行 —— 這個場景的說明文字（Markdown）
 *   5. `# 註解` —— 編譯器丟掉
 *   6. 指令裡的 `=>` 是「目標 => 內容」的分隔線（輸入／你來／呼叫）
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  encodeTour, toBase64, OP, type Tour, type Scene, type Step,
} from '../src/accelon26/tour-format';

const HERE = import.meta.dir;
const TOUR_DIR = resolve(HERE, '../tour');
const TEMPLATE = resolve(HERE, '../src/accelon26/accelon26.template.html');
const OUT = resolve(HERE, '../src/accelon26/tour-data.ts');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');

// --------------------------------------------------------------- 指令對照表
/** 中文／英文別名 → 正式指令名。寫哪個都行：這份表就是「給不寫程式的人用」的介面。 */
const ALIAS: Record<string, string> = {
  說: 'text', text: 'text', say: 'text',
  指向: 'point', point: 'point',
  不指向: 'unpoint', unpoint: 'unpoint',
  點: 'click', click: 'click',
  輸入: 'type', type: 'type',
  按鍵: 'key', key: 'key',
  等: 'wait', wait: 'wait',
  等頁面: 'waitFor', waitfor: 'waitFor',
  分頁: 'tab', tab: 'tab',
  側欄: 'side', side: 'side',
  設定: 'set', set: 'set',
  呼叫: 'call', call: 'call',
  你來: 'user', user: 'user',
  需要: 'require', require: 'require',
  若非: 'skipIf', skipif: 'skipIf', skipIf: 'skipIf',
};

/** `設定` 認得的鍵 → 播放器交給 app.set() 的鍵（值 1/0 或 0..2） */
const SET_KEYS = new Set(['advanced', 'variants', 'pagemarks', 'simmode', 'hardbreaks', 'raw']);

/** `呼叫` 認得的函式（播放器端的白名單；打錯字在編譯時就紅） */
const CALL_NAMES = new Set([
  'openSettings', 'closeSettings', 'openSearchAll', 'closeSearchAll', 'openAbout',
  'runSearchAll', 'dictLookup', 'search',
]);

/** `分頁` 認得的分頁名（左右兩欄的聯集） */
const TAB_NAMES = new Set([
  'dir', 'terms', 'freq', 'folio', 'latin', 'token',      // 左欄
  'sum', 'text', 'dict', 'meta', 'capacity', 'docs', 'images', // 右欄
]);

/** `api:` 條件讀的是 __accelon26.state() 的頂層鍵 */
const API_KEYS = new Set([
  'db', 'dict', 'advanced', 'variants', 'leftTab', 'rightTab', 'docTab', 'docTabs',
  'searchQuery', 'marks', 'docRows', 'cols', 'hint', 'status', 'renderRaw',
  'hardBreaks', 'simMode', 'pageMarks', 'catalog', 'dbPick', 'dbPickOpen',
]);

/** 播放器自己會產生的 id（不在 template 裡，掃不到） */
const DYNAMIC_IDS = new Set(['fsHint', 'notesBox']);

// ------------------------------------------------------------------ 小工具
const normCol = (s: string): 'L' | 'R' | null => {
  if (s === '左' || s === 'L' || s === 'l' || s === 'left') return 'L';
  if (s === '右' || s === 'R' || s === 'r' || s === 'right') return 'R';
  return null;
};

const isOn = (s: string): boolean => s === '開' || s === 'on' || s === '1' || s === 'true';
const isOff = (s: string): boolean => s === '關' || s === 'off' || s === '0' || s === 'false';

/** 說明文字：去掉頭尾空行、去掉行尾空白，保留內部空行（Markdown 分段靠它） */
function cleanBody(lines: string[]): string {
  const trimmed = lines.map((l) => l.replace(/\s+$/, ''));
  let a = 0;
  let b = trimmed.length;
  while (a < b && trimmed[a] === '') a++;
  while (b > a && trimmed[b - 1] === '') b--;
  return trimmed.slice(a, b).join('\n');
}

// ------------------------------------------------------------------- 剖析
interface Parsed { tour: Tour; errors: string[] }

/** 條件語法檢查（播放器端只是照著解，這裡先擋掉明顯寫錯的） */
function checkCond(cond: string, err: (m: string) => void): void {
  const c = cond.startsWith('!') ? cond.slice(1) : cond;
  if (!c) { err('條件是空的'); return; }
  const m = /^api:([A-Za-z0-9_.]+)(?:=(.*))?$/.exec(c);
  if (m) {
    const head = m[1].split('.')[0];
    if (!API_KEYS.has(head)) err(`api: 不認得 ${head}（可用：${[...API_KEYS].join(' ')}）`);
    return;
  }
  if (/^count:/.test(c)) {
    if (!/\S/.test(c.slice(6))) err('count: 後面要接選擇器');
    return;
  }
  if (/^text:/.test(c)) {
    if (!/=/.test(c)) err('text: 的寫法是 text:選擇器=文字');
    return;
  }
  // 其餘當選擇器：至少要像個選擇器（# . [ 或標籤名）
  if (!/^[#.[a-zA-Z]/.test(c)) err(`看不懂的條件：${cond}`);
}

/** 一行 `> 指令 參數` → Step */
function parseStep(word: string, rest: string, err: (m: string) => void): Step | null {
  const name = ALIAS[word] ?? ALIAS[word.toLowerCase()] ?? null;
  if (!name) {
    err(`不認得的指令「${word}」（可用：${[...new Set(Object.keys(ALIAS))].join(' ')}）`);
    return null;
  }
  const r = rest.trim();
  const two = r.split(/\s+/).filter(Boolean);
  const arrow = r.indexOf('=>');
  const left = arrow >= 0 ? r.slice(0, arrow).trim() : r;
  const right = arrow >= 0 ? r.slice(arrow + 2).trim() : '';

  switch (name) {
    case 'text':
      if (!r) { err('說 後面要接文字'); return null; }
      return { op: OP.text, args: [r] };
    case 'point':
    case 'click':
      if (!r) { err(`${name} 後面要接選擇器`); return null; }
      return { op: OP[name as 'point' | 'click'], args: [r] };
    case 'unpoint':
      return { op: OP.unpoint, args: [] };
    case 'type':
      if (arrow < 0 || !left) { err('輸入 的寫法是：輸入 選擇器 => 文字'); return null; }
      return { op: OP.type, args: [left, right] };
    case 'key':
      if (!two.length) { err('按鍵 後面要接鍵名（例：Enter、Escape）'); return null; }
      return { op: OP.key, args: two.length > 1 ? [two[0], two.slice(1).join(' ')] : [two[0]] };
    case 'wait': {
      if (!two.length || !/^\d+$/.test(two[0])) { err('等 後面要接毫秒數'); return null; }
      return { op: OP.wait, args: [two[0]] };
    }
    case 'waitFor': {
      // 最後一個 token 是純數字 → 那是逾時
      let cond = r;
      let timeout = '';
      const last = two[two.length - 1] ?? '';
      if (two.length > 1 && /^\d+$/.test(last)) {
        cond = r.slice(0, r.length - last.length).trim();
        timeout = last;
      }
      if (!cond) { err('等頁面 後面要接條件（例：#searchList .snippet）'); return null; }
      checkCond(cond, err);
      return { op: OP.waitFor, args: timeout ? [cond, timeout] : [cond] };
    }
    case 'tab': {
      if (two.length < 2) { err('分頁 的寫法是：分頁 左|右 名稱'); return null; }
      const col = normCol(two[0]);
      if (!col) { err(`分頁 的第一個參數要是 左 或 右（收到「${two[0]}」）`); return null; }
      const tab = two[1];
      if (!TAB_NAMES.has(tab)) err(`不認得的分頁「${tab}」（可用：${[...TAB_NAMES].join(' ')}）`);
      return { op: OP.tab, args: [col, tab] };
    }
    case 'side': {
      if (two.length < 2) { err('側欄 的寫法是：側欄 左|右 開|關'); return null; }
      const col = normCol(two[0]);
      if (!col) { err(`側欄 的第一個參數要是 左 或 右（收到「${two[0]}」）`); return null; }
      if (!isOn(two[1]) && !isOff(two[1])) { err(`側欄 的第二個參數要是 開 或 關（收到「${two[1]}」）`); return null; }
      return { op: OP.side, args: [col, isOn(two[1]) ? 'on' : 'off'] };
    }
    case 'set': {
      if (two.length < 2) { err('設定 的寫法是：設定 鍵 值'); return null; }
      if (!SET_KEYS.has(two[0])) err(`不認得的設定鍵「${two[0]}」（可用：${[...SET_KEYS].join(' ')}）`);
      return { op: OP.set, args: [two[0], two[1]] };
    }
    case 'call': {
      if (!left) { err('呼叫 的寫法是：呼叫 函式名 => 參數'); return null; }
      if (!CALL_NAMES.has(left)) err(`不認得的函式「${left}」（可用：${[...CALL_NAMES].join(' ')}）`);
      return { op: OP.call, args: right ? [left, right] : [left] };
    }
    case 'user':
      if (!left) { err('你來 的寫法是：你來 說明 => 完成條件'); return null; }
      if (right) checkCond(right, err);
      return { op: OP.user, args: right ? [left, right] : [left] };
    case 'require':
    case 'skipIf':
      if (!r) { err(`${name} 後面要接條件`); return null; }
      checkCond(r, err);
      return { op: name === 'require' ? OP.require : OP.skipIf, args: [r] };
    default:
      err(`未實作的指令 ${name}`);
      return null;
  }
}

export function parseTour(src: string, file: string): Parsed {
  const lines = src.replace(/^\uFEFF/, '').split(/\r?\n/);
  const errors: string[] = [];
  const tour: Tour = { id: '', title: '', intro: '', require: '', scenes: [] };
  let scene: Scene | null = null;
  let body: string[] = [];
  let seenScene = false;

  const flush = (): void => {
    if (!scene) return;
    scene.body = cleanBody(body);
    tour.scenes.push(scene);
    scene = null;
    body = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ln = i + 1;
    const at = (m: string): void => { errors.push(`${file}:${ln}  ${m}`); };

    const head = /^\s*(#{3,})\s*(.*)$/.exec(raw);
    if (head) {
      flush();
      seenScene = true;
      scene = { title: head[2].trim() || `場景 ${tour.scenes.length + 1}`, body: '', steps: [] };
      continue;
    }
    const cmd = /^\s*>\s?(.*)$/.exec(raw);
    if (cmd) {
      const text = cmd[1].trim();
      if (!text) { at('`>` 後面是空的'); continue; }
      if (!scene) { at('指令必須在一個 `### 場景` 裡面'); continue; }
      const sp = text.search(/\s/);
      const word = sp < 0 ? text : text.slice(0, sp);
      const rest = sp < 0 ? '' : text.slice(sp + 1);
      const st = parseStep(word, rest, at);
      if (st) scene.steps.push(st);
      continue;
    }
    const dir = /^\s*@(\w+)\s+(.*)$/.exec(raw);
    if (dir && ['id', 'title', 'intro', 'require'].includes(dir[1])) {
      if (seenScene) { at('`@` 檔頭資訊要放在第一個場景之前'); continue; }
      const v = dir[2].trim();
      if (dir[1] === 'id') tour.id = v;
      else if (dir[1] === 'title') tour.title = v;
      else if (dir[1] === 'intro') tour.intro = v;
      else tour.require = v;
      continue;
    }
    if (/^\s*#(?!#)\s?/.test(raw)) continue;      // 註解
    if (scene) body.push(raw);
    else if (raw.trim()) {
      // 場景外的散文：當成 @intro 的補充太隱晦，直接報錯
      at('場景之外的文字沒有去處（要放進場景，或寫成 `@intro`）');
    }
  }
  flush();

  // 檔名就是預設 id；@id 若給了就必須一致（避免「兩個 first-run」）
  const base = file.replace(/^.*[\\/]/, '').replace(/\.tour$/, '');
  if (!tour.id) tour.id = base;
  if (tour.id !== base) {
    errors.push(`${file}  @id「${tour.id}」要跟檔名「${base}」一致`);
  }
  if (!tour.title) tour.title = tour.id;
  if (!tour.scenes.length) errors.push(`${file}  沒有任何場景（用 \`### 標題\` 開始一個場景）`);
  return { tour, errors };
}

// -------------------------------------------------------------------- 靜態檢查
function templateIds(): Set<string> {
  const html = readFileSync(TEMPLATE, 'utf8');
  const ids = new Set<string>();
  for (const m of html.matchAll(/id="([A-Za-z][\w-]*)"/g)) ids.add(m[1]);
  for (const d of DYNAMIC_IDS) ids.add(d);
  return ids;
}

/** 從選擇器字串裡抓 `#id` 參照，檢查它們存在。抓不到的（例如 `.foo`）就跳過。 */
function checkSelector(sel: string, ids: Set<string>, err: (m: string) => void): void {
  for (const m of sel.matchAll(/#([A-Za-z][\w-]*)/g)) {
    if (!ids.has(m[1])) err(`選擇器裡的 #${m[1]} 在 template 裡找不到（改名了？打錯字？）`);
  }
  for (const m of sel.matchAll(/\[data-tab=["']?([\w-]+)/g)) {
    if (!TAB_NAMES.has(m[1])) err(`data-tab="${m[1]}" 不是已知分頁`);
  }
}

function lint(tour: Tour, ids: Set<string>, err: (m: string) => void): void {
  if (!tour.title) err('缺 @title');
  tour.scenes.forEach((sc, i) => {
    if (!sc.title) err(`場景 ${i + 1} 沒有標題`);
    if (!sc.body && !sc.steps.length) err(`場景 ${i + 1}「${sc.title}」是空的`);
    sc.steps.forEach((st, j) => {
      const where = (m: string) => err(`場景 ${i + 1} 第 ${j + 1} 步：${m}`);
      if (!st.args.length && st.op !== OP.unpoint) where('缺參數');
      for (const a of st.args) {
        checkSelector(a, ids, where);
        if (/^api:/.test(a)) checkCond(a, where);
      }
    });
  });
}

// ---------------------------------------------------------------------- 主流程
function main(): void {
  if (!existsSync(TOUR_DIR)) {
    console.error(`沒有 ${TOUR_DIR}（放 *.tour 劇本的地方）`);
    process.exit(2);
  }
  const files = readdirSync(TOUR_DIR).filter((f) => f.endsWith('.tour')).sort();
  if (!files.length) {
    console.error(`${TOUR_DIR} 裡沒有 .tour 劇本`);
    process.exit(2);
  }
  const ids = templateIds();
  const tours: Tour[] = [];
  let errors = 0;
  for (const f of files) {
    const src = readFileSync(resolve(TOUR_DIR, f), 'utf8');
    const { tour, errors: e1 } = parseTour(src, f);
    let bad = e1.length;
    for (const m of e1) console.error('  ' + m);
    const e2: string[] = [];
    lint(tour, ids, (m) => e2.push(`${f}  ${m}`));
    for (const m of e2) console.error('  ' + m);
    bad += e2.length;
    errors += bad;
    if (!bad) tours.push(tour);
  }
  if (errors) {
    console.error(`\n${errors} 個問題，沒有產生 tour-data.ts`);
    process.exit(1);
  }

  const index = tours.map((t) => ({
    id: t.id, title: t.title, intro: t.intro, scenes: t.scenes.length,
    steps: t.scenes.reduce((a, s) => a + s.steps.length, 0),
    require: t.require,
    bytes: encodeTour(t).length,
  }));
  const blobs = tours.map((t) => [t.id, toBase64(encodeTour(t))] as const);

  const text = `/**
 * AUTO-GENERATED by ts/tools/build-tours.ts — **不要手改**。
 *
 * 改劇本（ts/tour/*.tour）之後跑：
 *     bun run tools/build-tours.ts
 *
 * 這裡放的是編譯後的「宏腳本」（二進位 ＋ base64，人不可讀，見 tour-format.ts）。
 * 產物進版控的理由跟 variant-data.ts 一樣：建置不該依賴「前一步剛好跑過」；
 * 而 \`--check\` 負責抓「改了劇本忘了重編」。
 */
import type { TourMeta } from './tour-format';

/** 選單用的摘要（不播放也能顯示標題、場景數、大約幾步） */
export const TOUR_INDEX: TourMeta[] = ${JSON.stringify(index, null, 2)};

/** id → base64 宏 */
export const TOUR_BLOBS: Record<string, string> = {
${blobs.map(([id, b]) => `  ${JSON.stringify(id)}: '${b}',`).join('\n')}
};
`;

  const old = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  const same = old === text;
  if (CHECK) {
    if (!same) {
      console.error('tour-data.ts 已過期：跑 `bun run tools/build-tours.ts` 重建');
      process.exit(1);
    }
    console.log(`tour-data.ts 與 ${tours.length} 份劇本同步`);
    return;
  }
  if (!same) writeFileSync(OUT, text, 'utf8');
  const kb = (text.length / 1024).toFixed(1);
  console.log(`${same ? '沒有變更' : 'wrote'} ${OUT}  (${kb} KiB)`);
  for (const t of index) {
    console.log(`  ${t.id}: ${t.title} — ${t.scenes} 場景 / ${t.steps} 步 / ${t.bytes} bytes`);
  }
}

if (import.meta.main) main();
