package main

import (
	"archive/zip"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

// TestSafeZipName：資源名稱只留檔名，不能帶出 ../ 之類的路徑。
func TestSafeZipName(t *testing.T) {
	cases := map[string]string{
		"cover.jpg":        "cover.jpg",
		"images/cover.jpg": "cover.jpg",
		`images\cover.jpg`: "cover.jpg",
		"../../etc/passwd": "passwd",
		"":                 "img-0001",
		".":                "img-0001",
		"..":               "img-0001",
		"/":                "img-0001",
		"   ":              "img-0001",
	}
	for in, want := range cases {
		if got := safeZipName(in, "img-0001"); got != want {
			t.Errorf("safeZipName(%q) = %q，want %q", in, got, want)
		}
	}
}

func TestIsImageName(t *testing.T) {
	for _, n := range []string{"a.png", "a.JPG", "a.jpeg", "a.webp", "a.BMP", "a.svg", "a.gif", "a.ico"} {
		if !isImageName(n) {
			t.Errorf("%q 應該當成圖片（Store）", n)
		}
	}
	for _, n := range []string{"a.txt", "a.xml", "a.bin", "a"} {
		if isImageName(n) {
			t.Errorf("%q 不該當成圖片", n)
		}
	}
}

// TestExportZip：導出只放文字與圖片 —— 索引容器（tokens／tags／postings…）不可以進去。
func TestExportZip(t *testing.T) {
	host, dst, real := newTestHost(t)
	defer host.CloseAll()
	f, err := host.searchFile(dst)
	if err != nil {
		t.Fatalf("searchFile: %v", err)
	}
	out := filepath.Join(t.TempDir(), "out.zip")
	res := ExportResult{}
	if err := writeExportZip(f, "13j", out, &res); err != nil {
		t.Fatalf("writeExportZip: %v", err)
	}
	if res.Blocks == 0 || res.Chars == 0 {
		t.Fatalf("source 沒有被導出：blocks=%d chars=%d", res.Blocks, res.Chars)
	}
	if real && res.Chars != 831156 {
		t.Errorf("13j 文字字元數 = %d，want 831156（與 SourceCharCount 一致）", res.Chars)
	}

	zr, err := zip.OpenReader(out)
	if err != nil {
		t.Fatalf("開不了剛寫的 zip：%v", err)
	}
	defer zr.Close()
	byName := map[string]*zip.File{}
	for _, e := range zr.File {
		byName[e.Name] = e
	}
	if byName["README.txt"] == nil {
		t.Error("少了 README.txt")
	}
	txt := byName["13j.txt"]
	if txt == nil {
		t.Fatalf("少了 13j.txt（entries: %v）", keysOf(byName))
	}
	rc, err := txt.Open()
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		t.Fatal(err)
	}
	if len(body) == 0 {
		t.Error("文字檔是空的")
	}
	if real && !strings.HasPrefix(string(body), "<集>") {
		t.Errorf("13j.txt 應該從 <集> 開始，實際：%q", string(body[:min(40, len(body))]))
	}
	// 索引容器不可以出現在 zip 裡
	for _, bad := range []string{"tokens", "postings", "tags", "tables", "attributes", "caches"} {
		for name := range byName {
			if strings.Contains(strings.ToLower(name), bad) {
				t.Errorf("索引內容不該被導出：%s", name)
			}
		}
	}
	// 硬換行（作者 2026-10）：lines.physical 有幾行，txt 就要有幾個換行
	if real {
		if res.Lines != 42173 {
			t.Errorf("換行數 = %d，want 42173（13j 檔頭 linecount）", res.Lines)
		}
		got := int64(strings.Count(string(body), hardBreak))
		if got != res.Lines {
			t.Errorf("txt 裡的 %q 有 %d 個，want %d", hardBreak, got, res.Lines)
		}
		// 換行是「插進去」不是「取代」：去掉換行後要剛好是原本的字元數
		stripped := int64(len(utf16.Encode([]rune(strings.ReplaceAll(string(body), hardBreak, "")))))
		if stripped != res.Chars {
			t.Errorf("去掉換行後 %d 個 code unit，want %d", stripped, res.Chars)
		}
	}
}

func keysOf(m map[string]*zip.File) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
