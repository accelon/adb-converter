package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeAdb 造一個「檔頭合法」的最小 .adb：不給閱讀器用，只驗下載／替換。
func fakeAdbBytes(size int, fill byte) []byte {
	b := bytes.Repeat([]byte{fill}, size)
	copy(b[32:], adbSignature)
	return b
}

func shaHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func waitDownload(t *testing.T, h *AdbHost, id string, want string, timeout time.Duration) AdbDownloadStatus {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		st, err := h.AdbDownloadStatus(id)
		if err != nil {
			t.Fatalf("status: %v", err)
		}
		if st.State == want {
			return st
		}
		if st.State == "error" && want != "error" {
			t.Fatalf("下載失敗：%s", st.Error)
		}
		if st.State == "cancelled" && want != "cancelled" {
			t.Fatalf("下載被取消")
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等不到狀態 %s", want)
	return AdbDownloadStatus{}
}

func tempLeftovers(t *testing.T, dir string) []string {
	t.Helper()
	m, err := filepath.Glob(filepath.Join(dir, ".accelon26-*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestAdbDownloadReplacesOnlyAfterChecks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "13j.adb")
	old := fakeAdbBytes(4096, 'A')
	if err := os.WriteFile(path, old, 0o644); err != nil {
		t.Fatal(err)
	}
	newBytes := fakeAdbBytes(8192, 'B')
	copy(newBytes[128:], []byte("N\x00E\x00W\x00"))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(newBytes)))
		_, _ = w.Write(newBytes)
	}))
	defer srv.Close()

	h := &AdbHost{}
	id, err := startAdbDownload(h, srv.URL, path, shaHex(newBytes), int64(len(newBytes)))
	if err != nil {
		t.Fatal(err)
	}
	st := waitDownload(t, h, id, "done", 5*time.Second)
	if st.Received != int64(len(newBytes)) || st.Total != int64(len(newBytes)) {
		t.Fatalf("進度不對：%+v", st)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, newBytes) {
		t.Fatalf("原檔沒有換成新版（%d vs %d bytes）", len(got), len(newBytes))
	}
	if left := tempLeftovers(t, dir); len(left) != 0 {
		t.Fatalf("留下暫存檔：%v", left)
	}
}

func TestAdbDownloadShaMismatchLeavesOriginal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "13j.adb")
	old := fakeAdbBytes(4096, 'A')
	if err := os.WriteFile(path, old, 0o644); err != nil {
		t.Fatal(err)
	}
	newBytes := fakeAdbBytes(4096, 'C')

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(newBytes)
	}))
	defer srv.Close()

	h := &AdbHost{}
	id, err := startAdbDownload(h, srv.URL, path, strings.Repeat("0", 64), int64(len(newBytes)))
	if err != nil {
		t.Fatal(err)
	}
	st := waitDownload(t, h, id, "error", 5*time.Second)
	if !strings.Contains(st.Error, "sha256") {
		t.Fatalf("錯誤訊息沒有提到 sha256：%q", st.Error)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, old) {
		t.Fatal("sha256 不符時原檔被動到了")
	}
	if left := tempLeftovers(t, dir); len(left) != 0 {
		t.Fatalf("留下暫存檔：%v", left)
	}
}

func TestAdbDownloadCancelLeavesOriginal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ys.adb")
	old := fakeAdbBytes(4096, 'A')
	if err := os.WriteFile(path, old, 0o644); err != nil {
		t.Fatal(err)
	}
	newBytes := fakeAdbBytes(2<<20, 'D')

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fl, _ := w.(http.Flusher)
		w.Header().Set("Content-Length", fmt.Sprint(len(newBytes)))
		for i := 0; i < len(newBytes); i += 32 << 10 {
			end := i + 32<<10
			if end > len(newBytes) {
				end = len(newBytes)
			}
			if _, err := w.Write(newBytes[i:end]); err != nil {
				return
			}
			if fl != nil {
				fl.Flush()
			}
			time.Sleep(15 * time.Millisecond)
		}
	}))
	defer srv.Close()

	h := &AdbHost{}
	id, err := startAdbDownload(h, srv.URL, path, shaHex(newBytes), int64(len(newBytes)))
	if err != nil {
		t.Fatal(err)
	}
	// 等到真的開始收資料再按放棄（證明不是「還沒開始就取消」）
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		st, _ := h.AdbDownloadStatus(id)
		if st.Received > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !h.CancelAdbDownload(id) {
		t.Fatal("CancelAdbDownload 回 false")
	}
	st := waitDownload(t, h, id, "cancelled", 5*time.Second)
	if st.Received == 0 {
		t.Fatal("取消前沒有收到任何位元組（測試太早按）")
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, old) {
		t.Fatal("取消後原檔被動到了")
	}
	if left := tempLeftovers(t, dir); len(left) != 0 {
		t.Fatalf("取消後留下暫存檔：%v", left)
	}
}

func TestFileSha256(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.adb")
	b := fakeAdbBytes(1024, 'E')
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := fileSha256(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != shaHex(b) {
		t.Fatalf("sha256 不同：%s vs %s", got, shaHex(b))
	}
}

func TestFetchText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/404" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"dbs":[]}`))
	}))
	defer srv.Close()

	h := &AdbHost{}
	body, err := h.FetchText(srv.URL + "/manifest.json")
	if err != nil || body != `{"dbs":[]}` {
		t.Fatalf("FetchText: %q %v", body, err)
	}
	if _, err := h.FetchText(srv.URL + "/404"); err == nil {
		t.Fatal("404 應該回錯誤")
	}
	if _, err := h.FetchText("file:///etc/passwd"); err == nil {
		t.Fatal("非 http(s) 應該被拒絕")
	}
}
