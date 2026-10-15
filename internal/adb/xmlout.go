package adb

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// tag is the `<檔` (file/document) marker the reference exporter splits on.
var tag = []byte("<檔")

const (
	// how many characters after `<檔` the reference looks for n="..." (here in
	// bytes: one character is at most 4 UTF-8 bytes)
	tagLookahead = 200
	// how much joined XML text is buffered before tags are resolved
	flushChars = 1 << 20
)

// OutputFile is one written file.
type OutputFile struct {
	Name  string
	Bytes int64
}

// XmlWriterOptions configures XmlWriter.
type XmlWriterOptions struct {
	OutDir      string
	Dbname      string
	Stdout      bool
	NoOverwrite bool
	Discard     bool
}

// XmlWriter turns the joined XML text stream into files, splitting on `<檔`
// exactly like dumpXML does, but streaming: only ~1 MiB of text is buffered and
// a tag may straddle a flush boundary.
type XmlWriter struct {
	opts         XmlWriterOptions
	pending      []byte
	files        []OutputFile
	used         map[string]int
	f            *os.File
	w            *bufio.Writer
	currentName  string
	currentBytes int64
	tagCount     int
	total        int64
	err          error
	finished     bool
}

// NewXmlWriter creates a writer for one database.
func NewXmlWriter(opts XmlWriterOptions) *XmlWriter {
	return &XmlWriter{
		opts:        opts,
		used:        map[string]int{},
		pending:     make([]byte, 0, flushChars+4096),
		currentName: sanitizeName(opts.Dbname + ".xml"),
	}
}

// Write appends joined XML text.
func (x *XmlWriter) Write(p []byte) (int, error) {
	if x.err != nil {
		return 0, x.err
	}
	x.pending = append(x.pending, p...)
	if len(x.pending) >= flushChars {
		x.flush(false)
	}
	return len(p), x.err
}

func (x *XmlWriter) flush(final bool) {
	if len(x.pending) == 0 || x.err != nil {
		return
	}
	text := x.pending
	contentStart := 0
	searchFrom := 0
	for {
		rel := bytes.Index(text[searchFrom:], tag)
		if rel < 0 {
			// no further tag: keep a possible partial tag for the next round
			keep := 0
			if !final {
				keep = len(tag) - 1
				if n := len(text) - contentStart; n < keep {
					keep = n
				}
			}
			x.write(text[contentStart : len(text)-keep])
			x.pending = append(x.pending[:0], text[len(text)-keep:]...)
			return
		}
		at := searchFrom + rel
		winEnd := at + tagLookahead*4
		if winEnd > len(text) {
			winEnd = len(text)
		}
		win := text[at:winEnd]
		if !final && !bytes.Contains(win, []byte(`">`)) && len(text)-at < tagLookahead {
			// not enough lookahead to name the new file yet
			x.write(text[contentStart:at])
			x.pending = append(x.pending[:0], text[at:]...)
			return
		}
		x.write(text[contentStart:at])
		name := extractName(win, fmt.Sprintf("%s.%d.xml", x.opts.Dbname, x.tagCount))
		x.tagCount++
		x.rotate(name)
		contentStart = at
		searchFrom = at + len(tag)
	}
}

func extractName(win []byte, fallback string) string {
	if i := bytes.Index(win, []byte(`">`)); i >= 0 {
		win = win[:i+2]
	}
	i := bytes.Index(win, []byte(`n="`))
	if i < 0 {
		return fallback
	}
	rest := win[i+3:]
	j := bytes.IndexByte(rest, '"')
	if j <= 0 {
		return fallback
	}
	return string(rest[:j])
}

func (x *XmlWriter) unique(name string) string {
	base := sanitizeName(name)
	n := x.used[base]
	x.used[base] = n + 1
	if n == 0 {
		return base
	}
	if dot := strings.LastIndexByte(base, '.'); dot > 0 {
		return fmt.Sprintf("%s~%d%s", base[:dot], n, base[dot:])
	}
	return fmt.Sprintf("%s~%d", base, n)
}

func (x *XmlWriter) rotate(name string) {
	x.closeCurrent()
	x.currentName = x.unique(name)
}

func (x *XmlWriter) open() {
	if x.f != nil || x.w != nil || x.err != nil {
		return
	}
	if x.opts.Stdout {
		x.w = bufio.NewWriterSize(os.Stdout, 1<<20)
		return
	}
	path := filepath.Join(x.opts.OutDir, x.currentName)
	if x.opts.NoOverwrite {
		if _, err := os.Stat(path); err == nil {
			x.err = fmt.Errorf("refusing to overwrite %s (--no-overwrite)", path)
			return
		}
	}
	f, err := os.Create(path)
	if err != nil {
		x.err = err
		return
	}
	x.f = f
	x.w = bufio.NewWriterSize(f, 1<<20)
	// NOTE: currentBytes must not be reset here, write() already counted the
	// bytes that triggered this open. It is reset in closeCurrent.
}

func (x *XmlWriter) write(p []byte) {
	if len(p) == 0 || x.err != nil {
		return
	}
	x.total += int64(len(p))
	x.currentBytes += int64(len(p))
	if x.opts.Discard {
		return
	}
	x.open()
	if x.err != nil {
		return
	}
	if _, err := x.w.Write(p); err != nil {
		x.err = err
	}
}

func (x *XmlWriter) closeCurrent() {
	if x.w != nil {
		if err := x.w.Flush(); err != nil && x.err == nil {
			x.err = err
		}
		x.w = nil
	}
	if x.f != nil {
		if err := x.f.Close(); err != nil && x.err == nil {
			x.err = err
		}
		x.f = nil
		x.files = append(x.files, OutputFile{Name: x.currentName, Bytes: x.currentBytes})
		x.currentBytes = 0
	}
}

// Finish flushes the remaining text and writes the .lst index when the database
// produced more than one file.
func (x *XmlWriter) Finish() ([]OutputFile, int64, error) {
	if x.finished {
		return x.files, x.total, x.err
	}
	x.finished = true
	x.flush(true)
	x.closeCurrent()
	if len(x.files) == 0 {
		x.files = append(x.files, OutputFile{Name: x.currentName, Bytes: x.total})
	}
	if len(x.files) > 1 && !x.opts.Stdout && !x.opts.Discard && x.err == nil {
		var sb strings.Builder
		for i, f := range x.files {
			if i > 0 {
				sb.WriteByte('\n')
			}
			sb.WriteString(f.Name)
		}
		name := sanitizeName(x.opts.Dbname + ".lst")
		if err := os.WriteFile(filepath.Join(x.opts.OutDir, name), []byte(sb.String()), 0o644); err != nil {
			x.err = err
		} else {
			x.files = append(x.files, OutputFile{Name: name, Bytes: int64(sb.Len())})
		}
	}
	return x.files, x.total, x.err
}

// LineStats reports what the splitter saw.
type LineStats struct {
	Lines        int64
	Bytes        int64
	TailBytes    int64
	Shortfall    int64
	MaxLineBytes int
}

// LineSplitter consumes the decoded UTF-16LE text and writes UTF-8 lines into
// the XmlWriter, cutting at the offsets of the lines.physical table.
type LineSplitter struct {
	it      *PackedIterator
	sink    io.Writer
	carry   []byte
	line    []byte
	pos     int64
	needSep bool
	// one line end that was decoded but does not fit the current chunk yet
	next    int64
	hasNext bool
	// the line table is exhausted: everything left over is dropped, like the
	// reference exporter does
	done bool
	Stats LineStats
	err   error
}

// NewLineSplitter wires a line table iterator to a sink.
func NewLineSplitter(it *PackedIterator, sink io.Writer) *LineSplitter {
	return &LineSplitter{it: it, sink: sink, line: make([]byte, 0, 1<<16)}
}

func (s *LineSplitter) nextEnd() (int64, bool) {
	if s.hasNext {
		s.hasNext = false
		return s.next, true
	}
	if s.done {
		return 0, false
	}
	end, ok := s.it.Next()
	if !ok {
		s.done = true
		return 0, false
	}
	return end, true
}

// Push feeds decoded UTF-16LE bytes.
func (s *LineSplitter) Push(chunk []byte) error {
	if s.err != nil {
		return s.err
	}
	if len(s.carry) > 0 {
		merged := make([]byte, 0, len(s.carry)+len(chunk))
		merged = append(merged, s.carry...)
		merged = append(merged, chunk...)
		chunk = merged
	}
	cursor := 0
	for {
		end, ok := s.nextEnd()
		if !ok {
			break
		}
		rel := end - s.pos
		if rel > int64(len(chunk)) {
			s.next = end
			s.hasNext = true
			break
		}
		if rel < int64(cursor) {
			rel = int64(cursor)
		}
		line := chunk[cursor:rel]
		if len(line) > s.Stats.MaxLineBytes {
			s.Stats.MaxLineBytes = len(line)
		}
		if err := s.emit(line); err != nil {
			s.err = err
			return err
		}
		cursor = int(rel)
		s.Stats.Lines++
	}
	rest := chunk[cursor:]
	if s.done {
		// nothing in the table refers to this text any more
		s.Stats.TailBytes += int64(len(rest))
		s.carry = s.carry[:0]
	} else {
		s.carry = append(s.carry[:0], rest...)
	}
	s.pos += int64(cursor)
	return nil
}

func (s *LineSplitter) emit(line []byte) error {
	s.line = utf16leToUTF8(s.line[:0], line)
	if s.needSep {
		if _, err := s.sink.Write([]byte{'\n'}); err != nil {
			return err
		}
	}
	s.needSep = true
	_, err := s.sink.Write(s.line)
	return err
}

// Finish reports leftovers and closes the line list.
//
// The reference slices a JS string, so a line range that runs past the end of
// the text is clamped instead of dropped: the remaining bytes complete the
// current line and every following line is empty. Text past the LAST line
// offset, on the other hand, is dropped by the reference as well.
func (s *LineSplitter) Finish() {
	s.Stats.Bytes = s.pos + int64(len(s.carry))
	rest := s.carry
	s.carry = nil
	if s.hasNext {
		s.Stats.Shortfall = s.next - s.Stats.Bytes
		if err := s.emit(rest); err != nil && s.err == nil {
			s.err = err
		}
		s.Stats.Lines++
		s.hasNext = false
		rest = nil
		for {
			if _, ok := s.nextEnd(); !ok {
				break
			}
			if err := s.emit(nil); err != nil && s.err == nil {
				s.err = err
			}
			s.Stats.Lines++
		}
	} else if len(rest) > 0 {
		s.Stats.TailBytes += int64(len(rest))
	}
}
