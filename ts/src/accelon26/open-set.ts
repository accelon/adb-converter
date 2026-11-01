/**
 * 桌面版啟動時要恢復「上次開著的 adb」（作者 2026-11-01）。
 *
 * 為什麼要有：桌面版每次啟動都只挑一個庫（有 logo 的那個），使用者開著的另外
 * 三四個庫每次都要重開 —— 那正是「每次都重來」。
 *
 * 存哪裡：**localStorage `accelon26.openset.v1`**，而且**只在離開 exe 之前寫一次**
 * （作者 2026-11-01：「平時不必一直存，只有退出 exe 之前再存設定」）。
 * localStorage 是同步的，所以在 `beforeunload`／Wails 的 WindowClosing 那一刻寫
 * 一定寫得進去；settings.json 要走宿主非同步呼叫，關窗時不一定等得到。
 *
 * 只記「檔案身分」與順序（＝dbTabs 由左到右），不記各模組的快照：
 * 每個庫的閱讀位置（含捲動與選取區）由 `doc-pane` 的 `accelon26.lastRead.v1` 記著，
 * 重新 openFile 之後 `restoreLastRead()` 會自己回到那一頁。
 */
import type { AdbSource } from './adb';
import { activeSlot, openDbs } from './dbs';
import { initSettings, saveSettingsSoon } from './settings';
import { extraSetting, setExtraSetting } from './tag-style';

/** localStorage 的鍵 */
export const OPEN_SET_KEY = 'accelon26.openset.v1';
/**
 * 舊版（2026-11-01 中午那一顆 exe）把同一份清單寫在 settings.json 的頂層 `reading`，
 * 裡面有**這台機器的 adb 路徑**。settings.json 是跟著程式跑的設定檔，會給別人看／搬來搬去，
 * 別人的路徑當然不一樣 —— 所以那個鍵要清掉（作者 2026-11-01）。
 */
const LEGACY_SETTING_KEY = 'reading';

/**
 * 清掉 settings.json 裡舊版的 `reading`（含 adb 路徑）。
 *
 * `tag-style` 的 `toSettingsFile()` 會把不認得的頂層欄位原樣寫回，所以不清掉的話
 * 之後任何一次存設定都會再把路徑寫出去。啟動時呼叫一次即可（有才寫檔）。
 */
export async function dropLegacyReadingSetting(): Promise<boolean> {
  try {
    await initSettings();
  } catch {
    return false;
  }
  if (extraSetting(LEGACY_SETTING_KEY) === undefined) return false;
  setExtraSetting(LEGACY_SETTING_KEY, undefined);
  saveSettingsSoon();
  return true;
}

/**
 * 一個「開過的庫」的身分。
 *
 * **不記路徑**（作者 2026-11-01：「adb 跟著 exe 走」）：adb 就在執行檔旁邊，換一台
 * 電腦或搬個資料夾路徑就不一樣，記了只會帶來麻煩。辨認靠宿主給的名字（桌面版是
 * 庫名、網頁版是檔名），同名時再用大小挑。
 */
export interface OpenDbRec {
  /** 宿主給的名字：桌面版是庫名（檔頭 dbcname），網頁版是檔名（`13j.adb`） */
  name: string;
  /** 檔頭 dbname（`13j`、`ys`）；有就多一層比對 */
  dbname?: string;
  /** 檔案大小／時間：只用來在同名時挑對的那一個（換版會變，不是必要條件） */
  size?: number;
  lastModified?: number;
}

export interface OpenSet {
  v: 1;
  at: string;
  /** 上次 active 的那一個（用 `recKey` 比對） */
  active?: string;
  /** 由左到右（＝dbTabs 的順序） */
  dbs: OpenDbRec[];
}

const recOf = (s: AdbSource, name: string, dbname?: string): OpenDbRec => ({
  name: name || s.name,
  dbname: dbname || undefined,
  size: s.size,
  lastModified: s.lastModified,
});

/** 比對用的鍵（名字＋大小；同名同大小的兩個檔沒有辦法分辨，也不需要） */
export const recKey = (r: { name: string; size?: number }): string =>
  'n:' + r.name + ':' + (r.size ?? 0);

/** 目前開著的庫（「閱讀狀態」匯出也用這一份形狀） */
export function openDbRecs(): OpenDbRec[] {
  return openDbs.map((d) => recOf(
    d.file,
    d.name,
    (d.core as { reader?: { header: { dbname?: string } } } | null)?.reader?.header.dbname,
  ));
}

/**
 * 把「現在開著哪幾個庫、哪一個是 active」寫進 localStorage。
 *
 * **只在離開 exe 之前呼叫**（`ui.ts` 的 `saveOnExit()`）：平時開庫／切庫／關庫都不寫。
 * 同步寫入，所以視窗正在關閉時也一定寫得進去。
 */
export function writeOpenSetNow(): void {
  const dbs = openDbRecs();
  const active = activeSlot();
  try {
    if (!dbs.length) {
      // 全部關掉了：把紀錄清掉，下次啟動才不會去開一堆使用者早就關掉的庫
      localStorage.removeItem(OPEN_SET_KEY);
      return;
    }
    const set: OpenSet = { v: 1, at: new Date().toISOString(), active: active ? recKey(recOf(active.file, active.name)) : undefined, dbs };
    localStorage.setItem(OPEN_SET_KEY, JSON.stringify(set));
  } catch { /* 私密模式／配額：記不住就算了，不要擋關窗 */ }
}

/** 上次記下來的開啟清單（沒有、或壞掉就 null）。同步：啟動時直接讀。 */
export function savedOpenSet(): OpenSet | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(OPEN_SET_KEY); } catch { return null; }
  if (!raw) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const list = Array.isArray(o.dbs) ? o.dbs : [];
  const dbs: OpenDbRec[] = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    // 舊紀錄（有 `file`／`path`）也讀得進來：`file` 就當成名字，`path` 直接丟掉
    const name = typeof r.name === 'string' && r.name ? r.name
      : (typeof r.file === 'string' ? r.file : '');
    if (!name) continue;
    dbs.push({
      name,
      dbname: typeof r.dbname === 'string' ? r.dbname : undefined,
      size: typeof r.size === 'number' ? r.size : undefined,
      lastModified: typeof r.lastModified === 'number' ? r.lastModified : undefined,
    });
  }
  if (!dbs.length) return null;
  return { v: 1, at: typeof o.at === 'string' ? o.at : '', active: typeof o.active === 'string' ? o.active : undefined, dbs };
}

/** 在這次啟動看得到的來源裡，找出紀錄說的那一個（同名多個時挑大小相同的） */
export function findSource(srcs: readonly AdbSource[], rec: OpenDbRec): AdbSource | null {
  const same = srcs.filter((s) => s.name === rec.name);
  if (same.length === 1) return same[0];
  const bySize = same.find((s) => rec.size === undefined || s.size === rec.size);
  if (bySize) return bySize;
  // 名字對不上（換版改了顯示名）：用大小＋時間找，兩個都對才採用
  return srcs.find((s) => rec.size !== undefined && s.size === rec.size
    && (rec.lastModified === undefined || s.lastModified === rec.lastModified)) ?? null;
}

/** 這份開啟清單裡，實際找得到幾個檔（給狀態訊息用） */
export function resolveOpenSet(srcs: readonly AdbSource[], set: OpenSet | null): { found: AdbSource[]; missing: OpenDbRec[]; active?: string } {
  if (!set) return { found: [], missing: [] };
  const found: AdbSource[] = [];
  const missing: OpenDbRec[] = [];
  for (const rec of set.dbs) {
    const s = findSource(srcs, rec);
    if (s && !found.some((f) => f === s)) found.push(s);
    else if (!s) missing.push(rec);
  }
  const activeRec = set.active ? set.dbs.find((r) => recKey(r) === set.active) : undefined;
  return { found, missing, active: activeRec ? recKey(activeRec) : undefined };
}
