/**
 * 壓縮檔裡的使用說明（作者 2026-10-18）：一份簡體、一份繁體，內容一樣。
 *
 * 兩份都存成 **UTF-8 帶 BOM ＋ CRLF**：Windows 記事本沒有 BOM 時會用系統編碼讀，
 * 簡體／繁體字就會變亂碼。要改文字只改這裡，release.ts 與 pack-7z.ts 共用。
 */
import { writeFileSync } from 'node:fs';

export const README_SIMPLIFIED = `accelon26 使用说明
==================

1) 解压后，把 accelon26.exe 放到 accelon3.exe 同一个文件夹里
   （也就是 .adb 数据库文件所在的那个文件夹）。
   不需要安装，也不需要管理员权限，双击就能打开。

2) 打开后会自动列出同一个文件夹里的 .adb 数据库。
   也可以用右上角的文件夹按钮，或直接把 .adb 文件拖进窗口。

3) 遇到问题、想加功能，欢迎留言或直接找我：
   留言页：https://shutonggui.cn/accelon26/message.html
   官  网：https://shutonggui.cn/accelon26/
   微  信：Sukhanika

4) 程序会自己检查更新：官网发布新版时，左上角的 accelon26 会闪动，
   点一下就能更新，不用重新下载压缩包。

系统要求：Windows 10 / 11（64 位）。
`;

export const README_TRADITIONAL = `accelon26 使用說明
==================

1) 解壓縮後，把 accelon26.exe 放到 accelon3.exe 同一個資料夾裡
   （也就是 .adb 資料庫檔所在的那個資料夾）。
   不需要安裝，也不需要管理員權限，雙擊就能開啟。

2) 開啟後會自動列出同一個資料夾裡的 .adb 資料庫。
   也可以用右上角的資料夾按鈕，或直接把 .adb 檔拖進視窗。

3) 遇到問題、想加功能，歡迎留言或直接找我：
   留言頁：https://shutonggui.cn/accelon26/message.html
   官  網：https://shutonggui.cn/accelon26/
   微  信：Sukhanika

4) 程式會自己檢查更新：官網發布新版時，左上角的 accelon26 會閃動，
   點一下就能更新，不用重新下載壓縮檔。

系統需求：Windows 10 / 11（64 位元）。
`;

/** 寫出 UTF-8 帶 BOM、CRLF 換行的純文字（Windows 記事本才會正確辨識編碼）。 */
export function writeTextFileBom(path: string, text: string): void {
  const body = text.replace(/\r?\n/g, '\r\n');
  writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]));
}
