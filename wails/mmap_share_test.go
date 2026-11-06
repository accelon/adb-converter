//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 一般閱讀不能鎖住 adb：別的 agent 常常在測試期間替換 D:\accelon3 的檔案。
// mmap 要 share delete，否則 rename 會失敗。編輯／覆寫才走 OverwriteAdb 的流程。
func TestMmapAllowsAdbReplace(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "sample.adb")
	if err := os.WriteFile(p, syntheticAdb(8192), 0o644); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	view, handle, err := mmapFile(p, fi.Size())
	if err != nil {
		t.Fatalf("mmapFile: %v", err)
	}
	defer unmapFile(view, handle)

	next := filepath.Join(dir, "sample.new")
	if err := os.WriteFile(next, syntheticAdb(4096), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(next, p); err != nil {
		t.Fatalf("mapped adb 被鎖住，無法替換：%v", err)
	}
}
