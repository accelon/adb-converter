# Third-party notices

本專案執行期沒有 npm 依賴；以下兩個元件以 vendored 形式放在 ts/src/vendor/，只隨
單檔 HTML 一起發出。

## CodeMirror 6

* 套件：@codemirror/state、@codemirror/view、@codemirror/commands（build 時打包）
* 授權：MIT
* 檔案：ts/src/vendor/codemirror/codemirror.js、LICENSE-state／LICENSE-view／LICENSE-commands
* 重新產生：ts/tools/build-codemirror.ts（開發用；需要 npm 安裝上述套件）

## bzip2-wasm

* 來源：bzip2-wasm 1.0.1（Zorian Medwid），內含 bzip2 1.0.8
* 授權：bzip2-1.0.6（見 ts/src/vendor/bzip2-wasm/LICENSE）
* 檔案：bzip2.mjs、bzip2.wasm、bzip2-wasm-data.ts
* 重新產生 base64：ts/tools/gen-bzip2-wasm.ts
* 已把 import.meta.url 兩處改成單檔可用的字串；wasmBinary 由 bzip2-wasm.ts 直接提供，不再 fetch 旁邊的 .wasm。
