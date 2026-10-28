# adb viewer

## 用戶介面
adb 內容檢視器。

經典仿deekseek harness, obsidian 三欄介面。

## 技術架構

zero server side dependency, a SPA served by http or file:// 。網頁框架自選。

## 啟動時，以 url 參數可帶入 adb 名稱，用fetch 分段讀取文件，不要將整個adb 載入內存，網頁會炸。
如果是 file:// ，讓用戶選本機文件。成功拿到adb handle之後，進入主畫面。

## 左側
  meta分頁：顯示adb 基本訊息。
  文件清單：顯示adb 包進去的XML文件清單。點一下更新中間的內容。 
  圖片清單
 
## 中間
    上方 2/3 ：XML內容檢視，先不要渲染。
     下方 1/3：token 或 tag 的 posting list)，點一下更新文字內容 （文字要含前後文, posting 位置塗紅）。

右側：
    token 分頁: 列出所有token, postinglist 長度（可輸入過濾條件，不同方式排序，按postings 大小排序、按token Unicode）
    tag 分頁，例出所有的tag , 數量。
    圖片viewer。
