package main

import (
	"os"
	"testing"
)

// 索引查詢（postings／plAnd／詞組命中）對真實語料的煙霧測試：
// 這支不碰 GUI，卡住或 panic 都會直接看得見。
func TestSearchQueryOnCorpus(t *testing.T) {
	// 白名單要求檔案在「當前工作目錄」之內，而 go test 的 cwd 是 wails/，
	// 所以先切到倉庫根目錄（那裡才有 13j.adb），結束再切回來。
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(".."); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(cwd) }()
	cases := []struct{ adb, query string }{
		{"13j.adb", "象曰"},
		{"13j.adb", "孟子"},
	}
	for _, c := range cases {
		if _, err := os.Stat(c.adb); err != nil {
			t.Skipf("沒有 %s", c.adb)
		}
		h := &AdbHost{}
		out, err := h.SearchQuery(c.adb, c.query, 5000, nil)
		if err != nil {
			t.Fatalf("SearchQuery(%q): %v", c.query, err)
		}
		hits := 0
		if len(out.Clauses) > 0 {
			hits = len(out.Clauses[0].Hits)
		}
		t.Logf("%q：clauses=%d hits=%d missing=%v（%.2f ms）",
			c.query, len(out.Clauses), hits, out.Missing, out.Ms)
		if hits == 0 {
			t.Errorf("%q：沒有命中", c.query)
		}
		// Postings 也要能用
		post, err := h.Postings(c.adb, "象")
		if err != nil {
			t.Fatalf("Postings(象): %v", err)
		}
		t.Logf("  Postings(象)=%d 筆", len(post))
		h.CloseAll()
	}
}
