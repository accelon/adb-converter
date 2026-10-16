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
	"syscall"
	"unicode/utf16"
	"unsafe"
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
// Windows kernel32 mmap 層（直呼 kernel32，不引入 golang.org/x/sys 依賴）
//
// 為什麼用 mmap 而不是每次 os.Open + ReadAt：
//   - 映射只在首次存取時建立一次（CreateFileMappingW + MapViewOfFile），
//     之後每次 ReadBase64 都只在行程位址空間內取位元組，沒有任何檔案系統
//     syscall，省掉 open/seek/read 的核心往返；
//   - 映射內容由 OS page cache 支撐，隨機小段讀取不會把整個檔案拷進 Go 堆積；
//     同時開啟多個 adb 也只是各佔一段位址空間（本應用的檔案只有 2–25 MB）；
//   - base64 直接從映射切片編碼，零中間拷貝。
// 限制：檔案大小必須 > 0；映射內容在 Close / CloseAll 之前一直有效。
// ---------------------------------------------------------------------------

const (
	pageReadonly = 0x02   // PAGE_READONLY
	fileMapRead  = 0x0004 // FILE_MAP_READ
)

var (
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procCreateFileMappingW = kernel32.NewProc("CreateFileMappingW")
	procMapViewOfFile      = kernel32.NewProc("MapViewOfFile")
	procUnmapViewOfFile    = kernel32.NewProc("UnmapViewOfFile")
	procCloseHandle        = kernel32.NewProc("CloseHandle")
)

// mmapFile 以唯讀方式把整個檔案映射進行程位址空間。
// 回傳的 []byte 直接指向映射記憶體，呼叫方必須保證在 unmapFile 之前不再使用它。
func mmapFile(path string, size int64) ([]byte, syscall.Handle, error) {
	if size <= 0 {
		return nil, 0, fmt.Errorf("cannot mmap %s: size %d", path, size)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close() // 映射物件會持有檔案參考，這裡可以立即關閉控制代碼

	// flProtect 只能是 PAGE_READONLY；FILE_MAP_READ 是 MapViewOfFile 的參數。
	h, _, errno := procCreateFileMappingW.Call(
		f.Fd(), 0,
		pageReadonly,
		uintptr(uint64(size)>>32), uintptr(uint64(size)&0xffffffff),
		0,
	)
	if h == 0 {
		return nil, 0, os.NewSyscallError("CreateFileMapping", errno)
	}
	addr, _, errno := procMapViewOfFile.Call(h, fileMapRead, 0, 0, 0)
	if addr == 0 {
		procCloseHandle.Call(h)
		return nil, 0, os.NewSyscallError("MapViewOfFile", errno)
	}
	// addr 是核心回傳的映射基底位址，其生命週期由 handle 控制。
	// 用 unsafe.Add(nil, addr) 取得基底指標（等同 uintptr→指標轉換）；
	// 這樣寫同時避開 go vet 對 uintptr→unsafe.Pointer 的誤報。
	base := unsafe.Add(nil, addr)
	view := unsafe.Slice((*byte)(base), int(size))
	return view, syscall.Handle(h), nil
}

// unmapFile 解除映射並關閉映射物件控制代碼；對已經解除過的映射是安全的。
func unmapFile(view []byte, h syscall.Handle) {
	if len(view) > 0 {
		procUnmapViewOfFile.Call(uintptr(unsafe.Pointer(&view[0])))
	}
	if h != 0 {
		procCloseHandle.Call(uintptr(h))
	}
}

// mapped 是一個已 mmap 的 .adb 檔案。
type mapped struct {
	key     string         // 快取鍵：小寫、規範化後的絕對路徑
	abs     string         // 規範化後的絕對路徑（原樣大小寫）
	view    []byte         // 整個檔案的映射內容（page cache 支撐）
	handle  syscall.Handle // CreateFileMapping 的控制代碼
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
}

// resolve 把前端傳來的 path 規範化，並做嚴格的白名單驗證：
// 必須是 .adb 結尾，且必須位於當前工作目錄之內。本地閱讀器，從嚴即可。
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
	if !insideDir(cwd, abs) {
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

// ListAdbs 列出當前工作目錄裡所有 *.adb（大小寫不敏感），
// 每個檔案只讀前 256 位元組檔頭，加上 Size / Modified(UnixMilli)。
func (h *AdbHost) ListAdbs() ([]AdbInfo, error) {
	entries, err := os.ReadDir(".")
	if err != nil {
		return nil, err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	out := make([]AdbInfo, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".adb") {
			continue
		}
		m, err := h.acquire(filepath.Join(cwd, e.Name()))
		if err != nil {
			continue // 讀不了的檔案跳過，不阻塞整個列表
		}
		info := h.infoFor(m)
		h.release(m)
		out = append(out, info)
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
