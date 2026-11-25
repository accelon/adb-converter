/**
 * tbl-download.ts —— 每個 `<表>` 區塊加一顆「下載」按鈕（厚觀法師 354 二：
 * 「〈28普賢菩薩勸發品〉咒語對照表可以下載嗎？」2026-11-21）。
 *
 * 按下去把這張渲染好的表格存成單一 HTML 檔（白底、框線、標楷體，Word／瀏覽器直接開），
 * 檔名用「書名－表前最近一列標題」。渲染端只在 render_accelon3.tableHtml() 多一顆
 * `<button class="tblDl">`；這裡用文件級委派接 click，不改 doc-pane／panes。
 *
 * 為什麼是 HTML 而不是圖片：法師要的是能把表帶回去排版／印校對，HTML 開進 Word 就是表格；
 * 圖片路徑（圖窗「存檔」）已有，文字表沒有圖檔可存，才補這一著。
 */
import { activeDb } from './tag-style';

/** 表格 → 可獨立開啟的 HTML 文件（去掉 id／data-src／渲染器 class，留 colspan 與文字） */
function tableExportHtml(table: HTMLTableElement): string {
  const clone = table.cloneNode(true) as HTMLTableElement;
  clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  clone.querySelectorAll('[data-src]').forEach((el) => el.removeAttribute('data-src'));
  clone.querySelectorAll('[class]').forEach((el) => el.removeAttribute('class'));
  const title = (clone.querySelector('caption')?.textContent || '表格').trim() || '表格';
  return '<!DOCTYPE html>\n<html lang="zh-Hant"><head><meta charset="utf-8">'
    + `<title>${escHtml(title)}</title>\n<style>\n`
    + 'body { font-family: "DFKai-SB","BiauKai","標楷體","PMingLiU",serif; background:#fff; color:#000; margin:24px; }\n'
    // 厚觀法師 2026-11-25 07:55（408 三）：下載的檔案裡「天干地支／吉藏科判」要新細明體，
    // 否則與標楷體的經文混在一起不好讀。科判在資料端是 `<科>`（渲染後 span 帶 data-tag="科"，
    // class 被剝掉但 data-tag 留著），所以只命中科判；經文仍是 `<經>`（內聯楷體）不受影響，
    // 其他表（如〈28普賢〉咒語對照表）沒有 `<科>`，字型完全照舊。
    + '[data-tag="科"] { font-family: "PMingLiU","新細明體","MingLiU",serif; }\n'
    + 'table { border-collapse: collapse; }\n'
    + 'caption { text-align:left; font-weight:bold; padding:0 0 8px; }\n'
    + 'th, td { border:1px solid #444; padding:5px 10px; text-align:left; vertical-align:top; white-space:pre-wrap; }\n'
    + 'th { background:#f2f2f2; }\n'
    + '</style></head><body>\n' + clone.outerHTML + '\n</body></html>\n';
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 表前最近一列非空文字（通常是「附錄：〈28…〉咒語對照表」那行標題）→ 檔名用 */
function nearestTitle(wrap: Element): string {
  let n: Element | null = wrap;
  for (let guard = 0; guard < 400 && n; guard++) {
    let p: Element | null = n.previousElementSibling;
    while (p) {
      const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 60);
      p = p.previousElementSibling;
    }
    n = n.parentElement;
  }
  return '';
}

/** Windows／瀏覽器檔名非法字元 → 底線 */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function initTableDownload(): void {
  document.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    const btn = target?.closest?.('.tblDl') as HTMLElement | null;
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const wrap = btn.closest('.docTable');
    const table = wrap?.querySelector('table') as HTMLTableElement | null;
    if (!wrap || !table) return;
    const db = activeDb();
    const title = nearestTitle(wrap);
    const stem = safeName([db.name || db.file, title].filter(Boolean).join('－') || '表格');
    const blob = new Blob([tableExportHtml(table)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    const old = btn.textContent;
    btn.textContent = '已存檔 ✓';
    setTimeout(() => { btn.textContent = old; }, 1600);
  });
}
