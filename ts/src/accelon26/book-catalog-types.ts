/** 書目登錄（book catalog）的型別；資料在 book-catalog.json，打包進 accelon26。 */
export type BookCollection = 'accelon3' | 'sz';
export type BookKind = 'text' | 'dict' | 'reference' | 'index' | 'guide';
export type BookStatus = 'ready' | 'wip' | 'retired';

export interface BookCatalogEntry {
  /** 穩定 id，也是 adb 檔名去掉 .adb（例：cyd、taisho） */
  id: string;
  /** 同資料夾的 adb 檔名 */
  adb: string;
  /** adb 檔頭 dbname；有些庫是空的 */
  dbname?: string;
  title: string;
  aliases: string[];
  english?: string;
  author?: string;
  edition?: string;
  source?: string;
  collection: BookCollection;
  kind: BookKind;
  status: BookStatus;
  /** bytes */
  size: number;
  /** 目標定位方式；page-id 表示 <頁 id>，entry-name 表示詞頭 */
  pageScheme?: 'page-id' | 'entry-name' | 'line';
  /** adb 內容 sha256（可選；有給時可用來判斷 xref 是否過期） */
  contentHash?: string;
  /** 詞典的條目標籤（例：詞） */
  entryTag?: string;
}

/**
 * 一個 work = 一個穩定的「書」身份，例如《易》。
 * work 可以有多個 edition；每個 edition 指向目前包含它的 adb 與 adb 內的書 id。
 */
export interface WorkEdition {
  /** 目前承載這個 work 的 adb id（book-catalog 的 id） */
  adb: string;
  /** adb 內的 <書 id>；單書 adb 可省略 */
  book?: string;
  /** 版本／底本 */
  edition?: string;
  status?: BookStatus;
  pageScheme?: 'page-id' | 'entry-name' | 'line';
}

export interface WorkCatalogEntry {
  /** 穩定 work id（建議 pinyin slug，例如 yijing、zhuangzi） */
  id: string;
  title: string;
  aliases: string[];
  /** 可能有多個版本；resolver 依已安裝／hint 選 */
  editions: WorkEdition[];
}
