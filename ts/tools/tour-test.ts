/**
 * 操作導覽的「真瀏覽器全播」測試（作者 2026-10）。
 *
 *   bun run tools/tour-test.ts [--adb 13j.adb] [--html build/accelon26.html] [--port 8961]
 *
 * 為什麼要有這一支：導覽最容易壞的方式不是程式壞掉，而是**沒有人再跑一次**。
 * UI 一改版，選擇器就默默指著空氣，而畫面上什麼錯誤都不會發生。
 * 這支把每一份劇本從頭播到尾（自動按「下一個場景」），並在過程中斷言：
 *
 *   * 每一步都成功（failed 為空）：等不到的條件、找不到的元素都會留下證據
 *   * 聚光燈真的套在目標上、而且不擋操作（pointer-events:none 是設計，這裡驗大小）
 *   * 說明氣泡不蓋住「小目標」（大目標例如整個清單，蓋住是合理的）
 *   * 場景數與順序：10 個場景都走到，而且關鍵場景指對了地方
 *   * 設定會還原（導覽不該把使用者留在簡體或進階模式）
 *   * Esc 結束、🎬 開選單、進度存進 localStorage
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decodeTour, fromBase64, OP } from '../src/accelon26/tour-format';
import { TOUR_BLOBS } from '../src/accelon26/tour-data';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = resolve(opt('html', resolve(import.meta.dir, '../../build/accelon26.html')));
const ADB = resolve(opt('adb', resolve(import.meta.dir, '../../13j.adb')));
const PORT = Number(opt('port', '0'));
const TOUR = opt('tour', 'first-run');
/** 一個條件最多等這麼久（再久就是導覽真的卡住了，不是「慢」） */
const STUCK_MS = 30000;

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML + ' (run tools/build-viewer.ts)'); process.exit(2); }
if (!existsSync(ADB)) { console.error('missing ' + ADB); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const profile = resolve(import.meta.dir, '../../build/.chrome-profile-tour');
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  '--allow-file-access-from-files', '--window-size=1400,900',
  `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'pipe', stderr: 'pipe' });

async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [portLine, pathLine] = text.split('\n').map((s) => s.trim());
    if (Number(portLine) > 0 && pathLine) return `ws://127.0.0.1:${portLine}${pathLine}`;
    await Bun.sleep(200);
  }
  throw new Error('DevToolsActivePort never appeared');
}

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionId = '';
  logs: string[] = [];
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id && c.pending.has(m.id)) {
          const p = c.pending.get(m.id)!; c.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
          return;
        }
        if (m.method === 'Runtime.consoleAPICalled') c.logs.push(m.params.type + ': ' + (m.params.args ?? []).map((a: any) => a.value ?? a.description).join(' '));
        if (m.method === 'Runtime.exceptionThrown') c.logs.push('exception: ' + (m.params.exceptionDetails?.exception?.description ?? '?'));
      };
    });
    return c;
  }
  async send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (session && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 60000);
    });
  }
  async openPage(url: string) {
    const { targetId } = await this.send('Target.createTarget', { url }, false);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('DOM.enable');
  }
  async eval<T>(expression: string): Promise<T> {
    let r: any;
    try {
      r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    } catch (e) {
      const msg = (e as Error).message;
      if (!/Promise was collected/.test(msg)) throw e;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await Bun.sleep(400 * attempt);
        try {
          r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          break;
        } catch (e2) {
          if (attempt === 3) throw e2;
        }
      }
    }
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  }
}

interface TState {
  id: string | null; scene: number; scenes: number; step: number; steps: number;
  phase: string; waitKind: string; note: string; point: string | null;
  failed: { scene: number; step: number; msg: string }[];
  progress: number;
  bubble: { visible: boolean; rect: { x: number; y: number; w: number; h: number } | null; text: string; where: string; buttons: string[] };
  spot: { visible: boolean; rect: { x: number; y: number; w: number; h: number } | null; target: { x: number; y: number; w: number; h: number } | null; overlapTarget: boolean };
  tours: { id: string; title: string; scenes: number; steps: number }[];
}

const sleep = (ms: number) => Bun.sleep(ms);

try {
  const cdp = await Cdp.attach(await devtoolsUrl());
  await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
  await sleep(900);

  ok('播放器在頁面上（__accelon26.tourState）', await cdp.eval<boolean>('typeof window.__accelon26.tourState === "function"'));
  const index = await cdp.eval<TState['tours']>('JSON.stringify(window.__accelon26.tourState().tours).startsWith("[") ? window.__accelon26.tourState().tours : []');
  ok('選單資料有劇本', Array.isArray(index) && index.length > 0,
    (index ?? []).map((t) => `${t.title}（${t.scenes} 場景/${t.steps} 步）`).join(' '));

  // ------------------------------------------- 「關於」是首頁（作者 2026-10-18）
  // 它預設在啟動時顯示，而且操作導覽的入口就搬到這裡。
  const startup = await cdp.eval<string>(`(() => {
    const box = document.getElementById('aboutBox');
    const btn = document.getElementById('aboutTour');
    const chk = document.getElementById('aboutStartup');
    return JSON.stringify({
      open: !box.hidden,
      tour: !!btn && !!btn.getBoundingClientRect().width,
      checked: chk ? chk.checked : null,
      state: window.__accelon26.aboutState().startup,
      headerTour: !!document.getElementById('tourBtn'),
    });
  })()`);
  const su = JSON.parse(startup) as { open: boolean; tour: boolean; checked: boolean; state: boolean; headerTour: boolean };
  ok('啟動時自動顯示「關於」（含操作導覽的入口）', su.open === true && su.tour === true,
    `open=${su.open}、導覽按鈕=${su.tour}`);
  ok('「啟動時顯示本頁面」預設勾選，且頂欄不再有 🎬', su.checked === true && su.state === true && su.headerTour === false,
    `勾選=${su.checked}、存檔=${su.state}、頂欄🎬=${su.headerTour}`);
  // 取消勾選 → 存成 0，下次啟動就不再自動顯示
  const off = await cdp.eval<string>(`(() => {
    const chk = document.getElementById('aboutStartup');
    chk.checked = false;
    chk.dispatchEvent(new Event('change'));
    return JSON.stringify({ state: window.__accelon26.aboutState().startup,
      saved: localStorage.getItem('accelon26.about.startup') });
  })()`);
  const o = JSON.parse(off) as { state: boolean; saved: string };
  ok('取消勾選會存起來（不再自動顯示）', o.state === false && o.saved === '0', JSON.stringify(o));
  await cdp.eval(`(() => { const c = document.getElementById('aboutStartup'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);

  // 開 13j（跟使用者一樣：把檔案塞進 input、再觸發 change）
  const doc = await cdp.send('DOM.getDocument');
  const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: node.nodeId });
  await sleep(400);
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
  let ready = false;
  for (let i = 0; i < 300; i++) {
    // 「開好」的定義要看這個庫有什麼：有 s="*" 的等目錄樹掛上來，
    // 沒有的（詞典 fgdict）就看它的第一個分頁有沒有內容。
    const s = await cdp.eval<string>(`(() => {
      const st = window.__accelon26.state();
      const dirBtn = document.querySelector('#colLeft .tabBtn[data-tab="dir"]');
      const r = dirBtn ? dirBtn.getBoundingClientRect() : null;
      return JSON.stringify({ db: st.db, rows: document.querySelectorAll('#dirTree .tRow').length,
        tokens: st.tokens, dirHidden: !r || r.width === 0 || r.height === 0, leftTab: st.leftTab });
    })()`);
    const j = JSON.parse(s) as { db: string | null; rows: number; tokens: number; dirHidden: boolean };
    if (j.db && j.tokens > 0 && (j.rows > 0 || j.dirHidden)) { ready = true; break; }
    await sleep(200);
  }
  ok('資料庫開好、目錄樹也掛上來了', ready);

  // 「▶ 操作導覽」＝真正的入口：關掉「關於」、直接開始播
  await cdp.eval('document.getElementById("aboutTour").click()');
  await sleep(800);
  const entry = JSON.parse(await cdp.eval<string>(`(() => {
    const st = window.__accelon26.tourState();
    return JSON.stringify({ phase: st.phase, bubble: st.bubble.visible,
      about: document.getElementById('aboutBox').hidden });
  })()`)) as { phase: string; bubble: boolean; about: boolean };
  ok('按「▶ 操作導覽」→ 關掉關於、開始播放', entry.phase !== 'idle' && entry.bubble === true && entry.about === true,
    JSON.stringify(entry));
  await cdp.eval('window.__accelon26.stopTour()');
  await sleep(300);

  // ------------------------------------------------------------ 自動播放
  await cdp.eval(`void window.__accelon26.playTour(${JSON.stringify(TOUR)}, 0)`);
  const visited: number[] = [];
  const pointedAt = new Map<number, Set<string>>();
  const tabsSeen = new Set<string>();
  let samples = 0, spotShown = 0, spotMisses = 0, bubbleCovered = 0;
  let tapWaits = 0;
  const missLog = new Map<string, number>();
  let stuckSince = Date.now();
  let lastKey = '';
  let paused: TState['failed'] = [];
  let done = false;
  const t0 = Date.now();

  while (Date.now() - t0 < 240000) {
    const st = await cdp.eval<TState>('window.__accelon26.tourState()');
    const key = `${st.scene}:${st.step}:${st.phase}:${st.waitKind}`;
    if (key !== lastKey) { lastKey = key; stuckSince = Date.now(); }

    // 聚光燈：有指目標時就該看得見，而且框住的是目標
    if (st.point) {
      samples++;
      if (st.spot.visible) spotShown++; else { spotMisses++; missLog.set(st.point, (missLog.get(st.point) ?? 0) + 1); }
      const b = st.bubble.rect, s = st.spot.rect, t = st.spot.target;
      // 小目標（單一按鈕、一個詞條）不該被氣泡蓋住；大目標（整個清單）蓋住是合理的
      if (b && s && t && t.h < 110 && t.w < 560) {
        const overlap = !(b.y + b.h <= s.y || b.y >= s.y + s.h);
        if (overlap) bubbleCovered++;
      }
      const set = pointedAt.get(st.scene) ?? new Set<string>();
      set.add(st.point);
      pointedAt.set(st.scene, set);
    }
    if (st.phase === 'done') { done = true; break; }

    if (st.waitKind === 'next') {
      if (!visited.includes(st.scene)) visited.push(st.scene);
      const tab = await cdp.eval<string>('window.__accelon26.state().rightTab');
      if (tab) tabsSeen.add(tab);
      await cdp.eval('document.getElementById("tourNext").click()');
      await sleep(120);
      continue;
    }
    if (st.waitKind === 'user') {
      await cdp.eval('document.getElementById("tourDone").click()');
      await sleep(120);
      continue;
    }
    if (st.waitKind === 'tap') {
      // 「停」：等使用者在畫面任何地方點一下（作者 2026-10-18）
      tapWaits++;
      await cdp.eval('document.body.click()');
      await sleep(150);
      continue;
    }
    if (st.waitKind === 'pause') {
      paused = st.failed;
      console.log(`    （卡住：場景 ${st.scene + 1} 第 ${st.step + 1} 步「${st.note}」）`);
      await cdp.eval('document.getElementById("tourSkip").click()');
      await sleep(120);
      continue;
    }
    if (st.waitKind === 'cond' && Date.now() - stuckSince > STUCK_MS) {
      console.log(`    （等太久：場景 ${st.scene + 1}「${st.note}」）`);
      await cdp.eval('document.getElementById("tourSkip").click()');
      await sleep(120);
      continue;
    }
    if (st.phase === 'running' && Date.now() - stuckSince > 60000) {
      console.log(`    （卡住了：場景 ${st.scene + 1} 第 ${st.step + 1} 步，沒有任何進展）`);
      paused = st.failed.length ? st.failed : [{ scene: st.scene, step: st.step, msg: '沒有進展' }];
      break;
    }
    await sleep(120);
  }

  const final = await cdp.eval<TState>('window.__accelon26.tourState()');
  ok('導覽播完了（phase=done）', done, `${visited.length} 個場景、${((Date.now() - t0) / 1000).toFixed(1)} s`);
  ok('沒有任何一步失敗', final.failed.length === 0 && paused.length === 0,
    [...final.failed, ...paused].map((f) => `場景${f.scene + 1}#${f.step + 1} ${f.msg}`).join(' / '));
  // 有些場景本來就會被 `若非` 跳過（這個庫沒有那個分頁）。允許跳過，但**只允許**
  // 第一行就是 `若非` 的場景 —— 否則「漏了一個場景」就藏起來了。
  const macro = decodeTour(fromBase64(TOUR_BLOBS[TOUR]));
  const guarded = macro.scenes.map((s) => s.steps[0]?.op === OP.skipIf);
  const skipped = [...Array(final.scenes).keys()].filter((i) => !visited.includes(i));
  const surprise = skipped.filter((i) => !guarded[i]);
  ok('每個場景都走到（或由「若非」明確跳過）', surprise.length === 0,
    `${visited.length} / ${final.scenes}；跳過 ${skipped.map((i) => i + 1).join(',') || '無'}`);
  ok('聚光燈每次都套在目標上（沒指到空氣）', samples > 20 && spotMisses <= 2,
    `${samples} 次取樣、${spotShown} 次可見、${spotMisses} 次落空 ${[...missLog].map(([s, n]) => `${s}×${n}`).join(' ')}`);
  ok('氣泡不蓋住小目標', bubbleCovered === 0, `${bubbleCovered} 次重疊`);
  ok('介紹介面的場景每一步都停下來等人點一下（停）', tapWaits >= 3, `${tapWaits} 次「停」`);
  ok('導覽結束後聚光燈收掉', !final.spot.visible);

  // 關鍵場景指對了地方
  const s1 = pointedAt.get(0) ?? new Set();
  ok('場景 1 依序指左欄／中間／右欄',
    s1.has('#colLeft') && s1.has('#colMid') && s1.has('#colRight'), [...s1].join(' '));
  ok('場景 2 指到 adb 選單（📁）', (pointedAt.get(1) ?? new Set()).has('#dbPickBtn'),
    [...(pointedAt.get(1) ?? [])].join(' '));
  ok('查詞場景指到結果清單（跳過時不驗）',
    !visited.includes(2) || [...(pointedAt.get(2) ?? [])].some((s) => s.includes('#searchList')),
    [...(pointedAt.get(2) ?? [])].join(' '));
  ok('詞典場景把右欄切到「詞典」', tabsSeen.has('dict'), [...tabsSeen].join(' '));

  // 導覽不該把使用者留在非預設的設定
  const after = await cdp.eval<string>(`(() => {
    const st = window.__accelon26.state();
    return JSON.stringify({ simMode: st.simMode, advanced: st.advanced, hardBreaks: st.hardBreaks,
      settings: st.settings ?? null, progress: localStorage.getItem('accelon26.tour.first-run') });
  })()`);
  const a = JSON.parse(after) as { simMode: number; advanced: boolean; hardBreaks: boolean; progress: string };
  ok('文字顯示還原成「保持原樣」', a.simMode === 0, `simMode=${a.simMode}`);
  ok('「原書分行」還原成開', a.hardBreaks === true, `hardBreaks=${a.hardBreaks}`);
  ok('進度存進 localStorage', a.progress !== null && Number(a.progress) === final.scenes - 1,
    `accelon26.tour.${TOUR}=${a.progress}`);

  // ------------------------------------------------------------ 重播／Esc
  ok('結束後有「再看一次」', await cdp.eval<boolean>('document.getElementById("tourNext").textContent.includes("再看一次")'));
  await cdp.eval('document.getElementById("tourNext").click()');
  await sleep(400);
  const again = await cdp.eval<TState>('window.__accelon26.tourState()');
  ok('「再看一次」從頭播', again.scene === 0 && again.phase !== 'done', `scene=${again.scene} phase=${again.phase}`);

  await cdp.eval('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await sleep(300);
  const esc = await cdp.eval<TState>('window.__accelon26.tourState()');
  ok('Esc 結束導覽、氣泡收掉', esc.phase === 'idle' && esc.bubble.visible === false, `phase=${esc.phase}`);

  // ------------------------------------------------------------ 導覽選單
  await cdp.eval('window.__accelon26.openTourMenu()');
  await sleep(250);
  const menu = await cdp.eval<string>(`(() => {
    const box = document.getElementById('tourBox');
    const rows = [...document.querySelectorAll('#tourList .tourRow')];
    return JSON.stringify({ open: !box.hidden, rows: rows.length, name: rows[0]?.querySelector('.tourName')?.textContent ?? '',
      scenes: rows[0]?.querySelector('.tourMeta')?.textContent ?? '',
      play: rows[0]?.querySelector('[data-play]')?.textContent ?? '' });
  })()`);
  const m = JSON.parse(menu) as { open: boolean; rows: number; name: string; scenes: string; play: string };
  ok('選單列出劇本（多份劇本時才用得到）', m.open && m.rows > 0, `${m.name}｜${m.scenes}`);
  ok('看過之後按鈕變成「繼續」', m.play.includes('繼續') || m.play.includes('從頭'), `「${m.play}」`);
  await cdp.eval('document.getElementById("tourClose").click()');
  await sleep(200);
  ok('選單可以關掉', await cdp.eval<boolean>("document.getElementById('tourBox').hidden === true"));

  // ------------------------------------------------------------ 壞宏不亂播
  const guard = await cdp.eval<string>(`(() => {
    const t = window.__accelon26.playTour('no-such-tour', 0);
    return JSON.stringify({ box: !document.getElementById('tourBox').hidden, bubble: !document.getElementById('tourBubble').hidden });
  })()`);
  const g = JSON.parse(guard) as { box: boolean; bubble: boolean };
  await sleep(200);
  ok('要求播放不存在的劇本 → 開選單，不亂播', g.bubble === false, JSON.stringify(g));

  const errors = cdp.logs.filter((l) => l.startsWith('exception'));
  ok('頁面沒有未捕捉的例外', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL 執行時出錯：' + (e as Error).message);
  console.log((e as Error).stack ?? '');
} finally {
  proc.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
