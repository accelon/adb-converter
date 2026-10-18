// Command accelon26 是 accelon26 單檔 HTML 應用的 Wails3 桌面宿主（作者 2026-10 改名）。
// Go 層極薄：只註冊一個 AdbHost service（列 *.adb + mmap 讀位元組區間），
// UI 全在 assets/index.html 裡（由倉庫根目錄的 TypeScript 建置腳本產生）。
package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// assets 裡就是建置好的單檔 accelon26；webview 開啟 "/" 時由它提供 index.html。
// 這個目錄必須一直存在，否則 //go:embed 會編譯失敗。
//
//go:embed all:assets
var assets embed.FS

func main() {
	// -selftest：完全不開 GUI，跑一遍自檢後結束，用來在命令列驗證 exe。
	selftest := flag.Bool("selftest", false, "run the headless self test and exit")
	screens := flag.Bool("screens", false, "print the enumerated screens, the cursor and the launch screen, then exit")
	updatedFrom := flag.String("updated-from", "", "internal: build time of the exe this one replaced (shows the release notes)")
	debugPortFlag := flag.String("debug-port", "", "internal: WebView2 remote debugging port (overrides ACCELON26_DEBUG_PORT)")
	showVersion := flag.Bool("version", false, "print the build time, the release notes count and the update URL, then exit")
	checkUpdate := flag.Bool("check-update", false, "check the update URL now, print the status as JSON and exit")
	// 更新流程的「重新啟動器」：由舊版副本（accelon26-prev.exe）執行，等舊行程結束後才開新版。
	relaunchPid := flag.Int("relaunch-pid", 0, "internal: pid of the process this one must wait for")
	relaunchExe := flag.String("relaunch-exe", "", "internal: exe to start after that process exits")
	relaunchFrom := flag.String("relaunch-from", "", "internal: -updated-from for the new exe")
	relaunchPort := flag.String("relaunch-port", "", "internal: -debug-port for the new exe")
	flag.Parse()
	if *relaunchPid > 0 && *relaunchExe != "" {
		os.Exit(runRelauncher(*relaunchPid, *relaunchExe, *relaunchFrom, *relaunchPort))
	}
	if *selftest {
		os.Exit(runSelfTest())
	}
	if *showVersion {
		fmt.Printf("accelon26\nbuild time: %s (from %s)\nrelease notes: %d entries\nupdate URL: %s\nversion info: %s\nexe: %s\n",
			shortTime(exeBuildTime()), buildSource, len(allReleaseNotes()), updateURL(), manifestURL(), exePath())
		return
	}
	// -check-update：發布前驗線上的 versions.json（診斷用；連本地建置的 exe 也真的連網）。
	if *checkUpdate {
		forceUpdateCheck = true
		h := &AdbHost{}
		h.SetUpdatedFrom(*updatedFrom)
		info := h.CheckUpdate()
		b, _ := json.MarshalIndent(info, "", "  ")
		fmt.Println(string(b))
		return
	}

	host := &AdbHost{}
	host.SetUpdatedFrom(*updatedFrom)
	// 這次是被更新程式重啟的：等重新啟動器（accelon26-prev.exe）收工後，把上一版刪掉。
	// 新版要是在這幾秒內崩掉就不刪 —— 那時 prev 正是使用者的退路。
	if *updatedFrom != "" {
		go func() {
			time.Sleep(6 * time.Second)
			cleanupPrevExe()
		}()
	}

	// 只註冊一個 service。前端用 /wails/runtime.js 的 Call.ByName 直接呼叫：
	//   Call.ByName("main.AdbHost.ListAdbs")
	//   Call.ByName("main.AdbHost.ReadBase64", path, offset, length)
	// 自動化測試（tools/desktop-test.ts --gui）需要接上 WebView2 的 devtools。
	// Wails 會用自己的值覆寫 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS，所以只能從
	// WindowsOptions 傳進去；預設不開任何除錯埠，只有環境變數要求時才開。
	var windows application.WindowsOptions
	// WebView2 的使用者資料目錄：預設共用（正常情況只有一個行程）；自動化測試會用
	// ACCELON26_WEBVIEW_DIR 給每個行程各自一個，這樣每個行程才有**自己的** DevTools 埠
	// （同一個 WebView2 環境只有第一個行程拿得到 remote-debugging-port）。
	if dir := os.Getenv("ACCELON26_WEBVIEW_DIR"); dir != "" {
		windows.WebviewUserDataPath = dir
	}
	debugPort := os.Getenv("ACCELON26_DEBUG_PORT")
	if *debugPortFlag != "" {
		debugPort = *debugPortFlag // 更新時由舊行程指定，避免兩個行程搶同一個埠
	}
	if port := debugPort; port != "" {
		windows.AdditionalBrowserArgs = []string{
			"--remote-debugging-port=" + port,
			"--remote-allow-origins=*",
		}
	}

	app := application.New(application.Options{
		Name:        "accelon26",
		Description: "accelon26 — accelon .adb viewer (desktop host)",
		Windows:     windows,
		Services: []application.Service{
			application.NewService(host),
		},
		Assets: application.AssetOptions{
			// 必須用 BundledAssetFileServer：它除了提供 assets 之外，還會在
			// /wails/runtime.js 提供內建 runtime；我們的網頁要靠它才能
			// import runtime 並用 Call.ByName，不然桌面宿主會被當成不存在。
			Handler: application.BundledAssetFileServer(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	// -screens：列舉螢幕、游標、會選哪一張、上次的設定，然後結束（多螢幕排錯用）。
	if *screens {
		fmt.Print(screensInfo(app, nil)) // 視窗還沒建立：用平台的列舉＋主螢幕
		return
	}

	// 視窗先建好但**隱藏**，等 ApplicationStarted（訊息迴圈已就緒、Win32 螢幕清單也拿得到）
	// 才定位、套用上次的狀態、顯示 —— 這樣不會先出現在錯的螢幕再跳過去。
	//
	// 定位規則（作者 2026-10）：永遠放在「使用者執行 exe 的那張螢幕」（啟動瞬間游標所在，
	// 偵測不到就主螢幕）；第一次啟動全螢幕；之後恢復上次記下的位置、大小與狀態，
	// 但一定夾進那張螢幕的工作區（上次那張外接螢幕這回可能已經不在了）。
	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "accelon26",
		URL:    "/",
		Width:  defaultWindowW,
		Height: defaultWindowH,
		Hidden: true,
	})

	// 離開時記下設定：關閉事件先寫一次（那一刻視窗還在），OnShutdown 當保險；
	// windowTracker 只會真的寫一次。
	tracker := newWindowTracker(app, win)
	for _, ev := range windowEvents() {
		win.OnWindowEvent(ev, func(*application.WindowEvent) { tracker.snapshot() })
	}
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) { tracker.save() })
	app.OnShutdown(tracker.save)
	// 正常結束時刪掉「上一版」（accelon26-prev.exe）。反過來說：更新交接後自己結束的
	// 那一支**不刪** —— 那正是新版起不來時使用者的退路。
	app.OnShutdown(func() {
		if !handedOffToNewVersion() {
			cleanupPrevExe()
		}
	})
	host.SetWindowInfo(tracker.info) // 測試／排錯用（UI 不需要知道）
	host.SetQuit(func() { app.Quit() })
	host.SetToggleFullscreen(win.ToggleFullscreen) // Esc／F11 切換全螢幕
	host.StartUpdateChecker()                      // 背景檢查線上更新（含清掉上次留下的 .old）

	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		wa, screenName, ok := launchWorkArea(app, win)
		st, hasSaved := loadWindowState()
		tracker.setLaunch(screenName, wa)
		if !ok { // 一張螢幕都列舉不到：交給作業系統，只把記下的大小套上去
			if hasSaved {
				win.SetSize(st.W, st.H)
			}
			tracker.snapshot()
			win.Show()
			return
		}
		var x, y, w, h int
		state := stateFullscreen // 第一次啟動：全螢幕
		if hasSaved {
			st = clampWindowState(st, wa)
			w, h = st.W, st.H
			x, y = wa.X+st.RelX, wa.Y+st.RelY
			state = st.State
		} else {
			// 第一次啟動：全螢幕（這裡的框只當「還原時」用，所以先夾進工作區再置中，
			// 免得預設尺寸比螢幕大、置中算出負座標讓全螢幕跑到別張螢幕上）
			w, h = clampWindowState(windowState{W: defaultWindowW, H: defaultWindowH}, wa).W, clampWindowState(windowState{W: defaultWindowW, H: defaultWindowH}, wa).H
			x, y = wa.X+(wa.Width-w)/2, wa.Y+(wa.Height-h)/2
		}
		win.SetSize(w, h)
		win.SetPosition(x, y)
		// 有些平台／DPI 設定會在我們設完之後再把視窗挪一點（窗框、換算誤差）：等它穩定、
		// 讀回來補一次，免得每次啟動都往同一個方向漂移。這時視窗還隱藏著，看不出跳動。
		time.Sleep(60 * time.Millisecond)
		if gx, gy := win.Position(); gx != x || gy != y {
			log.Printf("window: 平台把位置調成 (%d,%d)，要求 (%d,%d)，補正", gx, gy, x, y)
			x, y = x-(gx-x), y-(gy-y)
			win.SetPosition(x, y)
			time.Sleep(60 * time.Millisecond)
		}
		if gx, gy := win.Position(); gx != x || gy != y {
			log.Printf("window: 位置仍對不上：實際 (%d,%d)、要求 (%d,%d)", gx, gy, x, y)
		}
		tracker.snapshot() // 先記下 normal 的框（還原用），再進全螢幕／最大化
		switch state {
		case stateFullscreen:
			win.Fullscreen()
		case stateMaximised:
			win.Maximise()
		}
		tracker.snapshot()
		win.Show()
		why := "第一次啟動：全螢幕"
		if hasSaved {
			why = "恢復上次設定"
		}
		log.Printf("window: 螢幕 %s 工作區 (%d,%d %dx%d) → %dx%d@%d,%d state=%s（%s）",
			screenName, wa.X, wa.Y, wa.Width, wa.Height, w, h, x, y, state, why)
	})
	log.Fatal(app.Run())
}

// runSelfTest 是不開 GUI 的自檢：列出當前工作目錄裡的 *.adb（只讀 256 位元組檔頭），
// 印出 mmap+base64 的讀取耗時，並驗證越界讀取會回報錯誤。回傳行程結束碼。
//
//	go build -o ..\build\desktop\accelon26.exe .
//	cd ..
//	..\build\desktop\accelon26.exe -selftest
func runSelfTest() int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "selftest: getwd: %v\n", err)
		return 1
	}
	host := &AdbHost{}
	defer host.CloseAll()

	fmt.Println("accelon26 -selftest")
	fmt.Printf("cwd: %s\n", cwd)

	list, err := host.ListAdbs()
	if err != nil {
		fmt.Fprintf(os.Stderr, "selftest: ListAdbs: %v\n", err)
		return 1
	}
	fmt.Printf("found %d .adb file(s):\n", len(list))
	for _, a := range list {
		fmt.Printf("  %-10s size=%-9d modified=%d\n", a.Name, a.Size, a.Modified)
		fmt.Printf("      path=%s\n", a.Path)
		fmt.Printf("      dbname=%q dbcname=%q\n", a.DbName, a.DbCName)
	}
	if len(list) == 0 {
		fmt.Fprintln(os.Stderr, "selftest FAILED: no .adb in the current working directory")
		return 1
	}

	// 計時用 13j.adb（有的話），否則第一個；區塊大小不超過檔案本身。
	target := list[0]
	for _, a := range list {
		if strings.EqualFold(a.DbName, "13j") {
			target = a
		}
	}
	chunk := 128 * 1024
	if int64(chunk) > target.Size {
		chunk = int(target.Size)
	}
	const times = 200

	start := time.Now()
	var b64bytes int
	for i := 0; i < times; i++ {
		s, err := host.ReadBase64(target.Path, 0, chunk)
		if err != nil {
			fmt.Fprintf(os.Stderr, "selftest: ReadBase64(%s): %v\n", target.Path, err)
			return 1
		}
		b64bytes += len(s)
	}
	elapsed := time.Since(start)
	inBytes := int64(times) * int64(chunk)
	mib := float64(1024 * 1024)
	fmt.Printf("mmap+base64 read: %d x %d bytes = %.1f MiB input, %d base64 bytes, total %s\n",
		times, chunk, float64(inBytes)/mib, b64bytes, elapsed)
	fmt.Printf("  %.1f ns/op, %.0f MiB/s input, %.0f MiB/s base64 out\n",
		float64(elapsed.Nanoseconds())/float64(times),
		float64(inBytes)/mib/elapsed.Seconds(),
		float64(b64bytes)/mib/elapsed.Seconds())

	// 越界必須回傳 error，不能 panic。
	if _, err := host.ReadBase64(target.Path, int64(1)<<62, 16); err == nil {
		fmt.Fprintln(os.Stderr, "selftest FAILED: out-of-range read did not return an error")
		return 1
	}
	fmt.Println("selftest OK")
	return 0
}
