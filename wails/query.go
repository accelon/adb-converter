package main

// 查詢後端（Go 版）：把「詞組 → 命中 VA」這一段搬到 Go，介面與 TS 的
// `SearchSession.clauseHits()` 等價（作者 2026-10）。
//
// 分工（刻意如此）：
//   * **語言層**（把字串切成 token、`.` 萬用字元的漢字規則）兩邊各有一份實作，
//     由共用的測試集（ts/test/shared/search-cases.json）盯著不能走鐘。
//   * **索引層**（解 posting、詞組交集）在這裡做；TS 端只送查詢字串過來。
//   * 檔案分段與 BM25 排名仍在 TS（`rankClauses()`）——Go 只回「每個詞組的命中」。
//
// 支援的語法（與 ts/src/accelon26/query.ts 一致）：
//   * 空白分隔詞組；`+` 必要、`-` 排除、`*` 鄰近前一個詞組（≤20 token）
//   * `.` 只有「前後都是漢字」時才是單字萬用字元（其餘的 `.` 是 skipword，丟掉）
//   * 一個詞組最多 10 個萬用字元

import (
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	proximityTokens = 20
	maxWildcards    = 10
)

// queryClause 是解析後的一個詞組。
type queryClause struct {
	Text     string   `json:"text"`
	Role     string   `json:"role"`     // optional／required／excluded
	NearPrev bool     `json:"nearPrev"` // `*` 綁前一個詞組
	Parts    []string `json:"parts"`    // 以 `.` 切開的片段（沒有 `.` 時只有一個）
	Wild     bool     `json:"wild"`
}

// clauseHits 是 Go 回給 TS 的「詞組命中」（對應 ts 的 ClauseHits）。
type clauseHits struct {
	Text        string      `json:"text"`
	Tokens      []string    `json:"tokens"`
	Role        string      `json:"role"`
	NearOf      int         `json:"nearOf"`
	Wildcard    bool        `json:"wildcard"`
	Missing     []string    `json:"missing"`
	Occurrences int         `json:"occurrences"`
	Hits        []phraseHit `json:"hits"`
	ColorIndex  int         `json:"colorIndex"`
}

// QueryOut 是一次查詢的結果（只到「詞組命中」為止）。
type QueryOut struct {
	Query   string       `json:"query"`
	Clauses []clauseHits `json:"clauses"`
	Missing []string     `json:"missing"`
	Ms      float64      `json:"ms"`
}

// isHan 與 TS 的 isHan() 相同：`.` 只在這類字之間才有作用。
func isHan(r rune) bool {
	return (r >= 0x3400 && r <= 0x4dbf) || (r >= 0x4e00 && r <= 0x9fff) ||
		(r >= 0xf900 && r <= 0xfaff) || (r >= 0x20000 && r <= 0x2fa1f)
}

// normalizeClause 整理詞組字面：`.` 只留「前後都是漢字」的那些，其餘丟掉。
func normalizeClause(text string) (string, bool) {
	runes := []rune(text)
	var out []rune
	wild := 0
	for i := 0; i < len(runes); i++ {
		if runes[i] != '.' {
			out = append(out, runes[i])
			continue
		}
		j := i
		for j < len(runes) && runes[j] == '.' {
			j++
		}
		var prev rune
		if len(out) > 0 {
			prev = out[len(out)-1]
		}
		var next rune
		if j < len(runes) {
			next = runes[j]
		}
		if isHan(prev) && isHan(next) && wild < maxWildcards {
			n := j - i
			if n > maxWildcards-wild {
				n = maxWildcards - wild
			}
			for k := 0; k < n; k++ {
				out = append(out, '.')
			}
			wild += n
		}
		i = j - 1
	}
	s := string(out)
	return s, strings.Contains(s, ".")
}

// parseQuery 把輸入切成詞組（空白／`+`／`-`／`*` 都是分隔，三個運算子作用在
// 緊接在後面的那一個詞組上）。
func parseQuery(text string) []queryClause {
	var out []queryClause
	var buf []rune
	role := ""
	near := false
	flush := func() {
		if len(buf) == 0 {
			role, near = "", false
			return
		}
		raw := string(buf)
		buf = buf[:0]
		norm, wild := normalizeClause(raw)
		if norm == "" {
			role, near = "", false
			return
		}
		parts := []string{norm}
		if wild {
			parts = strings.Split(norm, ".")
		}
		r := role
		if r == "" {
			r = "optional"
		}
		out = append(out, queryClause{Text: norm, Role: r, NearPrev: near, Parts: parts, Wild: wild})
		role, near = "", false
	}
	for _, ch := range text {
		switch ch {
		case ' ', '\t', '\n', '\r', '\u3000':
			flush()
			continue
		case '*':
			flush()
			near = true
			continue
		case '+':
			flush()
			role = "required"
			continue
		case '-':
			flush()
			role = "excluded"
			continue
		}
		buf = append(buf, ch)
	}
	flush()
	return out
}

// queryTokens 是查詢用的 tokenizer（與 TS `queryTokens()` 對齊）：
// CJK 每個字一個 token；拉丁字母／數字連成一串；其餘字元跳過。
func queryTokens(s string) []string {
	var out []string
	var word []rune
	flushWord := func() {
		if len(word) > 0 {
			out = append(out, string(word))
			word = word[:0]
		}
	}
	for _, r := range s {
		switch {
		case unicode.Is(unicode.Han, r) || r == '〇' || (r >= 0x3400 && r <= 0x4dbf):
			flushWord()
			out = append(out, string(r))
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			word = append(word, r)
		default:
			flushWord()
		}
	}
	flushWord()
	return out
}

// wildcard 佔位：詞組裡的 `.`（任意一個 token）
var wildPlaceholder = []int32(nil)

// clausePostings 取得一個詞組每個位置的 posting；`.` 的位置是 nil。
//
// `varIndex`（字 → 同組字串）來自 TS 的**變體表**（繁簡通檢）：同一個字的所有寫法
// 的 posting 取聯集。作者 2026-10：聯集的合併是計算量最大的部分，所以放在 Go 做
// （TS 只把「這一組有哪些字」傳過來，表本身很小）。
func (f *adbSearchFile) clausePostings(c queryClause, varIndex map[string]string) (tokens []string, lists [][]int32, missing []string) {
	push := func(t string) {
		tokens = append(tokens, t)
		l := f.postingsFor(t, varIndex)
		if len(l) == 0 {
			missing = append(missing, t)
			lists = append(lists, nil)
			return
		}
		lists = append(lists, l)
	}
	if !c.Wild {
		for _, t := range queryTokens(c.Text) {
			push(t)
		}
		return
	}
	for i, part := range c.Parts {
		if i > 0 {
			lists = append(lists, wildPlaceholder) // nil ＝ 任意一個 token
		}
		for _, t := range queryTokens(part) {
			push(t)
		}
	}
	return
}

// postingsFor 取一個 token 的 posting：有變體組就把同組字的 posting 全部聯集起來。
func (f *adbSearchFile) postingsFor(token string, varIndex map[string]string) []int32 {
	group := varIndex[token]
	if len(group) <= 1 {
		l, _ := f.postingsOf(token)
		return l
	}
	var parts [][]int32
	for _, ch := range group {
		l, ok := f.postingsOf(string(ch))
		if ok && len(l) > 0 {
			parts = append(parts, l)
		}
	}
	return unionPostings(parts)
}

// unionPostings 把多個遞增的 posting 合併成一個遞增、不重複的清單。
func unionPostings(lists [][]int32) []int32 {
	switch len(lists) {
	case 0:
		return nil
	case 1:
		return lists[0]
	}
	total := 0
	for _, l := range lists {
		total += len(l)
	}
	out := make([]int32, 0, total)
	idx := make([]int, len(lists))
	for {
		best := -1
		var bestVal int32
		for i, l := range lists {
			if idx[i] >= len(l) {
				continue
			}
			v := l[idx[i]]
			if best < 0 || v < bestVal {
				best, bestVal = i, v
			}
		}
		if best < 0 {
			return out
		}
		// 同一個 VA 可能出現在多個清單：一起跳過（去重）
		for i, l := range lists {
			if idx[i] < len(l) && l[idx[i]] == bestVal {
				idx[i]++
			}
		}
		out = append(out, bestVal)
	}
}

// postingsOf 取單一 token 的 posting（找不到回空）。
func (f *adbSearchFile) postingsOf(token string) ([]int32, bool) {
	toks, ok := f.container("tokens")
	if !ok {
		return nil, false
	}
	i := tokenIndexByName(toks, token)
	if i < 0 {
		return nil, false
	}
	l, err := f.blockList("tokens", i)
	if err != nil {
		return nil, false
	}
	return l, true
}

// phraseMatchPattern 支援 nil（萬用字元）的詞組比對，與 TS 版同一套規則。
func phraseMatchPattern(lists [][]int32, limit int) []phraseHit {
	if len(lists) == 0 {
		return nil
	}
	allReal := true
	for _, l := range lists {
		if l == nil {
			allReal = false
			break
		}
	}
	if allReal {
		return phraseMatch(lists, limit)
	}
	anchor := -1
	for i, l := range lists {
		if l != nil {
			anchor = i
			break
		}
	}
	if anchor < 0 {
		return nil
	}
	out := make([]phraseHit, 0, 1024)
	for _, va := range lists[anchor] {
		start := va - int32(anchor)
		if start < 0 {
			continue
		}
		ok := true
		for i, l := range lists {
			if l == nil || i == anchor {
				continue
			}
			if !hasVa(l, start+int32(i)) {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, phraseHit{VA: start, Units: int32(len(lists))})
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

// hasVa：遞增序列裡有沒有 target。
func hasVa(xs []int32, target int32) bool {
	i := lowerBound(xs, target, 0)
	return i < len(xs) && xs[i] == target
}

// SearchQuery 是 Go 後端的查詢入口：查詢字串 → 每個詞組的命中。
// TS 端（`backend.ts`）拿到之後照樣做分段與 BM25，所以結果與純 TS 後端一致。
//
// `groups` 是**變體表**（繁簡通檢）：每個字串是一組互為異體的單字（例如「菩萨薩」），
// TS 只傳查詢裡用得到的那些組；Go 在取 posting 時把同組字的清單聯集起來
// （`unionPostings`，計算量最大的部分留在這裡）。沒有變體需求時傳空陣列即可。
func (h *AdbHost) SearchQuery(path string, query string, maxHits int, groups []string) (*QueryOut, error) {
	if maxHits <= 0 {
		maxHits = 2000
	}
	f, err := h.searchFile(path)
	if err != nil {
		return nil, err
	}
	varIndex := map[string]string{}
	for _, g := range groups {
		runes := []rune(g)
		if len(runes) < 2 {
			continue
		}
		for _, r := range runes {
			if _, ok := varIndex[string(r)]; !ok {
				varIndex[string(r)] = g
			}
		}
	}
	t0 := time.Now()
	out := &QueryOut{Query: query, Clauses: []clauseHits{}, Missing: []string{}}
	clauses := parseQuery(query)
	// 每個詞組的 posting 平行解（詞組之間互不相依）
	results := make([]clauseHits, len(clauses))
	var wg sync.WaitGroup
	for i, c := range clauses {
		wg.Add(1)
		go func(i int, c queryClause) {
			defer wg.Done()
			tokens, lists, missing := f.clausePostings(c, varIndex)
			ch := clauseHits{
				Text: c.Text, Tokens: tokens, Role: c.Role, NearOf: -1,
				Wildcard: c.Wild, Missing: missing, Hits: []phraseHit{},
			}
			if c.NearPrev && i > 0 {
				ch.NearOf = i - 1
			}
			if len(lists) > 0 && len(missing) == 0 {
				ch.Hits = phraseMatchPattern(lists, maxHits)
			}
			ch.Occurrences = len(ch.Hits)
			results[i] = ch
		}(i, c)
	}
	wg.Wait()
	color := 0
	for _, ch := range results {
		if ch.Role == "excluded" {
			ch.ColorIndex = -1
		} else {
			ch.ColorIndex = color
			color++
		}
		if ch.Missing == nil {
			ch.Missing = []string{}
		}
		out.Clauses = append(out.Clauses, ch)
		seen := map[string]bool{}
		for _, m := range out.Missing {
			seen[m] = true
		}
		for _, m := range ch.Missing {
			if !seen[m] {
				seen[m] = true
				out.Missing = append(out.Missing, m)
			}
		}
	}
	out.Ms = float64(time.Since(t0).Microseconds()) / 1000
	return out, nil
}

// 讓 `go vet` 不抱怨未使用的 wildPlaceholder（它代表「nil 佔位」的語意）。
func init() { _ = wildPlaceholder }

var _ = fmt.Sprintf
