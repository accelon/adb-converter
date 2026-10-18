package main

import (
	"os"
	"testing"
)

// TestSourceCharCount 用 repo 根目錄的 13j.adb 驗「字數」：source 解壓後的 UTF-16
// code unit 總數（corpus-scan 的 chars＝831,156）。沒有那個檔就跳過。
func TestSourceCharCount(t *testing.T) {
	// AdbHost 只允許工作目錄裡的檔案，所以先切到 repo 根目錄（13j.adb 在那裡）。
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(".."); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(wd) }()
	if _, err := os.Stat("13j.adb"); err != nil {
		t.Skip("沒有 ../13j.adb")
	}
	h := &AdbHost{}
	n, err := h.SourceCharCount("13j.adb")
	if err != nil {
		t.Fatalf("SourceCharCount: %v", err)
	}
	if n != 831156 {
		t.Errorf("13j 字數 = %d，want 831156", n)
	}
	// 不存在的檔案要報錯，不是回 0
	if _, err := h.SourceCharCount("nope.adb"); err == nil {
		t.Error("不存在的檔案應該回錯誤")
	}
}
