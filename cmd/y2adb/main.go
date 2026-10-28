package main

import (
	"bufio"
	"encoding/xml"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// ys.adb 的文字：檔頭（集/隱/樹/引/摘要頭/參考資料/英文名）與 yinshun.adb 相同，
// 內文用 <檔> <書> <卷> <頁元> <頁> <段> <章>，其餘細節不強求一致。
const header = `<檔 n="ys.xml"><集 l="圖集,註釋群,編目資訊">印順法師佛學著作集</集><隱><樹 s="*" t="書" pf1="$書.id;.">目錄</樹><樹 s="*u=文" pf="$頁.id;)">頻次</樹><樹 s="~00602000">西文</樹></隱><隱><引>《$書;》：「$_;」( Y $*頁; )</引><摘要頭>$書;($頁;)</摘要頭><參考資料 n="taisho,wxzj"/></隱><英文名>Master Yinshun Corpus of Buddhist Studies</英文名></檔>`

var titleRe = regexp.MustCompile(`<title level="m"[^>]*>([^<]+)</title>`)

type emitter struct {
	out    strings.Builder
	line   strings.Builder
	stats  map[string]int
	lineNo int
	vol    int
	noteSeq int
	lbOut  *bufio.Writer
	// <cb:mulu level="N"> 的層級：1＝章、2＝節、3＝項（CBETA 只用這個標記目次層級）
	muluLevel int
	// 目前開著的標題標籤（章／節／項），</章> 要對上同一個名字
	headTag string
}

func (e *emitter) nl() {
	s := e.line.String()
	e.line.Reset()
	e.out.WriteString(s)
	e.out.WriteByte('\n')
	e.lineNo++
}

func (e *emitter) write(s string) { e.line.WriteString(s) }

/**
 * 開一個標題。層級來自前面的 <cb:mulu level="N">：
 *   1 → <章 t="節,項.">（章底下可以有節、項）
 *   2 → <節 t="項.">
 *   3 → <項>
 * 目錄樹靠 `t=` 宣告「這一層的小孩是哪一種標籤」，沒有 `t=` 就只能當葉節點。
 * 2026-10-28：先前一律寫 <章>，於是「第一章」「第一節」在目錄裡同屬一層。
 */
func (e *emitter) openHeading() {
	tag, t := "章", `t="節,項."`
	switch e.muluLevel {
	case 2:
		tag, t = "節", `t="項."`
	case 3, 4:
		tag, t = "項", ""
	}
	e.headTag = tag
	if t == "" {
		e.write("<" + tag + ` u="文">`)
	} else {
		e.write("<" + tag + " " + t + ` u="文">`)
	}
}

func esc(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

func clean(s string) string {
	f := strings.Fields(s)
	if len(f) == 0 {
		return ""
	}
	return strings.Join(f, " ")
}

func pbClass(pb string) string {
	if pb == "" {
		return ""
	}
	if pb[0] >= '0' && pb[0] <= '9' {
		return "#"
	}
	return string(pb[0])
}

func isOld(attrs []xml.Attr) bool {
	for _, a := range attrs {
		if a.Name.Local == "type" && a.Value == "old" {
			return true
		}
	}
	return false
}

func attr(attrs []xml.Attr, name string) string {
	for _, a := range attrs {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

func main() {
	src := flag.String("src", "", "Y 目錄")
	out := flag.String("out", "", "輸出文字檔")
	lbPath := flag.String("lbs", "", "輸出「行號到 lb」對照 TSV")
	flag.Parse()
	files, err := filepath.Glob(filepath.Join(*src, "Y*", "*.xml"))
	if err != nil || len(files) == 0 {
		panic("找不到 XML")
	}
	sort.Strings(files)
	e := &emitter{stats: map[string]int{}}
	if *lbPath != "" {
		f, err := os.Create(*lbPath)
		if err != nil {
			panic(err)
		}
		defer f.Close()
		e.lbOut = bufio.NewWriterSize(f, 1<<16)
		defer e.lbOut.Flush()
	}
	e.write(header)
	e.nl()
	vol := 0
	for _, path := range files {
		vol++
		e.vol = vol
		raw, err := os.ReadFile(path)
		if err != nil {
			panic(err)
		}
		title := ""
		if m := titleRe.FindSubmatch(raw); m != nil {
			title = string(m[1])
		}
		e.write(fmt.Sprintf(`<檔 n="%s">`, filepath.Base(path)))
		e.nl()
		e.write(fmt.Sprintf(`<書 l="目次" t="章,節,項." id="%d">%s</書>`, vol, esc(title)))
		e.stats["書"]++
		e.nl()
		dec := xml.NewDecoder(strings.NewReader(string(raw)))
		inBody := false
		skip := 0
		juan := 0
		pageClass := ""
		firstUnit := true
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.StartElement:
				if skip > 0 {
					skip++
					continue
				}
				if !inBody {
					if t.Name.Local == "body" {
						inBody = true
					}
					continue
				}
				switch t.Name.Local {
				case "body":
					inBody = true
				case "note":
					// CBETA 的校勘／註記：保留內容，獨立成行（不用 <註> 標籤，避免被當成腳註標記隱藏）
					e.noteSeq++
					n := attr(t.Attr, "n")
					if n == "" {
						n = fmt.Sprintf("%d", e.noteSeq)
					}
					e.nl()
					e.write("〔註" + n + "〕")
					e.stats["註"]++
				case "app":
					// 校勘層：只留底本 <lem>，異文 <rdg> 略過
					e.stats["app"]++
				case "rdg":
					skip = 1
				case "anchor", "g":
					skip = 1
				case "mulu":
					// 目次層級：1＝章、2＝節、3＝項。文字另有 <head>，這裡只記層級。
					if n := attr(t.Attr, "level"); n != "" {
						e.muluLevel = int(n[0] - '0')
					}
					skip = 1
				case "milestone":
					if attr(t.Attr, "unit") == "juan" && inBody {
						juan++
						e.nl()
						e.write(fmt.Sprintf(`<卷 n="%d">%d</卷>`, juan, juan))
						e.stats["卷"]++
						e.nl()
					}
				case "pb":
					if !inBody || isOld(t.Attr) {
						continue
					}
					pb := attr(t.Attr, "n")
					if pb == "" {
						continue
					}
					cls := pbClass(pb)
					if cls != pageClass {
						e.nl()
						label := "正文"
						if cls != "#" {
							if firstUnit {
								label = "序分頁"
							} else {
								label = "附錄"
							}
						}
						firstUnit = false
						e.write(fmt.Sprintf(`<頁元 n="%s" t="頁.">%s</頁元>`, esc(title), label))
						e.stats["頁元"]++
						e.nl()
						pageClass = cls
					}
					e.write(fmt.Sprintf(`<頁 id="%dp%s"/>`, vol, pb))
					e.stats["頁"]++
					e.nl()
				case "lb":
					if isOld(t.Attr) {
						continue
					}
					if n := attr(t.Attr, "n"); n != "" && e.lbOut != nil {
						fmt.Fprintf(e.lbOut, "%d\t%d\t%s\n", e.vol, e.lineNo, n)
					}
					e.nl()
				case "p":
					e.nl()
					e.write("<段/>")
					e.stats["段"]++
				case "head":
					e.nl()
					e.openHeading()
				case "jhead":
					e.nl()
					e.openHeading()
				}
			case xml.EndElement:
				if skip > 0 {
					skip--
					continue
				}
				if !inBody {
					continue
				}
				switch t.Name.Local {
				case "head", "jhead":
					tag := e.headTag
					if tag == "" {
						tag = "章"
					}
					e.write("</" + tag + ">")
					e.headTag = ""
					e.muluLevel = 0
				case "note":
					e.nl()
				case "body":
					inBody = false
				}
			case xml.CharData:
				if skip > 0 || !inBody {
					continue
				}
				s := clean(string(t))
				if s == "" {
					continue
				}
				e.write(esc(s))
			}
		}
	}
	if e.line.Len() > 0 {
		e.nl()
	}
	if err := os.WriteFile(*out, []byte(e.out.String()), 0o644); err != nil {
		panic(err)
	}
	fmt.Fprintf(os.Stderr, "lines=%d %v\n", strings.Count(e.out.String(), "\n"), e.stats)
}
