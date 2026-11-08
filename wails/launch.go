package main

// 以檔案開啟（作者 2026-11-08）
//
// 作者要的行為：使用者在檔案總管雙擊一個 .adb、以 accelon26.exe 開啟時——
//   1. 工作目錄切到那個 .adb 所在資料夾；
//   2. 直接開啟那一個 .adb；
//   3. 📁 清單先列該資料夾的所有 .adb，再列 exe 所在資料夾的（排在後面）。
//
// Windows 的檔案關聯與拖放都會把完整路徑當成命令列參數傳進來（有空白時系統已加引號），
// 所以這裡只做三件事：從 os.Args 挑出那個檔案、記在 AdbHost、把可開啟的資料夾列出優先序。
// 真正的開啟由前端（bootDesktop）呼叫，和一般開庫走同一條路。

import (
	"os"
	"path/filepath"
	"strings"
)

// splitLaunchArg 從參數裡挑出第一個「存在的 .adb 檔」當作啟動檔，其餘原樣留給 flag。
// 只挑一個：後續參數（-updated-from 等）照舊解析。
//
// 緊接在「會吃一個值」的旗標後面的參數不能當檔案（例如 `-export x.adb`），
// 否則那個路徑會被我們搶走，旗標反而沒有值。
func splitLaunchArg(args []string) (adb string, rest []string) {
	valueFlags := map[string]bool{
		"-export": true, "--export": true,
		"-updated-from": true, "--updated-from": true,
		"-debug-port": true, "--debug-port": true,
		"-relaunch-exe": true, "--relaunch-exe": true,
		"-relaunch-from": true, "--relaunch-from": true,
		"-relaunch-port": true, "--relaunch-port": true,
		"-relaunch-pid": true, "--relaunch-pid": true,
	}
	rest = make([]string, 0, len(args))
	for i, a := range args {
		if adb == "" && !(i > 0 && valueFlags[args[i-1]]) && isLaunchableAdb(a) {
			adb = a
			continue
		}
		rest = append(rest, a)
	}
	return adb, rest
}

// isLaunchableAdb：看起來是 .adb（大小寫不敏感）而且真的存在、不是資料夾。
// 以 "-" 開頭的一律不當檔案（那是旗標，例如 -selftest）。
func isLaunchableAdb(arg string) bool {
	if arg == "" || strings.HasPrefix(arg, "-") {
		return false
	}
	if !strings.EqualFold(filepath.Ext(arg), ".adb") {
		return false
	}
	fi, err := os.Stat(arg)
	return err == nil && !fi.IsDir()
}

// SetLaunchAdb 記下啟動時要開的 .adb（main 在 flag.Parse 之後、建立視窗前呼叫）。
func (h *AdbHost) SetLaunchAdb(path string) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return
	}
	h.mu.Lock()
	h.launchAdb = filepath.Clean(abs)
	h.mu.Unlock()
}

// LaunchAdb 回傳啟動時指定的 .adb；不是以檔案開啟就是空字串。
// 前端靠它決定「開機直接開這一個」與「清單預設照資料夾排」。
func (h *AdbHost) LaunchAdb() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.launchAdb
}

// launchDir 是啟動檔所在資料夾（沒有啟動檔就空字串）。
func (h *AdbHost) launchDir() string {
	p := h.LaunchAdb()
	if p == "" {
		return ""
	}
	return filepath.Dir(p)
}

// adbDirs 是允許列出／開啟的資料夾，依優先序：
//
//	1. 啟動檔所在資料夾（雙擊哪個資料夾的檔，就以那裡為主）；
//	2. 宿主的 adb 資料夾（exe 旁；不可寫時是 %APPDATA%\Accelon26\adb）；
//	3. exe 所在資料夾（唯讀也列，使用者仍可開 exe 旁的舊書）。
//
// 同一個資料夾只留一次（Windows 大小寫不敏感）。
func (h *AdbHost) adbDirs() []string {
	var out []string
	seen := map[string]bool{}
	add := func(d string) {
		if d == "" {
			return
		}
		abs, err := filepath.Abs(d)
		if err != nil {
			return
		}
		abs = filepath.Clean(abs)
		k := strings.ToLower(abs)
		if seen[k] {
			return
		}
		seen[k] = true
		out = append(out, abs)
	}
	add(h.launchDir())
	add(adbRootDir())
	add(exeDir())
	return out
}

// allowedAdbPath：這個 .adb 是否位於可開啟的資料夾（或目前工作目錄）。
// 工作目錄也接受，是因為以檔案開啟時 main 會先 Chdir 過去；兩者通常同一個。
func (h *AdbHost) allowedAdbPath(path string) bool {
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	for _, d := range h.adbDirs() {
		if insideDir(d, abs) {
			return true
		}
	}
	if cwd, err := os.Getwd(); err == nil && insideDir(cwd, abs) {
		return true
	}
	return false
}

// activeAdbDir 是目前「工作用的」adb 資料夾：有啟動檔就用它所在資料夾，否則宿主資料夾。
// 下載新書、加入 Obsidian、介面顯示都用這一個，才不會書在 A 夾、下載卻跑到 B 夾。
func (h *AdbHost) activeAdbDir() string {
	if d := h.launchDir(); d != "" {
		return d
	}
	return adbRootDir()
}
