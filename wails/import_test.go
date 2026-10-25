package main

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeAdb 是一個只有檔頭（簽名正確）的最小 adb，足夠 SaveAdb 驗證用。
func fakeAdb() []byte {
	b := make([]byte, 256)
	copy(b[0:], "test")
	copy(b[32:], adbSignature)
	return b
}

func TestSaveAdbIntoWritesFirstUsableDir(t *testing.T) {
	dir := t.TempDir()
	res := saveAdbInto([]string{filepath.Join(dir, "missing-parent"), filepath.Join(dir, "ok")}, "book.adb", fakeAdb())
	if !res.OK || res.Error != "" {
		t.Fatalf("expected ok, got %+v", res)
	}
	if filepath.Base(res.Path) != "book.adb" {
		t.Fatalf("unexpected path %q", res.Path)
	}
	got, err := os.ReadFile(res.Path)
	if err != nil || !bytes.Equal(got, fakeAdb()) {
		t.Fatalf("file contents differ (err=%v)", err)
	}
}

func TestValidAdbHeaderAcceptsTheRealHeader(t *testing.T) {
	if !validAdbHeader(fakeAdb()) {
		t.Fatal("a 256 byte header carrying the signature must be accepted")
	}
	// 少了 NUL 補齊、只有簽名本身也要算對
	sigOnly := make([]byte, 256)
	copy(sigOnly[32:], adbSignature)
	if !validAdbHeader(sigOnly) {
		t.Fatal("the padded header must be accepted")
	}
	if validAdbHeader(make([]byte, 256)) {
		t.Fatal("an empty header must be rejected")
	}
	if validAdbHeader([]byte("short")) {
		t.Fatal("a short buffer must be rejected")
	}
}

func TestSaveAdbSanitisesNameAndChecksSignature(t *testing.T) {
	dir := t.TempDir()
	// 路徑分隔、中文、空白都要被清掉；沒有 .adb 要補上
	res := saveAdbInto([]string{dir}, sanitizeAdbName("..\\../論語 book"), fakeAdb())
	if !res.OK {
		t.Fatalf("expected ok, got %+v", res)
	}
	base := filepath.Base(res.Path)
	if strings.ContainsAny(base, "\\/: ") {
		t.Fatalf("name was not sanitised: %q", base)
	}
	if !strings.HasSuffix(base, ".adb") {
		t.Fatalf("missing .adb suffix: %q", base)
	}

	bad := base64.StdEncoding.EncodeToString([]byte("not an adb at all"))
	if r := (&AdbHost{}).SaveAdb("x.adb", bad); r.OK || r.Error == "" {
		t.Fatalf("expected a signature error, got %+v", r)
	}
	// 不是 base64
	if r := (&AdbHost{}).SaveAdb("x.adb", "!!!!"); r.OK || !strings.Contains(r.Error, "解碼") {
		t.Fatalf("expected a decode error, got %+v", r)
	}
}

func TestSeedDirsHasWorkingDirectory(t *testing.T) {
	dirs := seedDirs()
	cwd, err := os.Getwd()
	if err != nil {
		t.Skip("no cwd")
	}
	found := false
	for _, d := range dirs {
		if strings.EqualFold(d, cwd) {
			found = true
		}
	}
	if !found {
		t.Fatalf("seedDirs() does not contain the working directory: %v", dirs)
	}
}
