/**
 * `<嵌>`：文內嵌入（transclusion）。
 *
 * 文字裡的 `<嵌 i="db?page" q="引文" j="12-34" n="智顗疏"/>` 由
 * render_accelon3.ts 畫成晶片；點晶片才去目標頁取那段引文，插在晶片後面。
 * 再點一次（或按「收合」）移除。概念參考 offtext 的 `^[引用]`：
 * 正文不動，展開的內容是另一份 offtext，可以再引用。
 */
import { renderEmbed } from './xref';

function closeEmbed(btn: HTMLElement): void {
  const next = btn.nextElementSibling as HTMLElement | null;
  if (next?.classList.contains('embedBlock')) next.remove();
  btn.classList.remove('is-open');
  btn.setAttribute('aria-expanded', 'false');
}

async function openEmbed(btn: HTMLElement): Promise<void> {
  const log = (globalThis as any).__embedLog as string[] | undefined;
  log?.push('start ' + (btn.dataset.embed ?? ''));
  const next = btn.nextElementSibling as HTMLElement | null;
  if (next?.classList.contains('embedBlock')) { closeEmbed(btn); return; }
  const value = btn.dataset.embed ?? '';
  const q = value.indexOf('?');
  const db = q >= 0 ? value.slice(0, q) : '';
  const anchor = q >= 0 ? value.slice(q + 1) : value;
  if (!db || !anchor) return;
  const label = btn.dataset.label ?? '';

  const block = document.createElement('div');
  block.className = 'embedBlock';
  block.innerHTML = '<div class="embedLoading">載入 ' + escapeHtml(anchor) + ' …</div>';
  btn.after(block);
  btn.classList.add('is-open');
  btn.setAttribute('aria-expanded', 'true');

  try {
    const res = await renderEmbed(db, anchor, btn.dataset.q ?? '', btn.dataset.j ?? '', label);
    log?.push('resolved ' + res.html.length + ' connected=' + block.isConnected);
    block.innerHTML = res.html;
    const head = block.querySelector('.embedHead') as HTMLElement | null;
    if (head) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'embedClose';
      close.textContent = '收合';
      close.title = '收合這段引文';
      close.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeEmbed(btn);
      });
      head.append(close);
    }
    // 讓行內 <聯> 等既有事件照常運作；<嵌> 內若再有 <嵌>，事件代理也會接到。
  } catch (err) {
    log?.push('error ' + String(err));
    block.innerHTML = '<div class="embedError">讀取失敗：' + escapeHtml(String(err)) + '</div>';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let bound = false;

export function initEmbed(): void {
  if (bound) return;
  bound = true;
  (globalThis as any).__renderEmbed = renderEmbed;
  (globalThis as any).__embedLog = [];
  document.addEventListener('click', (ev) => {
    const btn = (ev.target as Element | null)?.closest?.('button.embedChip') as HTMLElement | null;
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    void openEmbed(btn);
  }, true);
}
