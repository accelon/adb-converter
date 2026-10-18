package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// ---- 視窗位置與螢幕選擇（作者 2026-10） ------------------------------------------
//
//   1. 第一次啟動 → 全螢幕
//   2. 離開時記下視窗設定（位置、大小、狀態），下次恢復
//   3. 使用者可能有多張外接螢幕，**上次那張這回不一定還在** → 一律以「使用者執行 exe 的那個
//      螢幕」為準（＝啟動瞬間滑鼠游標所在的螢幕：雙擊／點執行就是在那裡），偵測不到就退回
//      主螢幕，再不行用列舉到的第一張
//   4. 記憶的位置是**相對該螢幕工作區原點**（Wails 的 WindowXY ＋ Screen 就是這個語意），
//      所以換螢幕／換解析度都不會把視窗丟到畫面外；大小再夾進工作區
//
// 狀態檔：%AppData%\accelon26\window.json（可用 ACCELON26_STATE_DIR 覆寫，測試與可攜版用）

const (
	stateNormal     = "normal"
	stateMaximised  = "maximised"
	stateFullscreen = "fullscreen"
	defaultWindowW  = 1400
	defaultWindowH  = 900
	minWindowW      = 480
	minWindowH      = 360
)

// windowState 就是「下次啟動要恢復什麼」。RelX/RelY 相對所在螢幕的工作區原點。
type windowState struct {
	RelX   int    `json:"relX"`
	RelY   int    `json:"relY"`
	W      int    `json:"w"`
	H      int    `json:"h"`
	State  string `json:"state"`
	Screen string `json:"screen,omitempty"` // 上次那張螢幕的名字（僅供診斷）
}

// stateDir 回傳狀態檔目錄；ACCELON26_STATE_DIR 優先（測試、可攜版）。
func stateDir() string {
	if d := os.Getenv("ACCELON26_STATE_DIR"); d != "" {
		return d
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		return ""
	}
	return filepath.Join(base, "accelon26")
}

func statePath() string {
	dir := stateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "window.json")
}

// loadWindowState 讀回上次的設定；沒有、讀不到或壞掉都回 ok=false（＝當成第一次）。
func loadWindowState() (windowState, bool) {
	path := statePath()
	if path == "" {
		return windowState{}, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return windowState{}, false
	}
	var st windowState
	if err := json.Unmarshal(raw, &st); err != nil {
		return windowState{}, false
	}
	if st.W < minWindowW || st.H < minWindowH {
		return windowState{}, false
	}
	return st, true
}

// saveWindowState 原子寫入（先寫 .tmp 再 rename），避免半寫入的檔案讓下次讀不到。
func saveWindowState(st windowState) error {
	path := statePath()
	if path == "" {
		return fmt.Errorf("no state directory")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// clampWindowState 把記住的矩形夾進工作區：大小不超過工作區、位置不越界。
// 「上次在外接螢幕、位置 3000,800，這回只有主螢幕」就是靠這裡救回來的。
func clampWindowState(st windowState, wa application.Rect) windowState {
	if wa.Width <= 0 || wa.Height <= 0 {
		return st
	}
	if st.W > wa.Width {
		st.W = wa.Width
	}
	if st.H > wa.Height {
		st.H = wa.Height
	}
	if st.W < minWindowW {
		st.W = minWindowW
	}
	if st.H < minWindowH {
		st.H = minWindowH
	}
	if st.W > wa.Width {
		st.W = wa.Width // 工作區比最小尺寸還小時，以工作區為準
	}
	if st.H > wa.Height {
		st.H = wa.Height
	}
	maxX, maxY := wa.Width-st.W, wa.Height-st.H
	if maxX < 0 {
		maxX = 0
	}
	if maxY < 0 {
		maxY = 0
	}
	if st.RelX > maxX {
		st.RelX = maxX
	}
	if st.RelY > maxY {
		st.RelY = maxY
	}
	if st.RelX < 0 {
		st.RelX = 0
	}
	if st.RelY < 0 {
		st.RelY = 0
	}
	return st
}

// screenChoice 是「選哪張螢幕」需要的最小資訊。抽出來的好處：選螢幕的邏輯是純函式，
// 可以單元測試，也能給不需要建立 App 的 -screens 用（App 的螢幕快取要 Run 之後才有）。
type screenChoice struct {
	Name    string
	Primary bool
	Monitor application.Rect // 整張螢幕（含工具列），用來判斷游標在哪張
	Work    application.Rect // 工作區（不含工具列），用來夾視窗位置
}

// screenDetail 是一張螢幕的原始列舉細節（只有 -screens 診斷在用）：
// Wails 的 Screen 沒有「目前這張」這個概念，DPI 也是換算過的。
type screenDetail struct {
	Scale   float64
	Current bool
}

// pickLaunchScreen 是唯一的選螢幕邏輯：**游標落在哪張螢幕的工作區就用那張**
// （使用者雙擊／點執行就是在那一張）；游標不在任何一張（或拿不到游標）就用主螢幕；
// 都沒有就用第一張。回 ok=false 表示一張都列舉不到。
func pickLaunchScreen(screens []screenChoice, cursorX, cursorY int, hasCursor bool) (screenChoice, bool) {
	if len(screens) == 0 {
		return screenChoice{}, false
	}
	if hasCursor {
		pt := application.Point{X: cursorX, Y: cursorY}
		// 先用整張螢幕（含工具列）判斷：游標停在工具列或螢幕邊界上也該算那一張
		for _, s := range screens {
			if containsInclusive(s.Monitor, cursorX, cursorY) {
				return s, true
			}
		}
		for _, s := range screens {
			if s.Work.Contains(pt) {
				return s, true
			}
		}
	}
	for _, s := range screens {
		if s.Primary {
			return s, true
		}
	}
	return screens[0], true
}

// 視窗樣式、原生螢幕列舉、游標位置這三件事是平台相依的：
//   windowStyleInfo／nativeScreens／nativeScreenDetails／cursorPos／windowScreenFallback
// 分別在 window_windows.go（Win32）與 window_darwin.go（Wails＋NSScreen）實作。
// 下面這些邏輯本身與平台無關，所以兩邊共用同一份。

// containsInclusive 與 Rect.Contains 相同，只是右／下邊界也算在內
// （游標剛好停在螢幕角落或工具列邊緣時，不要因為差一格就掉回主螢幕）。
func containsInclusive(r application.Rect, x, y int) bool {
	return x >= r.X && x <= r.X+r.Width && y >= r.Y && y <= r.Y+r.Height
}

// launchScreen 回傳「使用者執行 exe 的那個螢幕」。走 Wails 自己的螢幕表：
// 用**游標位置**去問 ScreenNearestPhysicalRect（它負責 physical/DIP 換算），
// 所以回來的 Screen.WorkArea 與 win.SetPosition/SetSize 是同一個座標系。
// 游標問不到（被拔掉的外接螢幕座標、拿不到游標、或平台沒有游標 API）就問視窗自己
// 落在哪張螢幕（macOS：新視窗開在「使用者正在用的那張」），再不行退回主螢幕。
func launchScreen(app *application.App, win *application.WebviewWindow) *application.Screen {
	// Wails 的螢幕快取要 Run 之後才會有（-screens 在 Run 之前跑，那邊是空的），
	// 空的時候不必問，也問不出東西。
	hasTable := len(app.Screen.GetAll()) > 0
	if x, y, ok := cursorPos(); ok && hasTable {
		if s := application.ScreenNearestPhysicalRect(application.Rect{X: x, Y: y, Width: 1, Height: 1}); s != nil {
			return s
		}
		log.Printf("window: 游標 (%d,%d) 不在任何螢幕上，改用視窗所在螢幕", x, y)
	}
	if s := windowScreenFallback(win); s != nil {
		return s
	}
	if p := app.Screen.GetPrimary(); p != nil {
		return p
	}
	all := app.Screen.GetAll()
	if len(all) > 0 {
		return all[0]
	}
	return nil
}

// launchWorkArea 回傳啟動螢幕的工作區（見 launchScreen）。
func launchWorkArea(app *application.App, win *application.WebviewWindow) (application.Rect, string, bool) {
	s := launchScreen(app, win)
	if s == nil {
		return application.Rect{}, "", false
	}
	return s.WorkArea, s.Name, true
}


// screenOfRect 找出某個矩形（視窗的絕對座標）落在哪張螢幕上；找不到就回主螢幕。
func screenOfRect(app *application.App, r application.Rect) *application.Screen {
	if s := application.ScreenNearestPhysicalRect(r); s != nil {
		return s
	}
	if p := app.Screen.GetPrimary(); p != nil {
		return p
	}
	screens := app.Screen.GetAll()
	if len(screens) > 0 {
		return screens[0]
	}
	return nil
}

// geometry 是視窗的絕對矩形（實體像素）。
type geometry struct {
	X, Y, W, H int
}

// windowTracker 記住「最後一次非最大化／非全螢幕的幾何」與目前狀態，
// 離開時寫成 windowState。全螢幕或最大化時 Position/Size 拿到的是當下的框，
// 不是還原後的框，所以才需要 last。
type windowTracker struct {
	app *application.App
	win *application.WebviewWindow
	mu  sync.Mutex
	// 事件驅動：save() 可能在視窗已經銷毀之後才被呼叫（OnShutdown），那時
	// Position()/Size() 已經拿不到東西，所以狀態都在事件裡先記下來。
	cur        *geometry // 最近的框（任何狀態）
	lastNormal *geometry // 最後一次 normal 狀態的框（還原用）
	curState   string
	saved      bool
	// 啟動時選了哪張螢幕（排錯用：多螢幕問題要看的就是這個）
	launchScreen string
	launchWork   application.Rect
}

func newWindowTracker(app *application.App, win *application.WebviewWindow) *windowTracker {
	return &windowTracker{app: app, win: win}
}

// snapshot 在每個視窗事件後更新：目前狀態、目前的框，以及「最後一次 normal 的框」。
func (t *windowTracker) snapshot() {
	if t.win == nil {
		return
	}
	full := t.win.IsFullscreen()
	max := t.win.IsMaximised()
	state := stateNormal
	switch {
	case full:
		state = stateFullscreen
	case max:
		state = stateMaximised
	}
	x, y := t.win.Position()
	w, h := t.win.Size()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.curState = state
	if w > 0 && h > 0 {
		t.cur = &geometry{X: x, Y: y, W: w, H: h}
		if state == stateNormal {
			t.lastNormal = t.cur
		}
	}
}

// setLaunch 記下啟動時選的螢幕與工作區（WindowInfo 會回報，測試與排錯用）。
func (t *windowTracker) setLaunch(screen string, work application.Rect) {
	t.mu.Lock()
	t.launchScreen, t.launchWork = screen, work
	t.mu.Unlock()
}

func (t *windowTracker) state() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.stateLocked()
}

// stateLocked 供已持有鎖的呼叫者使用。
func (t *windowTracker) stateLocked() string {
	if t.curState == "" {
		return stateNormal
	}
	return t.curState
}

// save 把目前的設定寫進狀態檔（離開時呼叫；重複呼叫只寫一次）。
func (t *windowTracker) save() {
	t.mu.Lock()
	if t.saved {
		t.mu.Unlock()
		return
	}
	g := t.lastNormal
	if g == nil {
		g = t.cur
	}
	if g == nil && t.win != nil { // 理論上不會走到這裡（事件會先記下來）
		x, y := t.win.Position()
		w, h := t.win.Size()
		if w > 0 && h > 0 {
			g = &geometry{X: x, Y: y, W: w, H: h}
		}
	}
	st := t.stateLocked()
	t.mu.Unlock()
	if g == nil {
		return
	}
	// **用啟動時選的那張螢幕**（而不是「視窗框最近的那張」）來算相對位置：
	// 平台可能把視窗挪幾十像素，剛好跨過螢幕邊界時，「最近的那張」會在兩張之間跳，
	// 存下來的相對位置就會在兩個座標系之間擺盪。用啟動螢幕＝使用者看到的那張才穩定。
	t.mu.Lock()
	launch, work := t.launchScreen, t.launchWork
	t.mu.Unlock()
	out := windowState{W: g.W, H: g.H, State: st}
	if launch != "" && work.Width > 0 && work.Height > 0 {
		out.Screen = launch
		out.RelX = g.X - work.X
		out.RelY = g.Y - work.Y
		out = clampWindowState(out, work)
	} else if scr := screenOfRect(t.app, application.Rect{X: g.X, Y: g.Y, Width: g.W, Height: g.H}); scr != nil {
		out.Screen = scr.Name
		out.RelX = g.X - scr.WorkArea.X
		out.RelY = g.Y - scr.WorkArea.Y
		out = clampWindowState(out, scr.WorkArea)
	}
	if err := saveWindowState(out); err != nil {
		log.Printf("window state: 寫入失敗 %v（%s）", err, statePath())
		return
	}
	log.Printf("window state: 已記下 %dx%d@%d,%d state=%s 螢幕=%s → %s", out.W, out.H, out.RelX, out.RelY, out.State, out.Screen, statePath())
	t.mu.Lock()
	t.saved = true
	t.mu.Unlock()
}

// info 是給測試／排錯看的視窗現況（不經 UI，直接由 AdbHost.WindowInfo 轉出去）。
func (t *windowTracker) info() map[string]any {
	out := map[string]any{"statePath": statePath()}
	if t.win == nil {
		return out
	}
	x, y := t.win.Position()
	w, h := t.win.Size()
	out["x"], out["y"], out["w"], out["h"] = x, y, w, h
	out["state"] = t.state()
	out["maximised"] = t.win.IsMaximised()
	out["fullscreen"] = t.win.IsFullscreen()
	if scr := screenOfRect(t.app, application.Rect{X: x, Y: y, Width: w, Height: h}); scr != nil {
		out["screen"] = scr.Name
		out["screenPrimary"] = scr.IsPrimary
		out["workArea"] = scr.WorkArea
	}
	t.mu.Lock()
	if t.lastNormal != nil {
		out["lastNormal"] = *t.lastNormal
	}
	if t.cur != nil {
		out["lastAny"] = *t.cur
	}
	out["trackerState"] = t.stateLocked()
	out["style"] = windowStyleInfo("accelon26") // 標題列／縮放／關閉／最大化（診斷用）
	if t.launchScreen != "" {
		out["launchScreen"] = t.launchScreen
		out["launchWorkArea"] = t.launchWork
	}
	t.mu.Unlock()
	return out
}

// screensInfo 是 -screens 的輸出：列舉到的每一張螢幕、游標位置、以及會選哪一張。
// Windows 用 Win32 的原始列舉（連 scale／current 都有），macOS 用 Wails 的螢幕表 ——
// 兩者都只是診斷用，視窗定位一律走 Wails 的座標系（見 launchScreen）。
func screensInfo(app *application.App, win *application.WebviewWindow) string {
	out := "accelon26 -screens\n"
	x, y, hasCursor := cursorPos()
	if hasCursor {
		out += fmt.Sprintf("cursor: (%d,%d)\n", x, y)
	} else {
		out += "cursor: (拿不到)\n"
	}
	choices := nativeScreens(app)
	details := nativeScreenDetails(app)
	for i, c := range choices {
		scale, current := 1.0, false
		if i < len(details) {
			scale, current = details[i].Scale, details[i].Current
		}
		out += fmt.Sprintf("  #%d %s primary=%v current=%v scale=%.2f monitor=(%d,%d %dx%d) work=(%d,%d %dx%d)\n",
			i, c.Name, c.Primary, current, scale,
			c.Monitor.X, c.Monitor.Y, c.Monitor.Width, c.Monitor.Height,
			c.Work.X, c.Work.Y, c.Work.Width, c.Work.Height)
	}
	if s := launchScreen(app, win); s != nil {
		out += fmt.Sprintf("Wails 選的啟動螢幕: %s primary=%v work=(%d,%d %dx%d) bounds=(%d,%d %dx%d)\n",
			s.Name, s.IsPrimary, s.WorkArea.X, s.WorkArea.Y, s.WorkArea.Width, s.WorkArea.Height,
			s.Bounds.X, s.Bounds.Y, s.Bounds.Width, s.Bounds.Height)
	}
	if chosen, ok := pickLaunchScreen(choices, x, y, hasCursor); ok {
		out += fmt.Sprintf("launch screen: %s (primary=%v, work %dx%d)\n", chosen.Name, chosen.Primary, chosen.Work.Width, chosen.Work.Height)
	} else {
		out += "launch screen: （列舉不到螢幕，交給 OS）\n"
	}
	if st, ok := loadWindowState(); ok {
		out += fmt.Sprintf("saved state: %+v\n", st)
	} else {
		out += "saved state: （無 → 這次會全螢幕）\n"
	}
	out += "state path: " + statePath() + "\n"
	return out
}

// windowEvents 是要監看的視窗事件（移動／縮放／狀態變化 → snapshot；關閉 → save）。
func windowEvents() []events.WindowEventType {
	return []events.WindowEventType{
		events.Common.WindowDidMove,
		events.Common.WindowDidResize,
		events.Common.WindowMaximise,
		events.Common.WindowUnMaximise,
		events.Common.WindowFullscreen,
		events.Common.WindowUnFullscreen,
	}
}
