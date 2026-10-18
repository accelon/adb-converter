//go:build darwin

package main

// window.go 的 macOS 實作：視窗樣式、游標位置、原生螢幕列舉。
// Windows 的對應實作在 window_windows.go，兩邊簽名一致。
//
// macOS 沒有 Win32 樣式可以讀，也沒有（不用 cgo 就取得得到的）游標座標；
// 螢幕清單則直接用 Wails 的（它包了 NSScreen，座標系與 win.SetPosition 相同）。

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// windowStyleInfo：macOS 的視窗樣式由 AppKit 管，沒有 GWL_STYLE 這種東西，
// 所以只回報「有視窗」與平台，其他欄位不猜（診斷用，UI 不依賴它）。
func windowStyleInfo(title string) map[string]any {
	return map[string]any{
		"found":    true,
		"platform": "darwin",
		"note":     "macOS 沒有 Win32 樣式可讀（標題列／縮放由 AppKit 決定）",
	}
}

// cursorPos：macOS 要拿滑鼠座標得碰 NSEvent 或 CoreGraphics（cgo）。第一版不做，
// 一律回「拿不到」，launchScreen 會改用「視窗自己在哪張螢幕」。
func cursorPos() (int, int, bool) { return 0, 0, false }

// nativeScreens：用 Wails 快取好的螢幕表（NSScreen）。Run 之前這張表是空的。
func nativeScreens(app *application.App) []screenChoice {
	all := app.Screen.GetAll()
	out := make([]screenChoice, 0, len(all))
	for _, s := range all {
		out = append(out, screenChoice{
			Name:    s.Name,
			Primary: s.IsPrimary,
			Monitor: s.Bounds,
			Work:    s.WorkArea,
		})
	}
	return out
}

// nativeScreenDetails：Wails 的 Screen 只有縮放比例，沒有「目前這張」。
func nativeScreenDetails(app *application.App) []screenDetail {
	all := app.Screen.GetAll()
	out := make([]screenDetail, 0, len(all))
	for _, s := range all {
		out = append(out, screenDetail{Scale: float64(s.ScaleFactor)})
	}
	return out
}

// windowScreenFallback：問視窗自己落在哪張螢幕。macOS 開新視窗時會放在「使用者
// 正在用的那張」（有選單列／最後互動的那張），這比退回主螢幕準得多。
func windowScreenFallback(win *application.WebviewWindow) *application.Screen {
	if win == nil {
		return nil
	}
	s, err := win.GetScreen()
	if err != nil {
		return nil
	}
	return s
}
