package main

import (
	"os"
	"testing"
)

// 索引查詢（postings／plAnd／分群）對真實語料的煙霧測試：
// 這支不碰 GUI，卡住或 panic 都會直接看得見。
func TestSearchTokensOnCorpus(t *testing.T) {
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
	cases := []struct {
		adb, tag string
		tokens   []string
	}{
		{"13j.adb", "書", []string{"象", "曰"}},
		{"13j.adb", "書", []string{"孟", "子"}},
	}
	for _, c := range cases {
		if _, err := os.Stat(c.adb); err != nil {
			t.Skipf("沒有 %s", c.adb)
		}
		h := &AdbHost{}
		out, err := h.SearchTokens(c.adb, c.tokens, c.tag, 5000)
		if err != nil {
			t.Fatalf("SearchTokens(%v): %v", c.tokens, err)
		}
		t.Logf("%v：hits=%d missing=%v groups=%d（lookup %.2f ms／plAnd %.2f ms／group %.2f ms，平行=%v）",
			c.tokens, len(out.Hits), out.Missing, len(out.Groups), out.LookupMs, out.AndMs, out.GroupMs, out.Parallel)
		if len(out.Hits) == 0 {
			t.Errorf("%v：沒有命中", c.tokens)
		}
		// Postings 也要能用
		post, err := h.Postings(c.adb, c.tokens[0])
		if err != nil {
			t.Fatalf("Postings(%s): %v", c.tokens[0], err)
		}
		t.Logf("  Postings(%q)=%d 筆", c.tokens[0], len(post))
		h.CloseAll()
	}
}
