/**
 * 快速鍵卡片（作者 2026-10-29）：「關於」→「⌨ 快速鍵」，**所有**快速鍵集中一頁。
 *
 * 為什麼要有這一頁：快速鍵原本散在 tooltip 與程式各處（F1–F9 在 ui.ts、Ctrl+B 在 ui.ts、
 * 編輯器的 Esc／Ctrl+S 在 doc-pane.ts、圖片檢視的 +−01 在 panes.ts、導覽的 ←→ 在
 * tour.ts、各彈窗的 Esc…）。讀者問「有那些鍵？」時，答案不該靠翻 tooltip。
 *
 * **單一真相**：`SHORTCUT_GROUPS` 就是清單；About 的那一行摘要也從這裡生（`keySummary()`），
 * 所以新增快速鍵時只改這一個檔案（新鍵仍要記得在真正的地方接上 handler）。
 *
 * Mac：Ctrl 顯示成 ⌘、Alt 顯示成 ⌥（`navigator.userAgent` 判斷）。卡片裡一律用同一個
 * 正規寫法（Ctrl+Alt+B），由 `keyLabel()` 負責換字。
 */
import { desktopAppInfo } from './host';

export interface ShortcutRow {
  /** 正規寫法：'F1'、'Ctrl+B'、'Ctrl+Alt+B'、'Esc'、'←'、'+' */
  keys: string;
  /** 做什麼（一句話，動詞開頭） */
  what: string;
  /** 只在桌面版（有宿主）才有 */
  desktop?: boolean;
}

export interface ShortcutGroup {
  title: string;
  /** 這一組的一句話說明（可省略） */
  note?: string;
  rows: ShortcutRow[];
}

/** 所有快速鍵。順序＝卡片上的順序：常用的放前面。 */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '任何時候',
    rows: [
      { keys: 'F1', what: '操作導覽（從第一頁開始，一步一步教你用）' },
      { keys: 'F2', what: '重建 ADB：把修訂產生新檔（網頁版下載、桌面版覆寫原檔）' },
      { keys: 'F3', what: '進入／離開編輯（改錯字；要先在「關於」填修訂者 ID）' },
      { keys: 'F9', what: '元素檢查：點畫面任一元素複製它的 id，再按 F9 或 Esc 結束' },
      { keys: 'Ctrl+B', what: '左欄（目錄／搜尋）開關' },
      { keys: 'Ctrl+Alt+B', what: '右欄（摘要／詞典／文字內容）開關' },
      { keys: 'Alt+1…5', what: '切換到第 1–5 個已開啟的 adb（依上方晶片順序；2026-10-30）' },
      { keys: 'Alt+O', what: '開啟 adb 清單（↑↓ 移動、Enter 開、Esc 收起）' },
      { keys: 'Alt+S', what: '搜尋所有 adb' },
      { keys: 'Alt+A', what: '關於（About；再按一次收起）' },
      { keys: 'Alt+←／→', what: '上一頁／下一頁（本文分頁；不是原書的葉）' },
      { keys: 'F11', what: '全螢幕／視窗切換', desktop: true },
      { keys: 'Esc', what: '關閉最上層的視窗；全螢幕時回到視窗', desktop: true },
      { keys: 'Esc', what: '關閉最上層的視窗（設置、全庫搜尋、關於、修訂清單、熱圖、書籤選單）' },
    ],
  },
  {
    title: '搜尋與跳至',
    note: '左欄每個搜尋框都有自己的 ✕ 清空；Esc **不會**清掉你打的字。',
    rows: [
      { keys: 'Enter', what: '立即搜尋（不等輸入停頓）' },
      { keys: '#123 ＋ Enter', what: '跳到第 123 行；#L123@db 指定庫' },
      { keys: 'Enter', what: '「跳至」欄：跳到最接近的頁 id' },
      { keys: 'Esc', what: '離開搜尋框，查詢字留著' },
    ],
  },
  {
    title: 'Ctrl／Alt ＋ 點擊',
    note: 'Mac 的 Ctrl 是 ⌘、Alt 是 ⌥。目錄節點不加鍵也有兩種意思：未展開→展開一層並跳過去，'
      + '已展開→收合（本文不動）。',
    rows: [
      { keys: 'Ctrl+點目錄節點', what: '把那一節的文字放右欄，本文不動（對照用）' },
      { keys: 'Alt+點目錄節點', what: '完全展開所有子孫節點（本文同時跳過去）；已展開時不變，點一下仍是收合' },
      { keys: 'Ctrl+點本文分頁', what: '分頁複製到右欄' },
      { keys: 'Ctrl+Shift+點本文分頁', what: '分頁搬到右欄（本文收起來）' },
      { keys: 'Ctrl+點連結', what: '`<聯>`／回連結按鈕：在新分頁開啟' },
      { keys: 'Alt+點字級按鈕', what: '字級 −2px（平常點是 +2px）；「T」三顆按鈕各管左欄／正文／右欄' },
    ],
  },
  {
    title: '編輯（改錯字）',
    rows: [
      { keys: 'Esc', what: '完成這一頁的編輯' },
      { keys: 'Ctrl+S', what: '暫存（還不產生 ADB；之後用 F2 才重建）' },
      { keys: 'Ctrl+Z', what: '復原' },
      { keys: 'Ctrl+Shift+Z', what: '重做（Ctrl+Y 也可以）' },
      { keys: 'Tab', what: '縮排；Shift+Tab 退縮' },
    ],
  },
  {
    title: '圖片檢視',
    rows: [
      { keys: '+', what: '放大（= 也可以）' },
      { keys: '-', what: '縮小' },
      { keys: '0', what: '適合視窗' },
      { keys: '1', what: '原始大小（100%）' },
      { keys: 'Esc', what: '關閉大圖' },
    ],
  },
  {
    title: '對話框與清單',
    note: '這一類是「焦點在按鈕或輸入框上」時才生效。',
    rows: [
      { keys: 'Enter', what: '送出（全庫搜尋、修訂者 ID、加入 Obsidian 的檔名）' },
      { keys: 'Enter／空白', what: '開啟（資料庫晶片、圖片縮圖、元素檢查命中）' },
      { keys: 'Esc', what: '取消／關閉' },
    ],
  },
  {
    title: '操作導覽',
    rows: [
      { keys: '→', what: '下一個場景（空白、Enter 也可以）' },
      { keys: '←', what: '上一個場景' },
      { keys: 'Esc', what: '結束導覽' },
    ],
  },
];

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 'Ctrl+Alt+B' → '⌘⌥B'（Mac）／'Ctrl+Alt+B'（其他） */
export function keyLabel(keys: string): string {
  if (!isMac()) return keys;
  return keys.replace(/Ctrl\+?/g, '⌘').replace(/Alt\+?/g, '⌥').replace(/Shift\+?/g, '⇧');
}

/** About 那一行的摘要：從清單生，不另外維護。 */
export function keySummary(): string {
  const pick = ['F1', 'F2', 'F3', 'F9', 'Ctrl+B', 'Ctrl+Alt+B'];
  const known = new Set(SHORTCUT_GROUPS.flatMap((g) => g.rows.map((r) => r.keys)));
  return pick.filter((k) => known.has(k)).map((k) => `${keyLabel(k)}`).join('、');
}

export function shortcutCount(): number {
  const seen = new Set<string>();
  for (const g of SHORTCUT_GROUPS) for (const r of g.rows) seen.add(g.title + '|' + r.keys + '|' + r.what);
  return seen.size;
}

const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

let open = false;
let bound = false;
/** 有宿主嗎（桌面版）——第一次開卡片時問一次，之後沿用 */
let desktopKnown: boolean | null = null;

export function shortcutsOpen(): boolean {
  return open;
}

/** 'Ctrl+Alt+B' → HTML：每個鍵一粒 <kbd>，加號用小字 */
function keysHtml(keys: string): string {
  const parts = keys.split(/(\s+|\+)/).filter((s) => s && !/^\s+$/.test(s));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '+') { out.push('<span class="skPlus">+</span>'); continue; }
    // 「#123 ＋ Enter」這種複合寫法：整段當成一個 chip（不是按鍵組合）
    if (p.includes('#')) { out.push(`<kbd class="skLit">${escapeHtml(p)}</kbd>`); continue; }
    out.push(`<kbd>${escapeHtml(keyLabel(p))}</kbd>`);
  }
  return out.join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function renderBody(box: HTMLElement, desktop: boolean): void {
  const groups = SHORTCUT_GROUPS.map((g) => {
    const rows = g.rows
      .filter((r) => !r.desktop || desktop)
      // 同一組裡重複的按鍵（Esc 兩種說法）保留：它們是不同的視窗
      .map((r) => `<div class="skRow"><span class="skKeys">${keysHtml(r.keys)}</span>`
        + `<span class="skWhat">${escapeHtml(r.what)}</span></div>`)
      .join('');
    if (!rows) return '';
    const note = g.note ? `<p class="skNote">${escapeHtml(g.note)}</p>` : '';
    return `<section class="skGroup"><h3>${escapeHtml(g.title)}</h3>${note}${rows}</section>`;
  }).join('');
  box.innerHTML = groups
    + '<p class="skFoot">這份清單就是程式裡的所有快速鍵；要改請改 '
    + '<code>ts/src/accelon26/shortcuts.ts</code>（About 的摘要也從它產生）。</p>';
}

export function closeShortcuts(): void {
  const box = el('shortcutBox');
  const back = el('shortcutBackdrop');
  if (box) box.hidden = true;
  if (back) back.hidden = true;
  open = false;
}

/** 開啟卡片。desktop 不傳就自己問宿主（決定 F11／Esc 那兩列要不要顯示）。 */
export async function openShortcuts(desktop?: boolean): Promise<void> {
  const box = el<HTMLElement>('shortcutBox');
  const back = el<HTMLElement>('shortcutBackdrop');
  const body = el<HTMLElement>('shortcutBody');
  if (!box || !back || !body) return;
  box.hidden = false;
  back.hidden = false;
  open = true;
  // 先畫（用上一次問到的答案），沒問過就問宿主：桌面版才顯示 F11／全螢幕 Esc
  const auto = desktop === undefined;
  renderBody(body, desktop ?? desktopKnown === true);
  if (auto && desktopKnown === null) {
    try {
      desktopKnown = !!(await desktopAppInfo());
    } catch {
      desktopKnown = false;
    }
    if (open) renderBody(body, desktopKnown);
  }
  const count = el<HTMLElement>('shortcutCount');
  if (count) count.textContent = `${shortcutCount()} 個（Esc 關閉）`;
  el<HTMLElement>('shortcutClose')?.focus();
  box.scrollTop = 0;
}

/** 只接一次：✕、點背景、Esc（capture：先於其他 Esc 處理，卡片在上面時不被別人吃掉） */
export function initShortcuts(): void {
  if (bound) return;
  bound = true;
  el('shortcutClose')?.addEventListener('click', () => closeShortcuts());
  el('shortcutBackdrop')?.addEventListener('click', () => closeShortcuts());
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open) { ev.stopPropagation(); closeShortcuts(); }
  }, true);
}
