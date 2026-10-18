package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDirWritable(t *testing.T) {
	dir := t.TempDir()
	if !dirWritable(dir) {
		t.Error("暫存目錄應該可以寫")
	}
	if dirWritable(filepath.Join(dir, "不存在的目錄")) {
		t.Error("不存在的目錄必須回 false")
	}
	if dirWritable("") {
		t.Error("空字串必須回 false")
	}
}

// updateTestServer 模擬靜態主機：給 Last-Modified 的 HEAD，以及可下載的 GET。
func updateTestServer(t *testing.T, modified time.Time, body []byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Last-Modified", modified.UTC().Format(http.TimeFormat))
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestCheckUpdate 用本地 HTTP 伺服器驗「遠端較新 → 提示、較舊 → 不提示」。
// （updateURLForced：設了 ACCELON26_UPDATE_URL 就略過『開發者本地 exe』的保護，
//
//	否則測試執行檔的建置時間永遠是剛剛，檢查永遠被跳過。）
func TestCheckUpdate(t *testing.T) {
	if !dirWritable(exeDir()) {
		t.Skipf("測試執行檔所在目錄不可寫（%s），檢查會被跳過", exeDir())
	}
	local := exeBuildTime()
	if local.IsZero() {
		t.Skip("拿不到測試執行檔的建置時間")
	}

	t.Run("遠端較新", func(t *testing.T) {
		srv := updateTestServer(t, local.Add(24*time.Hour), nil)
		t.Setenv("ACCELON26_UPDATE_URL", srv.URL)
		h := &AdbHost{}
		st := h.checkUpdateNow()
		if !st.Available {
			t.Errorf("應該偵測到新版本：%+v", st)
		}
		if st.DevBuild {
			t.Error("設了 ACCELON26_UPDATE_URL 時不該被當成開發者本地 exe")
		}
	})

	t.Run("遠端較舊", func(t *testing.T) {
		srv := updateTestServer(t, local.Add(-24*time.Hour), nil)
		t.Setenv("ACCELON26_UPDATE_URL", srv.URL)
		h := &AdbHost{}
		st := h.checkUpdateNow()
		if st.Available {
			t.Errorf("不該提示更新：%+v", st)
		}
	})

	t.Run("沒有 Last-Modified", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()
		t.Setenv("ACCELON26_UPDATE_URL", srv.URL)
		h := &AdbHost{}
		st := h.checkUpdateNow()
		if st.Available {
			t.Error("沒有 Last-Modified 時不能猜有新版")
		}
		if st.Note == "" {
			t.Error("應該說明為什麼不提示")
		}
	})

	t.Run("連不上", func(t *testing.T) {
		t.Setenv("ACCELON26_UPDATE_URL", "http://127.0.0.1:1/nope")
		h := &AdbHost{}
		st := h.checkUpdateNow()
		if st.Available || st.Note == "" {
			t.Errorf("連不上時應該安靜地失敗並留下說明：%+v", st)
		}
	})
}

// TestDevBuildSkipsCheck：沒設 ACCELON26_UPDATE_URL 且建置時間是剛剛 → 不檢查。
func TestDevBuildSkipsCheck(t *testing.T) {
	if !dirWritable(exeDir()) {
		t.Skip("目錄不可寫時本來就不檢查")
	}
	t.Setenv("ACCELON26_UPDATE_URL", "")
	buildOnce = sync.Once{}
	buildAt, buildSource = time.Time{}, ""
	buildTime = time.Now().UTC().Format(time.RFC3339) // 假裝是剛剛建置的
	defer func() { buildTime = ""; buildOnce = sync.Once{}; buildAt, buildSource = time.Time{}, "" }()
	h := &AdbHost{}
	st := h.checkUpdateNow()
	if !st.DevBuild || !st.Disabled {
		t.Errorf("開發者本地 exe 應該跳過檢查：%+v", st)
	}
}

func TestDownloadFileAndExeCheck(t *testing.T) {
	dir := t.TempDir()
	// 太小 → 拒絕（避免把錯誤頁存成 exe）
	small := updateTestServer(t, time.Now(), []byte("<html>not an exe</html>"))
	if err := downloadFile(small.URL, filepath.Join(dir, "small.exe")); err == nil {
		t.Error("小檔案應該被拒絕")
	}
	if _, err := os.Stat(filepath.Join(dir, "small.exe")); !os.IsNotExist(err) {
		t.Error("被拒絕的下載不該留下檔案")
	}
	// 夠大但不是 PE → downloadFile 過，looksLikeWindowsExe 擋
	fake := append([]byte("<html>"), bytes.Repeat([]byte("x"), 2<<20)...)
	srv := updateTestServer(t, time.Now(), fake)
	p := filepath.Join(dir, "fake.exe")
	if err := downloadFile(srv.URL, p); err != nil {
		t.Fatalf("下載：%v", err)
	}
	if err := looksLikeWindowsExe(p); err == nil {
		t.Error("不是 PE 的檔案應該被擋下來")
	}
	// 真的 PE 檔頭
	pe := append([]byte("MZ"), bytes.Repeat([]byte{0}, 2<<20)...)
	srv2 := updateTestServer(t, time.Now(), pe)
	p2 := filepath.Join(dir, "ok.exe")
	if err := downloadFile(srv2.URL, p2); err != nil {
		t.Fatalf("下載：%v", err)
	}
	if err := looksLikeWindowsExe(p2); err != nil {
		t.Errorf("MZ 開頭的檔案應該通過：%v", err)
	}
}

// manifestServer 模擬「有 versions.json 的新主機」：/versions.json 給版本資訊，
// /accelon26.exe 給二元檔。更新網址設成後者，manifestURL 就會推出前者。
func manifestServer(t *testing.T, buildTime string, body []byte) *httptest.Server {
	t.Helper()
	sum := sha256.Sum256(body)
	m := map[string]any{
		"app":       "accelon26",
		"channel":   "stable",
		"buildTime": buildTime,
		"url":       "",
		"size":      len(body),
		"sha256":    hex.EncodeToString(sum[:]),
	}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/versions.json" {
			m["url"] = srv.URL + "/accelon26.exe"
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(m)
			return
		}
		// 故意**不給** Last-Modified：證明判斷真的走 versions.json
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestCheckViaManifest：有 versions.json 時以 buildTime 為準，而且要把 sha256／size
// 帶回給 InstallUpdate 驗下載（回應完全不給 Last-Modified，證明不是靠它）。
func TestCheckViaManifest(t *testing.T) {
	if !dirWritable(exeDir()) {
		t.Skipf("測試執行檔所在目錄不可寫（%s），檢查會被跳過", exeDir())
	}
	local := exeBuildTime()
	if local.IsZero() {
		t.Skip("拿不到測試執行檔的建置時間")
	}

	t.Run("較新 → 提示並帶回 sha256", func(t *testing.T) {
		body := bytes.Repeat([]byte("MZ"), 1<<19)
		newer := local.Add(48 * time.Hour).UTC().Format(time.RFC3339)
		srv := manifestServer(t, newer, body)
		t.Setenv("ACCELON26_UPDATE_URL", srv.URL+"/accelon26.exe")
		h := &AdbHost{}
		st := h.checkUpdateNow()
		if !st.OK || !st.Available {
			t.Fatalf("應該從 versions.json 判斷有新版本：%+v", st)
		}
		want := sha256.Sum256(body)
		if st.SHA256 != hex.EncodeToString(want[:]) || st.Size != int64(len(body)) {
			t.Errorf("sha256／size 要跟 versions.json 一致：%+v", st)
		}
		if !strings.HasSuffix(st.DownloadURL, "/accelon26.exe") {
			t.Errorf("下載位置要來自 versions.json：%q", st.DownloadURL)
		}
	})

	t.Run("較舊 → 已是最新，但 OK=true", func(t *testing.T) {
		older := local.Add(-48 * time.Hour).UTC().Format(time.RFC3339)
		srv := manifestServer(t, older, bytes.Repeat([]byte("MZ"), 1<<19))
		t.Setenv("ACCELON26_UPDATE_URL", srv.URL+"/accelon26.exe")
		h := &AdbHost{}
		st := h.checkUpdateNow()
		if st.Available {
			t.Errorf("不該提示更新：%+v", st)
		}
		if !st.OK {
			t.Errorf("有拿到版本就該 OK=true（UI 才敢說『已是最新』）：%+v", st)
		}
	})
}

// TestParseBuildTimeLine：換檔前驗證靠的就是這一行輸出。
func TestParseBuildTimeLine(t *testing.T) {
	out := "accelon26\nbuild time: 2026-10-18 10:13 (from ldflags)\nrelease notes: 1 entries\n"
	got, err := parseBuildTimeLine(out)
	if err != nil {
		t.Fatalf("應該解析得出來：%v", err)
	}
	want := time.Date(2026, 10, 18, 10, 13, 0, 0, time.Local)
	if !got.Equal(want) {
		t.Errorf("解析到 %v，want %v", got, want)
	}
	if _, err := parseBuildTimeLine("accelon26\n"); err == nil {
		t.Error("沒有建置時間時要報錯")
	}
	// 不是執行檔的檔案一定驗不過（換檔前就不會動到使用者手上那一顆）。
	bad := filepath.Join(t.TempDir(), "bad.exe")
	if err := os.WriteFile(bad, []byte("not an exe"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyNewExe(bad, time.Time{}); err == nil {
		t.Error("不是 exe 的檔案應該驗不過")
	}
}

func TestReleaseNotes(t *testing.T) {
	h := &AdbHost{}
	if got := h.ReleaseNotes(""); len(got) != 0 {
		t.Errorf("平常啟動不該顯示任何說明，got %+v", got)
	}
	if got := h.ReleaseNotes("not-a-time"); len(got) != 0 {
		t.Errorf("看不懂的時間就當作沒有，got %+v", got)
	}
	all := allReleaseNotes()
	for _, n := range all {
		if _, err := time.Parse(time.RFC3339, n.BuildTime); err != nil {
			t.Errorf("release_notes.json 的 buildTime 必須是 RFC3339：%q", n.BuildTime)
		}
		if n.Title == "" || len(n.Items) == 0 {
			t.Errorf("每一版都要有標題與內容：%+v", n)
		}
	}
	if len(all) == 0 {
		t.Skip("release_notes.json 還沒有任何一版")
	}
	// 比最早那版還舊 → 全部都要回（更新後顯示的就是這個）
	got := h.ReleaseNotes("2000-01-01T00:00:00Z")
	if len(got) != len(all) {
		t.Errorf("應該回 %d 筆，got %d", len(all), len(got))
	}
	// 沒有比 since 新的版本 → fallback：還是要告訴使用者「更新完成了」
	future := time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
	fb := h.ReleaseNotes(future)
	if len(fb) != 1 || !strings.Contains(fb[0].Title, "已更新到") {
		t.Errorf("沒有對應說明時要有 fallback：%+v", fb)
	}
}
