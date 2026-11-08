//go:build windows

package main

// Windows 的 .adb 檔案關聯：寫在 HKCU（使用者層級），不需要管理員。
//
//   HKCU\Software\Classes\.adb                        (預設) = Accelon26.adb
//   HKCU\Software\Classes\.adb\OpenWithProgids        Accelon26.adb = ""
//   HKCU\Software\Classes\Accelon26.adb               (預設) = accelon26 ADB 資料庫
//   HKCU\Software\Classes\Accelon26.adb\DefaultIcon  "\…\accelon26.exe",0
//   HKCU\Software\Classes\Accelon26.adb\shell\open\command
//                                                     "\…\accelon26.exe" "%1"
//   HKCU\Software\Classes\Applications\accelon26.exe\shell\open\command（同上，「開啟方式」清單用）
//
// Windows 10/11 如果已經有 Explorer\FileExts\.adb\UserChoice（使用者按過「一律使用」），
// 那一筆有雜湊保護、程式改不動：這裡照樣寫 Classes，但回報 UserChoice，讓前端提示去
// 「設定 → 預設應用程式」改。

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const assocProgID = "Accelon26.adb"

var (
	shell32DLL     = windows.NewLazySystemDLL("shell32.dll")
	shChangeNotify = shell32DLL.NewProc("SHChangeNotify")
)

// adbAssociationInfo 讀出目前 .adb 指到哪一支 exe（UserChoice → Classes → OpenWithProgids → HKCR）。
func adbAssociationInfo() AdbAssocInfo {
	exe := exePath()
	info := AdbAssocInfo{Supported: true, Current: exe}

	progid := ""
	if k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.adb\UserChoice`, registry.QUERY_VALUE); err == nil {
		if v, _, err := k.GetStringValue("ProgId"); err == nil {
			progid = strings.TrimSpace(v)
		}
		k.Close()
	}
	if progid != "" {
		info.UserChoice = true
	}
	if progid == "" {
		progid = defaultValue(registry.CURRENT_USER, `Software\Classes\.adb`)
	}
	if progid == "" {
		if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\.adb\OpenWithProgids`, registry.QUERY_VALUE); err == nil {
			if names, err := k.ReadValueNames(0); err == nil && len(names) > 0 {
				progid = names[0]
			}
			k.Close()
		}
	}
	if progid == "" {
		progid = defaultValue(registry.CLASSES_ROOT, `.adb`)
	}
	info.ProgID = progid

	if progid != "" {
		cmd := readOpenCommand(registry.CURRENT_USER, progid)
		if cmd == "" {
			cmd = readOpenCommand(registry.CLASSES_ROOT, progid)
		}
		info.Command = cmd
		info.Exe = exeFromCommand(cmd)
		if info.Exe != "" {
			info.Dir = filepath.Dir(info.Exe)
			if fi, err := os.Stat(info.Exe); err == nil && !fi.IsDir() {
				info.Exists = true
			}
			info.IsCurrent = strings.EqualFold(filepath.Clean(info.Exe), filepath.Clean(exe))
		}
		info.Linked = cmd != ""
	}
	return info
}

// adbSetAssociation 把 .adb（與「開啟方式」）指到現在這支 exe，然後重新讀一次現況。
//
// 寫入走 `reg.exe add`（而不是 registry 套件直接寫）：登錄的 Classes 機碼權限依機器
// 而異，`reg.exe` 在各種環境（含受限權杖）都試得過；失敗時它會給清楚的錯誤。
func adbSetAssociation() AdbAssocInfo {
	exe := exePath()
	if exe == "" {
		info := adbAssociationInfo()
		info.WriteError = "找不到這支 exe 的路徑"
		return info
	}
	exe = filepath.Clean(exe)
	cmd := `"` + exe + `" "%1"`
	progKey := `HKCU\Software\Classes\` + assocProgID

	var writeErr error
	note := func(err error) {
		if err != nil && writeErr == nil {
			writeErr = err
		}
	}
	note(regAdd(`HKCU\Software\Classes\.adb`, "", assocProgID))
	note(regAdd(`HKCU\Software\Classes\.adb\OpenWithProgids`, assocProgID, ""))
	note(regAdd(progKey, "", "accelon26 ADB 資料庫"))
	note(regAdd(progKey+`\DefaultIcon`, "", `"`+exe+`",0`))
	note(regAdd(progKey+`\shell\open\command`, "", cmd))
	note(regAdd(`HKCU\Software\Classes\Applications\accelon26.exe`, "FriendlyAppName", "accelon26"))
	note(regAdd(`HKCU\Software\Classes\Applications\accelon26.exe\shell\open\command`, "", cmd))

	notifyShellAssocChanged()
	info := adbAssociationInfo()
	if writeErr != nil {
		info.WriteError = writeErr.Error()
	}
	return info
}

// regAdd 呼叫 `reg.exe add <key> [/ve|/v <name>] /d <value> /f`。
// 空字串的值也可以寫（/d ""）。
func regAdd(key, name, value string) error {
	args := []string{"add", key, "/f"}
	if name == "" {
		args = append(args, "/ve")
	} else {
		args = append(args, "/v", name)
	}
	args = append(args, "/d", value)
	cmd := exec.Command("reg", args...)
	hideConsoleWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v（%s）", key, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// notifyShellAssocChanged 告訴檔案總管關聯變了（開始選單／圖示才會跟著更新）。
func notifyShellAssocChanged() {
	const (
		shcneAssocChanged = 0x08000000
		shcnfIDList       = 0x0000
	)
	_, _, _ = shChangeNotify.Call(shcneAssocChanged, shcnfIDList, 0, 0)
}

// defaultValue 讀一個機碼的預設值（不存在就空字串）。
func defaultValue(root registry.Key, path string) string {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue("")
	if err != nil {
		return ""
	}
	return v
}

// readOpenCommand 讀 <progid>\shell\open\command 的預設值。
// HKCU 要加上 Software\Classes\ 前綴；HKCR 本身就是合併檢視，直接用 progid。
func readOpenCommand(root registry.Key, progid string) string {
	base := progid
	if root == registry.CURRENT_USER {
		base = `Software\Classes\` + progid
	}
	return defaultValue(root, base+`\shell\open\command`)
}

// exeFromCommand 從 `"C:\path\app.exe" "%1"` 取出 exe 路徑。
func exeFromCommand(cmd string) string {
	s := strings.TrimSpace(cmd)
	if s == "" {
		return ""
	}
	if s[0] == '"' {
		if i := strings.IndexByte(s[1:], '"'); i >= 0 {
			return s[1 : 1+i]
		}
		return strings.Trim(s, `"`)
	}
	// 沒有引號（路徑含空白時本來就該加引號）：取到第一個空白為止
	if i := strings.IndexAny(s, " \t"); i >= 0 {
		return s[:i]
	}
	return s
}
