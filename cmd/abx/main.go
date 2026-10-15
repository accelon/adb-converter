// Command abx exports Accelon3 .adb databases to XML.
//
//	abx export  [options] <file.adb|dir> ...
//	abx inspect <file.adb> ...
//	abx bench   [options] <file.adb> ...
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/accelon/adb-converter/internal/adb"
)

const version = "0.1.0"

type flags struct {
	out         string
	all         bool
	stdout      bool
	jobs        int
	fileJobs    int
	decoder     string
	chunkMiB    int64
	window      int
	noOverwrite bool
	quiet       bool
	jsonOut     bool
	progress    bool
	iters       int
	writeTo     string
	discard     bool
	text        string
	help        bool
	recursive   bool
}

func defaultFlags() flags {
	return flags{decoder: "auto", chunkMiB: 8, progress: true, iters: 3, recursive: true, text: "blockwise"}
}

func parseArgs(args []string) (flags, []string, error) {
	f := defaultFlags()
	var inputs []string
	need := func(i int, name string) (string, error) {
		if i+1 >= len(args) {
			return "", fmt.Errorf("%s needs a value", name)
		}
		return args[i+1], nil
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		key := a
		inline := ""
		hasInline := false
		if strings.HasPrefix(a, "--") {
			if eq := strings.IndexByte(a, '='); eq > 0 {
				key, inline, hasInline = a[:eq], a[eq+1:], true
			}
		}
		value := func(name string) (string, error) {
			if hasInline {
				return inline, nil
			}
			v, err := need(i, name)
			if err != nil {
				return "", err
			}
			i++
			return v, nil
		}
		switch key {
		case "-o", "--out":
			v, err := value(key)
			if err != nil {
				return f, nil, err
			}
			f.out = v
		case "--all":
			f.all = true
		case "--stdout":
			f.stdout = true
		case "-j", "--jobs":
			v, err := value(key)
			if err != nil {
				return f, nil, err
			}
			f.jobs, _ = strconv.Atoi(v)
		case "--file-jobs":
			v, err := value(key)
			if err != nil {
				return f, nil, err
			}
			f.fileJobs, _ = strconv.Atoi(v)
		case "--decoder":
			v, err := value(key)
			if err != nil {
				return f, nil, err
			}
			f.decoder = v
		case "--chunk-mib":
			v, err := value(key)
			if err != nil {
				return f, nil, err
			}
			n, _ := strconv.Atoi(v)
			f.chunkMiB = int64(n)
		case "--window":
			v, err := value(key)
			if err != nil {
				return f, nil, err
			}
			f.window, _ = strconv.Atoi(v)
		case "--no-overwrite":
			f.noOverwrite = true
		case "-q", "--quiet":
			f.quiet = true
		case "--json":
			f.jsonOut = true
		case "--no-progress":
			f.progress = false
		case "--iters":
			v, err := value(key)
			if err != nil {
				return f, nil, err
			}
			f.iters, _ = strconv.Atoi(v)
		case "--write":
			v, err := value(key)
			if err != nil {
				return f, nil, err
			}
			f.writeTo = v
		case "--discard":
			f.discard = true
		case "--text":
			v, err := value(key)
			if err != nil {
				return f, nil, err
			}
			if v != "stream" && v != "blockwise" {
				return f, nil, fmt.Errorf("--text must be stream or blockwise")
			}
			f.text = v
		case "-h", "--help":
			f.help = true
		case "-v", "--version":
			fmt.Println(version)
			os.Exit(0)
		default:
			if strings.HasPrefix(a, "-") {
				return f, nil, fmt.Errorf("unknown option %s", a)
			}
			inputs = append(inputs, a)
		}
	}
	return f, inputs, nil
}

func expandInputs(inputs []string) ([]string, error) {
	var out []string
	var walk func(dir string) error
	walk = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			p := filepath.Join(dir, e.Name())
			if e.IsDir() {
				if err := walk(p); err != nil {
					return err
				}
			} else if strings.EqualFold(filepath.Ext(e.Name()), ".adb") {
				out = append(out, p)
			}
		}
		return nil
	}
	for _, in := range inputs {
		st, err := os.Stat(in)
		if err != nil {
			return nil, fmt.Errorf("no such file or directory: %s", in)
		}
		if st.IsDir() {
			if err := walk(in); err != nil {
				return nil, err
			}
		} else {
			out = append(out, in)
		}
	}
	sort.Strings(out)
	return out, nil
}

func fmtBytes(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1<<20:
		return fmt.Sprintf("%.1f KiB", float64(n)/1024)
	case n < 1<<30:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	default:
		return fmt.Sprintf("%.2f GiB", float64(n)/(1<<30))
	}
}

func usage() {
	fmt.Printf(`abx %s - export Accelon3 .adb databases to XML

usage:
  abx export  [options] <file.adb | directory> ...
  abx inspect <file.adb> ...
  abx bench   [options] <file.adb> ...

export options:
  -o, --out <dir>      output directory (default: next to each input file)
      --all            also extract the resources container
      --stdout         write the XML to stdout (single file output only)
  -j, --jobs <n>       decode goroutines per file (default: %d)
      --file-jobs <n>  files processed in parallel
      --chunk-mib <n>  MiB of compressed data per work chunk (default: 8)
      --window <n>     chunks in flight (default: jobs * 2)
      --no-overwrite   refuse to replace existing output files
  -q, --quiet          no progress, only errors
      --json           machine readable summary on stdout
  -h, --help           this text
`, version, runtime.NumCPU())
}

func openSource(path string) (*os.File, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, st.Size(), nil
}

type fileResult struct {
	res  *adb.ExportResult
	err  error
	path string
}

func cmdExport(args []string) int {
	f, inputs, err := parseArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "abx: %v\n", err)
		return 2
	}
	if f.help || len(inputs) == 0 {
		usage()
		if f.help {
			return 0
		}
		return 2
	}
	files, err := expandInputs(inputs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "abx: %v\n", err)
		return 1
	}
	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "abx: no .adb files found")
		return 1
	}
	var totalIn int64
	for _, p := range files {
		if st, err := os.Stat(p); err == nil {
			totalIn += st.Size()
		}
	}
	cpu := runtime.NumCPU()
	avg := totalIn / int64(len(files))
	jobs := f.jobs
	if jobs <= 0 {
		if totalIn < 8<<20 {
			jobs = 1
		} else {
			jobs = cpu
		}
	}
	fileJobs := f.fileJobs
	if fileJobs <= 0 {
		if len(files) > 1 && avg < 64<<20 {
			fileJobs = cpu
		} else {
			fileJobs = 1
		}
	}
	if fileJobs > len(files) {
		fileJobs = len(files)
	}
	if jobs < 1 {
		jobs = 1
	}
	if fileJobs < 1 {
		fileJobs = 1
	}
	if fileJobs > 1 {
		if share := cpu / fileJobs; share >= 1 && share < jobs {
			jobs = share
		}
	}

	// with --stdout the XML goes to stdout, so all chatter must go to stderr
	sayf := func(format string, a ...any) { fmt.Printf(format, a...) }
	if f.stdout {
		sayf = func(format string, a ...any) { fmt.Fprintf(os.Stderr, format, a...) }
	}

	if !f.quiet && !f.jsonOut {
		sayf("abx %s: %d file(s), %s, %d decode goroutine(s), %d parallel file(s)\n",
			version, len(files), fmtBytes(totalIn), jobs, fileJobs)
	}

	start := time.Now()
	results := make([]fileResult, 0, len(files))
	var mu sync.Mutex
	var wg sync.WaitGroup
	work := make(chan string)
	var failed int
	for w := 0; w < fileJobs; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range work {
				src, size, err := openSource(path)
				if err != nil {
					mu.Lock()
					results = append(results, fileResult{path: path, err: err})
					failed++
					mu.Unlock()
					continue
				}
				outDir := f.out
				if outDir == "" {
					outDir = filepath.Dir(path)
				}
				if !f.stdout && !f.discard {
					if err := os.MkdirAll(outDir, 0o755); err != nil {
						src.Close()
						mu.Lock()
						results = append(results, fileResult{path: path, err: err})
						failed++
						mu.Unlock()
						continue
					}
				}
				res, err := adb.Export(path, src, size, adb.ExportOptions{
					OutDir:      outDir,
					All:         f.all,
					Jobs:        jobs,
					ChunkBytes:  f.chunkMiB << 20,
					Window:      f.window,
					Stdout:      f.stdout,
					Discard:     f.discard,
					StreamText:  f.text == "stream",
					NoOverwrite: f.noOverwrite,
					Progress:    f.progress && !f.quiet && !f.jsonOut,
				})
				src.Close()
				mu.Lock()
				results = append(results, fileResult{res: res, err: err, path: path})
				if err != nil {
					failed++
				}
				mu.Unlock()
				if err != nil {
					fmt.Fprintf(os.Stderr, "  error: %s: %v\n", path, err)
					continue
				}
				if !f.quiet && !f.jsonOut {
					var names []string
					for _, x := range res.XMLFiles {
						names = append(names, fmt.Sprintf("%s (%s)", x.Name, fmtBytes(x.Bytes)))
					}
					for _, x := range res.ResourceFiles {
						names = append(names, fmt.Sprintf("%s (%s)", x.Name, fmtBytes(x.Bytes)))
					}
					secs := res.Duration.Seconds()
					sayf("  %s: %d lines, %s text -> %s in %.2fs [%.1f MiB/s in]\n",
						res.Header.Dbname, res.Lines, fmtBytes(res.TextBytes), strings.Join(names, ", "),
						secs, float64(res.InBytes)/(1<<20)/secs)
				}
				if !f.quiet {
					for _, w := range res.Warnings {
						fmt.Fprintf(os.Stderr, "  warning: %s\n", w)
					}
				}
			}
		}()
	}
	for _, p := range files {
		work <- p
	}
	close(work)
	wg.Wait()

	elapsed := time.Since(start)
	var outBytes, lines int64
	for _, r := range results {
		if r.res == nil {
			continue
		}
		lines += r.res.Lines
		for _, x := range r.res.XMLFiles {
			outBytes += x.Bytes
		}
		for _, x := range r.res.ResourceFiles {
			outBytes += x.Bytes
		}
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	if f.jsonOut {
		type jsonResult struct {
			Path      string   `json:"path"`
			Dbname    string   `json:"dbname,omitempty"`
			Lines     int64    `json:"lines"`
			TextBytes int64    `json:"textBytes"`
			OutBytes  int64    `json:"outBytes"`
			InBytes   int64    `json:"inBytes"`
			Ms        int64    `json:"ms"`
			Files     []string `json:"files,omitempty"`
			Error     string   `json:"error,omitempty"`
		}
		out := struct {
			Version  string       `json:"version"`
			Files    int          `json:"files"`
			Failed   int          `json:"failed"`
			InBytes  int64        `json:"inBytes"`
			OutBytes int64        `json:"outBytes"`
			Lines    int64        `json:"lines"`
			Ms       int64        `json:"ms"`
			Jobs     int          `json:"jobs"`
			FileJobs int          `json:"fileJobs"`
			PeakRSS  uint64       `json:"peakRss"`
			Results  []jsonResult `json:"results"`
		}{Version: version, Files: len(files), Failed: failed, InBytes: totalIn, OutBytes: outBytes,
			Lines: lines, Ms: elapsed.Milliseconds(), Jobs: jobs, FileJobs: fileJobs, PeakRSS: ms.Sys}
		for _, r := range results {
			jr := jsonResult{Path: r.path}
			if r.res != nil {
				jr.Dbname = r.res.Header.Dbname
				jr.Lines = r.res.Lines
				jr.TextBytes = r.res.TextBytes
				jr.InBytes = r.res.InBytes
				jr.Ms = r.res.Duration.Milliseconds()
				for _, x := range r.res.XMLFiles {
					jr.OutBytes += x.Bytes
					jr.Files = append(jr.Files, x.Name)
				}
			}
			if r.err != nil {
				jr.Error = r.err.Error()
			}
			out.Results = append(out.Results, jr)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.Encode(out)
	} else if !f.quiet {
		sayf("total: %d/%d ok, %s in, %s out, %.2fs, %.1f MiB/s, peak mem %s\n",
			len(files)-failed, len(files), fmtBytes(totalIn), fmtBytes(outBytes), elapsed.Seconds(),
			float64(totalIn)/(1<<20)/elapsed.Seconds(), fmtBytes(int64(ms.Sys)))
	}
	if failed > 0 {
		return 1
	}
	return 0
}

func cmdInspect(args []string) int {
	f, inputs, err := parseArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "abx: %v\n", err)
		return 2
	}
	if f.help || len(inputs) == 0 {
		usage()
		return 2
	}
	files, err := expandInputs(inputs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "abx: %v\n", err)
		return 1
	}
	for _, path := range files {
		src, size, err := openSource(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "abx: %v\n", err)
			return 1
		}
		info, err := adb.Inspect(path, src, size)
		src.Close()
		if err != nil {
			fmt.Fprintf(os.Stderr, "abx: %v\n", err)
			return 1
		}
		h := info.Header
		fmt.Printf("%s  (%s)\n", path, fmtBytes(size))
		fmt.Printf("  dbname      %q  dbcname %q\n", h.Dbname, h.Dbcname)
		fmt.Printf("  version %d  compression %d  features %d  protection %d  crc32 %d\n",
			h.Version, h.Compression, h.Features, h.Protection, h.CRC32)
		fmt.Printf("  srcblocksize %d  linecount %d  tagcount %d  maxblockoffset %d  andtagid %d\n",
			h.SrcBlockSize, h.LineCount, h.TagCount, h.MaxBlockOffset, h.AndTagID)
		fmt.Printf("  dbtype %d (dictionary: %v)\n", h.DbType, h.IsDictionary())
		describe := func(label string, bs *adb.BlockSet) {
			if bs == nil {
				return
			}
			kind := "variable"
			if bs.Lengths == nil {
				kind = fmt.Sprintf("fixed(%d)", bs.BlockSize)
			}
			var names []string
			if bs.Feature&0x40000000 != 0 {
				names = append(names, "withpointer")
			}
			if bs.Feature&0x20000000 != 0 {
				names = append(names, "sorted")
			}
			if bs.Feature&0x10000000 != 0 {
				names = append(names, "named")
			}
			names = append(names, []string{"undefined", "hits", "ascii", "unicode", "blocks"}[bs.Feature&7])
			fmt.Printf("  %-10s @%d blocks=%d %s bytes=%d [%s]\n", label, bs.Start, bs.Count, kind, bs.TotalBlockSize, strings.Join(names, ","))
			if len(bs.Names) > 0 {
				fmt.Printf("             names: %s\n", strings.Join(bs.Names, ", "))
			}
		}
		describe("outer", info.Outer)
		describe("sources", info.Sources)
		describe("tables", info.Tables)
		describe("resources", info.Resources)
		if info.LineCount > 0 {
			fmt.Printf("  lines.physical %d entries, last end offset %d bytes (%d chars)\n",
				info.LineCount, info.LineLast, info.LineLast/2)
		}
	}
	return 0
}

func cmdBench(args []string) int {
	f, inputs, err := parseArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "abx: %v\n", err)
		return 2
	}
	if f.help || len(inputs) == 0 {
		usage()
		return 2
	}
	files, err := expandInputs(inputs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "abx: %v\n", err)
		return 1
	}
	cpu := runtime.NumCPU()
	maxJobs := f.jobs
	if maxJobs <= 0 {
		maxJobs = cpu
	}
	candidates := []int{1, maxJobs / 4, maxJobs / 2, maxJobs}
	seen := map[int]bool{}
	var jobList []int
	for _, v := range candidates {
		if v < 1 {
			v = 1
		}
		if !seen[v] {
			seen[v] = true
			jobList = append(jobList, v)
		}
	}
	sort.Ints(jobList)
	fmt.Printf("abx bench: decoder=stdlib chunk=%dMiB iterations=%d\n", f.chunkMiB, f.iters)
	for _, j := range jobList {
		best := time.Duration(1<<62 - 1)
		var bytes int64
		var peak uint64
		for it := 0; it < f.iters; it++ {
			t0 := time.Now()
			for _, path := range files {
				src, size, err := openSource(path)
				if err != nil {
					fmt.Fprintf(os.Stderr, "abx: %v\n", err)
					return 1
				}
				res, err := adb.Export(path, src, size, adb.ExportOptions{
					OutDir:     f.writeTo,
					Jobs:       j,
					ChunkBytes: f.chunkMiB << 20,
					Window:     f.window,
					Discard:    f.writeTo == "",
				})
				src.Close()
				if err != nil {
					fmt.Fprintf(os.Stderr, "abx: %v\n", err)
					return 1
				}
				bytes += res.InBytes
			}
			if d := time.Since(t0); d < best {
				best = d
			}
			var ms runtime.MemStats
			runtime.ReadMemStats(&ms)
			if ms.Sys > peak {
				peak = ms.Sys
			}
		}
		fmt.Printf("  jobs=%3d  best %.1f ms  ->  %.1f MiB/s in  peak mem %s\n",
			j, float64(best.Microseconds())/1000, float64(bytes)/(1<<20)/best.Seconds(), fmtBytes(int64(peak)))
	}
	return 0
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		os.Exit(0)
	}
	code := 0
	switch args[0] {
	case "export":
		code = cmdExport(args[1:])
	case "inspect":
		code = cmdInspect(args[1:])
	case "bench":
		code = cmdBench(args[1:])
	case "version":
		fmt.Println(version)
	case "help", "-h", "--help":
		usage()
	default:
		usage()
		code = 2
	}
	os.Exit(code)
}
