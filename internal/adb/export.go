package adb

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// Info is what `abx inspect` reports.
type Info struct {
	Path      string
	Size      int64
	Header    *Header
	Outer     *BlockSet
	Sources   *BlockSet
	Tables    *BlockSet
	Resources *BlockSet
	LineCount int
	LineLast  int64
}

// Inspect reads everything except the bulk text blocks.
func Inspect(path string, src Source, size int64) (*Info, error) {
	raw, err := ReadAt(src, 0, FileHeaderSize)
	if err != nil {
		return nil, err
	}
	h, ok := ParseHeader(raw)
	if !ok {
		return nil, fmt.Errorf("%s: not an Accelon3 .adb file (bad signature)", path)
	}
	outer, err := ParseBlockSet(src, FileHeaderSize)
	if err != nil {
		return nil, err
	}
	info := &Info{Path: path, Size: size, Header: h, Outer: outer}
	if off := outer.OffsetByName("source"); off != 0 {
		if info.Sources, err = ParseBlockSet(src, off); err != nil {
			return nil, err
		}
	}
	if off := outer.OffsetByName("tables"); off != 0 {
		if info.Tables, err = ParseBlockSet(src, off); err != nil {
			return nil, err
		}
	}
	if off := outer.OffsetByName("resources"); off != 0 {
		if info.Resources, err = ParseBlockSet(src, off); err != nil {
			return nil, err
		}
	}
	if info.Tables != nil {
		if at := info.Tables.OffsetByName("lines.physical"); at != 0 {
			it, err := NewPackedIterator(src, at)
			if err != nil {
				return nil, err
			}
			for {
				v, ok := it.Next()
				if !ok {
					break
				}
				info.LineCount++
				info.LineLast = v
			}
			if it.Err != nil {
				return nil, it.Err
			}
		}
	}
	return info, nil
}

// ExportOptions configures an export run.
type ExportOptions struct {
	OutDir      string
	All         bool
	Jobs        int
	ChunkBytes  int64
	Window      int
	Stdout      bool
	Discard     bool
	NoOverwrite bool
	Progress    bool
	// StreamText decodes the source blocks as one continuous UTF-16 stream, so
	// a surrogate pair straddling a block boundary survives. Default (false)
	// reproduces the reference decoder, which decodes each block separately and
	// therefore turns such a pair into two U+FFFD.
	StreamText bool
	Logf       func(format string, args ...any)
}

// ExportResult summarises one exported database.
type ExportResult struct {
	Path          string
	Header        *Header
	XMLFiles      []OutputFile
	ResourceFiles []OutputFile
	InBytes       int64
	SourceBytes   int64
	TextBytes     int64
	OutBytes      int64
	Lines         int64
	Blocks        int
	Chunks        int
	Workers       int
	Duration      time.Duration
	Warnings      []string
}

type chunk struct {
	first, last int
	start, end  int64
	ends        []int
}

func planChunks(bs *BlockSet, count int, target int64) []chunk {
	if count == 0 {
		return nil
	}
	var out []chunk
	for i := 0; i < count; {
		start, _ := bs.BlockRange(i)
		end := start
		j := i
		for j < count {
			_, e := bs.BlockRange(j)
			end = e
			j++
			if end-start >= target {
				break
			}
		}
		c := chunk{first: i, last: j - 1, start: start, end: end}
		prev := start
		for k := i; k <= c.last; k++ {
			_, e := bs.BlockRange(k)
			c.ends = append(c.ends, int(e-start))
			prev = e
		}
		_ = prev
		out = append(out, c)
		i = j
	}
	return out
}

// patchBlockEdges reproduces a quirk of the reference decoder: it decodes every
// source block on its own, so a UTF-16 surrogate pair that straddles a 16 KiB
// block boundary is seen as two lone surrogates and becomes two U+FFFD. The
// substitution is 2 bytes for 2 bytes.
//
// With StreamText the patch is skipped and such a pair survives. The leading
// BOM drop of a block is always applied, because it is not text.
func patchBlockEdges(buf []byte, hasPrev, hasNext bool) {
	if len(buf) < 2 {
		return
	}
	if hasPrev {
		if u := uint16(buf[0]) | uint16(buf[1])<<8; u >= 0xDC00 && u < 0xE000 {
			buf[0], buf[1] = 0xFD, 0xFF
		}
	}
	if hasNext {
		i := len(buf) - 2
		if u := uint16(buf[i]) | uint16(buf[i+1])<<8; u >= 0xD800 && u < 0xDC00 {
			buf[i], buf[i+1] = 0xFD, 0xFF
		}
	}
}

type decodeWorker struct {
	scratch []byte
}

// decodeInto decodes every block of a chunk into buf (reused from the pool).
// The returned slice may be a larger backing array; ownership passes to the
// caller, which must put it back into outPool once it is done with the bytes.
//
// firstBlock is the global index of the chunk's first block and blockCount the
// total number of blocks of the file, needed for the block edge patch.
func (w *decodeWorker) decodeInto(buf []byte, src []byte, ends []int, hint, firstBlock, blockCount int, streamText bool) ([]byte, error) {
	if hint < 1<<16 {
		hint = 1 << 16
	}
	if cap(w.scratch) < hint {
		w.scratch = make([]byte, hint)
	}
	if cap(buf) < len(ends)*hint {
		buf = make([]byte, 0, len(ends)*hint)
	}
	out := buf[:0]
	prev := 0
	for bi, e := range ends {
		blk := src[prev:e]
		prev = e
		w.scratch = w.scratch[:cap(w.scratch)]
		n, err := decodeBzip2Block(blk, w.scratch)
		for err == errTooSmall {
			w.scratch = make([]byte, len(w.scratch)*2)
			n, err = decodeBzip2Block(blk, w.scratch)
		}
		if err != nil {
			return out, err
		}
		// reference parity: a leading U+FEFF of a block is swallowed by the
		// reference's per block TextDecoder and is not text
		start := 0
		if n >= 2 && w.scratch[0] == 0xFF && w.scratch[1] == 0xFE {
			start = 2
		}
		if !streamText {
			idx := firstBlock + bi
			patchBlockEdges(w.scratch[start:n], idx > 0, idx < blockCount-1)
		}
		out = append(out, w.scratch[start:n]...)
	}
	return out, nil
}

type decodeResult struct {
	out  []byte
	err  error
	pool *[]byte
}

// Decoded chunk buffers are handed to the writer and returned here, so a long
// run does not allocate a fresh multi MiB buffer for every chunk.
var outPool = sync.Pool{New: func() any { b := make([]byte, 0, 1<<20); return &b }}

// Export decodes one .adb file into XML (and optionally its resources).
//
// Chunks of compressed source blocks are decoded by a pool of goroutines and
// consumed strictly in file order, so peak memory stays at roughly
// Window * chunk size regardless of how large the database is.
func Export(path string, src Source, size int64, opts ExportOptions) (*ExportResult, error) {
	start := time.Now()
	logf := opts.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	var warnings []string

	raw, err := ReadAt(src, 0, FileHeaderSize)
	if err != nil {
		return nil, err
	}
	h, ok := ParseHeader(raw)
	if !ok {
		return nil, fmt.Errorf("%s: not an Accelon3 .adb file (bad signature)", path)
	}
	if h.Compression != 1 {
		warnings = append(warnings, fmt.Sprintf("compression flag is %d (expected 1 = bzip2 blocks)", h.Compression))
	}
	outer, err := ParseBlockSet(src, FileHeaderSize)
	if err != nil {
		return nil, err
	}
	sourceOff := outer.OffsetByName("source")
	if sourceOff == 0 {
		return nil, fmt.Errorf("%s: no 'source' block in the top level container", path)
	}
	sources, err := ParseBlockSet(src, sourceOff)
	if err != nil {
		return nil, err
	}
	blocks := sources.BlockCount()

	var linesAt int64
	lineCount := int(0)
	if tablesOff := outer.OffsetByName("tables"); tablesOff != 0 {
		tables, err := ParseBlockSet(src, tablesOff)
		if err != nil {
			return nil, err
		}
		if linesAt = tables.OffsetByName("lines.physical"); linesAt == 0 {
			warnings = append(warnings, "tables container has no 'lines.physical' block")
		}
	} else {
		warnings = append(warnings, "no 'tables' container: cannot split lines")
	}

	// framing sanity check before spawning workers
	if blocks > 0 {
		first, _ := sources.BlockRange(0)
		magic, err := ReadAt(src, first, 3)
		if err != nil {
			return nil, err
		}
		if string(magic) != "BZh" {
			warnings = append(warnings, fmt.Sprintf("first source block does not start with the bzip2 magic (got %q)", magic))
		}
	}

	jobs := opts.Jobs
	if jobs <= 0 {
		jobs = runtime.NumCPU()
	}
	chunkBytes := opts.ChunkBytes
	if chunkBytes <= 0 {
		chunkBytes = 8 << 20
	}
	var sourceSpan int64
	if blocks > 0 {
		s, _ := sources.BlockRange(0)
		_, e := sources.BlockRange(blocks - 1)
		sourceSpan = e - s
	}
	target := chunkBytes
	if share := sourceSpan / int64(jobs*2); share > 0 && share < target {
		target = share
	}
	if target < 1 {
		target = 1
	}
	chunks := planChunks(sources, blocks, target)

	var it *PackedIterator
	if linesAt != 0 {
		if it, err = NewPackedIterator(src, linesAt); err != nil {
			return nil, err
		}
	}
	writer := NewXmlWriter(XmlWriterOptions{
		OutDir:      opts.OutDir,
		Dbname:      h.Dbname,
		Stdout:      opts.Stdout,
		NoOverwrite: opts.NoOverwrite,
		Discard:     opts.Discard,
	})
	splitter := NewLineSplitter(it, writer)

	n := len(chunks)
	results := make([]chan decodeResult, n)
	for i := range results {
		results[i] = make(chan decodeResult, 1)
	}
	window := opts.Window
	if window <= 0 {
		window = jobs * 2
	}
	if window < 2 {
		window = 2
	}
	if window > n && n > 0 {
		window = n
	}
	sem := make(chan struct{}, window)
	type work struct {
		idx   int
		first int
		src   []byte
		ends  []int
	}
	jobsCh := make(chan work)
	var wg sync.WaitGroup
	for w := 0; w < jobs; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			worker := &decodeWorker{}
			for j := range jobsCh {
				bufp := outPool.Get().(*[]byte)
				out, err := worker.decodeInto(*bufp, j.src, j.ends, int(h.SrcBlockSize), j.first, blocks, opts.StreamText)
				*bufp = out
				if err != nil {
					outPool.Put(bufp)
					out = nil
				}
				results[j.idx] <- decodeResult{out: out, err: err, pool: bufp}
			}
		}()
	}
	feedErr := make(chan error, 1)
	go func() {
		defer close(jobsCh)
		for i := range chunks {
			sem <- struct{}{}
			c := chunks[i]
			buf, err := ReadAt(src, c.start, int(c.end-c.start))
			if err != nil {
				feedErr <- err
				return
			}
			jobsCh <- work{idx: i, first: c.first, src: buf, ends: c.ends}
		}
	}()

	var consumedBytes int64
	lastReport := time.Now()
	for i := range chunks {
		res := <-results[i]
		if res.err != nil {
			<-sem
			return nil, fmt.Errorf("%s: block %d..%d: %w", path, chunks[i].first, chunks[i].last, res.err)
		}
		err := splitter.Push(res.out)
		if res.pool != nil {
			outPool.Put(res.pool)
		}
		if err != nil {
			<-sem
			return nil, err
		}
		consumedBytes += chunks[i].end - chunks[i].start
		<-sem
		if opts.Progress && time.Since(lastReport) > 500*time.Millisecond {
			lastReport = time.Now()
			pct := 100.0
			if sourceSpan > 0 {
				pct = float64(consumedBytes) * 100 / float64(sourceSpan)
			}
			fmt.Fprintf(os.Stderr, "\r  %s: %.1f%% (%.0f/%.0f MiB source)",
				filepath.Base(path), pct, float64(consumedBytes)/1048576, float64(sourceSpan)/1048576)
		}
	}
	if opts.Progress {
		fmt.Fprintln(os.Stderr)
	}
	select {
	case err := <-feedErr:
		if err != nil {
			return nil, err
		}
	default:
	}
	wg.Wait()
	splitter.Finish()
	xmlFiles, outBytes, err := writer.Finish()
	if err != nil {
		return nil, err
	}
	if splitter.Stats.TailBytes > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"%d bytes of decoded text past the last line offset were dropped (same as the reference exporter)",
			splitter.Stats.TailBytes))
	}

	var resourceFiles []OutputFile
	if opts.All && !opts.Discard {
		if opts.Stdout {
			return nil, fmt.Errorf("--stdout cannot be combined with --all (multiple outputs)")
		}
		if resourcesOff := outer.OffsetByName("resources"); resourcesOff != 0 {
			resources, err := ParseBlockSet(src, resourcesOff)
			if err != nil {
				return nil, err
			}
			used := map[string]bool{}
			for i := 0; i < resources.BlockCount(); i++ {
				begin, end := resources.BlockRange(i)
				name := ""
				if i < len(resources.Names) && resources.Names[i] != "" {
					name = sanitizeName(resources.Names[i])
				} else {
					name = fmt.Sprintf("resource-%04d.bin", i)
				}
				for used[name] {
					if dot := filepath.Ext(name); dot != "" {
						name = name[:len(name)-len(dot)] + "~1" + dot
					} else {
						name += "~1"
					}
				}
				used[name] = true
				buf, err := ReadAt(src, begin, int(end-begin))
				if err != nil {
					return nil, err
				}
				if err := os.WriteFile(filepath.Join(opts.OutDir, name), buf, 0o644); err != nil {
					return nil, err
				}
				resourceFiles = append(resourceFiles, OutputFile{Name: name, Bytes: int64(len(buf))})
			}
			if len(resources.Names) == 0 && resources.BlockCount() > 0 {
				warnings = append(warnings, "resources container has no name table, files were named resource-####.bin")
			}
		}
	}

	_ = lineCount
	res := &ExportResult{
		Path:          path,
		Header:        h,
		XMLFiles:      xmlFiles,
		ResourceFiles: resourceFiles,
		InBytes:       size,
		SourceBytes:   sourceSpan,
		TextBytes:     splitter.Stats.Bytes,
		OutBytes:      outBytes,
		Lines:         splitter.Stats.Lines,
		Blocks:        blocks,
		Chunks:        len(chunks),
		Workers:       jobs,
		Duration:      time.Since(start),
		Warnings:      warnings,
	}
	logf("  decoded %d blocks in %d chunks with %d worker(s)", blocks, len(chunks), jobs)
	return res, nil
}
