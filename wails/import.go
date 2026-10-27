package main

// ---- 「加入 Obsidian」的桌面版出口（作者 2026-10-25）--------------------------------
//
// 網頁版在瀏覽器裡把 Obsidian vault 轉成 adb 之後只能「下載」；桌面版不一樣：
// 檔案寫到**執行檔旁邊**，下一次 ListAdbs 就會列出來（等於「加入了 adb 清單」）。
//
// 為什麼寫在 exe 目錄而不是下載資料夾：作者要的是「桌面版放在執行檔文件夾」——
// 讀者不必再去下載資料夾搬檔。不可寫時（例如放在 Program Files）才退回下載資料夾，
// 並用 Note 告訴使用者實際存到哪裡。
//
// 資料走 base64 而不是 []byte：Wails 的 JSON 橋會把每個位元組變成一個數字（膨脹
// 約 6 倍），一個 4 MB 的 adb 會變成 24 MB 的 IPC。

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// SaveAdbResult 是「加入 Obsidian」在桌面版的結果（UI 直接顯示這幾個欄位）。
type SaveAdbResult struct {
	OK    bool   `json:"ok"`
	Path  string `json:"path,omitempty"`
	Error string `json:"error,omitempty"`
	Note  string `json:"note,omitempty"`
}

// adbSignature 是每個 .adb 檔頭 32..80 的簽名（後面補 NUL 到 48 bytes）；寫入前先確認
// 真的寫出了資料庫。注意要比的是**簽名本身的長度**，不是整個 32..80 欄位。
const adbSignature = "\r\nAccelon Search Engine\r\ndesigned by C.S.Yap"

// validAdbHeader：至少一個檔頭，且 32..(32+簽名長度) 等於簽名。
func validAdbHeader(data []byte) bool {
	if len(data) < 256 {
		return false
	}
	return string(data[32:32+len(adbSignature)]) == adbSignature
}

var adbNameSanitizer = regexp.MustCompile(`[^0-9A-Za-z._-]+`)

// sanitizeAdbName 只留檔名（擋掉路徑）、ASCII 安全字元，並強制 .adb 結尾。
func sanitizeAdbName(name string) string {
	clean := strings.TrimSpace(name)
	clean = filepath.Base(clean)
	clean = adbNameSanitizer.ReplaceAllString(clean, "-")
	clean = strings.Trim(clean, "-.")
	if clean == "" {
		clean = "book"
	}
	if !strings.EqualFold(filepath.Ext(clean), ".adb") {
		clean += ".adb"
	}
	return clean
}

// seedDirs 是「adb 會出現的資料夾」：目前工作目錄與執行檔所在目錄。
// 兩者通常是同一個（雙擊 exe）；從捷徑用不同的「開始位置」啟動時才會分開。
func seedDirs() []string {
	var out []string
	if cwd, err := os.Getwd(); err == nil && cwd != "" {
		out = append(out, cwd)
	}
	if exe, err := os.Executable(); err == nil {
		out = append(out, filepath.Dir(exe))
	}
	return out
}

// SaveAdb 把剛建好的 adb 寫到執行檔旁邊，失敗才退到下載資料夾／暫存。
//
// name 只取檔名（擋掉路徑）、只留 ASCII 安全字元、強制 .adb 結尾：
// 檔頭裡的 dbname 是 ASCII，兩邊同名最不容易混淆。
func (h *AdbHost) SaveAdb(name string, b64 string) SaveAdbResult {
	clean := sanitizeAdbName(name)

	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return SaveAdbResult{Error: "資料解碼失敗：" + err.Error()}
	}
	if !validAdbHeader(data) {
		return SaveAdbResult{Error: "這不是 .adb 檔（檔頭簽名不符）"}
	}

	targets := seedDirs()             // exe 目錄優先，其次工作目錄
	fallback := downloadsDir()        // 兩者都不可寫時才用
	if fallback != "" {
		targets = append(targets, fallback)
	}
	targets = append(targets, filepath.Join(os.TempDir(), "accelon26-import"))
	res := saveAdbInto(targets, clean, data)
	if res.OK {
		res.Note = noteIfMoved(res.Path)
	}
	return res
}

// OverwriteAdb 把重建好的 adb 覆寫回**原來的那個檔案**（作者 2026-10-27）。
//
// 為什麼不讓 WebView 用「下載」覆蓋：目前開啟的 adb 由宿主 mmap 著，Windows 上
// 被映射的檔案不能 rename／覆寫，WebView 的另存新檔會失敗並要使用者換資料夾。
// 這裡先 Close 解除映射，再寫同目錄暫存檔、rename 蓋回去（rename 失敗會重試，
// 讓最後一個還在讀的 ReadBase64 先退出）。
//
// 成功後宿主不再持有舊映射；前端要立刻重新開啟這個檔（見 rebuild-ui.ts 的 reloadPath）。
func (h *AdbHost) OverwriteAdb(path string, b64 string) SaveAdbResult {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return SaveAdbResult{Error: "資料解碼失敗：" + err.Error()}
	}
	if !validAdbHeader(data) {
		return SaveAdbResult{Error: "這不是 .adb 檔（檔頭簽名不符）"}
	}
	abs, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil || abs == "" {
		return SaveAdbResult{Error: "檔案路徑不合法"}
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return SaveAdbResult{Error: "找不到要覆蓋的檔案：" + err.Error()}
	}
	if fi.IsDir() || !strings.EqualFold(filepath.Ext(abs), ".adb") {
		return SaveAdbResult{Error: "只能覆蓋 .adb 檔"}
	}

	// 1) 解除 mmap（Windows 上這是能不能 rename 的關鍵）
	_ = h.Close(abs)

	// 2) 同目錄暫存檔 → rename（同一檔案系統才是原子替換）
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".accelon26-*.tmp")
	if err != nil {
		return SaveAdbResult{Error: "無法在原檔旁建立暫存檔：" + err.Error()}
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		cleanup()
		return SaveAdbResult{Error: "寫入暫存檔失敗：" + err.Error()}
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return SaveAdbResult{Error: "暫存檔同步失敗：" + err.Error()}
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return SaveAdbResult{Error: "關閉暫存檔失敗：" + err.Error()}
	}
	if err := os.Chmod(tmpName, fi.Mode().Perm()); err != nil {
		_ = err // 權限複製失敗不致命，rename 後仍是原檔權限
	}

	var renameErr error
	for i := 0; i < 40; i++ { // 最多約 2 秒：等最後一個 reader 放掉映射
		if renameErr = os.Rename(tmpName, abs); renameErr == nil {
			return SaveAdbResult{OK: true, Path: abs}
		}
		time.Sleep(50 * time.Millisecond)
	}
	// rename 真的不行（例如被其他程式鎖住）：退一步直接覆寫
	if err := os.WriteFile(abs, data, fi.Mode().Perm()); err == nil {
		cleanup()
		return SaveAdbResult{OK: true, Path: abs}
	}
	cleanup()
	return SaveAdbResult{Error: "無法覆蓋原檔（可能被其他程式鎖住）：" + renameErr.Error()}
}

// saveAdbInto 依序把 data 寫成 dirs 裡的 <name>，回傳第一個成功的位置。
// 抽出來是為了測試（測試不會去寫執行檔旁邊）。
func saveAdbInto(dirs []string, name string, data []byte) SaveAdbResult {
	seen := map[string]bool{}
	for _, dir := range dirs {
		if dir == "" || seen[dir] {
			continue
		}
		seen[dir] = true
		if err := os.MkdirAll(dir, 0o755); err != nil {
			continue
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, data, 0o644); err != nil {
			continue
		}
		if abs, err := filepath.Abs(path); err == nil {
			path = abs
		}
		return SaveAdbResult{OK: true, Path: path}
	}
	return SaveAdbResult{Error: "找不到可寫入的資料夾（執行檔旁、下載資料夾、暫存都失敗）"}
}

// noteIfMoved：檔案不在執行檔旁邊時給一句提示（使用者要知道去哪裡找）。
func noteIfMoved(path string) string {
	if wroteBesideExe(path) {
		return ""
	}
	return "執行檔所在資料夾寫不進去，已改存到 " + filepath.Dir(path)
}

// wroteBesideExe：剛寫的檔案是不是就在執行檔旁邊（用來決定要不要提示「改存到別處」）。
func wroteBesideExe(path string) bool {
	exe, err := os.Executable()
	if err != nil {
		return true
	}
	return strings.EqualFold(filepath.Dir(path), filepath.Dir(exe))
}
