//go:build windows

package main

// window.go 的 Windows 實作：視窗樣式、游標位置、原生螢幕列舉。
// macOS 的對應實作在 window_darwin.go，兩邊簽名一致。

import (
	"fmt"
	"log"
	"syscall"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/w32"
	"golang.org/x/sys/windows"
)

// windowStyleInfo 讀視窗的 Win32 樣式，用來確認「有標題列、可以縮放、可以關、可以最大化」
// （全螢幕時 Wails 會換成 WS_POPUP，那時沒有標題列是正常的，按 Esc／F11 會回復）。
func windowStyleInfo(title string) map[string]any {
	name, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return nil
	}
	hwnd := w32.FindWindowW(nil, name)
	if hwnd == 0 {
		return map[string]any{"found": false}
	}
	style := uint32(w32.GetWindowLong(hwnd, w32.GWL_STYLE))
	return map[string]any{
		"found":       true,
		"style":       fmt.Sprintf("0x%08X", style),
		"caption":     style&w32.WS_CAPTION != 0,
		"resizable":   style&w32.WS_THICKFRAME != 0,
		"sysMenu":     style&w32.WS_SYSMENU != 0,
		"minimizeBox": style&w32.WS_MINIMIZEBOX != 0,
		"maximizeBox": style&w32.WS_MAXIMIZEBOX != 0,
		"popupOnly":   style&w32.WS_OVERLAPPEDWINDOW == 0,
	}
}

// cursorPos 是滑鼠游標的實體座標（啟動時用它判斷「使用者是在哪張螢幕雙擊 exe」）。
func cursorPos() (int, int, bool) {
	return w32.GetCursorPos()
}

// nativeScreens 用 Win32 列舉螢幕（原始資料，-screens 診斷用）。
// 注意：這與 Wails 視窗座標系**不一定同一個空間**（DPI 虛擬化），所以視窗定位不用它，
// 而是用 Wails 自己的 application.Screen（它會在需要時做 physical/DIP 換算）。
func nativeScreens(app *application.App) []screenChoice {
	list, err := w32.GetAllScreens()
	if err != nil {
		log.Printf("window: Win32 螢幕列舉失敗：%v", err)
		return nil
	}
	if len(list) == 0 {
		log.Printf("window: Win32 說沒有螢幕")
	}
	out := make([]screenChoice, 0, len(list))
	for _, s := range list {
		mon, work := s.RcMonitor, s.RcWork
		out = append(out, screenChoice{
			Name:    windows.UTF16ToString(s.SzDevice[:]),
			Primary: s.IsPrimary,
			Monitor: application.Rect{X: int(mon.Left), Y: int(mon.Top), Width: int(mon.Right - mon.Left), Height: int(mon.Bottom - mon.Top)},
			Work:    application.Rect{X: int(work.Left), Y: int(work.Top), Width: int(work.Right - work.Left), Height: int(work.Bottom - work.Top)},
		})
	}
	return out
}

// nativeScreenDetails 是 nativeScreens 的附加欄位（縮放比例、是不是游標所在那張）。
func nativeScreenDetails(app *application.App) []screenDetail {
	list, err := w32.GetAllScreens()
	if err != nil {
		return nil
	}
	out := make([]screenDetail, 0, len(list))
	for _, s := range list {
		out = append(out, screenDetail{Scale: float64(s.ScaleFactor), Current: s.IsCurrent})
	}
	return out
}

// windowScreenFallback：Windows 一定有游標座標可用，所以不需要「問視窗在哪張螢幕」
// 這條退路（留著只是讓 launchScreen 兩邊共用；回 nil 表示不採用）。
func windowScreenFallback(win *application.WebviewWindow) *application.Screen { return nil }
