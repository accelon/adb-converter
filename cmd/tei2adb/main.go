// tei2adb: CBETA TEI P5 (T 藏) → Accelon3 adb 文字（一行一個 pcl 行，標記內嵌）。
//
// 用法：
//
//	go run ./cmd/tei2adb -tei D:\2023\sat2018\T -vol 1 -out build\tei-T01.txt
//	go run ./cmd/tei2adb -tei D:\2023\sat2018\T -vol 1-85 -out build\tei-all.txt
//	go run ./cmd/tei2adb -tei E:\3rd\XML\X -canon X -vol 1-88 -out build\wxzj-tei.txt
//
// 標記沿用舊 taisho.adb：檔／冊／段／書／頁／卷／序／經／品／分／會／其他。
// 校勘：取 <app><lem> 的文字（＝CBETA 採用的讀法），<note>/<rdg> 一律丟棄。
// 缺字：<g ref="#CB00178"/> → 優先換成 teiHeader/charDecl 的 Unicode（<mapping type="unicode">）；
// 沒有 Unicode 對應的才留 "&CB00178;" 並記進缺字表（作者 2026-10-31）。
package main

import (
	"bufio"
	"encoding/xml"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 舊 taisho.adb 的檔頭（7 棵樹的宣告照抄；只有來源說明改成 2025 版）。
const fileHeader = `<檔 n="taisho.xml"><集 c="hidden">大正新脩大藏經</集><英文名>Taisho Tripitaka</英文名>本資料庫內容來自CBETA {{RELEASE}} 版 TEI XML，並為中華電子佛典協會授權非營利使用。最新資料請到<聯 l="http://www.cbeta.org">www.cbeta.org</聯><隱><樹 s="*" l="序,分,跋,會,其他,附文,經,other,xu" t="冊,書,品." pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;-">經目</樹></隱><隱><樹 s="$書" pf="$頁.id;)" sf="-$書.id;">書名</樹><樹 s="*書" pf="$頁.id;)" sf="-$書.id;">分書頻次</樹></隱><隱><樹 s="*" t="冊,卷." pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;">分卷</樹></隱><隱><樹 s="*卷" pf="$頁.id;)" sf="-$書.id;">分卷頻次</樹></隱><隱><樹 s="~00602000">西文</樹></隱><隱><樹 s="%"t="冊,書" pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;-">反連結</樹></隱><隱><引>《$書;》：「$_;」( 大正 $*頁; )</引><摘要頭>$書;($頁;)</摘要頭></隱></檔>`

// 舊 wxzj.adb 的檔頭；來源改成 2025 TEI，樹／引文格式沿用。
const xHeader = `<檔 n="wxzj.xml"><集 c="hidden">卍新纂續藏經</集><英文名>Wanzi Xuzangjing</英文名>本資料庫內容來自CBETA {{RELEASE}} 版 TEI XML，並為中華電子佛典協會授權非營利使用。最新資料請到<聯 l="http://www.cbeta.org">www.cbeta.org</聯><隱><樹 s="*" l="序,分,跋,會,其他,附文,經,other,xu,科判" t="冊,書,品." pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;-">經目</樹></隱><隱><樹 s="$書" pf="$頁.id;)" sf="-$書.id;">書名</樹><樹 s="*書" pf="$頁.id;)" sf="-$書.id;">分書頻次</樹></隱><隱><樹 s="*" t="冊,卷." pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;">分卷</樹></隱><隱><樹 s="*卷" pf="$頁.id;)" sf="-$書.id;">分卷頻次</樹></隱><隱><樹 s="~00602000">西文</樹></隱><隱><樹 s="%" t="冊,書" pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;-">反連結</樹></隱><隱><引>《$書;》：「$_;」( 卍新續 $*頁; )</引><摘要頭>$書;($頁;)</摘要頭></隱></檔>`

// 舊 taisho.adb 的 56 個冊名（1–55、85）。
var oldVolTitles = map[int]string{
	1: "阿含部上", 2: "阿含部下", 3: "本緣部上", 4: "本緣部下", 5: "般若部一", 6: "般若部二",
	7: "般若部三", 8: "般若部四", 9: "法華部全,華嚴部上", 10: "華嚴部", 11: "寶積部上", 12: "寶積部下,涅槃部全",
	13: "大集部全", 14: "經集部一", 15: "經集部二", 16: "經集部三", 17: "經集部四", 18: "密教部一",
	19: "密教部二", 20: "密教部三", 21: "密教部四", 22: "律部一", 23: "律部二", 24: "律部三",
	25: "釋經論部上", 26: "釋經論部下,毘曇部一", 27: "毘曇部二", 28: "毘曇部三", 29: "毘曇部四", 30: "中觀部全,瑜伽部上",
	31: "瑜伽部下", 32: "論集部全", 33: "經疏部一", 34: "經疏部二", 35: "經疏部三", 36: "經疏部四",
	37: "經疏部五", 38: "經疏部六", 39: "經疏部七", 40: "律疏部全,論疏部一", 41: "論疏部二", 42: "論疏部三",
	43: "論疏部四", 44: "論疏部五,諸宗部一", 45: "諸宗部二", 46: "諸宗部三", 47: "諸宗部四", 48: "諸宗部五",
	49: "史傳部一", 50: "史傳部二", 51: "史傳部三", 52: "史傳部四", 53: "事彙部上", 54: "事彙部下,外教部全",
	55: "目錄部全", 85: "古逸部全,疑似部全",
}

// 56–84 冊依經號分部（作者提供）。
var partRanges = []struct {
	from, to int
	name     string
}{{2185, 2245, "續經疏部"},
	{2246, 2247, "續律疏部"},
	{2248, 2295, "續論疏部"},
	{2296, 2700, "續諸宗部"},
	{2701, 2731, "悉曇部"},
	{2732, 2920, "古逸部"},
}

func cnNum(n int) string {
	digits := []string{"〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"}
	switch {
	case n < 10:
		return digits[n]
	case n < 20:
		if n == 10 {
			return "十"
		}
		return "十" + digits[n%10]
	case n < 100:
		s := digits[n/10] + "十"
		if n%10 != 0 {
			s += digits[n%10]
		}
		return s
	}
	return strconv.Itoa(n)
}

// 舊 wxzj.adb 的 86 個冊名；X06、X52 在來源沒有檔。
func xVolTitle(v int) string {
	switch v {
	case 1:
		return "x01.經部、律部"
	case 2:
		return "x02.論集部、密經儀軌部"
	case 74:
		return "x74.禮懺部"
	}
	switch {
	case v >= 3 && v <= 37:
		return fmt.Sprintf("x%02d.大小乘釋經部%s", v, cnNum(v-2))
	case v >= 38 && v <= 44:
		return fmt.Sprintf("x%02d.大小乘釋律部%s", v, cnNum(v-37))
	case v >= 45 && v <= 51:
		return fmt.Sprintf("x%02d.大小乘釋論部%s", v, cnNum(v-44))
	case v == 53:
		return "x53.大小乘釋論部九"
	case v >= 54 && v <= 73:
		return fmt.Sprintf("x%02d.諸宗著述部%s", v, cnNum(v-53))
	case v >= 75 && v <= 88:
		return fmt.Sprintf("x%02d.史傳部%s", v, cnNum(v-74))
	}
	return fmt.Sprintf("x%02d", v)
}

type emitter struct {
	out         *bufio.Writer
	canon       string
	line        strings.Builder
	head        strings.Builder
	nHead       bool
	tag         string // 目前 <head> 要用的標題名
	juanClose   bool
	sawPB       bool
	pendingPage string
	skipKind    string
	lastPageCol string
	skip        int
	vol         int
	page        string
	book        int
	seq         int
	stats       map[string]int
	seenPages   map[string]bool
	count       int
	// 缺字：teiHeader/charDecl 的 charmap（CB 碼 → Unicode 字；見 docs/adb/taisho-steps.md）
	gaiji     map[string]rune
	// 沒有 unicode 只有 PUA 的缺字（沿用舊版行為，避免重建後多出 &CB…; 實體）
	gaijiPUA  map[string]rune
	// PUA 梵字 → 悉曇 Unicode 序列（-sanskrit-seq；有給才用）
	seqMap       map[rune]string
	curChar   string
	uniBuf    strings.Builder
	inUnicode bool
	inPUA     bool
	missing   map[string]int
	gStack    []string
	gText     []bool
	gInner    []strings.Builder
}

func (e *emitter) flush() {
	s := e.line.String()
	if s != "" {
		e.out.WriteString(s)
		e.out.WriteByte('\n')
		e.stats["lines"]++
		e.count++
	}
	e.line.Reset()
}

func (e *emitter) emit(s string) {
	e.line.WriteString(s)
}

func (e *emitter) emitTag(tag, text string) {
	if text == "" {
		return
	}
	e.emit("<" + tag + ">" + text + "</" + tag + ">")
	e.stats[tag]++
}

func (e *emitter) emitPage(id string) {
	if id == "" || e.seenPages[id] {
		return
	}
	e.seenPages[id] = true
	e.emit(`<頁 id="` + id + `"/>`)
	e.stats["頁"]++
}

func pageID(vol int, n string) string {
	n = strings.TrimSpace(n)
	if n == "" {
		return ""
	}
	col := ""
	last := n[len(n)-1]
	if last >= 'a' && last <= 'g' || last >= 'A' && last <= 'G' {
		col = strings.ToLower(string(last))
		n = n[:len(n)-1]
	}
	page := strings.TrimLeft(n, "0")
	if page == "" {
		page = "0"
	}
	if col == "" {
		return fmt.Sprintf("%dp%s", vol, page)
	}
	return fmt.Sprintf("%dp%s%s", vol, page, col)
}

func textOf(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, "\t", "")
	return s
}

func escapeText(s string) string {
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

// isPUA：Unicode 私人使用區（BMP PUA、第 15／16 平面）。CBETA 的缺字與梵字都用這些碼位。
func isPUA(r rune) bool {
	return (r >= 0xE000 && r <= 0xF8FF) || (r >= 0xF0000 && r <= 0x10FFFD)
}

// sanskritPUA：CBETA 梵字碼 → Unicode 私用區（SD-XXXX → U+FA000+XXXX；
// RJ-XXXX → U+100000+XXXX；規則與 cbeta_sanskrit.csv 的 pua 欄相同）。
func sanskritPUA(ref string) (rune, bool) {
	i := strings.IndexByte(ref, '-')
	if i <= 0 {
		return 0, false
	}
	var base rune
	switch ref[:i] {
	case "SD":
		base = 0xFA000
	case "RJ":
		base = 0x100000
	default:
		return 0, false
	}
	n, err := strconv.ParseInt(ref[i+1:], 16, 32)
	if err != nil || n < 0 {
		return 0, false
	}
	r := base + rune(n)
	if r > 0x10FFFD {
		return 0, false
	}
	return r, true
}

func main() {
	tei := flag.String("tei", `D:\2023\sat2018\T`, "TEI 根目錄（多個用 ; 分隔；同一冊取第一個找得到的）")
	vols := flag.String("vol", "1", "冊範圍，如 1 或 1-85")
	nos := flag.String("no", "", "只輸出指定經號（逗號分隔，如 235,1698,1510a）")
	linesPath := flag.String("lines", "", "輸出「卷起始行」TSV（sutra/juan/line）")
	pclPath := flag.String("pcl", "", "輸出「每一行的 pcl」TSV（line/vol/page/col/line）")
	out := flag.String("out", "build/tei.txt", "輸出文字檔")
	canon := flag.String("canon", "T", "藏別：T（大正藏）或 X（卍續藏）")
	release := flag.String("release", "2026.R2", "CBETA 版本字串（寫進檔頭的來源說明）")
	seqPath := flag.String("sanskrit-seq", "", "PUA → 悉曇 Unicode 序列的 TSV（pua,id,romanized,seq,note）；有給就輸出序列")
	flag.Parse()
	canonValue := strings.ToUpper(strings.TrimSpace(*canon))

	lo, hi := parseRange(*vols)
	only := map[string]bool{}
	for _, s := range strings.Split(*nos, ",") {
		if s = strings.TrimSpace(strings.ToLower(s)); s != "" {
			only[normSutraKey(s)] = true
		}
	}
	f, err := os.Create(*out)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	w := bufio.NewWriterSize(f, 1<<20)
	defer w.Flush()

	var linesOut *bufio.Writer
	if *linesPath != "" {
		lf, err := os.Create(*linesPath)
		if err != nil {
			panic(err)
		}
		defer lf.Close()
		linesOut = bufio.NewWriterSize(lf, 1<<16)
		defer linesOut.Flush()
	}

	var pclOut *bufio.Writer
	if *pclPath != "" {
		pf, err := os.Create(*pclPath)
		if err != nil {
			panic(err)
		}
		defer pf.Close()
		pclOut = bufio.NewWriterSize(pf, 1<<16)
		defer pclOut.Flush()
	}

	seqMap := map[rune]string{}
	if *seqPath != "" {
		seqMap = loadSeqMap(*seqPath)
	}

	e := &emitter{out: w, canon: canonValue, stats: map[string]int{}, seenPages: map[string]bool{},
		gaiji: map[string]rune{}, gaijiPUA: map[string]rune{}, missing: map[string]int{}, seqMap: seqMap}
	if canonValue == "X" {
		e.emit(strings.ReplaceAll(xHeader, "{{RELEASE}}", *release))
	} else {
		e.emit(strings.ReplaceAll(fileHeader, "{{RELEASE}}", *release))
	}
	e.flush()
	_ = linesOut

	bookSeq := 0
	for v := lo; v <= hi; v++ {
		// 一個冊可能在多個來源裡（CBETA XML-P5 的 T 藏沒有 56–84 冊，那些在 SAT2018）。
		// 依 -tei 的順序找第一個存在的 <root>/<canon><vol>。
		dir := ""
		for _, root := range strings.Split(*tei, ";") {
			cand := filepath.Join(strings.TrimSpace(root), fmt.Sprintf("%s%02d", canonValue, v))
			if st, err := os.Stat(cand); err == nil && st.IsDir() {
				dir = cand
				break
			}
		}
		if dir == "" {
			fmt.Fprintf(os.Stderr, "skip %s%02d: 所有 -tei 根目錄都沒有這一冊\n", canonValue, v)
			continue
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "skip %s: %v\n", dir, err)
			continue
		}
		var files []string
		for _, en := range ents {
			if strings.HasSuffix(en.Name(), ".xml") {
				files = append(files, en.Name())
			}
		}
		sort.Strings(files)
		if len(only) > 0 {
			keep := files[:0]
			for _, name := range files {
				if only[normSutraKey(sutraKey(name))] {
					keep = append(keep, name)
				}
			}
			files = keep
		}
		if len(files) == 0 {
			continue
		}
		e.vol = v
		title := volTitle(v, files, canonValue)
		e.emit(fmt.Sprintf(`<冊 id="%d">%s</冊>`, v, title))
		e.stats["冊"]++
		e.flush()

		prevSutra := ""
		for _, name := range files {
			path := filepath.Join(dir, name)
			sutra := name
			if i := strings.Index(sutra, "_"); i > 0 {
				sutra = sutra[:i]
			}
			if len(only) > 0 && !only[normSutraKey(sutraKey(name))] {
				continue
			}
			if sutra != prevSutra {
				prevSutra = sutra
				bookSeq++
				bookTitle := sutraTitle(path)
				e.emit("<段/>")
				e.emit(fmt.Sprintf(`<書 id="n%d">%s</書>`, bookSeq, bookTitle))
				e.stats["書"]++
				e.stats["段"]++
			}
			linesOut = e.parseFile(path, fmt.Sprintf("%04d", sutraNo(name)), juanOf(name), linesOut, pclOut)
		}
	}
	e.flush()
	if err := w.Flush(); err != nil {
		panic(err)
	}
	fmt.Fprintf(os.Stderr, "lines=%d", e.stats["lines"])
	for _, k := range []string{"冊", "書", "卷", "序", "經", "品", "分", "會", "其他", "附文", "科判"} {
		fmt.Fprintf(os.Stderr, " %s=%d", k, e.stats[k])
	}
	fmt.Fprintln(os.Stderr)
	writeMissingGaiji(filepath.Join(filepath.Dir(*out), missingGaijiName(canonValue)), e.missing)
	fmt.Fprintf(os.Stderr, "gaiji=%d missing=%d\n", len(e.gaiji), len(e.missing))
}

// takeUnicode：把 <mapping type="unicode">U+XXXX</mapping> 收進 gaiji 表
func (e *emitter) takeUnicode() {
	e.inUnicode = false
	code := strings.TrimSpace(e.uniBuf.String())
	e.uniBuf.Reset()
	if e.curChar == "" || !strings.HasPrefix(code, "U+") {
		return
	}
	v, err := strconv.ParseInt(code[2:], 16, 32)
	if err != nil || v < 0 || v > 0x10FFFF {
		return
	}
	e.gaiji[e.curChar] = rune(v)
}

// takePUA：把 <mapping type="PUA">U+F1115</mapping> 收進 PUA 表。
// CBETA 有些缺字只有 PUA（原字型的私用碼），沒有 unicode；舊版直接留 PUA 字元，
// 新版沿用同樣行為，避免重建後把 6,000 多個字變成 &CB…; 實體。
func (e *emitter) takePUA() {
	e.inPUA = false
	code := strings.TrimSpace(e.uniBuf.String())
	e.uniBuf.Reset()
	if e.curChar == "" || !strings.HasPrefix(code, "U+") {
		return
	}
	v, err := strconv.ParseInt(code[2:], 16, 32)
	if err != nil || v < 0 || v > 0x10FFFF {
		return
	}
	e.gaijiPUA[e.curChar] = rune(v)
}

// loadSeqMap：讀 `pua,id,romanized,seq,note` 的 TSV；只收 seq 非空的列。
func loadSeqMap(path string) map[rune]string {
	data, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	out := map[rune]string{}
	for i, line := range strings.Split(string(data), "\n") {
		if i == 0 || strings.TrimSpace(line) == "" {
			continue
		}
		cols := strings.Split(line, "\t")
		if len(cols) < 4 {
			continue
		}
		code := strings.TrimPrefix(strings.TrimSpace(cols[0]), "U+")
		v, err := strconv.ParseInt(code, 16, 32)
		if err != nil {
			continue
		}
		seq := cols[3]
		if seq == "" {
			continue
		}
		out[rune(v)] = seq
	}
	return out
}

// missingGaijiName：缺字表的檔名（T 藏／X 藏分開，免得 wxzj 覆蓋 taisho 的清單）。
func missingGaijiName(canon string) string {
	if canon == "X" {
		return "wxzj-missing-gaiji.tsv"
	}
	return "taisho-missing-gaiji.tsv"
}

// writeMissingGaiji：沒有 Unicode 對應的缺字（保留 &CB…; 佔位）寫成 TSV 給作者補表
func writeMissingGaiji(path string, missing map[string]int) {
	codes := make([]string, 0, len(missing))
	for c := range missing {
		codes = append(codes, c)
	}
	sort.Strings(codes)
	var b strings.Builder
	b.WriteString("code\tcount\n")
	for _, c := range codes {
		fmt.Fprintf(&b, "%s\t%d\n", c, missing[c])
	}
	_ = os.WriteFile(path, []byte(b.String()), 0o644)
}

func parseRange(s string) (int, int) {
	if i := strings.Index(s, "-"); i > 0 {
		a, _ := strconv.Atoi(s[:i])
		b, _ := strconv.Atoi(s[i+1:])
		return a, b
	}
	n, _ := strconv.Atoi(s)
	return n, n
}

func volTitle(v int, files []string, canon string) string {
	if canon == "X" {
		return xVolTitle(v)
	}
	if t, ok := oldVolTitles[v]; ok {
		return t
	}
	seen := map[string]bool{}
	var names []string
	for _, f := range files {
		no := sutraNo(f)
		for _, r := range partRanges {
			if no >= r.from && no <= r.to && !seen[r.name] {
				seen[r.name] = true
				names = append(names, r.name)
			}
		}
	}
	if len(names) == 0 {
		return "續藏"
	}
	return strings.Join(names, ",")
}

// sutraKey：T08n0235_001.xml → "0235"；T25n1510a_001.xml → "1510a"
func sutraKey(file string) string {
	base := file
	if i := strings.Index(base, "_"); i > 0 {
		base = base[:i]
	}
	if i := strings.Index(base, "n"); i >= 0 {
		return strings.ToLower(base[i+1:])
	}
	return ""
}

// normSutraKey：去掉前導零，"0235" → "235"、"01510a" → "1510a"
func normSutraKey(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	i := 0
	for i < len(s)-1 && s[i] == '0' {
		i++
	}
	return s[i:]
}

func sutraNo(file string) int {
	base := file
	if i := strings.LastIndex(base, "_"); i > 0 {
		base = base[:i]
	}
	i := strings.Index(base, "n")
	if i < 0 {
		return 0
	}
	rest := base[i+1:]
	j := 0
	for j < len(rest) && rest[j] >= '0' && rest[j] <= '9' {
		j++
	}
	n, _ := strconv.Atoi(rest[:j])
	return n
}

// juanOf：T56n2185_012.xml → 12
func juanOf(file string) int {
	base := strings.TrimSuffix(file, ".xml")
	i := strings.LastIndex(base, "_")
	if i < 0 {
		return 1
	}
	n, _ := strconv.Atoi(base[i+1:])
	if n < 1 {
		return 1
	}
	return n
}
func sutraTitle(path string) string {
	b, _ := os.ReadFile(path)
	head := string(b)
	if len(head) > 8192 {
		head = head[:8192]
	}
	const key = `<title level="m" xml:lang="zh-Hant">`
	i := strings.Index(head, key)
	if i >= 0 {
		rest := head[i+len(key):]
		if j := strings.Index(rest, "</title>"); j >= 0 {
			return resolveGaijiText(cleanTitle(rest[:j]), path)
		}
	}
	// 56–84 冊的檔頭只有「大正新脩大藏經數位版, No. N 題名」，沒有 level="m"。
	// 少了這段，541 部書的 <書> 題名會是空的（目錄整批空白）。
	i = strings.Index(head, `<title xml:lang="zh-Hant">`)
	if i >= 0 {
		rest := head[i+len(`<title xml:lang="zh-Hant">`):]
		if j := strings.Index(rest, "</title>"); j >= 0 {
			t := rest[:j]
			if k := strings.Index(t, "No. "); k >= 0 {
				t = t[k+len("No. "):]
				// 跳過經號（數字＋可選 a/b 後綴）與空白；不要吃掉題名開頭的拉丁字母
				p := 0
				for p < len(t) && (t[p] == ' ' || t[p] >= '0' && t[p] <= '9') {
					p++
				}
				if p < len(t) && (t[p] >= 'a' && t[p] <= 'z' || t[p] >= 'A' && t[p] <= 'Z') {
					p++
				}
				for p < len(t) && t[p] == ' ' {
					p++
				}
				return resolveGaijiText(cleanTitle(strings.TrimSpace(t[p:])), path)
			}
		}
	}
	return ""
}

// cleanTitle 去掉標題裡的內嵌標記：<g ref="#CB00178"/> → &CB00178;，其餘標籤移除。
func cleanTitle(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '<' {
			b.WriteByte(s[i])
			continue
		}
		j := strings.IndexByte(s[i:], '>')
		if j < 0 {
			break
		}
		tag := s[i : i+j+1]
		if k := strings.Index(tag, `ref="#`); k >= 0 {
			code := tag[k+6:]
			if e := strings.IndexAny(code, `"`); e >= 0 {
				code = code[:e]
			}
			// `<g ref="#CB…">㮈</g>`：內文只有一個字時就是替代字，優先使用（2026-10-31）
			if !strings.HasSuffix(tag, "/>") {
				if e := strings.Index(s[i+j+1:], "</g>"); e >= 0 && e <= 24 {
					inner := strings.TrimSpace(s[i+j+1 : i+j+1+e])
					if len([]rune(inner)) == 1 {
						b.WriteString(inner)
						i += j + 1 + e + len("</g>") - 1
						continue
					}
				}
			}
			b.WriteString("&" + code + ";")
		}
		i += j
	}
	return strings.TrimSpace(b.String())
}

// gaijiUnicode：從檔案的 teiHeader/charDecl 取 CB 碼 → Unicode（只取 type="unicode"）
func gaijiUnicode(path string) map[string]rune {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	s := string(b)
	re := regexp.MustCompile(`<char xml:id="([^"]+)">[\s\S]*?<mapping type="(?:normal_)?unicode">U\+([0-9A-Fa-f]+)</mapping>`)
	m := map[string]rune{}
	for _, x := range re.FindAllStringSubmatch(s, -1) {
		v, err := strconv.ParseInt(x[2], 16, 32)
		if err == nil && v >= 0 && v <= 0x10FFFF {
			m[x[1]] = rune(v)
		}
	}
	return m
}

// resolveGaijiText：把標題裡剩下的 &CODE; 用該檔的 charDecl 換掉（沒有對應就保留）
func resolveGaijiText(s, path string) string {
	if !strings.Contains(s, "&") {
		return s
	}
	m := gaijiUnicode(path)
	if len(m) == 0 {
		return s
	}
	re := regexp.MustCompile(`&([A-Za-z0-9][A-Za-z0-9-]*);`)
	return re.ReplaceAllStringFunc(s, func(t string) string {
		code := strings.TrimSuffix(strings.TrimPrefix(t, "&"), ";")
		if r, ok := m[code]; ok {
			return string(r)
		}
		return t
	})
}

func (e *emitter) parseFile(path, sutra string, juan int, linesOut, pclOut *bufio.Writer) *bufio.Writer {
	f, err := os.Open(path)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	e.sawPB = false
	e.lastPageCol = ""
	e.pendingPage = ""
	dec := xml.NewDecoder(bufio.NewReaderSize(f, 1<<20))
	dec.Strict = false
	firstLb := true
	divStack := []string{}
	inHead := false
	pendingTag := ""
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			panic(fmt.Sprintf("%s: %v", path, err))
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := t.Name.Local
			if e.skip > 0 {
				// teiHeader 的 charDecl：CB 缺字碼 → Unicode（作者 2026-10-31）
				if e.skipKind == "header" {
					switch name {
					case "char":
						e.curChar = attr(t, "id")
					case "mapping":
						switch ty := attr(t, "type"); ty {
						case "unicode", "normal_unicode":
							e.inUnicode = true
							e.uniBuf.Reset()
						case "PUA":
							e.inPUA = true
							e.uniBuf.Reset()
						}
					}
				}
				// 校勘／夾註裡偶爾夾著真正的換頁標記（例 T01 0731b 在 note 內），
				// 文字不收，但頁碼要留下，否則 yinshun 的 taisho?1p731b 會斷。
				if name == "pb" && e.skipKind == "note" {
					if e.canon == "X" && attr(t, "ed") != "" && attr(t, "ed") != "X" {
						e.sawPB = true
						e.skip++
						continue
					}
					pc := attr(t, "n")
					e.sawPB = true
					e.lastPageCol = pc
					e.emitPage(pageID(e.vol, pc))
				}
				e.skip++
				continue
			}
			// 校勘、梵漢對照、目錄編號一律不進正文：只留 CBETA 採用的漢文讀法。
			if name == "teiHeader" || name == "note" || name == "rdg" || name == "mulu" || name == "orig" || name == "sic" ||
				lang(t) == "sa" || lang(t) == "pi" || place(t) == "foot" ||
				(name == "div" && attr(t, "type") == "taisho-notes") {
				e.skip = 1
				switch {
				case name == "note" || name == "rdg":
					e.skipKind = "note"
				case name == "teiHeader":
					e.skipKind = "header"
				case name == "div":
					e.skipKind = "notes"
				case name == "mulu":
					e.skipKind = "mulu"
				default:
					e.skipKind = "foreign"
				}
				continue
			}
			switch name {
			case "lb":
				e.flush()
				if e.pendingPage != "" {
					e.emitPage(e.pendingPage)
					e.pendingPage = ""
				} else if !e.sawPB {
					// X 藏同一行常同時有 ed="X" 與 ed="R" 的 lb；頁碼只認 X。
					if e.canon == "X" && attr(t, "ed") != "" && attr(t, "ed") != "X" {
						continue
					}
					pc := lbPageCol(attr(t, "n"))
					if pc != "" && pc != e.lastPageCol {
						p := pageID(e.vol, pc)
						e.emitPage(p)
						e.lastPageCol = pc
					}
				}
				if firstLb {
					firstLb = false
					if linesOut != nil {
						fmt.Fprintf(linesOut, "%s\t%d\t%d\n", sutra, juan, e.count)
					}
				}
				if pclOut != nil {
					if pg, cl, ln, ok := parseLbPcl(attr(t, "n")); ok {
						fmt.Fprintf(pclOut, "%d\t%d\t%d\t%s\t%d\n", e.count, e.vol, pg, cl, ln)
					}
				}
			case "pb":
				// X 藏同時有 ed="X"（卍續藏頁碼）與 ed="R"（嘉興藏對照頁碼）；
				// 頁 id 只採用 X 的，否則同一頁碼會在 R 欄重複數十次。
				if e.canon == "X" && attr(t, "ed") != "" && attr(t, "ed") != "X" {
					e.sawPB = true
					continue
				}
				pc := attr(t, "n")
				e.sawPB = true
				e.lastPageCol = pc
				// 頁碼先記著，下一個 lb 換行後再放：頁碼要落在新頁第一行，
				// 不能黏在上一頁最後一行（否則 yinshun 的 taisho?… 錨點會差一行）。
				if e.pendingPage != "" {
					e.emitPage(e.pendingPage)
				}
				e.pendingPage = pageID(e.vol, pc)
			case "juan":
				switch attr(t, "fun") {
				case "open":
					pendingTag = "卷"
				case "close":
					e.juanClose = true
				}
			case "div":
				divStack = append(divStack, divTag(attr(t, "type")))
			case "head", "jhead":
				if name == "jhead" && e.juanClose {
					e.skip = 1
					continue
				}
				inHead = true
				e.head.Reset()
				e.nHead = true
				e.tag = ""
				if name == "jhead" {
					e.tag = "卷"
				}
				if e.tag == "" && len(divStack) > 0 {
					e.tag = divStack[len(divStack)-1]
				}
				if e.tag == "" {
					e.tag = pendingTag
				}
				if e.tag == "" {
					e.tag = "其他"
				}
			case "g":
				// <g ref="#CB01368">𩜁</g>：內文有替代字就用它；自閉合且 charDecl 有
				// Unicode 對應就補上；兩者都沒有才留 &CB…; 並記進缺字表（作者 2026-10-31）。
				ref := strings.TrimPrefix(attr(t, "ref"), "#")
				if ref != "" {
					e.gStack = append(e.gStack, ref)
					e.gText = append(e.gText, false)
					e.gInner = append(e.gInner, strings.Builder{})
					e.stats["g"]++
				}
			case "app", "lem", "space", "anchor", "milestone", "title", "p", "byline", "docNumber", "cb:juan":
				// 照常收字
			}
		case xml.EndElement:
			if e.skip > 0 {
				name := t.Name.Local
				if e.skipKind == "header" {
					switch name {
					case "mapping":
						if e.inUnicode {
							e.takeUnicode()
						} else if e.inPUA {
							e.takePUA()
						}
					case "char":
						e.curChar = ""
					}
				}
				e.skip--
				continue
			}
			name := t.Name.Local
			switch name {
			case "head", "jhead":
				inHead = false
				e.emitTag(e.tag, escapeText(e.head.String()))
				e.head.Reset()
			case "div":
				if len(divStack) > 0 {
					divStack = divStack[:len(divStack)-1]
				}
			case "juan":
				e.juanClose = false
			case "g":
				if n := len(e.gStack); n > 0 {
					ref := e.gStack[n-1]
					text := e.gText[n-1]
					inner := strings.TrimSpace(e.gInner[n-1].String())
					e.gStack = e.gStack[:n-1]
					e.gText = e.gText[:n-1]
					e.gInner = e.gInner[:n-1]
					runes := []rune(inner)
					one := text && len(runes) == 1
					out := ""
					switch {
					case strings.HasPrefix(ref, "SD-") || strings.HasPrefix(ref, "RJ-"):
						// 梵字：<g> 內文已經是 plane 16 PUA（SD/RJ），直接用；
						// 自閉合或內文不是 PUA 時，按 CBETA 規則算 U+FA000／U+100000。
						// 這兩個平面有內嵌的 Accelon Siddham／Ranjana 字型（2026-10-31）。
						if one && isPUA(runes[0]) {
							out = string(runes[0])
						} else if r, ok := sanskritPUA(ref); ok {
							out = string(r)
						} else {
							out = "&" + ref + ";"
							e.missing[ref]++
						}
						// 有對照表就把 PUA 換成 Noto 排得出來的 Unicode 序列
						// （序列在 tokenizer 裡仍算 1 個 VA；見 ts/src/tokenize.ts）
						if rs := []rune(out); len(rs) == 1 {
							if s, ok := e.seqMap[rs[0]]; ok {
								out = s
							}
						}
					case strings.HasPrefix(ref, "CB"):
						// CB 缺字：<g> 內文是真字就用；若是 PUA（原字型的私用碼），
						// 改用 teiHeader/charDecl 的 Unicode；只有 PUA 對應的就沿用
						// PUA 字元（舊版行為；2026-10-31 之前就是這樣）；都沒有才留 &CB…;。
						if one && !isPUA(runes[0]) {
							out = inner
						} else if r, ok := e.gaiji[ref]; ok {
							out = string(r)
						} else if r, ok := e.gaijiPUA[ref]; ok {
							out = string(r)
						} else {
							out = "&" + ref + ";"
							e.missing[ref]++
						}
					default:
						// 其他 ref（CBETA 自訂碼等）：內文優先，其次 charDecl。
						if one {
							out = inner
						} else if r, ok := e.gaiji[ref]; ok {
							out = string(r)
						} else {
							out = "&" + ref + ";"
							e.missing[ref]++
						}
					}
					if inHead {
						e.head.WriteString(out)
					} else {
						e.emit(out)
					}
				}
			}
		case xml.CharData:
			if e.skip > 0 {
				if e.inUnicode || e.inPUA {
					e.uniBuf.WriteString(string(t))
				}
				continue
			}
			s := textOf(string(t))
			if strings.TrimSpace(s) == "" {
				continue
			}
			if n := len(e.gText); n > 0 {
				// <g> 內文先收起來，等 </g> 再決定要不要用（單一字才用；組字式會丟掉）
				e.gText[n-1] = true
				e.gInner[n-1].WriteString(s)
				continue
			}
			if inHead {
				e.head.WriteString(s)
			} else {
				e.emit(escapeText(s))
			}
		}
	}
	if e.pendingPage != "" {
		e.emitPage(e.pendingPage)
		e.pendingPage = ""
	}
	return linesOut
}

func divTag(ty string) string {
	switch ty {
	case "xu":
		return "序"
	case "pin":
		return "品"
	case "jing":
		return "經"
	case "fen":
		return "分"
	case "other":
		return "其他"
	case "commentary", "orig", "w", "note":
		// X 藏 TEI 的正文／註解／音義段落；舊 wxzj 以「其他」為主。
		return "其他"
	case "fu":
		return "附文"
	case "hui":
		return "會"
	}
	return ""
}

func attr(t xml.StartElement, name string) string {
	for _, a := range t.Attr {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

func lang(t xml.StartElement) string  { return attr(t, "lang") }
func place(t xml.StartElement) string { return attr(t, "place") }

// parseLbPcl 解析 <lb n="0185b19"> → (185, b, 19)′。
func parseLbPcl(n string) (page int, col string, line int, ok bool) {
	n = strings.TrimSpace(n)
	if len(n) < 5 {
		return
	}
	page, err := strconv.Atoi(n[:4])
	if err != nil || n[4] < 'a' || n[4] > 'g' {
		return
	}
	col = string(n[4])
	if len(n) >= 7 {
		line, err = strconv.Atoi(n[5:7])
		if err != nil {
			return
		}
	}
	ok = true
	return
}

// lbPageCol 從行號（0001a03）取頁欄（0001a）；續藏 56–84 冊沒有 <pb>，只能靠它。
func lbPageCol(n string) string {
	n = strings.TrimSpace(n)
	if len(n) < 5 {
		return ""
	}
	pc := n[:5]
	if c := pc[4]; c >= 'a' && c <= 'g' {
		return pc
	}
	return ""
}

