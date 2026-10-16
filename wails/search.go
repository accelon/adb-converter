package main

import (
	"encoding/binary"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

// ---- 索引查詢（plAnd／posting 分群）在 Go 做 ----------------------------------
//
// 作者 2026-10：把 plAnd（詞組 AND）與 posting 分群統計做成 Go 版，TypeScript 直接取得
// 詞的 posting 與分群統計；計算量大的部分可以平行。
//
// 這一層只做「查索引」，不做任何語言處理：查詢字串的切詞仍在 TypeScript（tokenize.ts 是
// Delphi 移植，屬於語言層），Go 收到的是**已經切好的詞**，負責：
//   1. 在 tokens 容器的名稱表裡二分搜尋（UTF-16 code unit 序，與 adb 的排序一致）
//   2. 解開該詞的 packed posting list（varint delta；見 decodePackedList）
//   3. phraseMatch：把多個 posting list 取交集（相鄰 VA ＝ 命中）＝ plAnd
//   4. groupHits：把命中依「分群標籤的實例範圍」統計
// 多個詞的 posting 解壓用 goroutine 平行（見 SearchTokens）。

const (
	romblockHeaderSize = 16
	mileDistance       = 512
	boWithPointer      = 0x40000000
	boNamed            = 0x10000000
)

// packedListSize 是 packed list 的總位元組數（含 milestone 表）。
func packedListSize(added int64) int64 {
	return 4 + (added/mileDistance)*8 + added
}

// adbContainer 是解析一個容器只需要的那幾個欄位（資料本身留在 mmap 裡不複製）。
type adbContainer struct {
	name           string
	dataStart      int64
	totalBlockSize int64
	blockSize      int64
	feature        uint32
	count          int
	ends           []int64 // blockSize == 0 時的累積長度表
	names          []string
}

// adbSearchFile 是一個已 mmap 的 .adb 的「可查詢」視圖：容器表 ＋ 直接指向映射的視野。
type adbSearchFile struct {
	view       []byte
	maxVa      int32
	containers map[string]*adbContainer
}

func (f *adbSearchFile) slice(start, length int64) ([]byte, error) {
	if start < 0 || length < 0 || start+length > int64(len(f.view)) {
		return nil, fmt.Errorf("read [%d,%d) out of range (size %d)", start, start+length, len(f.view))
	}
	return f.view[start : start+length], nil
}

func blockRangeOf(c *adbContainer, i int) (int64, int64) {
	if c.ends != nil {
		start := c.dataStart
		if i > 0 {
			start += c.ends[i-1]
		}
		return start, c.dataStart + c.ends[i]
	}
	return c.dataStart + int64(i)*c.blockSize, c.dataStart + int64(i+1)*c.blockSize
}

// decodePackedList 解開 packed list：4 位元組長度 ＋ milestone 表（每 512 位元組 8 位元組）
// ＋ 每個值一個 LEB128 delta（累加成遞增的 VA）。與 adb.ts 的 decodePackedList 逐位元組一致。
func decodePackedList(buf []byte) ([]int32, error) {
	if len(buf) < 4 {
		return nil, fmt.Errorf("packed list too short (%d)", len(buf))
	}
	added := int64(binary.LittleEndian.Uint32(buf[0:4]))
	off := 4 + (added/mileDistance)*8
	end := off + added
	if end > int64(len(buf)) {
		return nil, fmt.Errorf("packed list wants %d bytes, have %d", end, len(buf))
	}
	out := make([]int32, 0, added/2+1)
	var v int32
	for off < end {
		var delta uint32
		var shift uint
		c := buf[off]
		for {
			delta += uint32(c&0x7f) << shift
			shift += 7
			off++
			if off < end {
				c = buf[off]
			}
			if !(c >= 0x80 && off < end && shift < 32) {
				break
			}
		}
		v += int32(delta)
		out = append(out, v)
	}
	return out, nil
}

// parseContainer 解析一個容器（只讀表頭、長度表、名稱表；payload 不讀）。
func (f *adbSearchFile) parseContainer(start int64, name string) (*adbContainer, error) {
	h, err := f.slice(start, romblockHeaderSize)
	if err != nil {
		return nil, err
	}
	feature := binary.LittleEndian.Uint32(h[0:4])
	total := int64(binary.LittleEndian.Uint32(h[8:12]))
	blockSize := int64(int32(binary.LittleEndian.Uint32(h[12:16])))
	dataStart := start + romblockHeaderSize
	c := &adbContainer{name: name, dataStart: dataStart, totalBlockSize: total, blockSize: blockSize, feature: feature}
	if blockSize == 0 {
		listStart := dataStart + total
		head, err := f.slice(listStart, 4)
		if err != nil {
			return nil, err
		}
		added := int64(binary.LittleEndian.Uint32(head))
		raw, err := f.slice(listStart, packedListSize(added))
		if err != nil {
			return nil, err
		}
		ends, err := decodePackedList(raw)
		if err != nil {
			return nil, err
		}
		c.ends = make([]int64, len(ends))
		for i, e := range ends {
			c.ends[i] = int64(e)
		}
		c.count = len(c.ends)
	} else {
		c.count = int(total / blockSize)
	}
	if feature&boNamed != 0 {
		switch {
		case len(c.ends) >= 2:
			nb, err := f.parseContainer(dataStart+c.ends[len(c.ends)-2], name+"#names")
			if err != nil {
				return nil, err
			}
			n := nb.count
			if nb.ends != nil {
				n = len(nb.ends)
			}
			for i := 0; i < n; i++ {
				r0, r1 := blockRangeOf(nb, i)
				l := r1 - r0 - 2
				if l <= 0 {
					continue
				}
				raw, err := f.slice(r0, l)
				if err != nil {
					return nil, err
				}
				c.names = append(c.names, decodeUTF16LE(raw))
			}
			c.count--
		case c.ends == nil:
			begin := int64(c.count-1) * blockSize
			raw, err := f.slice(dataStart+begin, blockSize)
			if err != nil {
				return nil, err
			}
			for _, s := range strings.Split(decodeUTF16LE(raw), "\x00") {
				if s != "" {
					c.names = append(c.names, s)
				}
			}
			c.count--
		}
	}
	return c, nil
}

// container 回傳具名容器（解析一次後快取）。
func (f *adbSearchFile) container(name string) (*adbContainer, bool) {
	c, ok := f.containers[name]
	return c, ok
}

// blockList 讀出某容器第 index 個 block 的 packed list。
func (f *adbSearchFile) blockList(name string, index int) ([]int32, error) {
	c, ok := f.container(name)
	if !ok {
		return nil, fmt.Errorf("no container %s", name)
	}
	if index < 0 || index >= c.count {
		return nil, fmt.Errorf("%s[%d] out of range 0..%d", name, index, c.count-1)
	}
	r0, r1 := blockRangeOf(c, index)
	raw, err := f.slice(r0, r1-r0)
	if err != nil {
		return nil, err
	}
	return decodePackedList(raw)
}

// compareUTF16 依 UTF-16 code unit 序比較（adb 名稱表的排序），與 search.ts 相同。
func compareUTF16(a, b string) int {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	n := len(ua)
	if len(ub) < n {
		n = len(ub)
	}
	for i := 0; i < n; i++ {
		if ua[i] != ub[i] {
			if ua[i] < ub[i] {
				return -1
			}
			return 1
		}
	}
	return len(ua) - len(ub)
}

// tokenIndexByName 在名稱表裡二分搜尋（名稱表已按 UTF-16 code unit 排序）。
func tokenIndexByName(c *adbContainer, name string) int {
	if len(c.names) == 0 {
		return -1
	}
	lo, hi := 0, len(c.names)-1
	for lo <= hi {
		mid := (lo + hi) / 2
		switch cmp := compareUTF16(c.names[mid], name); {
		case cmp == 0:
			return mid
		case cmp < 0:
			lo = mid + 1
		default:
			hi = mid - 1
		}
	}
	return -1
}

// innerStrings 讀出「本身就是容器」的內部容器（caches/<key>）的所有字串。
// 與 adb.ts 的 innerStrings 相同：每塊去掉最後 2 位元組（NUL），一次讀完整段資料區。
func (f *adbSearchFile) innerStrings(inner *adbContainer) ([]string, error) {
	if inner.count <= 0 {
		return nil, nil
	}
	buf, err := f.slice(inner.dataStart, inner.totalBlockSize)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, inner.count)
	for i := 0; i < inner.count; i++ {
		r0, r1 := blockRangeOf(inner, i)
		a, b := r0-inner.dataStart, r1-inner.dataStart
		if b-a < 2 {
			out = append(out, "")
			continue
		}
		out = append(out, decodeUTF16LE(buf[a:b-2]))
	}
	return out, nil
}

// cachedStrings 取得 caches/<key> 這張現成的字串表（分群名稱就用它，與 search.ts 一致）。
func (f *adbSearchFile) cachedStrings(key string) ([]string, error) {
	caches, ok := f.container("caches")
	if !ok {
		return nil, nil
	}
	ci := -1
	for i, n := range caches.names {
		if n == key {
			ci = i
			break
		}
	}
	if ci < 0 {
		return nil, nil
	}
	r0, _ := blockRangeOf(caches, ci)
	inner, err := f.parseContainer(r0, "caches/"+key)
	if err != nil {
		return nil, err
	}
	return f.innerStrings(inner)
}

// ---- plAnd（詞組交集 ＝ search.pas TPhraseHits.nextmatch 的移植） --------------

// phraseHit 是一次命中：起始 VA 與覆蓋的 VA 單位數（＝詞數）。
type phraseHit struct {
	VA    int32 `json:"va"`
	Units int32 `json:"units"`
}

// phraseMatch 找出 lists[0..n-1] 在 VA 空間連續出現的位置。
// idx 會跨外圈迭代保留（merge 式推進），與 TypeScript 版逐行等價。
func phraseMatch(lists [][]int32, limit int) []phraseHit {
	if len(lists) == 0 {
		return nil
	}
	if len(lists) == 1 {
		n := len(lists[0])
		if limit < n {
			n = limit
		}
		out := make([]phraseHit, 0, n)
		for _, va := range lists[0][:n] {
			out = append(out, phraseHit{VA: va, Units: 1})
		}
		return out
	}
	n := len(lists)
	idx := make([]int, n)
	out := make([]phraseHit, 0, 4096)
	for _, start := range lists[0] {
		target := start
		ok := true
		for i := 1; i < n; i++ {
			idx[i] = lowerBound(lists[i], target, idx[i])
			if idx[i] >= len(lists[i]) {
				ok = false
				break
			}
			target = lists[i][idx[i]]
		}
		if ok && target == start+int32(n-1) {
			out = append(out, phraseHit{VA: start, Units: int32(n)})
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

// lowerBound 回傳第一個 >= target 的索引（遞增序列，從 from 開始找）。
func lowerBound(xs []int32, target int32, from int) int {
	lo, hi := from, len(xs)
	for lo < hi {
		mid := (lo + hi) / 2
		if xs[mid] < target {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo
}

// binarySearchLE 回傳最後一個 <= target 的索引（遞增序列），沒有就 -1。
func binarySearchLE(xs []int32, target int32) int {
	lo, hi, best := 0, len(xs)-1, -1
	for lo <= hi {
		mid := (lo + hi) / 2
		if xs[mid] <= target {
			best = mid
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	return best
}

// searchGroup 是一群的統計（名稱、VA 範圍、命中數）。
type searchGroup struct {
	Name  string `json:"name"`
	From  int32  `json:"from"`
	To    int32  `json:"to"`
	Count int    `json:"count"`
}

// groupHits 依分群標籤的實例範圍統計命中（與 search.ts 的 groupHits 等價）。
// 命中數多時會用 goroutine 分塊平行（作者：計算量大的函式可以做 Go 平行版）。
func groupHits(hits []phraseHit, groupVa []int32, maxVa int32, names []string) []searchGroup {
	if len(groupVa) == 0 {
		return nil
	}
	groups := make([]searchGroup, len(groupVa))
	for i, from := range groupVa {
		to := maxVa
		if i+1 < len(groupVa) {
			to = groupVa[i+1]
		}
		name := "#" + itoa(i+1)
		if i < len(names) {
			name = names[i]
		}
		groups[i] = searchGroup{Name: name, From: from, To: to}
	}
	const parallelAt = 20000
	if len(hits) >= parallelAt {
		workers := runtimeNumCPU()
		partial := make([][]int, workers)
		var wg sync.WaitGroup
		chunk := (len(hits) + workers - 1) / workers
		for w := 0; w < workers; w++ {
			lo := w * chunk
			hi := lo + chunk
			if hi > len(hits) {
				hi = len(hits)
			}
			if lo >= hi {
				continue
			}
			partial[w] = make([]int, len(groups))
			wg.Add(1)
			go func(w, lo, hi int) {
				defer wg.Done()
				counts := partial[w]
				for _, h := range hits[lo:hi] {
					i := binarySearchLE(groupVa, h.VA)
					if i < 0 {
						continue
					}
					if h.VA >= groups[i].From && h.VA < groups[i].To {
						counts[i]++
					}
				}
			}(w, lo, hi)
		}
		wg.Wait()
		for _, counts := range partial {
			for i, c := range counts {
				groups[i].Count += c
			}
		}
		return groups
	}
	for _, h := range hits {
		i := binarySearchLE(groupVa, h.VA)
		if i < 0 {
			continue
		}
		if h.VA >= groups[i].From && h.VA < groups[i].To {
			groups[i].Count++
		}
	}
	return groups
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// ---- 暴露給 webview 的查詢入口 --------------------------------------------------

// SearchOut 是一次查詢回給 TypeScript 的全部東西：命中、缺詞、分群統計，以及各階段耗時
// （診斷用；前端不必依賴它們）。
type SearchOut struct {
	Query     string        `json:"query"`
	Tokens    []string      `json:"tokens"`
	Hits      []phraseHit   `json:"hits"`
	Missing   []string      `json:"missing"`
	Truncated bool          `json:"truncated"`
	GroupTag  string        `json:"groupTag"`
	Groups    []searchGroup `json:"groups"`
	LookupMs  float64       `json:"lookupMs"`
	AndMs     float64       `json:"andMs"`
	GroupMs   float64       `json:"groupMs"`
	Parallel  bool          `json:"parallel"`
}

// indexOfName 線性找名稱表中的索引（tags 只有上百個名稱）。
func indexOfName(c *adbContainer, name string) int {
	for i, n := range c.names {
		if n == name {
			return i
		}
	}
	return -1
}

// searchFile 取得（並快取）path 的可查詢視圖。映射會被 Open 釘住，所以視野一直有效，
// 直到 Close／CloseAll（那時也一併清掉這個快取）。
func (h *AdbHost) searchFile(path string) (*adbSearchFile, error) {
	abs, err := h.resolve(path)
	if err != nil {
		return nil, err
	}
	key := strings.ToLower(abs)
	h.mu.Lock()
	if f := h.search[key]; f != nil {
		h.mu.Unlock()
		return f, nil
	}
	h.mu.Unlock()

	// 釘住映射（pinned）：容器與 posting block 之後都直接從這塊映射讀。
	if _, err := h.Open(abs); err != nil {
		return nil, err
	}
	m, err := h.acquire(abs)
	if err != nil {
		return nil, err
	}
	defer h.release(m)
	if len(m.view) < 256 {
		return nil, fmt.Errorf("file too small: %s", abs)
	}
	f := &adbSearchFile{
		view:       m.view,
		maxVa:      int32(binary.LittleEndian.Uint32(m.view[96:100])),
		containers: map[string]*adbContainer{},
	}
	top, err := f.parseContainer(256, "")
	if err != nil {
		return nil, err
	}
	for i, name := range top.names {
		r0, _ := blockRangeOf(top, i)
		c, err := f.parseContainer(r0, name)
		if err != nil {
			return nil, err
		}
		f.containers[name] = c
	}
	h.mu.Lock()
	if h.search == nil {
		h.search = map[string]*adbSearchFile{}
	}
	h.search[key] = f
	h.mu.Unlock()
	return f, nil
}

// Postings 回傳某個詞的 posting（VA 清單，遞增）——
// 「TypeScript 直接取得詞 posting」的入口。找不到該詞時回空清單（不報錯）。
func (h *AdbHost) Postings(path string, token string) ([]int32, error) {
	f, err := h.searchFile(path)
	if err != nil {
		return nil, err
	}
	toks, ok := f.container("tokens")
	if !ok {
		return nil, fmt.Errorf("no tokens container")
	}
	i := tokenIndexByName(toks, token)
	if i < 0 {
		return []int32{}, nil
	}
	return f.blockList("tokens", i)
}

// SearchTokens 一次做完：查詞 → 解 posting（多詞平行）→ plAnd → 分群統計。
// TypeScript 端只要切好詞（語言層留在 TS），其餘索引運算都在這裡。
func (h *AdbHost) SearchTokens(path string, tokens []string, groupTag string, maxHits int) (*SearchOut, error) {
	if maxHits <= 0 {
		maxHits = 5000
	}
	f, err := h.searchFile(path)
	if err != nil {
		return nil, err
	}
	toks, ok := f.container("tokens")
	if !ok {
		return nil, fmt.Errorf("no tokens container")
	}
	out := &SearchOut{Tokens: tokens, GroupTag: groupTag, Hits: []phraseHit{}, Groups: []searchGroup{}}

	lists := make([][]int32, len(tokens))
	missing := make([]string, 0)
	var mu sync.Mutex
	lookup := func(i int, t string) {
		idx := tokenIndexByName(toks, t)
		if idx < 0 {
			mu.Lock()
			missing = append(missing, t)
			mu.Unlock()
			return
		}
		l, err := f.blockList("tokens", idx)
		if err != nil {
			mu.Lock()
			missing = append(missing, t)
			mu.Unlock()
			return
		}
		lists[i] = l
	}

	// 多個詞的 posting 各自解壓：這是唯一「計算量隨語料成長」的步驟，所以平行。
	t0 := time.Now()
	if len(tokens) > 1 {
		out.Parallel = true
		var wg sync.WaitGroup
		for i, t := range tokens {
			wg.Add(1)
			go func(i int, t string) {
				defer wg.Done()
				lookup(i, t)
			}(i, t)
		}
		wg.Wait()
	} else {
		for i, t := range tokens {
			lookup(i, t)
		}
	}
	out.LookupMs = msSince(t0)
	if len(missing) > 0 {
		out.Missing = missing
		return out, nil
	}

	t1 := time.Now()
	out.Hits = phraseMatch(lists, maxHits)
	out.AndMs = msSince(t1)
	out.Truncated = len(out.Hits) >= maxHits

	if len(out.Hits) > 0 && groupTag != "" {
		t2 := time.Now()
		if tags, ok := f.container("tags"); ok {
			if ti := indexOfName(tags, groupTag); ti >= 0 {
				groupVa, err := f.blockList("tags", ti)
				if err == nil && len(groupVa) > 0 {
					names, _ := f.cachedStrings(groupTag)
					if len(names) != len(groupVa) {
						names = nil // 名稱表對不上就退回 #N（與 TypeScript 端的規則一致）
					}
					out.Groups = groupHits(out.Hits, groupVa, f.maxVa, names)
				}
			}
		}
		out.GroupMs = msSince(t2)
	}
	return out, nil
}

func msSince(t time.Time) float64 {
	return float64(time.Since(t).Microseconds()) / 1000
}

func runtimeNumCPU() int { return runtime.NumCPU() }
