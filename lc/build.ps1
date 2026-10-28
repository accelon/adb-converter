# lc.adb 一鍵重建（CBETA LC → lc.adb）
# 用法：pwsh D:\2026\adb-converter\lc\build.ps1
$ErrorActionPreference = 'Stop'
Set-Location 'D:\2026\adb-converter'

# 0. CBETA LC 稀疏檢出（已存在就跳過）
$lcDir = 'D:\2026\xml-p5\LC'
if (-not (Test-Path $lcDir)) {
  Write-Host '== 取 CBETA LC =='
  Push-Location 'D:\2026\xml-p5'
  git -c http.proxy=socks5h://127.0.0.1:1080 sparse-checkout add LC
  Pop-Location
}

# 1. TEI → 一行一個 lb 的文字
Write-Host '== lc2adb =='
go run ./cmd/lc2adb -src $lcDir -out build/lc-text.txt -lbs build/lc.lbs.tsv

# 2. 先打包沒有 <聯> 的底本，backlink 要從它解出文字
Write-Host '== pack base =='
bun run lc/pack.ts build/lc-base.adb --base

# 3. 抽引文 → 搜大正藏 → 套 <聯>（不打包，交給下一步，順便換 logo）
Write-Host '== backlink =='
bun run ts/tools/backlink.ts --src build/lc-base.adb --slug lc --dbname lc `
  --taisho accelon3/taisho.adb `
  --cues "經云：,論曰：,論云：,曰：,云：,說：,：「,：『,頌曰：,文云：,又云：,所謂「,「" `
  --no-pack

# 4. 打包最終 lc.adb，並複製到 D:\accelon3\lc.adb
Write-Host '== pack lc.adb =='
bun run lc/pack.ts

# 5. 驗收
Write-Host '== validate =='
bun run lc/validate.ts
