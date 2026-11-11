# 下次發布要加 `*.br`（shutonggui.cn 已支援 brotli）

> 2026-11-06 作者指示：伺服器已經有 brotli，**各工作區下回發布時一併產生並上傳 `*.br`**。
> 這份是通用版；各區只差在「你的部署腳本在哪、現在傳什麼」。

## 1. 要做什麼（一句話）

發布 `xxx.html` 時，**同時**產生 `xxx.html.br`（brotli q11）與 `xxx.html.gz`（gzip -9），
三個檔一起上傳到同一個目錄。伺服器端的 `brotli_static` / `gzip_static` 會自己挑。

## 2. 怎麼產生（Windows 沒裝 brotli CLI 也可以）

Node 內建就有，不必裝東西（`vcpp\deploy.mjs` 已經這樣做，可直接抄）：

```js
import zlib from 'node:zlib';
const plain = fs.readFileSync('xxx.html');
fs.writeFileSync('xxx.html.gz', zlib.gzipSync(plain, { level: 9 }));
fs.writeFileSync('xxx.html.br', zlib.brotliCompressSync(plain, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
}));
```

品質別省：q11 對我們這種文言文單檔（3–5 MiB）比 q9 再省 3–5%，編一次多幾秒而已。

## 3. 驗收（發布後一定要做）

```bash
# 有沒有真的送 brotli
curl -sI -H "Accept-Encoding: br"   https://shutonggui.cn/incubator/xxx.html | grep -i content-encoding
curl -sI -H "Accept-Encoding: gzip" https://shutonggui.cn/incubator/xxx.html | grep -i content-encoding

# 大小關係（br 應該比 gz 小）
curl -sI https://shutonggui.cn/incubator/xxx.html.br | grep -i content-length
```

- 兩個都要回 `Content-Encoding: br` / `gzip`，不能只回 gzip。
- 若 br 沒生效：先確認 `brotli_static on;` 有沒有開（那是伺服器設定，不是工作區的事），
  再確認檔名是 `xxx.html.br`（不是 `xxx.br.html`、不是 `xxx.br`）。
- 鏡像站 `nissaya.cn` 也要各驗一次（vcpp 的經驗：兩站設定不一定同步）。

## 4. 三個坑

1. **壓縮檔過期比沒有更糟**：改了 html 卻忘了重產 `.br`／`.gz`，nginx 會照樣送舊的壓縮檔。
   做法跟 `vcpp\deploy.mjs` 一樣——**每次部署都從同一個 buffer 現場壓**，不要留著上次的檔案。
2. **上傳順序**：先傳 `.br`／`.gz` 再傳 `.html`（或三個一起），避免中間態出現「新 html + 舊 br」。
3. **`.br` 仍是 `Content-Type: text/html`**：nginx 依**原檔名**判斷型別，`br` 只當 `Content-Encoding`。
   不要為了讓它「認得」而改名。

## 5. 各區現況（2026-11-06 查過）

| 工作區 | 現在的部署腳本 | 現況 | 下回要做 |
|---|---|---|---|
| `vcpp` | `deploy.mjs` | **已經上傳 `vcpp.html.gz`／`.br`** | 不用改，可當範本 |
| `surangama` | `scripts\deploy-incubator.mjs` | 只傳 `surangama.html`（＋projects.json、index.html、check.mjs） | 加 `.gz`／`.br` 兩個檔 |
| `shl` | 無（只有 `deploy\incubator.json` 清單） | 還沒部署過 | 第一次部署就要含 `.br` |
| `yjj` | 無 | 尚未部署 | 部署時一併做 |
| `xinjing` | 無 | 尚未部署 | 同上 |
| `adb-converter` | `ts\tools\publish-incubator.ts` | 沒處理壓縮檔 | 加 `.gz`／`.br`（官網那支也順便看） |

> `zhu-combined` 是閱讀器本體，不部署，不用管。

## 6. 最小改法（surangama 為例）

`scripts\deploy-incubator.mjs` 的 `FILES` 目前是：

```js
const FILES = ['surangama.html', 'projects.json', 'index.html', 'check.mjs'];
```

改成先壓再一起傳：

```js
import zlib from 'node:zlib';
const plain = fs.readFileSync(path.join(ROOT, 'surangama.html'));
fs.writeFileSync(path.join(ROOT, 'surangama.html.gz'), zlib.gzipSync(plain, { level: 9 }));
fs.writeFileSync(path.join(ROOT, 'surangama.html.br'), zlib.brotliCompressSync(plain, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
}));
const FILES = ['surangama.html', 'surangama.html.gz', 'surangama.html.br',
               'projects.json', 'index.html', 'check.mjs'];
```

（`surangama.html` 的 `.gz` 若已在別處產生，確認是「同一次建置的同一份 buffer」就好。）

## 7. 回報

發布後在各自 `docs\build-log.md` 記一列，並寫下驗收結果：

```text
2026-11-xx | <sha> | html 5.02 MiB / gz 1.9 MiB / br 1.6 MiB | ...
          | Accept-Encoding: br → Content-Encoding: br ✓（主站、鏡像都驗）
```

