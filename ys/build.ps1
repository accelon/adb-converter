# ys.adb 重建流程（CBETA Y 更新後直接跑這個）
$ErrorActionPreference = 'Stop'
Set-Location 'D:\2026\adb-converter'
go run ./cmd/y2adb -src 'D:\2026\xml-p5\Y' -out 'build\ys-text.txt' -lbs 'build\ys.lbs.tsv'
bun run ys/prep.ts        # 序文（ys/ys-foreword.txt）＋附錄（ys/appendix.txt）
bun run ys/calibrate.ts   # 依對照表插入 <聯>
bun run ys/pack.ts        # 打包 ys.adb（含 logo）
Write-Host 'ys.adb rebuilt'
