/**
 * 本文分頁的 adb 上下文（作者 2026-11-01）。
 *
 * 重構前：本文區的一切（頁界、渲染、xref 錨點、編輯工作階段）都直接讀
 * `viewer.ts` 的全域 `reader`／`mapper`／`session`／`docs`，所以要看別庫的本文
 * 就只能把整個 adb 切過去（`switchTo`），左欄目錄與摘要也跟著換掉。
 *
 * 重構後：每個 `DocSession` 帶著自己的 `DocCtx`（只存**參考**，不複製 reader／mapper），
 * 本文區用分頁自己的 ctx 算頁界與畫行；全域的 `reader`／`mapper` 仍然是「左欄那一庫」
 * （active slot），兩者可以不同 → 跨庫分頁可以並存。
 *
 * 這裡刻意只放型別與兩個小註冊點，不 import 任何會反向 import 本模組的東西：
 * `doc-pane` 需要「由 dbId 找回 ctx」，而那份資料在 `dbs.ts` 的 slot 裡；
 * 用 hook 註冊可以避免 `dbs ↔ doc-pane` 的循環 import。
 */
import type { AdbReader, AdbSource, DocRow } from './adb';
import type { VaPaMapper } from './vapa';
import type { SearchSession } from './search';

export interface DocCtx {
  /** 這個 ctx 屬於哪一個已開啟的 adb slot（0＝未知；0 永遠不算 active） */
  dbId: number;
  reader: AdbReader;
  mapper: VaPaMapper;
  session: SearchSession | null;
  /** 這一庫的 `<檔>` 列表（`docOfVa`／paging 用） */
  docs: DocRow[];
  /** adb 名（hover／修訂清單用） */
  dbName: string;
  /** adb 中文名（hover 用） */
  dbCName: string;
  /** 檔案身分：編輯工作階段以它為 key（`edit-session.ts` 的 sourceKey） */
  file: AdbSource | null;
  /** 檔案顯示名（viewer 的 currentFile 等價物） */
  fileName: string;
}

/** 由 dbId 取回 ctx；由 `dbs.ts` 註冊（它才有 slot 清單）。 */
export type DocCtxResolver = (dbId: number) => DocCtx | null;

let resolver: DocCtxResolver | null = null;

export function setDocCtxResolver(fn: DocCtxResolver | null): void {
  resolver = fn;
}

export function resolveDocCtx(dbId: number): DocCtx | null {
  if (!dbId) return null;
  try {
    return resolver ? resolver(dbId) : null;
  } catch {
    return null;
  }
}

/**
 * 目前 active slot 的 id。
 *
 * `doc-pane` 不能 import `dbs`（會成環），所以由 `dbs.ts` 在 `loadFrom`／
 * `registerOpenDb`／`closeDb` 時同步過來。0＝還沒有任何庫。
 */
let activeDbId = 0;

export function setActiveDocDbId(id: number): void {
  activeDbId = Number(id) || 0;
}

export function activeDocDbId(): number {
  return activeDbId;
}

/**
 * 這個 ctx 是不是「左欄正在顯示的那一庫」。
 * 只有 true 時才畫麵包屑、連動目錄游標、畫反鏈 —— 那些資料都屬於左欄那一庫，
 * 拿別庫的 VA 去查只會得到錯的節點。
 */
export function isActiveDocCtx(ctx: DocCtx | null | undefined): boolean {
  return !!ctx && activeDbId !== 0 && ctx.dbId === activeDbId;
}
