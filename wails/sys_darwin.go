//go:build darwin

package main

// macOS 專屬的系統呼叫；Windows 的對應實作在 sys_windows.go。
// 兩邊的函式簽名必須完全一致（共享程式碼直接呼叫，沒有介面層）：
//
//	mmapHandle / mmapFile / unmapFile      把 .adb 映射進行程位址空間
//	openURLCommand                          用系統瀏覽器開網址
//	hideConsoleWindow                       子行程不要閃出終端機視窗
//	messageBox                              還沒有 GUI 時唯一的告知方式
//	waitForProcessExit                      等另一個行程結束
//	updatesSupported                        這個平台有沒有「換掉自己」的自動更新
//
// macOS 版**不會自己換檔**（updatesSupported 回 false）：Windows 的更新是下載一顆
// 新的 exe 換掉自己；macOS 換的是整個 .app（還牽涉簽章與公證），第一版請使用者自己
// 到官網下載。**版本檢查照做**（checkUpdateNow／StartUpdateChecker 不分平台），
// 有新版本時左上角會閃、About 會說「發現新版本」，只是「下載更新」按鈕開的是官網。

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// updatesSupported：macOS 版不自己換檔（換 .app ＋ 簽章／公證是另一件事）。
// 注意這只影響「安裝」，不影響「檢查」：版本檢查每個平台都做。
func updatesSupported() bool { return false }

// platformName 給 AppInfo／About 顯示（不直接用 runtime.GOOS，兩邊各說各話比較清楚）。
func platformName() string { return "darwin" }

// ---------------------------------------------------------------------------
// mmap 層
//
// 與 Windows 版同一個理由（見 sys_windows.go）：.adb 只映射一次，之後每次
// ReadBase64 都只在行程位址空間內取位元組，由 OS page cache 支撐，沒有每次
// open/seek/read 的核心往返。macOS 沒有「映射物件控制代碼」這種東西：
// syscall.Mmap 直接回一塊可以 Munmap 的切片，所以 handle 一律是 0。
// ---------------------------------------------------------------------------

// mmapHandle 在 macOS 用不到（Windows 是 CreateFileMapping 的控制代碼），
// 留著只是讓共享程式碼（mapped.handle）兩邊都能編譯。
type mmapHandle = uintptr

// mmapFile 以唯讀方式把整個檔案映射進行程位址空間。
// 回傳的 []byte 直接指向映射記憶體，呼叫方必須保證在 unmapFile 之前不再使用它。
func mmapFile(path string, size int64) ([]byte, mmapHandle, error) {
	if size <= 0 {
		return nil, 0, fmt.Errorf("cannot mmap %s: size %d", path, size)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close() // 映射建立之後檔案描述符就可以關掉，映射本身持有檔案參考

	// PROT_READ 對應 Windows 的 PAGE_READONLY；MAP_SHARED 對應 FILE_MAP_READ
	// （唯讀映射不會改到檔案，共享只是不要多佔一份私有頁）。
	view, err := syscall.Mmap(int(f.Fd()), 0, int(size), syscall.PROT_READ, syscall.MAP_SHARED)
	if err != nil {
		return nil, 0, os.NewSyscallError("mmap", err)
	}
	return view, 0, nil
}

// unmapFile 解除映射；對已經解除過的映射是安全的。
// 注意：Mac OS 的 Munmap 要求**同一個切片**（位址與長度都要相同），
// 所以呼叫方只能傳 mmapFile 回傳的那一個切片，不能傳它的子切片。
func unmapFile(view []byte, h mmapHandle) {
	if len(view) == 0 {
		return
	}
	_ = syscall.Munmap(view)
}

// openURLCommand 回傳「用預設瀏覽器開這個網址」的指令（macOS 是 open）。
func openURLCommand(rawurl string) *exec.Cmd {
	return exec.Command("open", rawurl)
}

// hideConsoleWindow 在 macOS 沒有對應的視窗樣式可設：從 Finder／Dock 啟動的
// .app 本來就不會開終端機，子行程也不會（它是同一個 bundle 裡的程式）。
func hideConsoleWindow(cmd *exec.Cmd) {}

// waitForProcessExit 等另一個行程結束（最多等 timeout）。
// macOS 沒有 OpenProcess/WaitForSingleObject：用 signal 0 探測行程還在不在
// （ESRCH＝已經結束），每 100 毫秒看一次。
func waitForProcessExit(pid int, timeout time.Duration) {
	if pid <= 0 {
		return
	}
	deadline := time.Now().Add(timeout)
	for {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return // ESRCH＝這個 pid 已經不存在
		}
		// EPERM 代表行程還在（只是不是我們的），要繼續等。
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// messageBox 是沒有 GUI 時唯一的告知方式：用 osascript 跳出系統的對話框
// （跟 Windows 的 MessageBoxW 同一個用途）。osascript 不在的話至少留下記錄。
func messageBox(title, text string) {
	fmt.Fprintf(os.Stderr, "accelon26: %s: %s\n", title, text)
	script := "display dialog " + appleScriptString(text) +
		" with title " + appleScriptString(title) +
		` buttons {"好"} default button 1 with icon caution`
	cmd := exec.Command("osascript", "-e", script)
	_ = cmd.Run()
}

// appleScriptString 把字串包成 AppleScript 的字串常值（反斜線與雙引號要跳脫）。
func appleScriptString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}
