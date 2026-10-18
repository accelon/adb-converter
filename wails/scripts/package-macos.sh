#!/bin/bash
# 把編譯好的 accelon26 包成 .app ＋ zip。CI（.github/workflows/build-macos.yml）與
# 本機都用這一支，所以「本機編的」與「CI 編的」是同一個形狀。
#
#   cd wails
#   CGO_ENABLED=1 go build -tags production -trimpath \
#     -ldflags "-X main.buildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
#     -o ../build/macos/arm64/accelon26 .
#   bash scripts/package-macos.sh arm64
#
# 用法：bash scripts/package-macos.sh <arm64|x86_64> [binary]
#   預設 binary 是 ../build/macos/<arch>/accelon26（第 2 個參數可以指定別的位置，
#   例如本機編在別處的 build/macos/accelon26）。
#
# 產出（都在 ../build/macos/）：
#   <arch>/accelon26.app                     ← 拖進「應用程式」就能用
#   accelon26-macos-<arch>.zip               ← 要上傳到官網的就是這個（ditto 壓，保留簽章）
#   accelon26-macos-<arch>.zip.sha256        ← 給人核對用
#
# 沒有 Apple 開發者憑證也能跑：這裡做的是 ad-hoc 簽章（codesign --sign -），
# 使用者第一次開啟仍要在 Finder 按右鍵 →「打開」。
set -euo pipefail

# 失敗時把「哪一行、哪個指令」印出來（CI 會把它變成 annotation，本機也看得懂）。
trap 'echo "FAILED (line $LINENO): $BASH_COMMAND" >&2' ERR

ARCH="${1:?用法: bash scripts/package-macos.sh <arm64|x86_64> [binary]}"
case "$ARCH" in
  arm64|x86_64) ;;
  *) echo "不認得的架構：$ARCH（只能 arm64 或 x86_64）" >&2; exit 1 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # wails/
ROOT="$(cd "$HERE/.." && pwd)"                            # 倉庫根目錄
OUT="$ROOT/build/macos"
BIN="${2:-$OUT/$ARCH/accelon26}"
APP="$OUT/$ARCH/accelon26.app"
ZIP="$OUT/accelon26-macos-$ARCH.zip"

if [ ! -f "$BIN" ]; then
  echo "找不到執行檔：$BIN（先 go build，或用第 2 個參數指定）" >&2
  exit 1
fi

echo "→ 打包 $BIN（$ARCH）"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/accelon26"
chmod +x "$APP/Contents/MacOS/accelon26"

# 圖示：www/img/appicon.png（128×128）→ icns。iconset 只能用 Apple 規定的那幾組尺寸
# （16/32/128/256/512 ＋ @2x），多一個 64×64 就會被 iconutil 拒絕。來源只有 128×128，
# 大尺寸是放大出來的。圖示失敗不該讓打包失敗：沒有 icns 的 .app 仍然可以跑。
ICON="$ROOT/www/img/appicon.png"
if [ -f "$ICON" ]; then
  ICONSET="$OUT/$ARCH/accelon26.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$ICON" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  if ! iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/accelon26.icns"; then
    echo "（警告）icns 產生失敗，這次的 .app 沒有圖示"
    rm -f "$APP/Contents/Resources/accelon26.icns"
  fi
fi

# Info.plist：先寫一個最小的空 dict，再用 PlistBuddy 一行一行加。
# **不要**用 heredoc 塞 XML —— 腳本裡的縮排會變成 XML 宣告前面的空白，plutil 就不認得了。
P="$APP/Contents/Info.plist"
printf '%s\n' \
  '<?xml version="1.0" encoding="UTF-8"?>' \
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0"><dict/></plist>' > "$P"
/usr/libexec/PlistBuddy \
  -c "Add :CFBundleName string accelon26" \
  -c "Add :CFBundleDisplayName string accelon26" \
  -c "Add :CFBundleIdentifier string cn.shutonggui.accelon26" \
  -c "Add :CFBundleExecutable string accelon26" \
  -c "Add :CFBundleIconFile string accelon26" \
  -c "Add :CFBundlePackageType string APPL" \
  -c "Add :CFBundleShortVersionString string 1.0" \
  -c "Add :CFBundleVersion string 1.0" \
  -c "Add :LSMinimumSystemVersion string 11.0" \
  -c "Add :NSHighResolutionCapable bool true" \
  -c "Add :NSPrincipalClass string NSApplication" \
  "$P"
plutil -lint "$P"

# ad-hoc 簽章：沒有開發者憑證也能簽，簽完 Gatekeeper 比較不會說「已損毀」。
codesign --force --deep --sign - "$APP"
codesign --verify --verbose "$APP"

# ditto（不是 zip）才留得住 .app 的結構與簽章屬性。
rm -f "$ZIP" "$ZIP.sha256"
( cd "$OUT/$ARCH" && ditto -c -k --sequesterRsrc --keepParent accelon26.app "$ZIP" )
( cd "$OUT" && shasum -a 256 "accelon26-macos-$ARCH.zip" | tee "accelon26-macos-$ARCH.zip.sha256" )

echo "✓ ${ZIP#$ROOT/}"
echo "  上傳：cd ts && bun run tools/deploy-macos.ts"
