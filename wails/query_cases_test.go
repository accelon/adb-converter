package main

// Go 後端的**共用測試集**（作者 2026-10）：讀 `ts/test/shared/search-cases.json`，
// 用 `SearchQuery()` 重跑一次，逐項比對 TS 後端算出來的答案。
//
// 資料庫路徑由環境變數給（沒給就找預設位置，再沒有就跳過那個庫）：
//
//	ACCELON_DB_13J=...\13j.adb
//	ACCELON_DB_YINSHUN=...\yinshun.adb
//	ACCELON_DB_FGDICT=...\fgdict.adb
//	ACCELON_SEARCH_CASES=<覆寫 cases 檔路徑>
//
// 執行：go test ./... （在 wails/ 目錄）

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type caseClause struct {
	Text        string   `json:"text"`
	Role        string   `json:"role"`
	Near        int      `json:"near"`
	Wild        bool     `json:"wild"`
	Tokens      []string `json:"tokens"`
	Missing     []string `json:"missing"`
	Occurrences int      `json:"occurrences"`
	Units       int      `json:"units"`
	First       []int32  `json:"first"`
	Last        int32    `json:"last"`
}

type searchCase struct {
	DB      string       `json:"db"`
	Query   string       `json:"query"`
	Clauses []caseClause `json:"clauses"`
}

// variantCase 是「繁簡通檢」的案例：`groups` 由 TS 的變體表挑出（只含查詢用到的字），
// Go 要把同組字的 posting 聯集起來 —— 這一段就是為了驗證 `unionPostings`。
type variantCase struct {
	DB      string       `json:"db"`
	Query   string       `json:"query"`
	Groups  []string     `json:"groups"`
	Clauses []caseClause `json:"clauses"`
}

type caseFile struct {
	Version      int           `json:"version"`
	Cases        []searchCase  `json:"cases"`
	VariantCases []variantCase `json:"variantCases"`
}

// casesPath 找 cases 檔（預設是相對 wails/ 的 ../ts/test/shared/search-cases.json）。
func casesPath(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("ACCELON_SEARCH_CASES"); p != "" {
		return p
	}
	candidates := []string{
		filepath.Join("..", "ts", "test", "shared", "search-cases.json"),
		filepath.Join("ts", "test", "shared", "search-cases.json"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return candidates[0]
}

// dbPath 找一個庫的 .adb：環境變數優先，其次常見位置（本機開發用；CI 請設環境變數）。
func dbPath(t *testing.T, db string) string {
	t.Helper()
	key := "ACCELON_DB_" + strings.ToUpper(db)
	if p := os.Getenv(key); p != "" {
		return p
	}
	guess := map[string][]string{
		"13j":     {filepath.Join("..", "13j.adb")},
		"yinshun": {`D:\accelon3\yinshun\yinshun.adb`},
		"fgdict":  {`D:\accelon3\fgdict.adb`},
	}[db]
	for _, p := range guess {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// useDB 讓某個庫變成「現在可以查」的狀態：`AdbHost.resolve()` 只接受工作目錄之內的
// 檔案，不同庫又在不同資料夾，所以每次查詢前都要切到那個資料夾，並回傳可用的相對檔名。
func useDB(t *testing.T, h *AdbHost, cache map[string]string, db string) string {
	t.Helper()
	full, ok := cache[db]
	if !ok {
		full = dbPath(t, db)
		if full != "" {
			// 一定要存**絕對路徑**：下面每次查詢都會 chdir，相對路徑會愈切愈歪
			if abs, err := filepath.Abs(full); err == nil {
				full = abs
			}
		}
		cache[db] = full
		if full == "" {
			t.Logf("skip db %s（沒有 .adb）", db)
			return ""
		}
	}
	if full == "" {
		return ""
	}
	dir := filepath.Dir(full)
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir %s: %v", dir, err)
	}
	name := filepath.Base(full)
	if _, err := h.Open(name); err != nil {
		t.Fatalf("open %s: %v", full, err)
	}
	return name
}

// compareClauses 比對一份查詢的每個詞組（text／role／near／wild／tokens／missing／命中數／
// 前幾個與最後一個 VA）。
func compareClauses(t *testing.T, label string, got []clauseHits, want []caseClause) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s：詞組數 %d，預期 %d", label, len(got), len(want))
		return
	}
	for i, w := range want {
		g := got[i]
		if g.Text != w.Text {
			t.Errorf("%s 第 %d 個詞組：text %q，預期 %q", label, i, g.Text, w.Text)
		}
		if g.Role != w.Role {
			t.Errorf("%s 第 %d 個詞組：role %q，預期 %q", label, i, g.Role, w.Role)
		}
		if (g.NearOf >= 0) != (w.Near >= 0) {
			t.Errorf("%s 第 %d 個詞組：nearOf %d，預期 %d", label, i, g.NearOf, w.Near)
		}
		if g.Wildcard != w.Wild {
			t.Errorf("%s 第 %d 個詞組：wildcard %v，預期 %v", label, i, g.Wildcard, w.Wild)
		}
		if strings.Join(g.Tokens, "|") != strings.Join(w.Tokens, "|") {
			t.Errorf("%s 第 %d 個詞組：tokens %v，預期 %v", label, i, g.Tokens, w.Tokens)
		}
		if strings.Join(g.Missing, "|") != strings.Join(w.Missing, "|") {
			t.Errorf("%s 第 %d 個詞組：missing %v，預期 %v", label, i, g.Missing, w.Missing)
		}
		if g.Occurrences != w.Occurrences {
			t.Errorf("%s 第 %d 個詞組：命中 %d，預期 %d", label, i, g.Occurrences, w.Occurrences)
			continue
		}
		if w.Units != 0 && len(g.Hits) > 0 && int(g.Hits[0].Units) != w.Units {
			t.Errorf("%s 第 %d 個詞組：units %d，預期 %d", label, i, g.Hits[0].Units, w.Units)
		}
		for k, va := range w.First {
			if k >= len(g.Hits) {
				t.Errorf("%s 第 %d 個詞組：少了第 %d 個命中", label, i, k)
				break
			}
			if g.Hits[k].VA != va {
				t.Errorf("%s 第 %d 個詞組：第 %d 個命中 VA %d，預期 %d", label, i, k, g.Hits[k].VA, va)
			}
		}
		if w.Last >= 0 && len(g.Hits) > 0 && g.Hits[len(g.Hits)-1].VA != w.Last {
			t.Errorf("%s 第 %d 個詞組：最後一個命中 VA %d，預期 %d",
				label, i, g.Hits[len(g.Hits)-1].VA, w.Last)
		}
	}
}

func loadCases(t *testing.T) caseFile {
	t.Helper()
	raw, err := os.ReadFile(casesPath(t))
	if err != nil {
		t.Skipf("沒有共用測試集（%v）", err)
	}
	var cf caseFile
	if err := json.Unmarshal(raw, &cf); err != nil {
		t.Fatalf("cases JSON 壞了：%v", err)
	}
	if cf.Version < 1 {
		t.Fatalf("不認得的 cases 版本 %d", cf.Version)
	}
	return cf
}

// withCaseDbs 建一個 AdbHost，並在測試結束後還原工作目錄。
func withCaseDbs(t *testing.T) (*AdbHost, map[string]string, func()) {
	t.Helper()
	h := &AdbHost{}
	startWd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	cleanup := func() {
		h.CloseAll()
		_ = os.Chdir(startWd)
	}
	return h, map[string]string{}, cleanup
}

// TestSearchCasesAgainstSharedSet 是「Go 後端 ≡ TS 後端」的守門測試。
func TestSearchCasesAgainstSharedSet(t *testing.T) {
	cf := loadCases(t)
	h, cache, cleanup := withCaseDbs(t)
	defer cleanup()

	ran := 0
	for _, c := range cf.Cases {
		path := useDB(t, h, cache, c.DB)
		if path == "" {
			continue
		}
		ran++
		got, err := h.SearchQuery(path, c.Query, 1_000_000, nil)
		if err != nil {
			t.Fatalf("%s %q: %v", c.DB, c.Query, err)
		}
		compareClauses(t, c.DB+" "+c.Query, got.Clauses, c.Clauses)
	}
	if ran == 0 {
		t.Skip("沒有任何可用的 .adb（設定 ACCELON_DB_* 後再跑）")
	}
	t.Logf("比對 %d 個查詢", ran)
}

// TestSearchQueryVariants 驗證「變體組的 posting 聯集」（繁簡通檢）在 Go 端與 TS 一致。
func TestSearchQueryVariants(t *testing.T) {
	cf := loadCases(t)
	if len(cf.VariantCases) == 0 {
		t.Skip("測試集沒有通檢案例（舊版檔案？重跑 bun run cases）")
	}
	h, cache, cleanup := withCaseDbs(t)
	defer cleanup()

	ran, withGroups := 0, 0
	for _, c := range cf.VariantCases {
		path := useDB(t, h, cache, c.DB)
		if path == "" {
			continue
		}
		ran++
		if len(c.Groups) > 0 {
			withGroups++
		}
		got, err := h.SearchQuery(path, c.Query, 1_000_000, c.Groups)
		if err != nil {
			t.Fatalf("%s %q: %v", c.DB, c.Query, err)
		}
		compareClauses(t, c.DB+" 通檢 "+c.Query, got.Clauses, c.Clauses)
	}
	if ran == 0 {
		t.Skip("沒有任何可用的 .adb（設定 ACCELON_DB_* 後再跑）")
	}
	t.Logf("比對 %d 個通檢查詢（其中 %d 個帶變體組）", ran, withGroups)
}
