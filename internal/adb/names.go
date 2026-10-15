package adb

import "strings"

var illegalNameChars = func() [256]bool {
	var t [256]bool
	for _, c := range []byte(`<>:"/\|?*`) {
		t[c] = true
	}
	for c := 0; c < 32; c++ {
		t[c] = true
	}
	return t
}()

var reservedNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// sanitizeName makes a name from a `<檔 n="...">` attribute usable as a file
// name on Windows and POSIX alike.
func sanitizeName(name string) string {
	var b strings.Builder
	for i := 0; i < len(name); i++ {
		if illegalNameChars[name[i]] {
			b.WriteByte('_')
		} else {
			b.WriteByte(name[i])
		}
	}
	s := strings.TrimRight(b.String(), ". ")
	if s == "" {
		s = "unnamed"
	}
	stem := s
	if dot := strings.LastIndexByte(s, '.'); dot > 0 {
		stem = s[:dot]
	}
	if reservedNames[strings.ToLower(stem)] {
		s = "_" + s
	}
	if len(s) > 120 {
		ext := ""
		if dot := strings.LastIndexByte(s, '.'); dot > 0 {
			ext = s[dot:]
		}
		s = s[:120-len(ext)] + ext
	}
	return s
}
