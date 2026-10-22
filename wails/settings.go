package main

// settings.json（作者 2026-10-22）
//
// 位置：**exe 旁的 settings.json**；exe 所在資料夾不可寫時，才退到
// `os.UserConfigDir()/accelon26/settings.json`（Windows 是 %APPDATA%）。
// 檔案內容（v1）由前端管，Go 只負責「決定位置、讀、原子寫、列出字型」。
//
// 為什麼位置由 Go 決定：只有宿主知道 exe 在哪、資料夾能不能寫（dirWritable 已有）；
// About 顯示的必須是**實際使用的那一個**，不是 UI 猜的。

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// SettingsInfo 是 UI 需要的全部事實（wails/settings.go → host.ts）。
type SettingsInfo struct {
	Path     string `json:"path"`
	Kind     string `json:"kind"`     // "exe" 或 "userconfig"
	Writable bool   `json:"writable"` // 目前能不能寫
	Note     string `json:"note,omitempty"`
}

// LoadSettingsResult 用結構回傳，避免 Wails 把 error 變成 rejected promise。
type LoadSettingsResult struct {
	OK    bool   `json:"ok"`
	Text  string `json:"text"`
	Error string `json:"error,omitempty"`
}

// SaveSettingsResult 同上。
type SaveSettingsResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

var (
	settingsOnce sync.Once
	settingsAt   SettingsInfo
)

// settingsTarget 是純函式（方便測試）：給 exe 資料夾與使用者設定資料夾，
// 決定 settings.json 放哪裡。exe 資料夾可寫就放 exe 旁；否則退到設定資料夾。
func settingsTarget(exeDir, configDir string) SettingsInfo {
	note := ""
	if exeDir != "" {
		if dirWritable(exeDir) {
			return SettingsInfo{Path: filepath.Join(exeDir, "settings.json"), Kind: "exe", Writable: true}
		}
		note = "exe 所在資料夾不可寫，改用使用者設定資料夾"
	}
	if configDir == "" {
		return SettingsInfo{Kind: "userconfig", Writable: false, Note: "找不到可寫入的設定資料夾"}
	}
	return SettingsInfo{
		Path:     filepath.Join(configDir, "accelon26", "settings.json"),
		Kind:     "userconfig",
		Writable: true,
		Note:     note,
	}
}

func currentSettingsInfo() SettingsInfo {
	settingsOnce.Do(func() {
		configDir, _ := os.UserConfigDir()
		settingsAt = settingsTarget(exeDir(), configDir)
	})
	return settingsAt
}

// SettingsInfo 回傳實際使用的位置（UI 的設定頁與 About 都讀這一個）。
func (h *AdbHost) SettingsInfo() SettingsInfo {
	return currentSettingsInfo()
}

// LoadSettings 讀 settings.json。檔案不存在＝成功但沒有內容（第一次開啟）。
func (h *AdbHost) LoadSettings() LoadSettingsResult {
	info := currentSettingsInfo()
	if !info.Writable || info.Path == "" {
		return LoadSettingsResult{OK: false, Error: info.Note}
	}
	return readSettingsAt(info.Path)
}

// readSettingsAt 是實際的讀檔（測試用同一個函式；path 由呼叫端給）。
func readSettingsAt(path string) LoadSettingsResult {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return LoadSettingsResult{OK: true, Text: ""}
	}
	if err != nil {
		return LoadSettingsResult{OK: false, Error: err.Error()}
	}
	// 壞掉的 JSON 不要讓 UI 猜：直接回錯誤（UI 保留預設，不覆寫）
	if len(b) > 0 && !json.Valid(b) {
		return LoadSettingsResult{OK: false, Error: "settings.json 不是合法的 JSON"}
	}
	return LoadSettingsResult{OK: true, Text: string(b)}
}

// SaveSettings 原子寫入（同目錄暫存檔 → rename）。回傳錯誤給 UI 顯示。
func (h *AdbHost) SaveSettings(text string) SaveSettingsResult {
	info := currentSettingsInfo()
	if info.Path == "" {
		return SaveSettingsResult{OK: false, Error: info.Note}
	}
	return writeSettingsAt(info.Path, text)
}

// writeSettingsAt 是實際的原子寫入（測試用）。
func writeSettingsAt(path, text string) SaveSettingsResult {
	if !json.Valid([]byte(text)) {
		return SaveSettingsResult{OK: false, Error: "拒絕寫入：不是合法的 JSON"}
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return SaveSettingsResult{OK: false, Error: err.Error()}
	}
	tmp, err := os.CreateTemp(dir, ".settings-*.json")
	if err != nil {
		return SaveSettingsResult{OK: false, Error: err.Error()}
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // rename 成功後就沒有這個檔了；失敗時清掉
	if _, err := tmp.WriteString(text); err != nil {
		tmp.Close()
		return SaveSettingsResult{OK: false, Error: err.Error()}
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return SaveSettingsResult{OK: false, Error: err.Error()}
	}
	if err := tmp.Close(); err != nil {
		return SaveSettingsResult{OK: false, Error: err.Error()}
	}
	if err := os.Rename(tmpName, path); err != nil {
		return SaveSettingsResult{OK: false, Error: err.Error()}
	}
	return SaveSettingsResult{OK: true}
}

// Fonts 回傳使用者已安裝的字型家族（平台各自實作）。
func (h *AdbHost) Fonts() []string {
	return systemFonts()
}

// 給測試／診斷用：目前的路徑（不上橋）。
func settingsPath() string {
	info := currentSettingsInfo()
	if info.Path == "" {
		return fmt.Sprintf("(%s)", info.Note)
	}
	return info.Path
}
