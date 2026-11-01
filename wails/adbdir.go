package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// 作者 2026-11-01：adb 只認一個資料夾。
//  1. exe 所在資料夾可寫 → 就用它（正常情況）。
//  2. 不可寫（例如 C:\Program Files）→ %APPDATA%\Accelon26\adb\。
//
// 比對、下載、開啟都用 adbRootDir()，不要一邊讀 exe 旁、一邊寫 APPDATA。
var adbDirOnce sync.Once
var adbDirCache string

func adbRootDir() string {
	// 測試／可攜模式：明確指定就用它（不必猜 exe 旁可不可寫）。
	if env := strings.TrimSpace(os.Getenv("ACCELON26_ADB_DIR")); env != "" {
		return env
	}
	adbDirOnce.Do(func() {
		if d := exeDir(); d != "" && canWriteDir(d) {
			adbDirCache = d
			return
		}
		d := appDataAdbDir()
		_ = os.MkdirAll(d, 0o755)
		adbDirCache = d
	})
	return adbDirCache
}

// appDataAdbDir 是 exe 旁不可寫時的固定位置；不主動建立（查重複時可能不存在）。
func appDataAdbDir() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		return ""
	}
	return filepath.Join(base, "Accelon26", "adb")
}

// canWriteDir 真的建一個暫存檔再刪掉，避免用權限位猜錯。
func canWriteDir(dir string) bool {
	f, err := os.CreateTemp(dir, ".accelon26-write-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

// otherAdbDir 回傳「另一邊」的資料夾（只用來標示同名檔，不會拿來讀寫）。
func otherAdbDir() string {
	active := adbRootDir()
	if active == exeDir() {
		return appDataAdbDir()
	}
	return exeDir()
}

// AdbDir 給前端顯示「目前使用的 adb 資料夾」。
func (h *AdbHost) AdbDir() string { return adbRootDir() }

// AdbDuplicate 是「另一邊也有同名 adb」的提示；不自動覆蓋任何一邊。
type AdbDuplicate struct {
	Name       string `json:"name"`
	ActivePath string `json:"activePath"`
	OtherPath  string `json:"otherPath"`
	Same       bool   `json:"same"`
}

// AdbDuplicates 比對 active 與另一邊的同名 .adb；同名才回報（大小不同就不必算 sha）。
func (h *AdbHost) AdbDuplicates() []AdbDuplicate {
	active := adbRootDir()
	other := otherAdbDir()
	if active == "" || other == "" || strings.EqualFold(active, other) {
		return nil
	}
	otherEntries, err := os.ReadDir(other)
	if err != nil {
		return nil
	}
	out := make([]AdbDuplicate, 0, 4)
	for _, e := range otherEntries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".adb") {
			continue
		}
		a := filepath.Join(active, e.Name())
		ai, err := os.Stat(a)
		if err != nil || ai.IsDir() {
			continue
		}
		o := filepath.Join(other, e.Name())
		oi, err := os.Stat(o)
		if err != nil || oi.IsDir() {
			continue
		}
		same := false
		if ai.Size() == oi.Size() {
			sa, ea := sha256File(a)
			sb, eb := sha256File(o)
			same = ea == nil && eb == nil && sa == sb
		}
		out = append(out, AdbDuplicate{Name: e.Name(), ActivePath: a, OtherPath: o, Same: same})
	}
	return out
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
