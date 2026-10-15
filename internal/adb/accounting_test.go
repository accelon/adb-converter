package adb

import (
	"os"
	"path/filepath"
	"testing"
)

// The bytes the writer reports must match what landed on disk. Regression test
// for a bug where open() reset the per file counter after the first write had
// already been counted (losing exactly one flush worth of bytes).
func TestWriterAccounting(t *testing.T) {
	path := filepath.Join("..", "..", "13j.adb")
	f, err := os.Open(path)
	if err != nil {
		t.Skip("no fixture")
	}
	defer f.Close()
	st, _ := f.Stat()
	dir := t.TempDir()
	res, err := Export(path, f, st.Size(), ExportOptions{OutDir: dir, Jobs: 1})
	if err != nil {
		t.Fatal(err)
	}
	disk := int64(0)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if fi, err := e.Info(); err == nil {
			disk += fi.Size()
		}
	}
	own := int64(0)
	for _, x := range res.XMLFiles {
		own += x.Bytes
	}
	t.Logf("reported OutBytes=%d XMLFiles=%d disk=%d", res.OutBytes, own, disk)
	for _, x := range res.XMLFiles {
		t.Logf("  %s reported %d", x.Name, x.Bytes)
		if fi, err := os.Stat(filepath.Join(dir, x.Name)); err == nil {
			t.Logf("  %s on disk  %d", x.Name, fi.Size())
		}
	}
	if own != disk {
		t.Errorf("writer accounting %d != disk %d", own, disk)
	}
}
