package main

// .adb 檔案關聯（作者 2026-11-08）
//
// 「雙擊 .adb 就用 accelon26 開啟」需要在 Windows 登錄寫一筆關聯（HKCU，不必管理員）。
// About（說明）頁有一顆按鈕呼叫這裡，並顯示目前 .adb 是指到哪一支 exe、它在哪個資料夾——
// 換過資料夾的 exe 一眼就看得出關聯還停在舊的。
//
// 平台差異留在 assoc_windows.go / assoc_darwin.go；這一支只放對前端穩定的形狀。

// AdbAssocInfo 是 About 頁「.adb 檔案關聯」那一列要的全部資訊。
type AdbAssocInfo struct {
	Supported bool   `json:"supported"` // 這個平台能不能由程式設定（只有 Windows）
	Linked    bool   `json:"linked"`    // 目前 .adb 有沒有指定開啟程式
	IsCurrent bool   `json:"isCurrent"` // 指定的就是現在這支 exe
	Command   string `json:"command"`   // 目前的開啟指令（`"…accelon26.exe" "%1"`）
	Exe       string `json:"exe"`       // 指令裡的 exe
	Dir       string `json:"dir"`       // 那個 exe 的資料夾
	Exists    bool   `json:"exists"`    // 那個 exe 還在不在（換過資料夾、刪掉了就 false）
	Current   string `json:"current"`   // 現在這支 exe
	ProgID    string `json:"progid"`    // .adb 目前指到的 ProgID
	// UserChoice：Windows 10/11「預設應用程式」的選擇（有雜湊保護，程式改不動）。
	// true 而且 IsCurrent=false 時，前端要提示使用者去 Windows 設定裡改。
	UserChoice bool `json:"userChoice"`
	// WriteError：設定時寫登錄失敗的原因（成功就空字串；診斷用）。
	WriteError string `json:"writeError,omitempty"`
}

// AdbAssociation 回報目前 .adb 的關聯（About 頁顯示用）。
func (h *AdbHost) AdbAssociation() AdbAssocInfo { return adbAssociationInfo() }

// SetAdbAssociation 把 .adb 指到現在這支 exe（Windows：HKCU\Software\Classes）。
// 回傳設定後重新讀到的狀態；呼叫方要看 IsCurrent 才知道有沒有真的生效。
func (h *AdbHost) SetAdbAssociation() AdbAssocInfo { return adbSetAssociation() }
