/**
 * `<嵌>`：文內嵌入（transclusion）。
 *
 * 文字裡的 `<嵌 i="db?page" q="引文" j="12-34" n="智顗疏"/>` 由
 * render_accelon3.ts 畫成晶片；點晶片才去目標頁取那段引文，插在晶片後面。
 * 再點一次（或按「收合」）移除。概念參考 offtext 的 `^[引用]`：
 * 正文不動，展開的內容是另一份 offtext，可以再引用。
 */
import { openTaishoAt, renderEmbed, renderEmbedGroup } from './xref';

let litKey = '';

function unlight(): void {
  const hl = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  hl?.delete('embedLit');
  document.querySelectorAll('#docText .docLine.embedLitLine').forEach((el) => el.classList.remove('embedLitLine'));
  litKey = '';
}

/** 亮起正文：從 <嵌始> 到晶片之前的 range；用 CSS Highlight API，跨行也可以。 */
function lightSegment(key: string): void {
  if (!key) return;
  unlight();
  const starts = [...document.querySelectorAll<HTMLElement>('#docText .embedSegStart')];
  const chips = [...document.querySelectorAll<HTMLElement>('#docText .embedChip')];
  const start = starts.find((el) => el.dataset.key === key || el.dataset.eid === key);
  const chip = chips.find((el) => el.dataset.key === key || el.dataset.eid === key);
  if (!start || !chip) return;
  const range = document.createRange();
  range.setStartAfter(start);
  range.setEndBefore(chip);
  const hl = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const H = (window as unknown as { Highlight?: new (r: Range) => unknown }).Highlight;
  if (hl && H) {
    hl.set('embedLit', new H(range));
    litKey = key;
    return;
  }
  // 舊瀏覽器：至少把涵蓋的行點亮
  let on = false;
  for (const line of document.querySelectorAll<HTMLElement>('#docText .docLine')) {
    if (line === start.closest('.docLine')) on = true;
    if (on) line.classList.add('embedLitLine');
    if (line === chip.closest('.docLine')) break;
  }
  litKey = key;
}

function closeEmbed(btn: HTMLElement): void {
  const next = btn.nextElementSibling as HTMLElement | null;
  if (next?.classList.contains('embedBlock')) next.remove();
  btn.classList.remove('is-open');
  btn.setAttribute('aria-expanded', 'false');
  if ((btn.dataset.key || btn.dataset.eid) === litKey) unlight();
}

async function openEmbed(btn: HTMLElement): Promise<void> {
  const next = btn.nextElementSibling as HTMLElement | null;
  if (next?.classList.contains('embedBlock')) { closeEmbed(btn); return; }
  const value = btn.dataset.embed ?? '';
  const targets = btn.dataset.embedTargets ?? '';
  const q = value.indexOf('?');
  const db = q >= 0 ? value.slice(0, q) : '';
  const anchor = q >= 0 ? value.slice(q + 1) : value;
  if (!targets && (!db || !anchor)) return;
  const label = btn.dataset.label ?? '';

  const block = document.createElement('div');
  block.className = 'embedBlock';
  block.innerHTML = '<div class="embedLoading">載入 ' + escapeHtml(anchor) + ' …</div>';
  btn.after(block);
  btn.classList.add('is-open');
  btn.setAttribute('aria-expanded', 'true');

  try {
    const res = targets
      ? await renderEmbedGroup(btn.dataset.q ?? '', targets, label)
      : await renderEmbed(db, anchor, btn.dataset.q ?? '', btn.dataset.j ?? '', label);
    block.innerHTML = res.html;
    const key = btn.dataset.key || btn.dataset.eid || '';
    if (key) {
      // 一次只開一個群組；舊面板收掉，正文亮起新的一段
      document.querySelectorAll<HTMLElement>('#docText .embedBlock').forEach((b) => { if (b !== block) b.remove(); });
      document.querySelectorAll<HTMLElement>('#docText .embedChip.is-open').forEach((b) => { if (b !== btn) b.classList.remove('is-open'); });
      lightSegment(key);
    }
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
  document.addEventListener('click', (ev) => {
    const tlink = (ev.target as Element | null)?.closest?.('button.embedTLink') as HTMLElement | null;
    if (tlink) {
      ev.preventDefault();
      ev.stopPropagation();
      const value = tlink.dataset.topen ?? '';
      const q = value.indexOf('?');
      const db = q >= 0 ? value.slice(0, q) : '';
      const anchor = q >= 0 ? value.slice(q + 1) : value;
      if (db && anchor) {
        void openTaishoAt(db, anchor, tlink.dataset.tlabel ?? '', tlink.dataset.trange ?? '', ev.ctrlKey || ev.metaKey);
      }
      return;
    }
    const btn = (ev.target as Element | null)?.closest?.('button.embedChip') as HTMLElement | null;
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    void openEmbed(btn);
  }, true);
}

