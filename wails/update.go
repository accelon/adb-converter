package main

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ---- 建置時間與線上更新（作者 2026-10） -----------------------------------------
//
// 作者原文：「accelon26.exe … 左上角 hover hint 顯示 built time。如果
// https://shutonggui.cn/accelon26/accelon26.exe 的 built time 比用戶運行中的更新，
// 左上角閃動表示有更新版提醒用戶更新，用戶點下時，問是否確定更新（先檢查 exe 所在目錄
// 是否可寫，不可寫就永遠不檢查是否有更新；如果目前運行的 exe built time 和電腦時鐘差別
// 不到 2 小時，表示是開發者本地 exe，就不必檢查更新了），更新後，顯示改版新增或改進的功能。」
//
// 設計：
//   * 建置時間：建置時用 -ldflags "-X main.buildTime=<RFC3339>" 注入；沒有注入就退回
//     執行檔的修改時間（複製到別台機器也會變，所以正式發佈一定要注入）。
//   * 遠端建置時間：HTTP 的 Last-Modified（靜態主機上傳檔案時就會有；沒有的話就不提示，
//     不猜）。比本地新「至少一分鐘」才算新，避免時鐘/時區誤差。
//   * 不檢查更新的兩種情況：（1）exe 所在目錄不可寫（更新不了，就永遠不檢查，
//     也就不會打擾使用者）；（2）本地建置時間與現在差不到 2 小時（開發者自己的 exe）。
//   * 更新方式：下載到 <dir>/accelon26.exe.new → 驗 size／sha256／PE 檔頭／-version →
//     把執行中的 exe 改名成 accelon26-prev.exe（Windows 允許改執行中映像的名字，但不能
//     覆蓋）→ .new 改名成正式名字 → 啟動新 exe（帶 -updated-from，讓它顯示改版說明）→
//     自己立刻結束（新舊行程不能同時用同一個 WebView2 資料目錄）。prev 就是新版起不來
//     時的退路（可以直接雙擊），新版正常關閉時刪掉。
//   * 更新後顯示的說明：release_notes.json（內嵌）依 buildTime 排序，只顯示比
//     -updated-from 新的那幾筆。

const (
	// 正式發佈位置（作者手動上傳）；環境變數 ACCELON26_UPDATE_URL 可覆寫，測試與自架用。
	defaultUpdateURL = "https://shutonggui.cn/accelon26/accelon26.exe"
	// 本地建置時間與現在差不到這個 → 開發者本地 exe，不檢查更新。
	devWindow = 2 * time.Hour
	// 背景檢查的間隔（啟動時先檢查一次）。
	updateCheckEvery = 6 * time.Hour
	// 遠端要比本地新這麼多才算「有新版本」（容忍時區/時鐘誤差）。
	newerSlack = time.Minute
	// 線上版本資訊檔（跟 exe 放同一個資料夾）：buildTime 是版本真相，sha256 用來驗下載。
	manifestName = "versions.json"
	// 抓版本資訊的逾時（只是一個小 JSON，不該等太久）。
	manifestTimeout = 8 * time.Second
)

// versionManifest 是線上的 versions.json（由 ts/tools/release.ts 產生、deploy 一起上傳）。
type versionManifest struct {
	App       string `json:"app"`
	Channel   string `json:"channel"`
	BuildTime string `json:"buildTime"`
	URL       string `json:"url"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
}

// buildTime 由建置腳本注入：
//
//	go build -ldflags "-X main.buildTime=$(Get-Date -AsUTC -Format o)" -o ... .
var buildTime = ""

var (
	buildOnce   sync.Once
	buildAt     time.Time
	buildSource string // ldflags｜file｜（空）
)

//go:embed release_notes.json
var releaseNotesJSON []byte

func exePath() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	return p
}

func exeDir() string {
	p := exePath()
	if p == "" {
		return ""
	}
	return filepath.Dir(p)
}

// exeBuildTime 回傳執行檔的建置時間（-ldflags 優先，其次檔案修改時間）。
func exeBuildTime() time.Time {
	buildOnce.Do(func() {
		if buildTime != "" {
			if t, err := time.Parse(time.RFC3339, buildTime); err == nil {
				buildAt, buildSource = t, "ldflags"
				return
			}
		}
		if p := exePath(); p != "" {
			if st, err := os.Stat(p); err == nil {
				buildAt, buildSource = st.ModTime(), "file"
			}
		}
	})
	return buildAt
}

// updateURL 是檢查更新的位置（環境變數可覆寫：測試用本地 HTTP 伺服器）。
func updateURL() string {
	if u := strings.TrimSpace(os.Getenv("ACCELON26_UPDATE_URL")); u != "" {
		return u
	}
	return defaultUpdateURL
}

// updateURLForced 表示更新位置是被環境變數指定的（測試／自架）：那就略過
// 「開發者本地 exe」的保護，否則自動化測試永遠測不到檢查邏輯。
func updateURLForced() bool { return strings.TrimSpace(os.Getenv("ACCELON26_UPDATE_URL")) != "" }

// forceUpdateCheck 由 `-check-update`（診斷用）設起來：連開發者本地建置的 exe
// 也真的連一次網，好讓發布前可以驗線上的 versions.json。
var forceUpdateCheck bool

// manifestURL 是 versions.json 的位置：預設跟更新網址同一個資料夾
// （…/accelon26/accelon26.exe → …/accelon26/versions.json）。
// ACCELON26_VERSION_URL 可以直接指定，測試與自架用。
func manifestURL() string {
	if u := strings.TrimSpace(os.Getenv("ACCELON26_VERSION_URL")); u != "" {
		return u
	}
	p, err := url.Parse(updateURL())
	if err != nil {
		return updateURL() + "." + manifestName
	}
	p.RawQuery, p.Fragment = "", ""
	if i := strings.LastIndex(p.Path, "/"); i >= 0 {
		p.Path = p.Path[:i+1] + manifestName
	} else {
		p.Path = "/" + manifestName
	}
	return p.String()
}

// fetchManifest 讀 versions.json。讀不到（404、連不上、不是 JSON）就回錯誤，
// 呼叫方會退回用 Last-Modified 判斷 —— 舊主機沒有 versions.json 也能更新。
func fetchManifest() (versionManifest, error) {
	var m versionManifest
	req, err := http.NewRequest(http.MethodGet, manifestURL(), nil)
	if err != nil {
		return m, err
	}
	req.Header.Set("Cache-Control", "no-cache")
	client := &http.Client{Timeout: manifestTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return m, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return m, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(body, &m); err != nil {
		return m, fmt.Errorf("不是合法的 JSON")
	}
	if strings.TrimSpace(m.BuildTime) == "" {
		return m, fmt.Errorf("沒有 buildTime")
	}
	return m, nil
}

// dirWritable 用「真的建一個暫存檔再刪掉」判斷目錄可不可寫。
func dirWritable(dir string) bool {
	if dir == "" {
		return false
	}
	f, err := os.CreateTemp(dir, ".accelon26-write-test-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	if err := os.Remove(name); err != nil {
		return false
	}
	return true
}

// ---- 給 UI 的資訊 --------------------------------------------------------------

// AppInfo 是左上角 hover hint 與更新提示要用的全部資訊（UI 不必知道 Go 層怎麼做事）。
type AppInfo struct {
	Name            string `json:"name"`
	BuildTime       string `json:"buildTime"`     // RFC3339
	BuildTimeText   string `json:"buildTimeText"` // 本地時間，給人看的
	BuildSource     string `json:"buildSource"`
	ExePath         string `json:"exePath"`
	ExeDir          string `json:"exeDir"`
	DirWritable     bool   `json:"dirWritable"`
	CanUpdate       bool   `json:"canUpdate"`
	DevBuild        bool   `json:"devBuild"`
	UpdateURL       string `json:"updateURL"`
	UpdateAvailable bool   `json:"updateAvailable"`
	RemoteBuildTime string `json:"remoteBuildTime"`
	LastCheck       string `json:"lastCheck"`
	// CheckOK＝真的拿到線上的版本時間。false 時 UI 要顯示 Note（檢查失敗），
	// 不可以說「已是最新」。
	CheckOK     bool   `json:"checkOK"`
	Note        string `json:"note"`
	UpdatedFrom string `json:"updatedFrom"`
}

// handedOff 表示這個行程已經把棒子交給新版（更新後自己結束）。結束時就**不要**刪掉
// `accelon26-prev.exe` —— 那是新版起不來時使用者的退路。
var handedOff atomic.Bool

func handedOffToNewVersion() bool { return handedOff.Load() }

// UpdateStatus 是檢查結果（會快取在 AdbHost 裡，AppInfo 直接用它，不再連網）。
type UpdateStatus struct {
	Available   bool
	OK          bool // 真的拿到線上的版本時間（UI 靠它分辨「已是最新」與「檢查失敗」）
	Remote      time.Time
	CheckedAt   time.Time
	Disabled    bool
	DevBuild    bool
	DirWritable bool
	Note        string
	// versions.json 說的下載位置與雜湊（沒有 versions.json 時是空的）。
	SHA256      string
	Size        int64
	DownloadURL string
}

// shortTime 給 hover hint 用的可讀時間（本地時區）。
func shortTime(t time.Time) string {
	if t.IsZero() {
		return "（未知）"
	}
	return t.Local().Format("2006-01-02 15:04")
}

// checkUpdateNow 做一次檢查。順序：
//  1. versions.json（版本真相：buildTime ＋ sha256）—— 新主機走這條；
//  2. 沒有 versions.json 就退回 HEAD 的 Last-Modified —— 舊主機仍可更新。
func (h *AdbHost) checkUpdateNow() UpdateStatus {
	local := exeBuildTime()
	st := UpdateStatus{
		CheckedAt:   time.Now(),
		DirWritable: dirWritable(exeDir()),
	}
	if !st.DirWritable {
		st.Disabled = true
		st.Note = "exe 所在目錄不可寫 → 永遠不檢查更新"
		return st
	}
	if local.IsZero() {
		st.Disabled = true
		st.Note = "拿不到建置時間 → 不檢查更新"
		return st
	}
	if d := time.Since(local); d < devWindow && d > -devWindow && !updateURLForced() && !forceUpdateCheck {
		st.DevBuild = true
		st.Disabled = true
		st.Note = "本地建置的 exe（建置時間與現在差不到 2 小時）→ 不檢查更新"
		return st
	}

	// 1) versions.json
	why := ""
	if m, err := fetchManifest(); err != nil {
		why = "versions.json 讀不到（" + err.Error() + "）"
	} else if remote, err := time.Parse(time.RFC3339, m.BuildTime); err != nil {
		why = "versions.json 的 buildTime 看不懂：" + m.BuildTime
	} else {
		st.OK = true
		st.Remote = remote
		st.SHA256 = strings.ToLower(strings.TrimSpace(m.SHA256))
		st.Size = m.Size
		st.DownloadURL = strings.TrimSpace(m.URL)
		st.Available = remote.After(local.Add(newerSlack))
		if !st.Available {
			st.Note = "已是最新（線上 " + shortTime(remote) + "）"
		}
		return st
	}

	// 2) fallback：HEAD 取 Last-Modified（舊主機）
	req, err := http.NewRequest(http.MethodHead, updateURL(), nil)
	if err != nil {
		st.Note = why + "；更新網址無效：" + err.Error()
		return st
	}
	req.Header.Set("Cache-Control", "no-cache")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		st.Note = why + "；檢查失敗：" + err.Error()
		return st
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		st.Note = why + fmt.Sprintf("；檢查失敗：HTTP %d", resp.StatusCode)
		return st
	}
	lm := resp.Header.Get("Last-Modified")
	if lm == "" {
		st.Note = why + "；線上檔案沒有 Last-Modified，無法比較建置時間"
		return st
	}
	remote, err := http.ParseTime(lm)
	if err != nil {
		st.Note = why + "；Last-Modified 看不懂：" + lm
		return st
	}
	st.OK = true
	st.Remote = remote
	st.Available = remote.After(local.Add(newerSlack))
	if st.Available {
		st.Note = "沒有 versions.json，改用 Last-Modified 判斷（建議主機放一份）"
	} else {
		st.Note = "已是最新（線上 " + shortTime(remote) + "）"
	}
	return st
}

// ---- 更新結果與 AdbHost 上的狀態 ------------------------------------------------

// SetUpdatedFrom 由 main 把 -updated-from 的值傳進來（更新後的新行程會帶著它，
// 用來只顯示「比舊版新」的改版說明）。
func (h *AdbHost) SetUpdatedFrom(iso string) {
	h.mu.Lock()
	h.updatedFrom = iso
	h.mu.Unlock()
}

// SetQuit 由 main 注入「結束應用程式」的動作（更新完成、啟動新版之後用）。
func (h *AdbHost) SetQuit(f func()) {
	h.mu.Lock()
	h.quit = f
	h.mu.Unlock()
}

func (h *AdbHost) updateStatus() UpdateStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.updateSt
}

func (h *AdbHost) setUpdateStatus(st UpdateStatus) {
	h.mu.Lock()
	h.updateSt = st
	h.mu.Unlock()
}

// AppInfo 是 UI（左上角 hint 與更新提示）唯一需要的資訊。**不連網**：
// 用背景檢查的快取結果。
func (h *AdbHost) AppInfo() AppInfo {
	st := h.updateStatus()
	local := exeBuildTime()
	h.mu.Lock()
	updatedFrom := h.updatedFrom
	h.mu.Unlock()
	info := AppInfo{
		Name:            "accelon26",
		BuildTime:       rfc3339(local),
		BuildTimeText:   shortTime(local),
		BuildSource:     buildSource,
		ExePath:         exePath(),
		ExeDir:          exeDir(),
		DirWritable:     st.DirWritable,
		CanUpdate:       st.DirWritable && !st.DevBuild,
		DevBuild:        st.DevBuild,
		UpdateURL:       updateURL(),
		UpdateAvailable: st.Available,
		RemoteBuildTime: rfc3339(st.Remote),
		LastCheck:       rfc3339(st.CheckedAt),
		CheckOK:         st.OK,
		Note:            st.Note,
		UpdatedFrom:     updatedFrom,
	}
	if !st.CheckedAt.IsZero() && st.Note == "" && !st.Available {
		info.Note = "已是最新（線上 " + shortTime(st.Remote) + "）"
	}
	return info
}

func rfc3339(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// CheckUpdate 立即檢查一次並回傳最新資訊（UI 想主動確認時呼叫；平常靠背景檢查）。
// 剛檢查過（90 秒內、而且真的拿到線上的版本）就直接回快取：開「關於」時不該每次都
// 連網等好幾秒，尤其是啟動時背景檢查才剛跑完。
func (h *AdbHost) CheckUpdate() AppInfo {
	st := h.updateStatus()
	if st.OK && time.Since(st.CheckedAt) < 90*time.Second {
		return h.AppInfo()
	}
	h.setUpdateStatus(h.checkUpdateNow())
	return h.AppInfo()
}

// StartUpdateChecker 啟動背景檢查：清掉上次更新留下的 .old，然後先檢查一次，
// 之後每 updateCheckEvery 檢查一次。**只有真的在跑 GUI 時才呼叫。**
func (h *AdbHost) StartUpdateChecker() {
	go func() {
		cleanupOldExe()
		for {
			h.setUpdateStatus(h.checkUpdateNow())
			time.Sleep(updateCheckEvery)
		}
	}()
}

// cleanupOldExe 刪掉上次更新留下的 .old（新版啟動時它已經不被鎖住了）。
func cleanupOldExe() {
	p := exePath()
	if p == "" {
		return
	}
	_ = os.Remove(p + ".old")
}

// ---- 更新：下載、換檔、重啟 ------------------------------------------------------

// InstallResult 是更新的結果（成功時行程馬上就會結束，所以 UI 通常看不到它）。
type InstallResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Path  string `json:"path,omitempty"`
	From  string `json:"from,omitempty"`
}

// InstallUpdate 下載新 exe、換掉自己、啟動新版（帶 -updated-from）然後結束。
// 目錄不可寫、下載不完整（大小／sha256／PE 檔頭／-version 驗不過）都原封不動地失敗，
// 不留半成品，也不會動到使用者手上那一顆；新版起來後若馬上結束，會把舊版換回去。
func (h *AdbHost) InstallUpdate() InstallResult {
	if !h.installMu.TryLock() {
		return InstallResult{Error: "已經在更新中，請稍等"}
	}
	defer h.installMu.Unlock()

	h.mu.Lock()
	quit := h.quit
	h.mu.Unlock()
	dir := exeDir()
	self := exePath()
	if dir == "" || self == "" {
		return InstallResult{Error: "找不到執行檔位置"}
	}
	if !dirWritable(dir) {
		return InstallResult{Error: "exe 所在目錄不可寫（" + dir + "），無法更新"}
	}

	// 要驗 sha256 就得知道線上那一版的 sha256：快取太舊或沒有雜湊就重新問一次。
	st := h.updateStatus()
	if st.SHA256 == "" || time.Since(st.CheckedAt) > 10*time.Minute {
		st = h.checkUpdateNow()
		h.setUpdateStatus(st)
	}
	if st.Disabled {
		return InstallResult{Error: st.Note}
	}
	if !st.Available {
		return InstallResult{Error: "線上沒有比目前更新的版本"}
	}
	src := st.DownloadURL
	if src == "" {
		src = updateURL()
	}

	newPath := filepath.Join(dir, filepath.Base(self)+".new")
	_ = os.Remove(newPath)
	if err := downloadFile(src, newPath); err != nil {
		_ = os.Remove(newPath)
		return InstallResult{Error: "下載失敗：" + err.Error()}
	}
	// 下載內容必須跟 versions.json 說的一致：截斷、錯誤頁、中間被換掉都在這裡擋。
	if st.Size > 0 {
		if fi, err := os.Stat(newPath); err != nil || fi.Size() != st.Size {
			_ = os.Remove(newPath)
			return InstallResult{Error: fmt.Sprintf("下載大小不符（預期 %d 位元組）", st.Size)}
		}
	}
	if st.SHA256 != "" {
		sum, err := fileSHA256(newPath)
		if err != nil {
			_ = os.Remove(newPath)
			return InstallResult{Error: "無法計算下載檔的雜湊：" + err.Error()}
		}
		if !strings.EqualFold(sum, st.SHA256) {
			_ = os.Remove(newPath)
			return InstallResult{Error: "下載內容的 sha256 不符（預期 " + shortHash(st.SHA256) + "）"}
		}
	}
	if err := looksLikeWindowsExe(newPath); err != nil {
		_ = os.Remove(newPath)
		return InstallResult{Error: "下載回來的不是 Windows 執行檔：" + err.Error()}
	}
	// 換檔前先讓新 exe 自己報一次建置時間：抓錯檔、或這一版不比現在新，就停在這裡。
	if err := verifyNewExe(newPath, exeBuildTime()); err != nil {
		_ = os.Remove(newPath)
		return InstallResult{Error: "下載回來的 exe 驗證失敗：" + err.Error()}
	}

	// 執行中的 exe 不能覆蓋，但可以改名。舊版改名成 `accelon26-prev.exe`——**可以直接
	// 雙擊**，這是新版起不來時使用者自己就能用的退路（新版跑起來、關得乾淨之後才刪）。
	prev := prevExePath(self)
	if _, err := os.Stat(prev); err == nil {
		if err := os.Remove(prev); err != nil { // 還被鎖住（上次沒關乾淨）就換個名字
			prev = fmt.Sprintf("%s-%d%s", strings.TrimSuffix(self, filepath.Ext(self)), time.Now().Unix(), filepath.Ext(self))
		}
	}
	if err := os.Rename(self, prev); err != nil {
		_ = os.Remove(newPath)
		return InstallResult{Error: "無法移動執行中的 exe：" + err.Error()}
	}
	if err := os.Rename(newPath, self); err != nil {
		_ = os.Rename(prev, self) // 還原
		_ = os.Remove(newPath)
		return InstallResult{Error: "無法寫入新的 exe：" + err.Error()}
	}
	from := rfc3339(exeBuildTime())
	// 舊行程還沒結束，DevTools 的埠還被佔著：明確給新行程下一個埠（測試也靠這個接上去）。
	port := ""
	if p := os.Getenv("ACCELON26_DEBUG_PORT"); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			port = strconv.Itoa(n + 1)
		}
	}
	// 由 prev 這支當「重新啟動器」：它等我們完全結束（WebView2 的資料目錄放掉）之後才啟動
	// 新版。**不能自己直接 Start 新版**：實測新舊同時活著時，新行程的 WebView2 會拿到
	// 8007139f 而失敗。重新啟動器同時負責觀察新版，起不來就回滾。
	rlArgs := []string{"-relaunch-pid", strconv.Itoa(os.Getpid()), "-relaunch-exe", self, "-relaunch-from", from}
	if port != "" {
		rlArgs = append(rlArgs, "-relaunch-port", port)
	}
	rl := exec.Command(prev, rlArgs...)
	rl.Dir = dir
	rl.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := rl.Start(); err != nil {
		// 連重新啟動器都開不起來：立刻把舊版換回來（我們還沒結束）。
		_ = os.Remove(self)
		_ = os.Rename(prev, self)
		return InstallResult{Error: "無法啟動更新程序：" + err.Error(), Path: self, From: from}
	}
	go func() { _ = rl.Wait() }()
	// 舊行程要**立刻讓位**：新舊兩個行程不能同時用同一個 WebView2 資料目錄。
	handedOff.Store(true)
	go func() {
		time.Sleep(700 * time.Millisecond)
		if quit != nil {
			quit()
		}
	}()
	return InstallResult{OK: true, Path: self, From: from}
}

// relaunchWatch 是重新啟動器觀察新版的時間：新 exe 在這段時間內結束（非 0）就當成起不來。
const relaunchWatch = 4 * time.Second

// runRelauncher 是更新流程的「重新啟動器」：由舊版副本（accelon26-prev.exe）跑起來，
// 等舊行程真的結束之後才啟動新版，並觀察新版是否起得來；起不來就回滾 + 告訴使用者。
// 它自己不碰 GUI／WebView2，所以不會跟新版搶資料目錄。
func runRelauncher(pid int, exe, from, port string) int {
	if h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid)); err == nil {
		_, _ = windows.WaitForSingleObject(h, 60000) // 舊行程完全結束（最多等 60 秒）
		_ = windows.CloseHandle(h)
	}
	// 舊行程結束後，WebView2 的子行程有時還會晚一點才放掉資料目錄。
	time.Sleep(400 * time.Millisecond)

	args := []string{}
	if from != "" {
		args = append(args, "-updated-from", from)
	}
	if port != "" {
		args = append(args, "-debug-port", port)
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		restorePrevExe(exe)
		messageBox("accelon26 更新失敗", "新版本無法啟動，已還原為先前的版本。\n\n"+err.Error())
		return 1
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		if err == nil {
			return 0 // 使用者一開就關（罕見，但算正常）
		}
		restorePrevExe(exe)
		messageBox("accelon26 更新失敗", "新版本啟動後馬上結束，已還原為先前的版本。\n\n請把這個情況回報給開發者。")
		again := exec.Command(exe)
		again.Dir = filepath.Dir(exe)
		_ = again.Start()
		return 1
	case <-time.After(relaunchWatch):
		return 0
	}
}

// restorePrevExe 把「重新啟動器自己」（＝ accelon26-prev.exe）改回正式名字。
func restorePrevExe(exe string) {
	self, err := os.Executable()
	if err != nil {
		return
	}
	_ = os.Remove(exe)
	_ = os.Rename(self, exe)
}

var (
	user32DLL  = windows.NewLazySystemDLL("user32.dll")
	procMsgBox = user32DLL.NewProc("MessageBoxW")
)

// messageBox 是沒有 GUI 時唯一的告知方式（重新啟動器還沒建立 Wails 應用）。
func messageBox(title, text string) {
	t, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	x, err := windows.UTF16PtrFromString(text)
	if err != nil {
		return
	}
	_, _, _ = procMsgBox.Call(0, uintptr(unsafe.Pointer(x)), uintptr(unsafe.Pointer(t)), 0x00000040|0x00040000)
}

// prevExePath 是「上一版」的位置：accelon26.exe → accelon26-prev.exe（可以直接雙擊）。
func prevExePath(self string) string {
	dir, base := filepath.Split(self)
	ext := filepath.Ext(base)
	return filepath.Join(dir, strings.TrimSuffix(base, ext)+"-prev"+ext)
}

// cleanupPrevExe 在**正常結束**時刪掉上一版：新版真的跑起來、也關得乾淨，才不需要它。
// 新版若起不來，這個檔案會留著，使用者雙擊就能回到上一版。
func cleanupPrevExe() {
	p := exePath()
	if p == "" {
		return
	}
	_ = os.Remove(prevExePath(p))
	_ = os.Remove(p + ".old") // 舊程式留下的名字
}

func shortHash(h string) string {
	if len(h) <= 12 {
		return h
	}
	return h[:12] + "…"
}

// fileSHA256 算整個檔案的 sha256（十六進位小寫）。
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// buildTimeLine 抓 `-version` 輸出裡的建置時間（"build time: 2026-10-18 10:13 (from …)"）。
var buildTimeLine = regexp.MustCompile(`build time:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})`)

// verifyNewExe 執行下載回來的 exe 的 `-version`，確認它跑得起來、而且建置時間比目前新。
// 這是換檔前最後一道關卡：壞檔、錯架構、拿舊版蓋新版，都在這裡停下來。
func verifyNewExe(path string, local time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "-version").Output()
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("-version 沒有在 10 秒內結束")
		}
		return fmt.Errorf("-version 執行失敗：%v", err)
	}
	m := buildTimeLine.FindStringSubmatch(string(out))
	if m == nil {
		return fmt.Errorf("-version 沒有印出建置時間")
	}
	t, err := parseBuildTimeLine(string(out))
	if err != nil {
		return err
	}
	if !local.IsZero() && !t.After(local) {
		return fmt.Errorf("版本沒有比較新（%s，目前 %s）", shortTime(t), shortTime(local))
	}
	return nil
}

// parseBuildTimeLine 從 `-version` 的輸出取出建置時間（給人看的是本地時間，分鐘精度）。
func parseBuildTimeLine(out string) (time.Time, error) {
	m := buildTimeLine.FindStringSubmatch(out)
	if m == nil {
		return time.Time{}, fmt.Errorf("-version 沒有印出建置時間")
	}
	t, err := time.ParseInLocation("2006-01-02 15:04", m[1], time.Local)
	if err != nil {
		return time.Time{}, fmt.Errorf("建置時間看不懂：%s", m[1])
	}
	return t, nil
}

// downloadFile 把 url 抓下來存成 path（逾時 10 分鐘，先寫 .part 再改名）。
func downloadFile(url string, path string) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Cache-Control", "no-cache")
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	part := path + ".part"
	f, err := os.Create(part)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, resp.Body)
	closeErr := f.Close()
	if err != nil {
		_ = os.Remove(part)
		return err
	}
	if closeErr != nil {
		_ = os.Remove(part)
		return closeErr
	}
	if n < 1<<20 { // 小於 1 MiB 一定不是我們的 exe
		_ = os.Remove(part)
		return fmt.Errorf("檔案太小（%d 位元組）", n)
	}
	return os.Rename(part, path)
}

// looksLikeWindowsExe 檢查檔頭是不是 MZ（下載到 HTML 錯誤頁時要能拒絕）。
func looksLikeWindowsExe(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(f, hdr); err != nil {
		return err
	}
	if hdr[0] != 'M' || hdr[1] != 'Z' {
		return fmt.Errorf("檔頭不是 MZ")
	}
	return nil
}

// ---- 改版說明（release_notes.json） --------------------------------------------

// ReleaseNote 是一版的功能說明（發佈時我（助手）或作者維護這個檔案）。
type ReleaseNote struct {
	BuildTime string   `json:"buildTime"`
	Title     string   `json:"title"`
	Items     []string `json:"items"`
}

func allReleaseNotes() []ReleaseNote {
	var out []ReleaseNote
	if err := json.Unmarshal(releaseNotesJSON, &out); err != nil {
		return nil
	}
	// 由舊到新（檔案裡可以隨意排）
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].BuildTime < out[i].BuildTime {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

// ReleaseNotes 回傳比 since（RFC3339，＝更新前那顆 exe 的建置時間）新的說明。
// since 空字串＝平常啟動，回空的（使用者沒更新就不吵他）。
func (h *AdbHost) ReleaseNotes(since string) []ReleaseNote {
	if strings.TrimSpace(since) == "" {
		return []ReleaseNote{}
	}
	from, err := time.Parse(time.RFC3339, since)
	if err != nil {
		return []ReleaseNote{}
	}
	out := []ReleaseNote{}
	for _, n := range allReleaseNotes() {
		t, err := time.Parse(time.RFC3339, n.BuildTime)
		if err != nil || !t.After(from) {
			continue
		}
		out = append(out, n)
	}
	if len(out) == 0 {
		// 沒有對應的說明也要告訴使用者「更新成功了」，不要靜悄悄。
		out = append(out, ReleaseNote{
			BuildTime: rfc3339(exeBuildTime()),
			Title:     "已更新到 " + shortTime(exeBuildTime()),
			Items:     []string{"這次更新沒有附說明（發佈時忘了更新 release_notes.json）。"},
		})
	}
	return out
}
