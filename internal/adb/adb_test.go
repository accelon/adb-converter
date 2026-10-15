package adb

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// The varint layout is not LEB128: low group first with a clear high bit, then
// higher groups with the high bit set. 7807 is the classic counter example.
func TestDecodePackedListLayout(t *testing.T) {
	// added=2, payload 7f bc => 7807
	raw := []byte{2, 0, 0, 0, 0x7f, 0xbc}
	got := DecodePackedList(raw)
	if len(got) != 1 || got[0] != 7807 {
		t.Fatalf("DecodePackedList = %v, want [7807]", got)
	}
	// two values: 7807 then 7807+7479
	raw = []byte{4, 0, 0, 0, 0x7f, 0xbc, 0x37, 0xba}
	got = DecodePackedList(raw)
	if len(got) != 2 || got[0] != 7807 || got[1] != 15286 {
		t.Fatalf("DecodePackedList = %v, want [7807 15286]", got)
	}
}

func TestPackedIteratorMatchesEager(t *testing.T) {
	src := []byte{4, 0, 0, 0, 0x01, 0x80, 0x02, 0x7f}
	eager := DecodePackedList(src)
	// value boundaries are the bytes with a CLEAR high bit: 01 + 80(ext) => 1,
	// then 02 => 2, then 7f => 127, cumulative 1, 3, 130
	if len(eager) != 3 || eager[0] != 1 || eager[1] != 3 || eager[2] != 130 {
		t.Fatalf("eager = %v, want [1 3 130]", eager)
	}
	it, err := NewPackedIterator(bytes.NewReader(src), 0)
	if err != nil {
		t.Fatal(err)
	}
	var lazy []int64
	for {
		v, ok := it.Next()
		if !ok {
			break
		}
		lazy = append(lazy, v)
	}
	if len(eager) != len(lazy) {
		t.Fatalf("eager %v lazy %v", eager, lazy)
	}
	for i := range eager {
		if eager[i] != lazy[i] {
			t.Fatalf("eager %v lazy %v", eager, lazy)
		}
	}
}

// A truncated or corrupt list must not panic.
func TestPackedListTruncated(t *testing.T) {
	for _, src := range [][]byte{
		{},
		{1},
		{5, 0, 0, 0, 0x01},
		{200, 0, 0, 0, 0xff, 0xff},
		{4, 0, 0, 0, 0xff, 0xff, 0xff, 0xff},
	} {
		_ = DecodePackedList(src)
		if it, err := NewPackedIterator(bytes.NewReader(src), 0); err == nil {
			for {
				if _, ok := it.Next(); !ok {
					break
				}
			}
		}
	}
}

func TestUTF16ToUTF8(t *testing.T) {
	// 十三經
	src := []byte{0x41, 0x53, 0x09, 0x4e, 0x93, 0x7d}
	got := string(utf16leToUTF8(nil, src))
	if got != "十三經" {
		t.Fatalf("got %q", got)
	}
	// surrogate pair: U+1F600
	src = []byte{0x3d, 0xd8, 0x00, 0xde}
	if got := string(utf16leToUTF8(nil, src)); got != "\U0001F600" {
		t.Fatalf("surrogate pair got %q", got)
	}
	// unpaired high surrogate becomes U+FFFD, like TextEncoder in the reference
	src = []byte{0x3d, 0xd8, 0x41, 0x00}
	if got := string(utf16leToUTF8(nil, src)); got != "\uFFFDA" {
		t.Fatalf("unpaired surrogate got %q", got)
	}
}

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		`a/b:c*d?e"f<g>h|i`: "a_b_c_d_e_f_g_h_i",
		"trailing...":       "trailing",
		"":                  "unnamed",
		"con":               "_con",
	}
	for in, want := range cases {
		if got := sanitizeName(in); got != want {
			t.Errorf("sanitizeName(%q) = %q, want %q", in, got, want)
		}
	}
}

// Golden test against the sample database in the repository root.
func TestExport13j(t *testing.T) {
	path := filepath.Join("..", "..", "13j.adb")
	f, err := os.Open(path)
	if err != nil {
		t.Skipf("fixture %s not available: %v", path, err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	info, err := Inspect(path, f, st.Size())
	if err != nil {
		t.Fatal(err)
	}
	if info.Header.Dbname != "13j" || info.Header.Dbcname != "十三經" {
		t.Fatalf("header %+v", info.Header)
	}
	if info.LineCount != int(info.Header.LineCount) {
		t.Fatalf("linecount %d != lines.physical %d", info.Header.LineCount, info.LineCount)
	}
	if got := info.Outer.Names; len(got) != 6 || got[0] != "source" || got[5] != "caches" {
		t.Fatalf("outer names %v", got)
	}

	dir := t.TempDir()
	res, err := Export(path, f, st.Size(), ExportOptions{OutDir: dir, Jobs: 4})
	if err != nil {
		t.Fatal(err)
	}
	if res.Lines != 42173 {
		t.Errorf("lines = %d, want 42173", res.Lines)
	}
	if res.TextBytes != 1662312 {
		t.Errorf("text bytes = %d, want 1662312", res.TextBytes)
	}
	if len(res.XMLFiles) != 1 || res.XMLFiles[0].Name != "13j.xml" {
		t.Fatalf("files %+v", res.XMLFiles)
	}
	out, err := os.ReadFile(filepath.Join(dir, "13j.xml"))
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2484602 {
		t.Errorf("output size = %d, want 2484602", len(out))
	}
	if !bytes.HasPrefix(out, []byte("<集>十三經</集>\n")) {
		t.Errorf("unexpected first line: %q", firstLine(out))
	}
}

func firstLine(b []byte) string {
	if i := bytes.IndexByte(b, '\n'); i >= 0 {
		return string(b[:i])
	}
	return string(b)
}
