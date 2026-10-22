package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSettingsTargetExeWritable(t *testing.T) {
	dir := t.TempDir()
	info := settingsTarget(dir, filepath.Join(dir, "config"))
	if info.Kind != "exe" || !info.Writable {
		t.Fatalf("exe dir writable should use exe: %+v", info)
	}
	if info.Path != filepath.Join(dir, "settings.json") {
		t.Fatalf("path = %q", info.Path)
	}
}

func TestSettingsTargetFallback(t *testing.T) {
	base := t.TempDir()
	exeDir := filepath.Join(base, "no-such-dir") // 不存在＝不可寫
	configDir := filepath.Join(base, "config")
	info := settingsTarget(exeDir, configDir)
	if info.Kind != "userconfig" || !info.Writable {
		t.Fatalf("non-writable exe dir should fall back: %+v", info)
	}
	want := filepath.Join(configDir, "accelon26", "settings.json")
	if info.Path != want {
		t.Fatalf("path = %q, want %q", info.Path, want)
	}
	if info.Note == "" {
		t.Fatal("fallback should explain why")
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")

	// 第一次：檔案不存在＝ok、沒有內容
	if r := readSettingsAt(path); !r.OK || r.Text != "" {
		t.Fatalf("missing file: %+v", r)
	}

	first := `{"format":"accelon26-settings","version":1,"profiles":{"global":{"tagStyle":{"tags":{"章":{"color":"#7cc0ff","size":125}}}}}}`
	if r := writeSettingsAt(path, first); !r.OK {
		t.Fatalf("save: %+v", r)
	}
	r := readSettingsAt(path)
	if !r.OK || strings.TrimSpace(r.Text) != first {
		t.Fatalf("load after save: %+v", r)
	}

	// 不合法的 JSON 不可以蓋掉舊檔
	if r := writeSettingsAt(path, `{"format":`); r.OK {
		t.Fatal("invalid JSON must be rejected")
	}
	if r := readSettingsAt(path); !r.OK || strings.TrimSpace(r.Text) != first {
		t.Fatalf("old file must survive a rejected write: %+v", r)
	}

	// 壞掉的手改檔：回錯誤，但不要把內容當成可用
	if err := os.WriteFile(path, []byte("{oops"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r := readSettingsAt(path); r.OK {
		t.Fatal("broken JSON must not load")
	}

	// 原子寫入不留暫存檔
	entries, _ := os.ReadDir(filepath.Dir(path))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".settings-") {
			t.Fatalf("leftover temp file: %s", e.Name())
		}
	}
}

func TestSaveSettingsResultShape(t *testing.T) {
	// UI 讀的是 {ok, error}；欄位一定要有 json tag（Wails 用 JSON 傳）
	// （編譯期檢查：JSON 標籤在 struct 上；這裡只確認 OK 的預設值）
	var r SaveSettingsResult
	if r.OK {
		t.Fatal("zero value should not be ok")
	}
}
