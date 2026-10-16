package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func rect(x, y, w, h int) application.Rect { return application.Rect{X: x, Y: y, Width: w, Height: h} }

// TestWindowStateRoundTrip：狀態檔寫了要讀得回來（在暫存目錄，不碰使用者真正的設定）。
func TestWindowStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ADBVIEW_STATE_DIR", dir)
	if _, ok := loadWindowState(); ok {
		t.Fatal("空的目錄不該讀得到設定")
	}
	want := windowState{RelX: 120, RelY: 80, W: 1024, H: 768, State: stateMaximised, Screen: `\\.\DISPLAY2`}
	if err := saveWindowState(want); err != nil {
		t.Fatal(err)
	}
	got, ok := loadWindowState()
	if !ok {
		t.Fatal("讀不回剛寫的設定")
	}
	if got != want {
		t.Fatalf("讀回的不一樣：got %+v want %+v", got, want)
	}
	// 壞掉的檔案要當成「第一次」而不是讓程式起不來
	if err := os.WriteFile(filepath.Join(dir, "window.json"), []byte("不是 json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := loadWindowState(); ok {
		t.Fatal("壞掉的設定檔應該被忽略")
	}
}

// TestClampWindowState：上次在外接螢幕、這回那張不在了 —— 位置與大小都要夾進工作區。
func TestClampWindowState(t *testing.T) {
	work := rect(0, 0, 1920, 1040)
	cases := []struct {
		name     string
		in, want windowState
	}{
		{"位置越界 → 貼齊右下", windowState{RelX: 3000, RelY: 2000, W: 800, H: 600},
			windowState{RelX: 1120, RelY: 440, W: 800, H: 600}},
		{"負的位置 → 歸零", windowState{RelX: -500, RelY: -300, W: 800, H: 600},
			windowState{RelX: 0, RelY: 0, W: 800, H: 600}},
		{"比工作區還大 → 縮到工作區", windowState{RelX: 10, RelY: 20, W: 4000, H: 3000},
			windowState{RelX: 0, RelY: 0, W: 1920, H: 1040}},
		{"太小 → 拉到最小尺寸", windowState{RelX: 5, RelY: 5, W: 10, H: 10},
			windowState{RelX: 5, RelY: 5, W: minWindowW, H: minWindowH}},
		{"剛好放得下 → 原封不動", windowState{RelX: 100, RelY: 100, W: 800, H: 600},
			windowState{RelX: 100, RelY: 100, W: 800, H: 600}},
	}
	for _, c := range cases {
		got := clampWindowState(c.in, work)
		if got.W != c.want.W || got.H != c.want.H || got.RelX != c.want.RelX || got.RelY != c.want.RelY {
			t.Errorf("%s：got %+v want %+v", c.name, got, c.want)
		}
	}
	// 工作區比最小尺寸還小（罕見）時，以工作區為準
	got := clampWindowState(windowState{W: 800, H: 600}, rect(0, 0, 320, 240))
	if got.W != 320 || got.H != 240 {
		t.Errorf("小工作區：got %+v", got)
	}
}

// TestPickLaunchScreen：游標那張 → 主螢幕 → 第一張；游標在邊界也算那一張。
func TestPickLaunchScreen(t *testing.T) {
	primary := screenChoice{Name: "P", Primary: true, Monitor: rect(0, 0, 1920, 1080), Work: rect(0, 0, 1920, 1040)}
	left := screenChoice{Name: "L", Monitor: rect(-1280, 0, 1280, 1024), Work: rect(-1280, 0, 1280, 1024)}
	right := screenChoice{Name: "R", Monitor: rect(1920, 200, 1600, 900), Work: rect(1920, 240, 1600, 860)}
	all := []screenChoice{primary, left, right}

	if got, _ := pickLaunchScreen(all, -100, 500, true); got.Name != "L" {
		t.Errorf("游標在左螢幕：got %s", got.Name)
	}
	if got, _ := pickLaunchScreen(all, 2400, 400, true); got.Name != "R" {
		t.Errorf("游標在右螢幕：got %s", got.Name)
	}
	// 游標剛好落在右螢幕的右下角（邊界算在內）
	if got, _ := pickLaunchScreen(all, 3520, 1100, true); got.Name != "R" {
		t.Errorf("游標在右螢幕角落：got %s", got.Name)
	}
	// 游標不在任何螢幕（外接螢幕被拔掉的座標）→ 主螢幕
	if got, _ := pickLaunchScreen(all, 5000, 5000, true); got.Name != "P" {
		t.Errorf("游標在外太空：got %s", got.Name)
	}
	// 拿不到游標 → 主螢幕；沒有主螢幕 → 第一張
	if got, _ := pickLaunchScreen(all, 0, 0, false); got.Name != "P" {
		t.Errorf("沒有游標：got %s", got.Name)
	}
	noPrimary := []screenChoice{left, right}
	if got, _ := pickLaunchScreen(noPrimary, 0, 0, false); got.Name != "L" {
		t.Errorf("沒有主螢幕：got %s", got.Name)
	}
	if _, ok := pickLaunchScreen(nil, 0, 0, true); ok {
		t.Error("一張都沒有時應該回 ok=false")
	}
}
