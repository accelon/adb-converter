package main

// ---- 公開資料庫的 .adb 自動更新（作者 2026-10-29）----------------------------------
//
// 官網「公開數據庫」的 adb 會更新；程式開機時讀 `adb/manifest.json`（檔名、大小、
// sha256、說明），比對資料夾裡同名的 .adb，有新版就在 #dbTabs 顯示紅色的「New」。
//
// 為什麼下載放在 Go：
//   * WebView 直接 fetch https://shutonggui.cn 會被 CORS 擋住（伺服器沒有 ACAO）；
//   * 20 MB 的檔案走 Wails 的 JSON 橋（base64）要膨脹 33%，而且前端沒有辦法把
//     位元組寫回 exe 旁邊的資料夾。
//
// 安全底線（作者：「要能隨時放棄，不傷現有的 adb」）：
//   1. 先下載到**同一個資料夾**的 `.accelon26-*.tmp`，邊下邊算 sha256；
//   2. 大小或 sha256 不符、檔頭不是 adb、使用者按放棄 → 刪掉暫存檔，原檔一個位元組都沒動；
//   3. 只有全部驗過才 `Close`（解除 mmap）→ `rename` 蓋回去（同檔案系統的原子替換）；
//      rename 失敗（例如另一個程式鎖著）就報錯，原檔仍然不動。
//
// 進度與放棄用「開始 → 輪詢 → 取消」三個呼叫，不用 Wails 事件：前端每 150 ms 問一次，
// 下載在 goroutine 裡跑，取消只是把 context 取消掉。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// adbHTTP 是下載與讀 manifest 共用的 client：連線／TLS／等回應都有上限，
// 但**不設整體 Timeout** —— 站慢的時候 20 MB 可能要下載幾分鐘。
var adbHTTP = &http.Client{
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   20 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       60 * time.Second,
	},
}

// adbManifestURL 讓測試用環境變數指向本機伺服器（正式版就是官網）。
func adbManifestURL() string {
	if u := strings.TrimSpace(os.Getenv("ACCELON26_ADB_MANIFEST")); u != "" {
		return u
	}
	// 跟 exe 更新同一個站（主站或鏡像，見 mirror.go）。
	return currentMirrorBase() + "adb/manifest.json"
}

// AdbManifestURL 前端要知道去哪裡拿清單（測試會用 ACCELON26_ADB_MANIFEST 覆寫）。
func (h *AdbHost) AdbManifestURL() string { return adbManifestURL() }

func isHTTPURL(rawurl string) bool {
	u := strings.ToLower(strings.TrimSpace(rawurl))
	return strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")
}

// FetchText 抓一個小文字檔（manifest.json）。上限 4 MiB，避免被指到奇怪的東西。
func (h *AdbHost) FetchText(rawurl string) (string, error) {
	if !isHTTPURL(rawurl) {
		return "", errors.New("只支援 http(s) 網址")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawurl, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := adbHTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("連不上更新伺服器：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("更新伺服器回應 HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", fmt.Errorf("讀取更新清單失敗：%w", err)
	}
	return string(b), nil
}

// FileSha256 回傳本機 .adb 的 sha256（小寫 hex）。只讀檔，不改任何東西。
func (h *AdbHost) FileSha256(path string) (string, error) {
	abs, err := h.resolve(path)
	if err != nil {
		return "", err
	}
	return fileSha256(abs)
}

func fileSha256(abs string) (string, error) {
	f, err := os.Open(abs)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sum := sha256.New()
	if _, err := io.CopyBuffer(sum, f, make([]byte, 256<<10)); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

// AdbDownloadStatus 是前端輪詢到的下載狀態。
type AdbDownloadStatus struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	State    string `json:"state"` // running | done | cancelled | error
	Received int64  `json:"received"`
	Total    int64  `json:"total"`
	Error    string `json:"error,omitempty"`
}

type adbDownload struct {
	mu       sync.Mutex
	id       string
	path     string
	state    string
	received int64
	total    int64
	errMsg   string
	cancel   context.CancelFunc
}

var adbDlMu sync.Mutex
var adbDls = map[string]*adbDownload{}

func (d *adbDownload) snapshot() AdbDownloadStatus {
	d.mu.Lock()
	defer d.mu.Unlock()
	return AdbDownloadStatus{ID: d.id, Path: d.path, State: d.state, Received: d.received, Total: d.total, Error: d.errMsg}
}

func (d *adbDownload) setProgress(received, total int64) {
	d.mu.Lock()
	d.received, d.total = received, total
	d.mu.Unlock()
}

func (d *adbDownload) finish(state, errMsg string) {
	d.mu.Lock()
	d.state, d.errMsg = state, errMsg
	d.mu.Unlock()
}

// StartAdbDownload 開始把 rawurl 下載到 path（必須是既有 .adb），完成後原子替換。
// 回傳 id，前端用 AdbDownloadStatus(id) 輪詢、CancelAdbDownload(id) 放棄。
func (h *AdbHost) StartAdbDownload(rawurl, path, wantSha string, wantSize int64) (string, error) {
	if !isHTTPURL(rawurl) {
		return "", errors.New("只支援 http(s) 網址")
	}
	abs, err := h.resolve(path)
	if err != nil {
		return "", err
	}
	if fi, err := os.Stat(abs); err != nil || fi.IsDir() {
		return "", errors.New("找不到要更新的 adb：" + abs)
	}
	return startAdbDownload(h, rawurl, abs, wantSha, wantSize)
}

// StartNewAdbDownload 下載一個**本機還沒有**的公開資料庫：檔名經 sanitize 後寫到
// 執行檔旁（或工作目錄／下載資料夾）。已存在同名檔則拒絕，交給更新流程處理。
func (h *AdbHost) StartNewAdbDownload(rawurl, name, wantSha string, wantSize int64) (string, error) {
	if !isHTTPURL(rawurl) {
		return "", errors.New("只支援 http(s) 網址")
	}
	clean := sanitizeAdbName(name)
	var target string
	for _, dir := range append(seedDirs(), downloadsDir()) {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		_ = os.MkdirAll(dir, 0o755)
		p := filepath.Join(dir, clean)
		if _, err := os.Stat(p); err == nil {
			return "", errors.New("本機已經有 " + clean + "，請用更新功能")
		}
		f, err := os.CreateTemp(dir, ".accelon26-*.tmp")
		if err != nil {
			continue
		}
		tmp := f.Name()
		_ = f.Close()
		_ = os.Remove(tmp)
		target = p
		break
	}
	if target == "" {
		return "", errors.New("找不到可寫入的資料夾")
	}
	return startAdbDownload(h, rawurl, target, wantSha, wantSize)
}

func startAdbDownload(h *AdbHost, rawurl, abs, wantSha string, wantSize int64) (string, error) {
	id := fmt.Sprintf("dl-%d", time.Now().UnixNano())
	ctx, cancel := context.WithCancel(context.Background())
	d := &adbDownload{id: id, path: abs, state: "running", total: wantSize, cancel: cancel}

	adbDlMu.Lock()
	// 同一個檔案只允許一個下載在跑（連點兩下不會互相覆蓋暫存檔）。
	for _, other := range adbDls {
		o := other.snapshot()
		if o.State == "running" && strings.EqualFold(o.Path, abs) {
			adbDlMu.Unlock()
			cancel()
			return "", errors.New("這個資料庫正在下載中")
		}
	}
	adbDls[id] = d
	adbDlMu.Unlock()

	go runAdbDownload(ctx, h, d, rawurl, abs, wantSha)
	return id, nil
}

func runAdbDownload(ctx context.Context, h *AdbHost, d *adbDownload, rawurl, abs, wantSha string) {
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".accelon26-*.tmp")
	if err != nil {
		d.finish("error", "無法在原檔旁建立暫存檔："+err.Error())
		return
	}
	tmpName := tmp.Name()
	renamed := false
	defer func() {
		if !renamed {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()

	if old, err := os.Stat(abs); err == nil {
		_ = tmp.Chmod(old.Mode().Perm())
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawurl, nil)
	if err != nil {
		d.finish("error", err.Error())
		return
	}
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := adbHTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			d.finish("cancelled", "")
		} else {
			d.finish("error", "下載失敗："+err.Error())
		}
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		d.finish("error", fmt.Sprintf("下載失敗：HTTP %d", resp.StatusCode))
		return
	}

	total := resp.ContentLength
	if total <= 0 {
		total = d.snapshot().Total // 伺服器沒給 Content-Length：用 manifest 的大小
	}
	d.setProgress(0, total)

	hasher := sha256.New()
	buf := make([]byte, 128<<10)
	var received int64
	for {
		if ctx.Err() != nil {
			d.finish("cancelled", "")
			return
		}
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := tmp.Write(buf[:n]); werr != nil {
				d.finish("error", "寫入暫存檔失敗："+werr.Error())
				return
			}
			_, _ = hasher.Write(buf[:n])
			received += int64(n)
			d.setProgress(received, total)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			if ctx.Err() != nil {
				d.finish("cancelled", "")
			} else {
				d.finish("error", "下載中斷："+rerr.Error())
			}
			return
		}
	}

	if err := tmp.Sync(); err != nil {
		d.finish("error", "暫存檔同步失敗："+err.Error())
		return
	}
	if err := tmp.Close(); err != nil {
		d.finish("error", "關閉暫存檔失敗："+err.Error())
		return
	}
	if total > 0 && received != total {
		d.finish("error", fmt.Sprintf("下載不完整：收到 %d／%d bytes", received, total))
		return
	}
	got := hex.EncodeToString(hasher.Sum(nil))
	if wantSha != "" && !strings.EqualFold(got, wantSha) {
		d.finish("error", "下載檔案的 sha256 與清單不符（可能被截斷或換過檔）")
		return
	}
	if head, err := readHead(tmpName, 256); err != nil || !validAdbHeader(head) {
		d.finish("error", "下載的檔案不是 .adb（檔頭簽名不符）")
		return
	}

	// 到這裡才動原檔：先解除 mmap，再 rename（Windows 上被映射的檔案不能換）。
	_ = h.Close(abs)
	var renameErr error
	for i := 0; i < 40; i++ { // 最多約 2 秒：等最後一個讀取退出
		if renameErr = os.Rename(tmpName, abs); renameErr == nil {
			renamed = true
			d.finish("done", "")
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	d.finish("error", "無法替換原檔（可能被其他程式鎖住；原檔沒有更動）："+renameErr.Error())
}

func readHead(path string, n int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b := make([]byte, n)
	m, err := io.ReadFull(f, b)
	if err != nil && err != io.ErrUnexpectedEOF {
		return nil, err
	}
	return b[:m], nil
}

// AdbDownloadStatus 輪詢一個下載。找不到（例如程式剛重啟）回 error。
func (h *AdbHost) AdbDownloadStatus(id string) (AdbDownloadStatus, error) {
	adbDlMu.Lock()
	d := adbDls[id]
	adbDlMu.Unlock()
	if d == nil {
		return AdbDownloadStatus{}, errors.New("找不到這個下載")
	}
	return d.snapshot(), nil
}

// CancelAdbDownload 放棄下載：中斷連線、刪掉暫存檔，原檔不動。
func (h *AdbHost) CancelAdbDownload(id string) bool {
	adbDlMu.Lock()
	d := adbDls[id]
	adbDlMu.Unlock()
	if d == nil {
		return false
	}
	d.mu.Lock()
	if d.state != "running" {
		d.mu.Unlock()
		return false
	}
	cancel := d.cancel
	d.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return true
}

// cleanupStaleAdbTemps 清掉上次中斷（當機、直接關行程）留下的下載暫存檔。
// 只刪超過 6 小時的：另一個 accelon26 視窗可能正在下載（同一個資料夾）。
func cleanupStaleAdbTemps() {
	cutoff := time.Now().Add(-6 * time.Hour)
	for _, dir := range seedDirs() {
		matches, err := filepath.Glob(filepath.Join(dir, ".accelon26-*.tmp"))
		if err != nil {
			continue
		}
		for _, p := range matches {
			if fi, err := os.Stat(p); err == nil && fi.ModTime().Before(cutoff) {
				_ = os.Remove(p)
			}
		}
	}
}
