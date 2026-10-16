// Command adbview 是 adbview 單檔 HTML 應用的 Wails3 桌面宿主。
// Go 層極薄：只註冊一個 AdbHost service（列 *.adb + mmap 讀位元組區間），
// UI 全在 assets/index.html 裡（由倉庫根目錄的 TypeScript 建置腳本產生）。
package main

import (
	"embed"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// assets 裡就是建置好的單檔 adbview；webview 開啟 "/" 時由它提供 index.html。
// 這個目錄必須一直存在，否則 //go:embed 會編譯失敗。
//
//go:embed all:assets
var assets embed.FS

func main() {
	// -selftest：完全不開 GUI，跑一遍自檢後結束，用來在命令列驗證 exe。
	selftest := flag.Bool("selftest", false, "run the headless self test and exit")
	flag.Parse()
	if *selftest {
		os.Exit(runSelfTest())
	}

	// 只註冊一個 service。前端用 /wails/runtime.js 的 Call.ByName 直接呼叫：
	//   Call.ByName("main.AdbHost.ListAdbs")
	//   Call.ByName("main.AdbHost.ReadBase64", path, offset, length)
	// 自動化測試（tools/desktop-test.ts --gui）需要接上 WebView2 的 devtools。
	// Wails 會用自己的值覆寫 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS，所以只能從
	// WindowsOptions 傳進去；預設不開任何除錯埠，只有環境變數要求時才開。
	var windows application.WindowsOptions
	if port := os.Getenv("ADBVIEW_DEBUG_PORT"); port != "" {
		windows.AdditionalBrowserArgs = []string{
			"--remote-debugging-port=" + port,
			"--remote-allow-origins=*",
		}
	}

	app := application.New(application.Options{
		Name:        "adbview",
		Description: "accelon .adb viewer (desktop host)",
		Windows:     windows,
		Services: []application.Service{
			application.NewService(&AdbHost{}),
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

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "adbview",
		Width:  1400,
		Height: 900,
		URL:    "/",
	})

	log.Fatal(app.Run())
}

// runSelfTest 是不開 GUI 的自檢：列出當前工作目錄裡的 *.adb（只讀 256 位元組檔頭），
// 印出 mmap+base64 的讀取耗時，並驗證越界讀取會回報錯誤。回傳行程結束碼。
//
//	go build -o ..\build\desktop\adbview.exe .
//	cd ..
//	..\build\desktop\adbview.exe -selftest
func runSelfTest() int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "selftest: getwd: %v\n", err)
		return 1
	}
	host := &AdbHost{}
	defer host.CloseAll()

	fmt.Println("adbview -selftest")
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
