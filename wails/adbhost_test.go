package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// realAdb 是倉庫根目錄裡的真實樣本；缺少時測試改用合成檔案。
const realAdb = "D:\\2026\\adb-converter\\13j.adb"

// newTestHost 建一個臨時目錄，把 13j.adb（或一個 300 位元組的合成檔案）放進去，
// 然後 chdir 進這個目錄。回傳的 host 由呼叫方 defer CloseAll()（必須在
// TempDir 清理之前解除映射，否則 Windows 刪不掉被映射的檔案）。
func newTestHost(t *testing.T) (host *AdbHost, dst string, real bool) {
	t.Helper()
	dir := t.TempDir()
	dst = filepath.Join(dir, "13j.adb")

	raw, err := os.ReadFile(realAdb)
	real = err == nil
	if !real {
		raw = syntheticAdb(300)
	}
	if err := os.WriteFile(dst, raw, 0o644); err != nil {
		t.Fatalf("write %s: %v", dst, err)
	}
	t.Chdir(dir)
	return &AdbHost{}, dst, real
}

// syntheticAdb 造一個 size 位元組的假 adb：offset 0..32 放 ASCII 名，
// offset 128..192 放 UTF-16LE 名，其餘填 0 / 0xAB。只用於真實樣本缺失時。
func syntheticAdb(size int) []byte {
	b := make([]byte, size)
	copy(b[0:32], "synthetic")
	for i, u := range utf16.Encode([]rune("合成樣本")) {
		binary.LittleEndian.PutUint16(b[128+i*2:], u)
	}
	if size > 256 {
		copy(b[256:], bytes.Repeat([]byte{0xAB}, size-256))
	}
	return b
}

func TestListAdbsReadsHeader(t *testing.T) {
	host, dst, real := newTestHost(t)
	defer host.CloseAll()

	list, err := host.ListAdbs()
	if err != nil {
		t.Fatalf("ListAdbs: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("want 1 .adb, got %d: %+v", len(list), list)
	}
	got := list[0]
	if !strings.EqualFold(got.Path, dst) {
		t.Errorf("Path = %q, want %q", got.Path, dst)
	}
	if got.Size <= 0 {
		t.Errorf("Size = %d, want > 0", got.Size)
	}
	if got.Modified == 0 {
		t.Errorf("Modified = 0, want UnixMilli")
	}
	if got.DbName == "" {
		t.Errorf("DbName is empty, want the 0..32 ASCII field")
	}
	if got.Name == "" {
		t.Errorf("Name is empty, want dbcname/dbname fallback")
	}
	if !real {
		t.Logf("real sample %s missing; using synthetic file", realAdb)
		return
	}
	if got.DbName != "13j" {
		t.Errorf("DbName = %q, want %q", got.DbName, "13j")
	}
	if got.DbCName != "十三經" {
		t.Errorf("DbCName = %q, want %q", got.DbCName, "十三經")
	}
	if got.Name != "十三經" {
		t.Errorf("Name = %q, want the dbcname %q", got.Name, "十三經")
	}
}

func TestReadBase64(t *testing.T) {
	host, dst, _ := newTestHost(t)
	defer host.CloseAll()

	raw, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}

	// 檔頭 256 位元組必須和 os.ReadFile 完全一致
	b64, err := host.ReadBase64(dst, 0, 256)
	if err != nil {
		t.Fatalf("ReadBase64 head: %v", err)
	}
	head, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("decode head: %v", err)
	}
	if !bytes.Equal(head, raw[:256]) {
		t.Errorf("head mismatch:\n got %x\nwant %x", head, raw[:256])
	}

	// readAt 走同一張映射，但回傳不拷貝的切片
	view, err := host.readAt(dst, 0, 256)
	if err != nil {
		t.Fatalf("readAt head: %v", err)
	}
	if !bytes.Equal(view, raw[:256]) {
		t.Errorf("readAt mismatch")
	}

	// 末尾 4 位元組
	last, err := host.ReadBase64(dst, int64(len(raw))-4, 4)
	if err != nil {
		t.Fatalf("ReadBase64 tail: %v", err)
	}
	tail, err := base64.StdEncoding.DecodeString(last)
	if err != nil {
		t.Fatalf("decode tail: %v", err)
	}
	if !bytes.Equal(tail, raw[len(raw)-4:]) {
		t.Errorf("tail = %x, want %x", tail, raw[len(raw)-4:])
	}

	// 越界 / 非法參數必須回傳 error，不能 panic
	if _, err := host.ReadBase64(dst, int64(len(raw))-2, 8); err == nil {
		t.Errorf("read past EOF should return an error")
	}
	if _, err := host.ReadBase64(dst, -1, 8); err == nil {
		t.Errorf("negative offset should return an error")
	}
	if _, err := host.ReadBase64(dst, 0, -1); err == nil {
		t.Errorf("negative length should return an error")
	}
	if _, err := host.readAt(dst, int64(len(raw)), 1); err == nil {
		t.Errorf("readAt at EOF should return an error")
	}
	if _, err := host.readAt(dst, 0, -1); err == nil {
		t.Errorf("readAt with negative length should return an error")
	}

	// 路徑白名單：非 .adb、工作目錄之外都拒絕
	if _, err := host.ReadBase64("C:\\Windows\\notadb.txt", 0, 4); err == nil {
		t.Errorf("non-.adb path should be rejected")
	}
	if _, err := host.ReadBase64(filepath.Join("..", "..", "escape.adb"), 0, 4); err == nil {
		t.Errorf("path outside the working directory should be rejected")
	}
}

// TestMmapReadTiming 記錄 mmap 讀取成本：128 KiB x 200 次。
// go test -v 會印出 ns/op；go test -bench 另見 BenchmarkReadBase64_128KiB。
func TestMmapReadTiming(t *testing.T) {
	host, dst, _ := newTestHost(t)
	defer host.CloseAll()

	const chunk, times = 128 * 1024, 200
	start := time.Now()
	var out int
	for i := 0; i < times; i++ {
		s, err := host.ReadBase64(dst, 0, chunk)
		if err != nil {
			t.Fatalf("ReadBase64: %v", err)
		}
		out += len(s)
	}
	d := time.Since(start)
	t.Logf("mmap+base64 128 KiB x %d = %d base64 bytes in %s (%.1f ns/op)",
		times, out, d, float64(d.Nanoseconds())/float64(times))
}

func BenchmarkReadBase64_128KiB(b *testing.B) {
	dir := b.TempDir()
	dst := filepath.Join(dir, "bench.adb")
	if err := os.WriteFile(dst, syntheticAdb(2*1024*1024), 0o644); err != nil {
		b.Fatal(err)
	}
	b.Chdir(dir)
	host := &AdbHost{}
	defer host.CloseAll()

	b.SetBytes(128 * 1024)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := host.ReadBase64(dst, 0, 128*1024); err != nil {
			b.Fatal(err)
		}
	}
}
