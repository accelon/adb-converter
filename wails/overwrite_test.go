package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

// validSyntheticAdb 是 syntheticAdb 加上真的 adb 簽名（SaveAdb／OverwriteAdb 會驗檔頭）。
func validSyntheticAdb(size int) []byte {
	b := syntheticAdb(size)
	copy(b[32:32+len(adbSignature)], adbSignature)
	return b
}

// 作者 2026-10-27：開啟中的 adb 由宿主 mmap，Windows 上不能直接覆寫／rename。
// OverwriteAdb 必須先 Close 解除映射，再原子換檔；換完宿主讀到的是新內容。
func TestOverwriteAdbReplacesMappedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "book.adb")
	old := validSyntheticAdb(4096)
	if err := os.WriteFile(path, old, 0o644); err != nil {
		t.Fatalf("write old: %v", err)
	}

	h := &AdbHost{}
	defer h.CloseAll()
	t.Chdir(dir) // host 的白名單只認工作目錄裡的 .adb
	if _, err := h.Open(path); err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := h.readAt(path, 0, 64); err != nil { // 強制建立映射
		t.Fatalf("readAt: %v", err)
	}

	next := validSyntheticAdb(8192)
	copy(next[256:], "new-content")
	res := h.OverwriteAdb(path, base64.StdEncoding.EncodeToString(next))
	if !res.OK {
		t.Fatalf("OverwriteAdb failed: %s", res.Error)
	}
	if res.Path == "" {
		t.Fatalf("OverwriteAdb returned empty path")
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if len(got) != len(next) {
		t.Fatalf("size = %d, want %d", len(got), len(next))
	}
	if string(got[256:267]) != "new-content" {
		t.Fatalf("content not replaced: %q", got[256:267])
	}

	// 映射已解除：宿主重新讀到新檔
	b64, err := h.ReadBase64(path, 256, 11)
	if err != nil {
		t.Fatalf("ReadBase64 after overwrite: %v", err)
	}
	if b64 != base64.StdEncoding.EncodeToString([]byte("new-content")) {
		t.Fatalf("ReadBase64 = %q", b64)
	}
	info, err := h.Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if info.Size != int64(len(next)) {
		t.Fatalf("reopen size = %d, want %d", info.Size, len(next))
	}
}

func TestOverwriteAdbRejectsMissingOrBadFile(t *testing.T) {
	h := &AdbHost{}
	defer h.CloseAll()
	data := validSyntheticAdb(1024)
	b64 := base64.StdEncoding.EncodeToString(data)

	missing := filepath.Join(t.TempDir(), "nope.adb")
	if r := h.OverwriteAdb(missing, b64); r.OK || r.Error == "" {
		t.Fatalf("missing file: ok=%v err=%q", r.OK, r.Error)
	}

	dir := t.TempDir()
	t.Chdir(dir)
	txt := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(txt, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if r := h.OverwriteAdb(txt, b64); r.OK {
		t.Fatalf("non-adb target should fail")
	}
}
