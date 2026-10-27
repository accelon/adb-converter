// k2adb: 高麗藏 k-txt（K01.tsv…＋juaninfo.tsv）→ Accelon3 adb 文字。
//
// 用法：
//   go run ./cmd/k2adb -k D:\2023\tripitaka-migrator\k-txt -out build\goryeo-text.txt
//
// 標記沿用 taisho.adb 的語彙：檔／冊／段／書／頁／卷（高麗藏沒有品）。
// 每行 = 一個 pcl 行；<頁 id="NpMc"/> 由頁行碼推得；<卷> 用該卷第一行的卷題。
// 經號、卷號寫進屬性：<書 id="K0001" n="0001">、<卷 id="0001-1" n="1">。
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const fileHeader = `<檔 n="goryeo.xml"><集 c="hidden">高麗大藏經</集><英文名>Goryeo Tripitaka</英文名>本資料庫內容來自高麗藏再雕本（東國大學 KABC 文字，經 tripitaka-migrator 整理）。<隱><樹 s="*" l="序,分,跋" t="冊,書,卷." pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;-">經目</樹></隱><隱><樹 s="$書" pf="$頁.id;)" sf="-$書.id;">書名</樹><樹 s="*書" pf="$頁.id;)" sf="-$書.id;">分書頻次</樹></隱><隱><樹 s="*" t="冊,卷." pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;">分卷</樹></隱><隱><樹 s="*卷" pf="$頁.id;)" sf="-$書.id;">分卷頻次</樹></隱><隱><樹 s="~00602000">西文</樹></隱><隱><樹 s="%" t="冊,書" pf1="$冊.id;." pf2="$頁.id;)" sf2="-$書.id;-">反連結</樹></隱><隱><引>《$書;》：「$_;」( 高麗 $*頁; )</引><摘要頭>$書;($頁;)</摘要頭></隱></檔>`

type row struct {
	sutra string
	vol   int
	name  string
	juan  int
	start string
	end   string
	total int
	startSeq int
}

var carets = regexp.MustCompile(`\^[a-zA-Z]+\d*`)

func clean(s string) string {
	s = carets.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "\u3000", "\u3000")
	return strings.TrimSpace(s)
}

func parsePcl(p string) (page int, col string, line int, seq int, ok bool) {
	if len(p) != 7 {
		return
	}
	page, _ = strconv.Atoi(p[:4])
	c := p[4]
	if c < 'a' || c > 'g' {
		return
	}
	line, _ = strconv.Atoi(p[5:])
	seq = page*1000 + int(c-'a')*100 + line
	ok = true
	col = string(c)
	return
}

func pageID(vol, page int, col string) string {
	return fmt.Sprintf("%dp%d%s", vol, page, col)
}

func bookTitle(name string) string {
	s := clean(name)
	// 去掉結尾的「卷第…」「卷…」
	if i := strings.LastIndex(s, "卷"); i > 0 {
		tail := s[i+len("卷"):]
		if tail == "" || strings.HasPrefix(tail, "第") || strings.ContainsAny(tail[:1], "一二三四五六七八九十百上下中") || (tail[0] >= '0' && tail[0] <= '9') {
			s = s[:i]
		}
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return clean(name)
	}
	return s
}

func main() {
	kdir := flag.String("k", `D:\2023\tripitaka-migrator\k-txt`, "k-txt 目錄")
	out := flag.String("out", "build/goryeo-text.txt", "輸出文字檔")
	linesPath := flag.String("lines", "", "輸出「卷起始行」TSV（sutra/juan/line）")
	flag.Parse()

	rows := readJuaninfo(filepath.Join(*kdir, "juaninfo.tsv"))
	byVol := map[int][]row{}
	for _, r := range rows {
		byVol[r.vol] = append(byVol[r.vol], r)
	}
	vols := make([]int, 0, len(byVol))
	for v := range byVol {
		vols = append(vols, v)
	}
	sort.Ints(vols)

	f, err := os.Create(*out)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	w := bufio.NewWriterSize(f, 1<<20)
	defer w.Flush()

	stats := map[string]int{}
	var linesOut *os.File
	if *linesPath != "" {
		linesOut, err = os.Create(*linesPath)
		if err != nil {
			panic(err)
		}
		defer linesOut.Close()
	}
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			w.WriteString(cur.String())
			w.WriteByte('\n')
			stats["lines"]++
			cur.Reset()
		}
	}

	emit := func(s string) { cur.WriteString(s) }
	emit(fileHeader)
	flush()

	for _, vol := range vols {
		path := filepath.Join(*kdir, fmt.Sprintf("K%02d.tsv", vol))
		fh, err := os.Open(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "skip %s: %v\n", path, err)
			continue
		}
		jrows := byVol[vol]
		sort.Slice(jrows, func(a, b int) bool { return jrows[a].startSeq < jrows[b].startSeq })
		ji := 0
		curSutra := ""
		curKey := ""
		curPage := -1
		curCol := ""

		emit(fmt.Sprintf(`<冊 id="%d">高麗藏第%d冊</冊>`, vol, vol))
		stats["冊"]++

		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			line := sc.Text()
			tab := strings.IndexByte(line, '\t')
			if tab < 0 {
				continue
			}
			pcl := line[:tab]
			page, col, _, seq, ok := parsePcl(pcl)
			if !ok {
				continue
			}
			text := line[tab+1:]

			// 推進到所屬的卷
			for ji < len(jrows) && seq >= jrows[ji].startSeq {
				r := jrows[ji]
				if r.sutra != curSutra {
					curSutra = r.sutra
					emit(fmt.Sprintf(`<段/><書 id="K%sV%02d" n="%s">%s</書>`, r.sutra, r.vol, r.sutra, bookTitle(r.name)))
					stats["書"]++
				}
				if r.sutra+"/"+strconv.Itoa(r.juan) != curKey {
					curKey = r.sutra + "/" + strconv.Itoa(r.juan)
					// 這一行的文字就是卷題
					title := clean(text)
					if title == "" {
						title = clean(r.name)
					}
					emit(fmt.Sprintf(`<卷 id="%s-%d" n="%d">%s</卷>`, r.sutra, r.juan, r.juan, esc(title)))
					if linesOut != nil {
						fmt.Fprintf(linesOut, "%s\t%d\t%d\n", r.sutra, r.juan, stats["lines"])
					}
					stats["卷"]++
					text = "" // 卷題已用掉
				}
				ji++
			}

			if page != curPage || col != curCol {
				emit(`<頁 id="` + pageID(vol, page, col) + `"/>`)
				stats["頁"]++
				curPage, curCol = page, col
			}
			if text != "" {
				emit(esc(clean(text)))
			}
			flush()
		}
		if err := sc.Err(); err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", path, err)
		}
		fh.Close()
	}
	flush()
	w.Flush()
	fmt.Fprintf(os.Stderr, "lines=%d", stats["lines"])
	for _, k := range []string{"冊", "書", "卷", "頁"} {
		fmt.Fprintf(os.Stderr, " %s=%d", k, stats[k])
	}
	fmt.Fprintln(os.Stderr)
}

func esc(s string) string {
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

func readJuaninfo(path string) []row {
	f, err := os.Open(path)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	var out []row
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	first := true
	for sc.Scan() {
		line := sc.Text()
		if first {
			first = false
			if strings.HasPrefix(line, "經號") {
				continue
			}
		}
		p := strings.Split(line, "\t")
		if len(p) < 7 {
			continue
		}
		vol, _ := strconv.Atoi(p[1])
		juan, _ := strconv.Atoi(p[3])
		_, _, _, seq, ok := parsePcl(p[4])
		if !ok {
			continue
		}
		out = append(out, row{sutra: p[0], vol: vol, name: p[2], juan: juan, start: p[4], end: p[5], startSeq: seq})
	}
	return out
}

