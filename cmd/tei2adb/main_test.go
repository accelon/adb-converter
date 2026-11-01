package main

import "testing"

func TestSanskritPUA(t *testing.T) {
	cases := []struct {
		ref  string
		want rune
		ok   bool
	}{
		{"SD-D5B5", 0x1075B5, true},
		{"SD-A440", 0x104440, true},
		{"RJ-CCBA", 0x10CCBA, true},
		{"RJ-C943", 0x10C943, true},
		{"SD-123", 0xFA123, true},
		{"XX-1234", 0, false},
		{"SD-ZZZZ", 0, false},
		{"SD-", 0, false},
	}
	for _, c := range cases {
		got, ok := sanskritPUA(c.ref)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("sanskritPUA(%q) = U+%04X,%v; want U+%04X,%v", c.ref, got, ok, c.want, c.ok)
		}
	}
}

func TestIsPUA(t *testing.T) {
	for _, r := range []rune{0xE000, 0xF8FF, 0xF0000, 0x1075B5, 0x10FFFD} {
		if !isPUA(r) {
			t.Errorf("isPUA(U+%04X) = false; want true", r)
		}
	}
	for _, r := range []rune{0x0041, 0xD7FF, 0xF900, 0xFFFF, 0x110000} {
		if isPUA(r) {
			t.Errorf("isPUA(U+%04X) = true; want false", r)
		}
	}
}

func TestMissingGaijiName(t *testing.T) {
	if got := missingGaijiName("X"); got != "wxzj-missing-gaiji.tsv" {
		t.Errorf("X: %q", got)
	}
	if got := missingGaijiName("T"); got != "taisho-missing-gaiji.tsv" {
		t.Errorf("T: %q", got)
	}
}
