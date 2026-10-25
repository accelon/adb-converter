package main

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode/utf16"
)

// 這一層刻意做得極薄，只做兩件事：
//   1. 列出當前工作目錄裡的 *.adb，並只讀每個檔案的前 256 位元組檔頭；
//   2. 用 mmap 把檔案裡的任意位元組區間按 base64 交給 webview。
// 任何 adb 格式解析都在 TypeScript 側（assets/index.html），這裡一概不做：
// 沒有事件、沒有 socket、沒有自訂協議。
//
// 綁定名約定：套件名 + service 型別名 + 方法名，套件名為 main，所以前端這樣呼叫
//   const c = (await import("/wails/runtime.js")).Call;
//   await c.ByName("main.AdbHost.ListAdbs");
//   await c.ByName("main.AdbHost.ReadBase64", path, offset, length);

// ---------------------------------------------------------------------------
// mmap 層：mmapFile / unmapFile 是平台相依的（sys_windows.go / sys_darwin.go），
// 這裡只負責快取映射、參考計數與解除映射的時機。
//
// 為什麼用 mmap 而不是每次 os.Open + ReadAt，見 sys_windows.go 的說明。
// ---------------------------------------------------------------------------

// mapped 是一個已 mmap 的 .adb 檔案。
type mapped struct {
	key     string     // 快取鍵：小寫、規範化後的絕對路徑
	abs     string     // 規範化後的絕對路徑（原樣大小寫）
	view    []byte     // 整個檔案的映射內容（page cache 支撐）
	handle  mmapHandle // 映射物件的控制代碼（macOS 沒有，一律 0）
	size    int64
	refs    int  // 參考計數：>0 期間映射不會被解除
	pinned  bool // Open 釘住的參考（由 Close 釋放）
	closing bool // Close 已請求，等 refs 歸零後再 unmap
}

// AdbInfo 是一個 .adb 對前端可見的全部資訊，只來自 256 位元組檔頭 + 目錄中繼資料。
type AdbInfo struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	DbName   string `json:"dbname"`
	DbCName  string `json:"dbcname"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

// AdbHost 是註冊給 Wails 的唯一 service。
// webview 會從多個 goroutine 呼叫它，所以內部狀態一律用 mu 保護。
type AdbHost struct {
	mu     sync.Mutex
	files  map[string]*mapped
	search map[string]*adbSearchFile // 已解析的容器表（search.go），與映射同生共死

	// winInfo 由 main 在建立視窗後注入（window.go）。UI 不需要它，測試與多螢幕排錯用。
	winInfo func() map[string]any
	// 全螢幕切換（Esc／F11 用）：main 注入，UI 不需要知道是 Wails 還是別的。
	toggleFullscreen func()

	// 更新（update.go）：背景檢查的快取結果、-updated-from 的值、結束應用程式的回呼。
	updateSt    UpdateStatus
	updatedFrom string
	quit        func()
	// installMu 讓「下載＋換檔＋重啟」一次只有一個人在做（連點兩次、兩個視窗都按更新）。
	installMu sync.Mutex
	// exportMu 讓「導出文字與圖片」一次只有一個人在做（export.go）。
	exportMu sync.Mutex
}

// SetWindowInfo 注入視窗診斷（main 在建立視窗前後設定）。
func (h *AdbHost) SetWindowInfo(f func() map[string]any) { h.winInfo = f }

// OpenExternal 用系統的預設瀏覽器開一個網址（「留言給作者」這類外部連結）。
// WebView2 的 target=_blank 只會開一個內嵌的新視窗，那不是使用者要的：
// 「關於」裡的「留言給作者」走這條，才會真的開 Chrome／Edge（macOS 是 Safari）。
// 實際的啟動指令是平台相依的（openURLCommand）：Windows 用 rundll32，macOS 用 open。
func (h *AdbHost) OpenExternal(rawurl string) bool {
	if !strings.HasPrefix(rawurl, "https://") && !strings.HasPrefix(rawurl, "http://") {
		return false
	}
	cmd := openURLCommand(rawurl)
	if err := cmd.Start(); err != nil {
		return false
	}
	go func() { _ = cmd.Wait() }()
	return true
}

// RevealInFolder 在系統的檔案管理員裡顯示一個檔案（導出 zip 之後那顆按鈕）。
// 只接受真的存在的檔案；指令本身是平台相依的（revealCommand）。
func (h *AdbHost) RevealInFolder(p string) bool {
	if p == "" {
		return false
	}
	if fi, err := os.Stat(p); err != nil || fi.IsDir() {
		return false
	}
	cmd := revealCommand(p)
	if err := cmd.Start(); err != nil {
		return false
	}
	go func() { _ = cmd.Wait() }()
	return true
}

// SetToggleFullscreen 注入「切換全螢幕」（main 在建立視窗後設定）。
func (h *AdbHost) SetToggleFullscreen(f func()) {
	h.mu.Lock()
	h.toggleFullscreen = f
	h.mu.Unlock()
}

// ToggleFullscreen 切換全螢幕（Esc／F11）。Wails 的全螢幕會把 WS_OVERLAPPEDWINDOW 換成
// WS_POPUP，所以全螢幕時沒有標題列、也不能縮放；切回來就會回復。
func (h *AdbHost) ToggleFullscreen() bool {
	h.mu.Lock()
	f := h.toggleFullscreen
	h.mu.Unlock()
	if f != nil {
		f()
	}
	return h.IsFullscreen()
}

// IsFullscreen 目前是不是全螢幕（UI 顯示提示用）。
func (h *AdbHost) IsFullscreen() bool {
	if h.winInfo == nil {
		return false
	}
	info := h.winInfo()
	v, _ := info["fullscreen"].(bool)
	return v
}

// WindowInfo 回傳視窗現況：位置、大小、狀態（normal/maximised/fullscreen）、所在螢幕、
// 工作區、上次的 normal 幾何，以及狀態檔路徑。沒有視窗（例如 -selftest）時回空 map。
func (h *AdbHost) WindowInfo() map[string]any {
	if h.winInfo == nil {
		return map[string]any{}
	}
	return h.winInfo()
}

// resolve 把前端傳來的 path 規範化，並做嚴格的白名單驗證：
// 必須是 .adb 結尾，且必須位於當前工作目錄（或執行檔所在目錄）之內。
// 本地閱讀器，從嚴即可；執行檔目錄是 2026-10-25 加的，因為「加入 Obsidian」把
// 新建的 adb 寫在 exe 旁邊，而捷徑的「開始位置」不一定等於 exe 所在的資料夾。
func (h *AdbHost) resolve(path string) (string, error) {
	if path == "" {
		return "", errors.New("empty path")
	}
	if !strings.EqualFold(filepath.Ext(path), ".adb") {
		return "", fmt.Errorf("not an .adb file: %q", path)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	allowed := insideDir(cwd, abs)
	if !allowed {
		if exe, err := os.Executable(); err == nil {
			allowed = insideDir(filepath.Dir(exe), abs)
		}
	}
	if !allowed {
		return "", fmt.Errorf("path outside working directory: %s", abs)
	}
	return abs, nil
}

// insideDir 判斷 path 是否就是 dir 或位於 dir 之內（Windows 上大小寫不敏感）。
func insideDir(dir, path string) bool {
	d := strings.ToLower(strings.TrimRight(filepath.Clean(dir), "\\/"))
	p := strings.ToLower(filepath.Clean(path))
	return p == d || strings.HasPrefix(p, d+string(os.PathSeparator))
}

// acquire 取得 path 的映射（首次存取時建立）並把參考計數 +1；用完必須 release。
func (h *AdbHost) acquire(path string) (*mapped, error) {
	abs, err := h.resolve(path)
	if err != nil {
		return nil, err
	}
	key := strings.ToLower(abs)

	h.mu.Lock()
	defer h.mu.Unlock()
	if h.files == nil {
		h.files = make(map[string]*mapped)
	}
	if m := h.files[key]; m != nil && !m.closing {
		m.refs++
		return m, nil
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if fi.IsDir() {
		return nil, fmt.Errorf("is a directory: %s", abs)
	}
	view, handle, err := mmapFile(abs, fi.Size())
	if err != nil {
		return nil, err
	}
	m := &mapped{key: key, abs: abs, view: view, handle: handle, size: fi.Size(), refs: 1}
	h.files[key] = m
	return m, nil
}

// release 參考計數 -1。映射本身會一直快取，直到 Close / CloseAll。
func (h *AdbHost) release(m *mapped) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if m.refs > 0 {
		m.refs--
	}
	if m.refs == 0 && m.closing {
		h.dropLocked(m.key, m)
	}
}

// dropLocked 從快取移除並解除映射（呼叫方需持有 h.mu）。
func (h *AdbHost) dropLocked(key string, m *mapped) {
	if h.files[key] == m {
		delete(h.files, key)
	}
	unmapFile(m.view, m.handle)
	m.view, m.handle = nil, 0
}

// ---- 256 位元組檔頭：這是本層唯一的「解析」 -----------------------------------

// parseHeader 只解析檔頭裡的兩個名稱欄位，不做任何其它 adb 解析。
//
//	offset 0..32    ASCII，NUL 填充     -> dbname，例如 "13j"
//	offset 128..192 UTF-16LE，NUL 填充  -> dbcname，例如 "十三經"
func parseHeader(header []byte) (dbname, dbcname string) {
	if n := min(32, len(header)); n > 0 {
		dbname = trimCString(string(header[:n]))
	}
	if len(header) > 128 {
		n := min(192, len(header))
		dbcname = trimCString(decodeUTF16LE(header[128:n]))
	}
	return dbname, dbcname
}

// trimCString 去掉 C 字串的 NUL 結尾；真實檔案裡兩端都可能出現 NUL 填充。
func trimCString(s string) string {
	s = strings.Trim(s, "\x00")
	if i := strings.IndexByte(s, 0); i >= 0 {
		s = s[:i]
	}
	return s
}

// decodeUTF16LE 把 UTF-16LE 位元組解成 Go 字串（不做位元組序猜測）。
func decodeUTF16LE(b []byte) string {
	if len(b) < 2 {
		return ""
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[i*2:])
	}
	return string(utf16.Decode(u))
}

// infoFor 組裝一個檔案的 AdbInfo（呼叫方需已持有該檔案的映射參考）。
func (h *AdbHost) infoFor(m *mapped) AdbInfo {
	info := AdbInfo{Path: m.abs, Name: filepath.Base(m.abs), Size: m.size}
	if fi, err := os.Stat(m.abs); err == nil {
		info.Modified = fi.ModTime().UnixMilli()
	}
	if n := min(int64(256), m.size); n > 0 && len(m.view) >= int(n) {
		info.DbName, info.DbCName = parseHeader(m.view[:n])
	}
	// 顯示名優先序：dbcname > dbname > 檔名
	switch {
	case info.DbCName != "":
		info.Name = info.DbCName
	case info.DbName != "":
		info.Name = info.DbName
	}
	return info
}

// ---- 暴露給 webview 的方法 ----------------------------------------------------

// ListAdbs 列出 *.adb（大小寫不敏感）：工作目錄與執行檔所在目錄（作者 2026-10-25
// 加入「加入 Obsidian」後，adb 會寫在 exe 旁邊，而 exe 的「開始位置」不一定等於它
// 所在的資料夾）。同一個絕對路徑只列一次。每個檔案只讀前 256 位元組檔頭。
func (h *AdbHost) ListAdbs() ([]AdbInfo, error) {
	dirs := seedDirs()
	seen := map[string]bool{}
	out := make([]AdbInfo, 0, 16)
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue // 目錄不存在／不可讀：跳過它，不要讓整個列表失敗
		}
		for _, e := range entries {
			if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".adb") {
				continue
			}
			path := filepath.Join(dir, e.Name())
			if abs, err := filepath.Abs(path); err == nil {
				path = abs
			}
			if seen[strings.ToLower(path)] {
				continue
			}
			seen[strings.ToLower(path)] = true
			m, err := h.acquire(path)
			if err != nil {
				continue // 讀不了的檔案跳過，不阻塞整個列表
			}
			info := h.infoFor(m)
			h.release(m)
			out = append(out, info)
		}
	}
	if len(out) == 0 {
		// 保留原本的錯誤語意：連工作目錄都讀不到時回報錯誤
		if _, err := os.ReadDir("."); err != nil {
			return nil, err
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Open 驗證並 mmap 一個 .adb（結果快取在 files 裡），回傳它的檔頭資訊。
// 開啟會增加一個「釘住」的參考：映射保持到 Close / CloseAll，
// 因此隨後的 ReadBase64 不需要重新映射。重複 Open 不會重複計數。
func (h *AdbHost) Open(path string) (*AdbInfo, error) {
	m, err := h.acquire(path)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	if m.pinned {
		m.refs-- // 已經釘住過，撤銷這次多餘的參考
	} else {
		m.pinned = true // 這次 acquire 的參考轉交給 pin
	}
	h.mu.Unlock()
	info := h.infoFor(m)
	return &info, nil
}

// ReadBase64 是 UI 唯一的讀取入口：回傳 [offset, offset+length) 的 base64。
// 越界、負的 offset 或負的 length 都回傳 error（不 panic，也不悄悄截斷範圍）。
func (h *AdbHost) ReadBase64(path string, offset int64, length int) (string, error) {
	if length < 0 {
		return "", fmt.Errorf("negative length: %d", length)
	}
	if length == 0 {
		return "", nil
	}
	if offset < 0 {
		return "", fmt.Errorf("negative offset: %d", offset)
	}
	m, err := h.acquire(path)
	if err != nil {
		return "", err
	}
	defer h.release(m)

	end := offset + int64(length)
	if end < offset || end > m.size {
		return "", fmt.Errorf("read [%d,%d) out of bounds (size %d)", offset, end, m.size)
	}
	return base64.StdEncoding.EncodeToString(m.view[offset:end]), nil
}

// readAt 回傳映射內容裡 [off, off+n) 的切片（不拷貝），供 ReadBase64 的同類
// 呼叫與測試使用。因為映射是快取的，回傳的切片在 Close / CloseAll 之前一直有效。
func (h *AdbHost) readAt(path string, off, n int64) ([]byte, error) {
	if off < 0 || n < 0 {
		return nil, fmt.Errorf("negative range: off=%d n=%d", off, n)
	}
	m, err := h.acquire(path)
	if err != nil {
		return nil, err
	}
	defer h.release(m)
	if off+n < off || off+n > m.size {
		return nil, fmt.Errorf("range [%d,%d) out of bounds (size %d)", off, off+n, m.size)
	}
	return m.view[off : off+n], nil
}

// Close 解除一個檔案的映射（冪等）。如果此刻還有讀取在進行，
// 會等最後一個 reader 退出後再 unmap。
func (h *AdbHost) Close(path string) error {
	abs, err := h.resolve(path)
	if err != nil {
		return err
	}
	key := strings.ToLower(abs)
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.files[key]
	if m == nil {
		return nil
	}
	if m.pinned {
		m.pinned = false
		if m.refs > 0 {
			m.refs--
		}
	}
	m.closing = true
	if m.refs == 0 {
		h.dropLocked(key, m)
	}
	delete(h.search, key) // 查詢用的容器表指向這塊映射，不能再留
	return nil
}

// CloseAll 強制解除所有映射，供測試與程式結束時呼叫
// （呼叫時不應再有並發的 ReadBase64）。
func (h *AdbHost) CloseAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, m := range h.files {
		h.dropLocked(key, m)
	}
	h.search = nil
}
