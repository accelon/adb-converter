//go:build windows

package main

// Windows 專屬的系統呼叫集中在這一支；macOS 的對應實作在 sys_darwin.go。
// 兩邊的函式簽名必須完全一致（共享程式碼直接呼叫，沒有介面層）：
//
//	mmapHandle / mmapFile / unmapFile      把 .adb 映射進行程位址空間
//	openURLCommand                          用系統瀏覽器開網址
//	hideConsoleWindow                       子行程不要閃出主控台視窗
//	messageBox                              還沒有 GUI 時唯一的告知方式
//	waitForProcessExit                      等另一個行程結束
//	updatesSupported                        這個平台有沒有「換掉自己」的自動更新
//
// 之所以要分平台：mmap、開外部連結、隱藏視窗、訊息框、等行程結束，這五件事在
// Windows 與 macOS 上沒有一件是同一個 API。

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// updatesSupported：Windows 版支援自動更新（下載新的 exe、換掉自己、重啟）。
func updatesSupported() bool { return true }

// platformName 給 AppInfo／About 顯示（不直接用 runtime.GOOS，兩邊各說各話比較清楚）。
func platformName() string { return "windows" }

// ---------------------------------------------------------------------------
// kernel32 mmap 層（直呼 kernel32，不引入 golang.org/x/sys 的記憶體映射封裝）
//
// 為什麼用 mmap 而不是每次 os.Open + ReadAt：
//   - 映射只在首次存取時建立一次（CreateFileMappingW + MapViewOfFile），
//     之後每次 ReadBase64 都只在行程位址空間內取位元組，沒有任何檔案系統
//     syscall，省掉 open/seek/read 的核心往返；
//   - 映射內容由 OS page cache 支撐，隨機小段讀取不會把整個檔案拷進 Go 堆積；
//     同時開啟多個 adb 也只是各佔一段位址空間（本應用的檔案只有 2–25 MB）；
//   - base64 直接從映射切片編碼，零中間拷貝。
// 限制：檔案大小必須 > 0；映射內容在 Close / CloseAll 之前一直有效。
// ---------------------------------------------------------------------------

// mmapHandle 是映射物件的控制代碼（macOS 沒有這種東西，那邊是空的 uintptr）。
type mmapHandle = syscall.Handle

const (
	pageReadonly = 0x02   // PAGE_READONLY
	fileMapRead  = 0x0004 // FILE_MAP_READ
)

var (
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procCreateFileMappingW = kernel32.NewProc("CreateFileMappingW")
	procMapViewOfFile      = kernel32.NewProc("MapViewOfFile")
	procUnmapViewOfFile    = kernel32.NewProc("UnmapViewOfFile")
	procCloseHandle        = kernel32.NewProc("CloseHandle")
)

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
	defer f.Close() // 映射物件會持有檔案參考，這裡可以立即關閉控制代碼

	// flProtect 只能是 PAGE_READONLY；FILE_MAP_READ 是 MapViewOfFile 的參數。
	h, _, errno := procCreateFileMappingW.Call(
		f.Fd(), 0,
		pageReadonly,
		uintptr(uint64(size)>>32), uintptr(uint64(size)&0xffffffff),
		0,
	)
	if h == 0 {
		return nil, 0, os.NewSyscallError("CreateFileMapping", errno)
	}
	addr, _, errno := procMapViewOfFile.Call(h, fileMapRead, 0, 0, 0)
	if addr == 0 {
		procCloseHandle.Call(h)
		return nil, 0, os.NewSyscallError("MapViewOfFile", errno)
	}
	// addr 是核心回傳的映射基底位址，其生命週期由 handle 控制。
	// 用 unsafe.Add(nil, addr) 取得基底指標（等同 uintptr→指標轉換）；
	// 這樣寫同時避開 go vet 對 uintptr→unsafe.Pointer 的誤報。
	base := unsafe.Add(nil, addr)
	view := unsafe.Slice((*byte)(base), int(size))
	return view, syscall.Handle(h), nil
}

// unmapFile 解除映射並關閉映射物件控制代碼；對已經解除過的映射是安全的。
func unmapFile(view []byte, h mmapHandle) {
	if len(view) > 0 {
		procUnmapViewOfFile.Call(uintptr(unsafe.Pointer(&view[0])))
	}
	if h != 0 {
		procCloseHandle.Call(uintptr(h))
	}
}

// openURLCommand 回傳「用預設瀏覽器開這個網址」的指令（Windows 是 rundll32）。
func openURLCommand(rawurl string) *exec.Cmd {
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", rawurl)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}

// revealCommand 回傳「在檔案總管裡選中這個檔案」的指令（導出 zip 之後用）。
func revealCommand(path string) *exec.Cmd {
	return exec.Command("explorer", "/select,"+path)
}

// hideConsoleWindow 讓子行程不要閃出一個主控台視窗
// （更新流程的重新啟動器是 GUI 程式，不該冒出黑色命令視窗）。
func hideConsoleWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

// waitForProcessExit 等另一個行程結束（最多等 timeout）。
// 拿不到控制代碼（行程已經結束、或沒有權限）就直接返回。
func waitForProcessExit(pid int, timeout time.Duration) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)
	_, _ = windows.WaitForSingleObject(h, uint32(timeout/time.Millisecond))
}

var (
	user32DLL  = windows.NewLazySystemDLL("user32.dll")
	procMsgBox = user32DLL.NewProc("MessageBoxW")
)

// messageBox 是沒有 GUI 時唯一的告知方式（重新啟動器還沒建立 Wails 應用）。
func messageBox(title, text string) {
	t, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	x, err := windows.UTF16PtrFromString(text)
	if err != nil {
		return
	}
	_, _, _ = procMsgBox.Call(0, uintptr(unsafe.Pointer(x)), uintptr(unsafe.Pointer(t)), 0x00000040|0x00040000)
}
