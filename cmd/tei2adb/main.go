// tei2adb: CBETA TEI P5 (T 藏) → Accelon3 adb 文字（一行一個 pcl 行，標記內嵌）。
//
// 用法：
//   go run ./cmd/tei2adb -tei D:\2023\sat2018\T -vol 1 -out build\tei-T01.txt
//   go run ./cmd/tei2adb -tei D:\2023\sat2018\T -vol 1-85 -out build\tei-all.txt
//   go run ./cmd/tei2adb -tei E:\3rd\XML\X -canon X -vol 1-88 -out build\wxzj-tei.txt
//
// 標記沿用舊 taisho.adb：檔／冊／段／書／頁／卷／序／經／品／分／會／其他。
// 校勘：取 <app><lem> 的文字（＝CBETA 採用的讀法），<note>/<rdg> 一律丟棄。
// 缺字：<g ref="#CB00178"/> → 文字 "&CB00178;"（之後再用 glyphwiki 構形序處理）。
package main

import (
	"bufio"
	"encoding/xml"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// 舊 taisho.adb 的檔頭（7 棵樹的宣告照抄；只有來源說明改成 2025 版）。
const fileHeader = `<檔 n="taisho.xml"><集 c="hidden">大正新脩大藏經</集><英文名>Taisho Tripitaka</英文名>本資料庫內容來自CBETA 2025.2 版 TEI XML，並為中華電子佛典協會授權非營利使用。最新資料請到<聯 l="http://www.cbeta.org">www.cbeta.org</聯><隱><樹 s="*" l="序,分,跋,會,其他,附文,經,other,xu" t="冊,書,品." pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;-">經目</樹></隱><隱><樹 s="$書" pf="$頁.id;)" sf="-$書.id;">書名</樹><樹 s="*書" pf="$頁.id;)" sf="-$書.id;">分書頻次</樹></隱><隱><樹 s="*" t="冊,卷." pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;">分卷</樹></隱><隱><樹 s="*卷" pf="$頁.id;)" sf="-$書.id;">分卷頻次</樹></隱><隱><樹 s="~00602000">西文</樹></隱><隱><樹 s="%"t="冊,書" pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;-">反連結</樹></隱><隱><引>《$書;》：「$_;」( 大正 $*頁; )</引><摘要頭>$書;($頁;)</摘要頭></隱></檔>`

// 舊 wxzj.adb 的檔頭；來源改成 2025 TEI，樹／引文格式沿用。
const xHeader = `<檔 n="wxzj.xml"><集 c="hidden">卍新纂續藏經</集><英文名>Wanzi Xuzangjing</英文名>本資料庫內容來自CBETA 2025.2 版 TEI XML，並為中華電子佛典協會授權非營利使用。最新資料請到<聯 l="http://www.cbeta.org">www.cbeta.org</聯><隱><樹 s="*" l="序,分,跋,會,其他,附文,經,other,xu,科判" t="冊,書,品." pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;-">經目</樹></隱><隱><樹 s="$書" pf="$頁.id;)" sf="-$書.id;">書名</樹><樹 s="*書" pf="$頁.id;)" sf="-$書.id;">分書頻次</樹></隱><隱><樹 s="*" t="冊,卷." pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;">分卷</樹></隱><隱><樹 s="*卷" pf="$頁.id;)" sf="-$書.id;">分卷頻次</樹></隱><隱><樹 s="~00602000">西文</樹></隱><隱><樹 s="%" t="冊,書" pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;-">反連結</樹></隱><隱><引>《$書;》：「$_;」( 卍新續 $*頁; )</引><摘要頭>$書;($頁;)</摘要頭></隱></檔>`

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
}{	{2185, 2245, "續經疏部"},
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
		if n == 10 { return "十" }
		return "十" + digits[n%10]
	case n < 100:
		s := digits[n/10] + "十"
		if n%10 != 0 { s += digits[n%10] }
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
	out   *bufio.Writer
	canon string
	line  strings.Builder
	head  strings.Builder
	nHead bool
	tag   string // 目前 <head> 要用的標題名
	juanClose bool
	sawPB     bool
	pendingPage string
	skipKind  string
	lastPageCol string
	skip  int
	vol   int
	page  string
	book  int
	seq   int
	stats map[string]int
	seenPages map[string]bool
	count int
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

func main() {
	tei := flag.String("tei", `D:\2023\sat2018\T`, "TEI 根目錄")
	vols := flag.String("vol", "1", "冊範圍，如 1 或 1-85")
	nos := flag.String("no", "", "只輸出指定經號（逗號分隔，如 235,1698,1510a）")
	linesPath := flag.String("lines", "", "輸出「卷起始行」TSV（sutra/juan/line）")
	pclPath := flag.String("pcl", "", "輸出「每一行的 pcl」TSV（line/vol/page/col/line）")
	out := flag.String("out", "build/tei.txt", "輸出文字檔")
	canon := flag.String("canon", "T", "藏別：T（大正藏）或 X（卍續藏）")
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

	e := &emitter{out: w, canon: canonValue, stats: map[string]int{}, seenPages: map[string]bool{}}
	if canonValue == "X" {
		e.emit(xHeader)
	} else {
		e.emit(fileHeader)
	}
	e.flush()
	_ = linesOut

	bookSeq := 0
	for v := lo; v <= hi; v++ {
		dir := filepath.Join(*tei, fmt.Sprintf("%s%02d", canonValue, v))
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
			return cleanTitle(rest[:j])
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
				return cleanTitle(strings.TrimSpace(t[p:]))
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
			b.WriteString("&" + code + ";")
		}
		i += j
	}
	return strings.TrimSpace(b.String())
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
			if name == "teiHeader" || name == "note" || name == "rdg" || name == "mulu" ||
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
				ref := strings.TrimPrefix(attr(t, "ref"), "#")
				if ref != "" {
					e.emit("&" + ref + ";")
					e.stats["g"]++
				}
			case "app", "lem", "space", "anchor", "milestone", "title", "p", "byline", "docNumber", "cb:juan":
				// 照常收字
			}
		case xml.EndElement:
			if e.skip > 0 {
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
			}
		case xml.CharData:
			if e.skip > 0 {
				continue
			}
			s := textOf(string(t))
			if strings.TrimSpace(s) == "" {
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

func lang(t xml.StartElement) string { return attr(t, "lang") }
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


