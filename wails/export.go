package main

// ---- 導出：文字 ＋ 圖片（作者 2026-10）------------------------------------------
//
// 進階模式 → 容量 分頁的「導出」：把 adb 裡的**文字**（source 容器解壓後的原樣標記）
// 與**圖片**（resources 容器的每一個資源）打包成一個 zip，存到使用者的「下載」資料夾。
//
// 刻意**不導出即時建置的索引**：tokens／postings／tags／tables／attributes／caches
// —— 那些是為了查詢而生的，換一台機器或換一個閱讀器都可以重建，體積卻很大
// （作者 2026-10：「去除 posting, tags 等即時建置的信息，只將文字和圖片」）。
//
// 為什麼在 Go 做：source 要逐塊 bzip2 解壓、resources 要按容器的長度表切片，兩者都已經
// 在 mmap 裡；在 Go 直接串流寫 zip（archive/zip）不必經過 Wails 的 JSON 橋
// （350 MB 的 adb 走 base64 會是 GB 級的 IPC 流量）。

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// ExportResult 是「導出文字與圖片」的結果（UI 直接顯示這幾個數字）。
type ExportResult struct {
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	Note       string `json:"note,omitempty"` // 例如「下載資料夾寫不進去，已改存到…」
	Path       string `json:"path,omitempty"`
	Folder     string `json:"folder,omitempty"`
	Chars      int64  `json:"chars"`      // 文字字元數（UTF-16 code unit，含標記）
	Blocks     int    `json:"blocks"`     // source 區塊數
	ImageCount int    `json:"imageCount"` // 導出的圖片張數
	ImageBytes int64  `json:"imageBytes"`
	ZipBytes   int64  `json:"zipBytes"`
	Ms         int64  `json:"ms"`
}

// exportReadme 放在 zip 裡，說明這個壓縮檔是什麼、不是什麼。
const exportReadme = `accelon26 導出（文字 ＋ 圖片）

這個壓縮檔只包含資料庫的內容：
  *.txt          全部文字（source 容器解壓後的原樣標記，XML 形式）
  images/…       resources 容器裡的每一個資源（圖片等）

不含 tokens／postings／tags／tables／attributes／caches 這些「即時建置」的索引
—— 它們是為了查詢而產生的，任何 adb 閱讀器都可以重建，體積卻很大。

由 accelon26 的「進階 → 容量 → 導出」產生。
`

// downloadsDir 回傳使用者的「下載」資料夾（Windows 與 macOS 都是 ~/Downloads）；
// 沒有這個資料夾就退回家目錄。
func downloadsDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	d := filepath.Join(home, "Downloads")
	if st, err := os.Stat(d); err == nil && st.IsDir() {
		return d
	}
	return home
}

// exportDirs 依序嘗試的存放位置：使用者的「下載」資料夾 → exe 旁邊的 export/ →
// 系統暫存。實務上下載資料夾可能不存在，或被防毒／受控資料夾存取擋住（作者 2026-10
// 在沙箱裡就遇到 Access is denied），所以要有一條退路，並且告訴使用者實際存到哪裡。
func exportDirs() []string {
	var out []string
	if d := downloadsDir(); d != "" {
		out = append(out, d)
	}
	if exe, err := os.Executable(); err == nil {
		out = append(out, filepath.Join(filepath.Dir(exe), "export"))
	}
	out = append(out, filepath.Join(os.TempDir(), "accelon26-export"))
	return out
}

// ExportTextImages 把 adb 的文字與圖片打包成 zip，存到「下載」資料夾（寫不進去就退到
// exe 旁的 export/，再不行就系統暫存；結果會說明實際位置）。
// 同一時間只允許一個導出（TryLock）。
func (h *AdbHost) ExportTextImages(adbPath string) ExportResult {
	if !h.exportMu.TryLock() {
		return ExportResult{Error: "已經在導出中，請稍等"}
	}
	defer h.exportMu.Unlock()

	t0 := time.Now()
	abs, err := h.resolve(adbPath)
	if err != nil {
		return ExportResult{Error: err.Error()}
	}
	f, err := h.searchFile(abs)
	if err != nil {
		return ExportResult{Error: err.Error()}
	}
	preferred := downloadsDir()
	base := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	name := fmt.Sprintf("%s-export-%s.zip", base, time.Now().Format("20060102-1504"))

	var firstErr error
	for _, dir := range exportDirs() {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("%s：%w", dir, err)
			}
			continue
		}
		out := filepath.Join(dir, name)
		res := ExportResult{Path: out, Folder: dir}
		if err := writeExportZip(f, base, out, &res); err != nil {
			_ = os.Remove(out) // 不留下半個壓縮檔
			if firstErr == nil {
				firstErr = fmt.Errorf("%s：%w", dir, err)
			}
			continue
		}
		if st, err := os.Stat(out); err == nil {
			res.ZipBytes = st.Size()
		}
		res.OK = true
		if dir != preferred {
			// 只說原因；「存到哪裡」由 UI 那句話負責（避免同一個路徑講兩次）
			res.Note = "「下載」資料夾寫不進去（" + errText(firstErr) + "）"
		}
		res.Ms = time.Since(t0).Milliseconds()
		return res
	}
	return ExportResult{Error: "沒有可寫入的位置（" + errText(firstErr) + "）"}
}

// errText 把 error 變成一句給人看的話（nil 就回「未知原因」）。
func errText(err error) string {
	if err == nil {
		return "未知原因"
	}
	return err.Error()
}

// isImageName 判斷是不是已經壓縮過的圖片格式（用 zip.Store 存，不必再 deflate）。
func isImageName(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg":
		return true
	}
	return false
}

// safeZipName 只留檔名（資源名稱可能帶目錄或反斜線），避免 ../ 之類的路徑。
func safeZipName(name string, fallback string) string {
	n := strings.ReplaceAll(name, "\\", "/")
	n = path.Base(n)
	n = strings.TrimSpace(n)
	if n == "" || n == "." || n == ".." || n == "/" {
		return fallback
	}
	return n
}

// writeExportZip 真的寫檔：一個文字檔 ＋ images/ 下的每個資源 ＋ README.txt。
// 內容全部從 f.view（mmap）直接讀，不複製整份資料。
func writeExportZip(f *adbSearchFile, base, out string, res *ExportResult) error {
	src, ok := f.container("source")
	if !ok {
		return fmt.Errorf("這個 adb 沒有 source 容器")
	}
	fh, err := os.Create(out)
	if err != nil {
		return fmt.Errorf("無法建立檔案：%w", err)
	}
	defer fh.Close()

	zw := zip.NewWriter(fh)
	now := time.Now()

	// 1) README
	if w, err := zw.CreateHeader(&zip.FileHeader{Name: "README.txt", Method: zip.Deflate, Modified: now}); err != nil {
		return err
	} else if _, err := io.WriteString(w, exportReadme); err != nil {
		return err
	}

	// 2) 文字：每個 source 區塊解壓 → 截到第一個 NUL → UTF-16LE 解碼 → 串進同一個檔
	tw, err := zw.CreateHeader(&zip.FileHeader{Name: base + ".txt", Method: zip.Deflate, Modified: now})
	if err != nil {
		return err
	}
	for i := 0; i < src.count; i++ {
		r0, r1 := blockRangeOf(src, i)
		if r0 < 0 || r1 > int64(len(f.view)) || r1 < r0 {
			return fmt.Errorf("source 區塊 %d 超出檔案範圍", i)
		}
		raw, err := bunzip(f.view[r0:r1])
		if err != nil {
			return fmt.Errorf("source 區塊 %d：%w", i, err)
		}
		if n := firstNulUnit(raw); n >= 0 {
			raw = raw[:n*2]
		}
		if _, err := io.WriteString(tw, decodeUTF16LE(raw)); err != nil {
			return err
		}
		res.Chars += int64(len(raw)) / 2
		res.Blocks++
	}

	// 3) 圖片：resources 容器（未壓縮，一塊就是一個資源）
	if rsrc, ok := f.container("resources"); ok && rsrc.count > 0 {
		seen := map[string]int{}
		for i := 0; i < rsrc.count; i++ {
			name := ""
			if i < len(rsrc.names) {
				name = rsrc.names[i]
			}
			name = safeZipName(name, fmt.Sprintf("img-%04d", i+1))
			if n := seen[name]; n > 0 { // 同名資源加上序號，否則 zip 會有重複項目
				seen[name] = n + 1
				ext := filepath.Ext(name)
				name = strings.TrimSuffix(name, ext) + fmt.Sprintf("-%d", n+1) + ext
			} else {
				seen[name] = 1
			}
			r0, r1 := blockRangeOf(rsrc, i)
			if r0 < 0 || r1 > int64(len(f.view)) || r1 < r0 {
				continue
			}
			method := zip.Deflate
			if isImageName(name) {
				method = zip.Store
			}
			w, err := zw.CreateHeader(&zip.FileHeader{Name: "images/" + name, Method: method, Modified: now})
			if err != nil {
				return err
			}
			if _, err := w.Write(f.view[r0:r1]); err != nil {
				return err
			}
			res.ImageCount++
			res.ImageBytes += r1 - r0
		}
	}
	return zw.Close()
}
