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
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
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
	Files      int    `json:"files"`      // 文字檔數（有 <檔> 的庫：一篇一個）
	Lines      int64  `json:"lines"`      // 保留的硬換行數（＝行數）
	ImageCount int    `json:"imageCount"` // 導出的圖片張數
	ImageBytes int64  `json:"imageBytes"`
	ZipBytes   int64  `json:"zipBytes"`
	Ms         int64  `json:"ms"`
}

// hardBreak 是 txt 裡保留的硬換行。用 CRLF：這份檔多半在 Windows 上打開
// （記事本與多數編輯器都認得；Unix 工具也吃得下）。
const hardBreak = "\r\n"

// lineEnds 讀 tables/lines.physical：每一行的**結束位置**（原始單位是 UTF-16LE 位元組，
// `>>1` 就是 code unit 索引）。沒有這個表就回 nil（導出的 txt 就沒有換行）。
func (f *adbSearchFile) lineEnds() []int64 {
	t, ok := f.container("tables")
	if !ok {
		return nil
	}
	idx := -1
	for i, n := range t.names {
		if n == "lines.physical" {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil
	}
	ends, err := f.blockList("tables", idx)
	if err != nil || len(ends) == 0 {
		return nil
	}
	out := make([]int64, len(ends))
	for i, b := range ends {
		out[i] = int64(b) >> 1
	}
	return out
}

// exportReadme 放在 zip 裡，說明這個壓縮檔是什麼、不是什麼。
const exportReadme = `accelon26 導出（文字 ＋ 圖片）

這個壓縮檔只包含資料庫的內容：
  *.xml          有 <檔> 的資料庫：**一篇一個檔案**（名字取 <檔 n="…">），
                 內容是該篇原樣標記（含 <檔> … </檔> 包起來），保留原書硬換行（CRLF）
  *.txt          沒有 <檔> 的資料庫：全部文字串成一個檔（同樣保留硬換行）
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

// ---- 文字：一個檔或一篇一個檔 ----------------------------------------------------
//
// 兩種資料庫（作者 2026-10）：
//   * **有 `<檔>` 的**（yinshun、taixu…）：第一篇是 `<檔 n="yinshun.xml">` 這種設定檔，
//     之後每一本書一個 `<檔 n="y01.xml">`。作者要的是「按照文件 block 分成 Y01.xml」，
//     所以一篇一個檔案（名字取 `n="…"`），內容含 `<檔 …>` 包起來的原樣標記。
//   * **沒有 `<檔>` 的**（13j、jc、kangxi…）：全部串成 `<db>.txt`。
//
// 兩種都保留原書的硬換行（tables/lines.physical）：行尾是「所有 source 區塊串起來之後」
// 的偏移，一行可能跨區塊（13j：42,173 個行尾只有 13 個落在區塊邊界上），所以在整個
// 串流上一邊切一邊寫。

// sourceUnits 解壓第 i 個 source 區塊，回傳 UTF-16 code unit（已截到第一個 NUL）。
func (f *adbSearchFile) sourceUnits(src *adbContainer, i int) ([]uint16, error) {
	r0, r1 := blockRangeOf(src, i)
	if r0 < 0 || r1 > int64(len(f.view)) || r1 < r0 {
		return nil, fmt.Errorf("source 區塊 %d 超出檔案範圍", i)
	}
	raw, err := bunzip(f.view[r0:r1])
	if err != nil {
		return nil, fmt.Errorf("source 區塊 %d：%w", i, err)
	}
	if n := firstNulUnit(raw); n >= 0 {
		raw = raw[:n*2]
	}
	units := make([]uint16, len(raw)/2)
	for j := range units {
		units[j] = uint16(raw[j*2]) | uint16(raw[j*2+1])<<8
	}
	return units, nil
}

// unitsIndex 在 units[from:] 裡找一段 code unit 樣式（回傳絕對索引，-1＝沒有）。
// 注意樣式要用 code unit 表示，**不能**直接拿 Go 字串的位元組比對（中文是多位元組）。
func unitsIndex(units []uint16, from int, pat []uint16) int {
	n := len(pat)
	if n == 0 || from < 0 {
		return -1
	}
	for i := from; i+n <= len(units); i++ {
		ok := true
		for j := 0; j < n; j++ {
			if units[i+j] != pat[j] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}

// `<檔` 與 `</檔>` 的 code unit 形式。
var (
	docOpen  = []uint16{'<', '檔'}
	docClose = []uint16{'<', '/', '檔', '>'}
	gtOnly   = []uint16{'>'}
)

// docEntryName 從 `<檔 n="y01.xml">` 這種標籤取出檔名（沒有就用序號）。
func docEntryName(tag string, seq int) string {
	name := ""
	if m := regexpDocName.FindStringSubmatch(tag); m != nil {
		name = m[1]
	}
	return safeZipName(name, fmt.Sprintf("doc-%04d.xml", seq))
}

var regexpDocName = regexp.MustCompile(`\bn="([^"]*)"`)

// writeText 把 source 的文字寫進 zip（見上面兩種資料庫的說明）。
func (f *adbSearchFile) writeText(zw *zip.Writer, src *adbContainer, base string, now time.Time, res *ExportResult) error {
	first, err := f.sourceUnits(src, 0)
	if err != nil {
		return err
	}
	docMode := strings.HasPrefix(string(utf16.Decode(first[:min(len(first), 2)])), "<檔")
	if !docMode {
		return f.writeTextSingle(zw, src, base, now, res)
	}
	return f.writeTextDocs(zw, src, base, now, res, first)
}

// writeTextSingle：沒有 `<檔>` 的庫 —— 全部串成一個 txt。
func (f *adbSearchFile) writeTextSingle(zw *zip.Writer, src *adbContainer, base string, now time.Time, res *ExportResult) error {
	w, err := zw.CreateHeader(&zip.FileHeader{Name: base + ".txt", Method: zip.Deflate, Modified: now})
	if err != nil {
		return err
	}
	lineCU := f.lineEnds()
	var pos, li int64
	for i := 0; i < src.count; i++ {
		units, err := f.sourceUnits(src, i)
		if err != nil {
			return err
		}
		if err := writeUnits(w, units, pos, lineCU, &li, res); err != nil {
			return err
		}
		pos += int64(len(units))
		res.Blocks++
	}
	res.Files++
	res.Lines = li
	return nil
}

// writeTextDocs：有 `<檔>` 的庫 —— 一篇一個檔案，名字取 `n="…"`。
// 一篇的內容在記憶體裡累積到 `</檔>` 為止（一本書通常幾十萬字，不會爆記憶體）。
func (f *adbSearchFile) writeTextDocs(zw *zip.Writer, src *adbContainer, base string, now time.Time, res *ExportResult, first []uint16) error {
	lineCU := f.lineEnds()
	var li int64
	var pend []uint16 // 還沒寫出的文字（含目前這一篇）
	var pendAt int64  // pend[0] 在整個串流的位置
	inDoc := false
	seq := 0
	seen := map[string]int{}

	flush := func(end int) error {
		seq++
		// 名字取自這一篇開頭的 `<檔 … n="…">`
		entry := docEntryName(string(utf16.Decode(unitsSlice(pend, 0, min(len(pend), 200)))), seq)
		if n := seen[entry]; n > 0 {
			seen[entry] = n + 1
			ext := filepath.Ext(entry)
			entry = strings.TrimSuffix(entry, ext) + fmt.Sprintf("-%d", n+1) + ext
		} else {
			seen[entry] = 1
		}
		w, err := zw.CreateHeader(&zip.FileHeader{Name: entry, Method: zip.Deflate, Modified: now})
		if err != nil {
			return err
		}
		if err := writeUnits(w, unitsSlice(pend, 0, end), pendAt, lineCU, &li, res); err != nil {
			return err
		}
		res.Files++
		return nil
	}

	for i := 0; i < src.count; i++ {
		var units []uint16
		if i == 0 {
			units = first
		} else {
			u, err := f.sourceUnits(src, i)
			if err != nil {
				return err
			}
			units = u
		}
		pend = append(pend, units...)
		res.Blocks++
		for {
			if !inDoc {
				j := unitsIndex(pend, 0, docOpen)
				if j < 0 {
					break
				}
				gt := unitsIndex(pend, j, gtOnly)
				if gt < 0 {
					break // 標籤還沒收完（跨區塊），等下一塊
				}
				inDoc = true
				pendAt += int64(j) // 前面的雜訊（正常是空的）不算進這一篇
				pend = unitsSlice(pend, j, len(pend))
				continue
			}
			k := unitsIndex(pend, 0, docClose)
			if k < 0 {
				break
			}
			end := k + len(docClose)
			if err := flush(end); err != nil {
				return err
			}
			pend = unitsSlice(pend, end, len(pend))
			pendAt += int64(end)
			inDoc = false
		}
	}
	// 收尾：還有沒關起來的一篇（檔案被截斷）也照樣寫出來
	if len(pend) > 0 && inDoc {
		if err := flush(len(pend)); err != nil {
			return err
		}
	}
	return nil
}

// unitsSlice 是 []uint16 的 s[a:b]（保留原本的底層陣列，方便直接切片）。
func unitsSlice(units []uint16, a, b int) []uint16 {
	if a < 0 {
		a = 0
	}
	if b > len(units) {
		b = len(units)
	}
	if a > b {
		return nil
	}
	return units[a:b]
}

// writeUnits 把一段文字寫進 w，依 lines.physical 插入硬換行；at＝這段在整個串流的位置。
// li 是行尾表的游標（跨篇、跨區塊單調前進）。
func writeUnits(w io.Writer, units []uint16, at int64, lineCU []int64, li *int64, res *ExportResult) error {
	n := int64(len(units))
	off := int64(0)
	for *li < int64(len(lineCU)) && lineCU[*li] <= at+n {
		e := lineCU[*li] - at
		if e < 0 {
			(*li)++ // 行尾在這段之前（被跳過的雜訊），跳過
			continue
		}
		if e > off {
			if _, err := io.WriteString(w, string(utf16.Decode(units[off:e]))); err != nil {
				return err
			}
			off = e
		}
		if _, err := io.WriteString(w, hardBreak); err != nil {
			return err
		}
		res.Lines++
		(*li)++
	}
	if off < n {
		if _, err := io.WriteString(w, string(utf16.Decode(units[off:n]))); err != nil {
			return err
		}
	}
	res.Chars += n
	return nil
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

	// 2) 文字
	if err := f.writeText(zw, src, base, now, res); err != nil {
		return err
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
