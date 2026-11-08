//go:build windows

package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"
)

func TestExeFromCommand(t *testing.T) {
	cases := []struct{ in, want string }{
		{`"C:\Program Files\accelon26\accelon26.exe" "%1"`, `C:\Program Files\accelon26\accelon26.exe`},
		{`"D:\accelon3\accelon26.exe"`, `D:\accelon3\accelon26.exe`},
		{`D:\accelon3\accelon26.exe "%1"`, `D:\accelon3\accelon26.exe`},
		{`  "D:\a b\accelon26.exe" "%1"  `, `D:\a b\accelon26.exe`},
		{``, ``},
	}
	for _, c := range cases {
		if got := exeFromCommand(c.in); !strings.EqualFold(got, c.want) {
			t.Errorf("exeFromCommand(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestReadOpenCommand 用一個臨時 ProgID 驗證「讀 command」那條路（不碰真的 .adb）。
func TestReadOpenCommand(t *testing.T) {
	progid := fmt.Sprintf("Accelon26SelfTest.%d", time.Now().UnixNano())
	base := `Software\Classes\` + progid
	t.Cleanup(func() { _ = registry.DeleteKey(registry.CURRENT_USER, base) })

	want := `"D:\accelon3\accelon26.exe" "%1"`
	k, _, err := registry.CreateKey(registry.CURRENT_USER, base+`\shell\open\command`, registry.SET_VALUE)
	if err != nil {
		t.Fatalf("create key: %v", err)
	}
	if err := k.SetStringValue("", want); err != nil {
		t.Fatalf("set value: %v", err)
	}
	k.Close()

	if got := readOpenCommand(registry.CURRENT_USER, progid); got != want {
		t.Fatalf("readOpenCommand = %q, want %q", got, want)
	}
	if got := exeFromCommand(readOpenCommand(registry.CURRENT_USER, progid)); !strings.EqualFold(got, `D:\accelon3\accelon26.exe`) {
		t.Fatalf("parsed exe = %q", got)
	}
	if dir := filepath.Dir(`D:\accelon3\accelon26.exe`); dir != `D:\accelon3` {
		t.Fatalf("dir = %q", dir)
	}
}
