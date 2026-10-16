package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
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
//   * 更新方式：下載到 <dir>/accelon26.exe.new → 檢查是 PE（MZ 開頭）→ 把執行中的 exe
//     改名成 .old（Windows 允許改執行中映像的名字，但不能覆蓋）→ .new 改名成正式名字 →
//     啟動新 exe（帶 -updated-from，讓它顯示改版說明）→ 自己結束。.old 下次啟動時清掉。
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
)

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
	Note            string `json:"note"`
	UpdatedFrom     string `json:"updatedFrom"`
}

// UpdateStatus 是檢查結果（會快取在 AdbHost 裡，AppInfo 直接用它，不再連網）。
type UpdateStatus struct {
	Available   bool
	Remote      time.Time
	CheckedAt   time.Time
	Disabled    bool
	DevBuild    bool
	DirWritable bool
	Note        string
}

// shortTime 給 hover hint 用的可讀時間（本地時區）。
func shortTime(t time.Time) string {
	if t.IsZero() {
		return "（未知）"
	}
	return t.Local().Format("2006-01-02 15:04")
}

// checkUpdateNow 做一次檢查（HEAD 取 Last-Modified）。
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
	if d := time.Since(local); d < devWindow && d > -devWindow && !updateURLForced() {
		st.DevBuild = true
		st.Disabled = true
		st.Note = "本地建置的 exe（建置時間與現在差不到 2 小時）→ 不檢查更新"
		return st
	}
	url := updateURL()
	req, err := http.NewRequest(http.MethodHead, url, nil)
	if err != nil {
		st.Note = "更新網址無效：" + err.Error()
		return st
	}
	req.Header.Set("Cache-Control", "no-cache")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		st.Note = "檢查失敗：" + err.Error()
		return st
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		st.Note = fmt.Sprintf("檢查失敗：HTTP %d", resp.StatusCode)
		return st
	}
	lm := resp.Header.Get("Last-Modified")
	if lm == "" {
		st.Note = "線上檔案沒有 Last-Modified，無法比較建置時間"
		return st
	}
	remote, err := http.ParseTime(lm)
	if err != nil {
		st.Note = "Last-Modified 看不懂：" + lm
		return st
	}
	st.Remote = remote
	st.Available = remote.After(local.Add(newerSlack))
	if !st.Available {
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
func (h *AdbHost) CheckUpdate() AppInfo {
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
// 目錄不可寫或下載回來的不是 PE 就原封不動地失敗，不留半成品。
func (h *AdbHost) InstallUpdate() InstallResult {
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
	newPath := filepath.Join(dir, filepath.Base(self)+".new")
	_ = os.Remove(newPath)
	if err := downloadFile(updateURL(), newPath); err != nil {
		_ = os.Remove(newPath)
		return InstallResult{Error: "下載失敗：" + err.Error()}
	}
	if err := looksLikeWindowsExe(newPath); err != nil {
		_ = os.Remove(newPath)
		return InstallResult{Error: "下載回來的不是 Windows 執行檔：" + err.Error()}
	}
	// 執行中的 exe 不能覆蓋，但可以改名；上次留下的 .old 若還被鎖住就換個名字。
	old := self + ".old"
	if _, err := os.Stat(old); err == nil {
		if err := os.Remove(old); err != nil {
			old = fmt.Sprintf("%s.old-%d", self, time.Now().Unix())
		}
	}
	if err := os.Rename(self, old); err != nil {
		_ = os.Remove(newPath)
		return InstallResult{Error: "無法移動執行中的 exe：" + err.Error()}
	}
	if err := os.Rename(newPath, self); err != nil {
		_ = os.Rename(old, self) // 還原
		_ = os.Remove(newPath)
		return InstallResult{Error: "無法寫入新的 exe：" + err.Error()}
	}
	from := rfc3339(exeBuildTime())
	args := []string{"-updated-from", from}
	// 舊行程還沒結束，DevTools 的埠還被佔著：明確給新行程下一個埠（測試也靠這個接上去）。
	if port := os.Getenv("ACCELON26_DEBUG_PORT"); port != "" {
		if n, err := strconv.Atoi(port); err == nil {
			args = append(args, "-debug-port", strconv.Itoa(n+1))
		}
	}
	cmd := exec.Command(self, args...)
	if wd, err := os.Getwd(); err == nil {
		cmd.Dir = wd
	}

	if err := cmd.Start(); err != nil {
		return InstallResult{Error: "新版啟動失敗：" + err.Error(), Path: self, From: from}
	}
	go func() {
		time.Sleep(700 * time.Millisecond)
		if quit != nil {
			quit()
		}
	}()
	return InstallResult{OK: true, Path: self, From: from}
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
