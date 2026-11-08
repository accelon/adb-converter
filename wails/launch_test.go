package main

// 以檔案開啟（作者 2026-11-08）的測試：參數挑選、資料夾優先序、開啟白名單。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 在 dir 裡造一個最小的 .adb（只需能被 mmap 與讀檔頭）。
func writeAdb(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, syntheticAdb(4096), 0o644); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
	return p
}

func TestSplitLaunchArg(t *testing.T) {
	dir := t.TempDir()
	adb := writeAdb(t, dir, "book.adb")

	// 檔案關聯：通常只有一個參數
	got, rest := splitLaunchArg([]string{adb})
	if !strings.EqualFold(got, adb) || len(rest) != 0 {
		t.Fatalf("單一參數：got %q rest %v", got, rest)
	}

	// 前後有其他旗標（檔案在中間）
	got, rest = splitLaunchArg([]string{"-updated-from", "2026-01-01T00:00:00Z", adb, "-selftest"})
	if !strings.EqualFold(got, adb) {
		t.Fatalf("中間的檔案沒被挑出來：%q", got)
	}
	if len(rest) != 3 || rest[2] != "-selftest" {
		t.Fatalf("其餘參數不對：%v", rest)
	}

	// -export 的值不能被當成啟動檔
	got, rest = splitLaunchArg([]string{"-export", adb})
	if got != "" || len(rest) != 2 {
		t.Fatalf("-export 的值被搶走了：got %q rest %v", got, rest)
	}

	// 不存在的 .adb、資料夾、其他副檔名都不算
	got, _ = splitLaunchArg([]string{filepath.Join(dir, "missing.adb")})
	if got != "" {
		t.Fatalf("不存在的檔案被當成啟動檔：%q", got)
	}
	got, _ = splitLaunchArg([]string{dir})
	if got != "" {
		t.Fatalf("資料夾被當成啟動檔：%q", got)
	}
}

func TestLaunchAdbFolderComesFirst(t *testing.T) {
	launchDir := t.TempDir()
	hostDir := t.TempDir()
	first := writeAdb(t, launchDir, "launch.adb")
	writeAdb(t, launchDir, "sibling.adb")
	writeAdb(t, hostDir, "host.adb")
	t.Chdir(hostDir) // 宿主資料夾＝工作目錄，acquire 才認得它

	host := &AdbHost{}
	defer host.CloseAll()
	host.SetLaunchAdb(first)

	list, err := host.listAdbsIn([]string{launchDir, hostDir})
	if err != nil {
		t.Fatalf("listAdbsIn: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("want 3 .adb, got %d: %+v", len(list), list)
	}
	// 啟動檔第一，其次同資料夾的兄弟，最後才是宿主資料夾
	if !strings.EqualFold(list[0].Path, first) {
		t.Errorf("第一筆 = %q，want %q", list[0].Path, first)
	}
	if !strings.EqualFold(list[1].Dir, launchDir) {
		t.Errorf("第二筆應該還是啟動檔資料夾：%+v", list[1])
	}
	if !strings.EqualFold(list[2].Dir, hostDir) {
		t.Errorf("最後一筆應該是宿主資料夾：%+v", list[2])
	}
	for _, a := range list {
		if a.Dir == "" {
			t.Errorf("%s 的 Dir 是空的", a.Path)
		}
	}
}

func TestLaunchAdbCanBeOpened(t *testing.T) {
	launchDir := t.TempDir()
	first := writeAdb(t, launchDir, "launch.adb")
	other := writeAdb(t, t.TempDir(), "other.adb")

	host := &AdbHost{}
	defer host.CloseAll()
	host.SetLaunchAdb(first)

	// 啟動檔所在資料夾的 .adb 可以開
	if _, err := host.Open(first); err != nil {
		t.Fatalf("Open(launch): %v", err)
	}
	// 第三個資料夾的 .adb 仍然要拒絕（白名單只多了啟動檔那一夾）
	if _, err := host.Open(other); err == nil {
		t.Fatalf("Open(%s) 應該被拒絕", other)
	} else if !strings.Contains(err.Error(), "同一資料夾") {
		t.Fatalf("拒絕理由不對：%v", err)
	}
	// 顯示的 adb 資料夾跟著啟動檔
	if got := host.AdbDir(); !strings.EqualFold(got, launchDir) {
		t.Fatalf("AdbDir() = %q，want %q", got, launchDir)
	}
}

func TestLaunchAdbNilKeepsHostDir(t *testing.T) {
	host := &AdbHost{}
	defer host.CloseAll()
	if got := host.AdbDir(); !strings.EqualFold(got, adbRootDir()) {
		t.Fatalf("沒有啟動檔時 AdbDir() 應該是 adbRootDir：%q", got)
	}
	if host.LaunchAdb() != "" {
		t.Fatalf("LaunchAdb() 應該是空字串")
	}
}
