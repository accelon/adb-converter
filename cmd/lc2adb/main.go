// lc2adb: CBETA TEI P5（LC 呂澂佛學著作集）→ Accelon3 adb 文字。
//
// 用法：
//
//	go run ./cmd/lc2adb -src D:\2026\xml-p5\LC -out build\lc-text.txt
//
// 輸出一行一個 <lb> 行。標記沿用 ys.adb 的形制：
//
//	檔／書／卷／頁／段／章／節／項
//
// 頁 id 用「冊號 + p + 原書頁欄」（例：1pa001a），避免八個檔的 a001a 互撞。
//
// 與 y2adb 的差異：
//   - LC 的 <head> 有時把 <cb:mulu> 夾在文字中間（anchor 之後），層級要在 head
//     收尾時才拿得到；所以 head 先緩衝，收尾再輸出 <章>/<節>/<項>。
//   - 正文的 <note place="inline"> 是行內小註，用「（…）」留在原位，不另起一行。
//   - <g> 的內容是缺字本字，保留文字（不要像 y2adb 整段跳過）。
//   - <back>（校注附錄）不收，正文 </body> 之後全部忽略。
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

const header = `<檔 n="lc.xml"><集 l="圖集,註釋群,編目資訊">呂澂佛學著作集</集><隱><樹 s="*" t="書" pf1="$書.id;.">目錄</樹><樹 s="*u=文" pf="$頁.id;)">頻次</樹><樹 s="~00602000">西文</樹></隱><隱><引>《$書;》：「$_;」( LC $*頁; )</引><摘要頭>$書;($頁;)</摘要頭><參考資料 n="taisho,wxzj"/></隱><英文名>Corpus of Lü Cheng's Buddhist Studies</英文名></檔>`

var titleRe = regexp.MustCompile(`<title level="m"[^>]*>([^<]+)</title>`)

type emitter struct {
	out     strings.Builder
	line    strings.Builder
	stats   map[string]int
	lineNo  int
	vol     int
	lbOut   *bufio.Writer
	headTag string

	// <head> 緩衝
	inHead    bool
	headText  strings.Builder
	headLevel int
	// <cb:mulu> 通常在 <head> 之前，先把層級記下來給下一個 head 用
	pendingLevel int
	// 少數 <cb:mulu> 沒有配對的 <head>（前言、經典簡介、經疏…），
	// 先把 mulu 文字緩衝；下一個元素是 head 就丟掉，否則自己當標題輸出。
	muluPending bool
	muluText    strings.Builder
	inMulu      bool
}

func (e *emitter) nl() {
	s := e.line.String()
	e.line.Reset()
	e.out.WriteString(s)
	e.out.WriteByte('\n')
	e.lineNo++
}

// ensureLine 只在目前這一行有內容時才換行；避免 <pb>/<p>/<head> 連著來時
// 產生大量空白行（<lb> 仍用 nl，因為空行本身就是原書的一行）。
func (e *emitter) ensureLine() {
	if e.line.Len() > 0 {
		e.nl()
	}
}

func (e *emitter) write(s string) { e.line.WriteString(s) }

// emit 在 head 內寫到 headText，否則寫到正文。
func (e *emitter) emit(s string) {
	if e.inHead {
		e.headText.WriteString(s)
	} else {
		e.write(s)
	}
}

/**
 * 開一個標題。層級來自 <cb:mulu level="N">：
 *   1 → <章 t="節,項.">（章底下可以有節、項）
 *   2 → <節 t="項.">
 *   3 → <項>
 * 目錄樹靠 `t=` 宣告「這一層的小孩是哪一種標籤」。
 */
func (e *emitter) openHeading(level int) {
	tag, t := "章", `t="節,項."`
	switch level {
	case 2:
		tag, t = "節", `t="項."`
	case 3, 4, 5:
		tag, t = "項", ""
	}
	e.headTag = tag
	if t == "" {
		e.write("<" + tag + ` u="文">`)
	} else {
		e.write("<" + tag + " " + t + ` u="文">`)
	}
}

// flushMulu 把沒有 <head> 的 <cb:mulu> 當成一個標題輸出。
func (e *emitter) flushMulu() {
	if !e.muluPending {
		return
	}
	e.muluPending = false
	text := strings.TrimSpace(e.muluText.String())
	e.muluText.Reset()
	if text == "" {
		e.pendingLevel = 0
		return
	}
	e.ensureLine()
	e.openHeading(e.pendingLevel)
	e.write(esc(clean(text)))
	tag := e.headTag
	if tag == "" {
		tag = "章"
	}
	e.write("</" + tag + ">")
	e.headTag = ""
	e.pendingLevel = 0
	e.stats["標題"]++
}

func esc(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

func clean(s string) string {
	// 只收 ASCII 空白；U+3000（全角空格）是原書標題的一部分，要留著。
	var b strings.Builder
	inSpace := false
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if !inSpace && b.Len() > 0 {
				b.WriteByte(' ')
				inSpace = true
			}
			continue
		}
		b.WriteRune(r)
		inSpace = false
	}
	return strings.TrimRight(b.String(), " ")
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
	src := flag.String("src", "", "LC 目錄")
	out := flag.String("out", "", "輸出文字檔")
	lbPath := flag.String("lbs", "", "輸出「行號到 lb」對照 TSV")
	flag.Parse()
	files, err := filepath.Glob(filepath.Join(*src, "LC*", "*.xml"))
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
		e.ensureLine()
		e.write(fmt.Sprintf(`<檔 n="%s">`, filepath.Base(path)))
		e.nl()
		e.write(fmt.Sprintf(`<書 l="目次" t="章,節,項." id="%d">%s</書>`, vol, esc(title)))
		e.stats["書"]++
		e.nl()
		dec := xml.NewDecoder(strings.NewReader(string(raw)))
		inBody := false
		skip := 0
		juan := 0
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
				if e.inMulu {
					continue
				}
				if e.muluPending {
					switch t.Name.Local {
					case "head":
						// 有 head 就用 head 的文字，mulu 只是目次副本
						e.muluPending = false
						e.muluText.Reset()
					case "anchor":
						// 錨點不影響「下一個是不是 head」
					default:
						e.flushMulu()
					}
				}
				switch t.Name.Local {
				case "mulu":
					// mulu 的文字通常與 head 重複；先緩衝，等下一元素再決定。
					if n := attr(t.Attr, "level"); n != "" {
						if e.inHead {
							e.headLevel = int(n[0] - '0')
						} else {
							e.pendingLevel = int(n[0] - '0')
						}
					}
					if e.inHead {
						skip = 1
					} else {
						e.muluText.Reset()
						e.muluPending = true
						e.inMulu = true
					}
				case "head", "jhead":
					e.inHead = true
					e.headText.Reset()
					e.headLevel = e.pendingLevel
					e.pendingLevel = 0
					if t.Name.Local == "jhead" {
						// jhead 只是來源版本題（「呂澂佛學論著選集卷四」），不是正文標題
						e.inHead = false
						skip = 1
					}
				case "note":
					e.emit("（")
					e.stats["註"]++
				case "app":
					e.stats["app"]++
				case "rdg":
					skip = 1
				case "anchor":
					// 校勘錨點，無文字
				case "milestone":
					if attr(t.Attr, "unit") == "juan" {
						juan++
						e.ensureLine()
						e.write(fmt.Sprintf(`<卷 n="%d">%d</卷>`, juan, juan))
						e.stats["卷"]++
						e.ensureLine()
					}
				case "pb":
					if isOld(t.Attr) {
						continue
					}
					pb := attr(t.Attr, "n")
					if pb == "" {
						continue
					}
					e.ensureLine()
					e.write(fmt.Sprintf(`<頁 id="%dp%s"/>`, vol, pb))
					e.stats["頁"]++
					e.ensureLine()
				case "lb":
					if isOld(t.Attr) {
						continue
					}
					if n := attr(t.Attr, "n"); n != "" && e.lbOut != nil {
						fmt.Fprintf(e.lbOut, "%d\t%d\t%s\n", e.vol, e.lineNo, n)
					}
					e.nl()
				case "p":
					e.ensureLine()
					e.write("<段/>")
					e.stats["段"]++
				}
			case xml.EndElement:
				if skip > 0 {
					skip--
					continue
				}
				if !inBody {
					continue
				}
				if t.Name.Local == "mulu" {
					e.inMulu = false
					continue
				}
				if e.inMulu {
					continue
				}
				if e.muluPending && (t.Name.Local == "div" || t.Name.Local == "list" || t.Name.Local == "body") {
					e.flushMulu()
				}
				switch t.Name.Local {
				case "head":
					if e.inHead {
						e.inHead = false
						e.ensureLine()
						e.openHeading(e.headLevel)
						e.write(esc(clean(e.headText.String())))
						tag := e.headTag
						if tag == "" {
							tag = "章"
						}
						e.write("</" + tag + ">")
						e.headTag = ""
						e.stats["標題"]++
					}
				case "note":
					e.emit("）")
				case "body":
					inBody = false
				}
			case xml.CharData:
				if skip > 0 || !inBody {
					continue
				}
				if e.inMulu {
					e.muluText.WriteString(clean(string(t)))
					continue
				}
				s := clean(string(t))
				if s == "" {
					continue
				}
				if e.muluPending {
					e.flushMulu()
				}
				e.emit(esc(s))
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
