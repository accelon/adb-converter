package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func resetMirror(t *testing.T) {
	t.Helper()
	mirrorSel.mu.Lock()
	mirrorSel.base = mirrorPrimaryBase
	mirrorSel.mu.Unlock()
}

func TestSetUpdateMirror(t *testing.T) {
	resetMirror(t)
	defer resetMirror(t)
	h := &AdbHost{}

	if !h.SetUpdateMirror("https://nissaya.cn/accelon26") {
		t.Fatal("合法網址被拒絕")
	}
	if got := h.UpdateMirror(); got != mirrorOverseasBase {
		t.Fatalf("沒有補上結尾斜線：%q", got)
	}
	if got := candidateBases()[0]; got != mirrorOverseasBase {
		t.Fatalf("candidateBases 第一個不是目前站：%q", got)
	}
	if len(candidateBases()) != 2 || candidateBases()[1] != mirrorPrimaryBase {
		t.Fatalf("應該退回主站：%v", candidateBases())
	}
	if h.SetUpdateMirror("ftp://example.com/x") {
		t.Fatal("ftp 應該被拒絕")
	}
	if h.SetUpdateMirror("not a url") {
		t.Fatal("亂碼網址應該被拒絕")
	}
	// 測試／自架的站不在「已知兩站」裡：不回退（避免偷偷連正式站）
	if !h.SetUpdateMirror("http://127.0.0.1:12345/accelon26/") {
		t.Fatal("本機網址應該被接受")
	}
	if got := candidateBases(); len(got) != 1 {
		t.Fatalf("自架站不應該回退：%v", got)
	}
}

func TestProbeMirror(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("應該用 HEAD 探測，收到 %s", r.Method)
		}
		if r.URL.Path != "/versions.json" {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(r.URL.RawQuery, "probe=") {
			w.Header().Set("Cache-Control", "no-cache")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := &AdbHost{}
	p := h.ProbeMirror(srv.URL, 2000)
	if !p.OK || p.MS < 0 {
		t.Fatalf("探測失敗：%+v", p)
	}

	notFound := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer notFound.Close()
	if p := h.ProbeMirror(notFound.URL, 2000); p.OK || !strings.Contains(p.Error, "404") {
		t.Fatalf("404 應該失敗：%+v", p)
	}

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(400 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer slow.Close()
	if p := h.ProbeMirror(slow.URL, 100); p.OK {
		t.Fatalf("逾時應該失敗：%+v", p)
	}
}

func TestFetchManifestAt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/versions.json" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"app":"accelon26","buildTime":"2026-10-29T00:00:00Z","size":123,"sha256":"abc","url":"https://example.com/x.exe"}`))
	}))
	defer srv.Close()
	m, err := fetchManifestAt(srv.URL + "/versions.json")
	if err != nil || m.BuildTime != "2026-10-29T00:00:00Z" || m.Size != 123 {
		t.Fatalf("fetchManifestAt: %+v %v", m, err)
	}
	if _, err := fetchManifestAt(srv.URL + "/missing.json"); err == nil {
		t.Fatal("404 應該回錯誤")
	}
}
