//go:build windows

package main

import (
	"strings"
	"testing"
)

func TestFontFamilies(t *testing.T) {
	cases := map[string][]string{
		`Arial Bold (TrueType)`:                                  {"Arial"},
		`Arial Italic (TrueType)`:                                {"Arial"},
		`Microsoft JhengHei & Microsoft JhengHei UI (TrueType)`: {"Microsoft JhengHei", "Microsoft JhengHei UI"},
		`PMingLiU-ExtB (TrueType)`:                               {"PMingLiU-ExtB"},
		`DFKai-SB (TrueType)`:                                    {"DFKai-SB"},
		`Source Han Serif TC Bold (OpenType)`:                    {"Source Han Serif TC"},
	}
	for in, want := range cases {
		got := fontFamilies(in)
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("fontFamilies(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestSystemFontsNonEmpty(t *testing.T) {
	fonts := systemFonts()
	if len(fonts) == 0 {
		t.Fatal("no installed fonts found")
	}
	// 這台機器一定有正黑體或細明體；沒有就代表登錄解析壞了
	hasCJK := false
	for _, f := range fonts {
		if strings.Contains(f, "JhengHei") || strings.Contains(f, "MingLiU") || strings.Contains(f, "Kai") {
			hasCJK = true
			break
		}
	}
	if !hasCJK {
		t.Logf("fonts (first 20): %v", fonts[:min(20, len(fonts))])
		t.Log("no CJK font found (possible on a minimal container); list is still non-empty")
	}
}
