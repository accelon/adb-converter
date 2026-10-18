package main

import "fmt"

// ---- 字數（作者 2026-10-18）----------------------------------------------------
//
// adb 選單要顯示每個資料庫的「字數」。這個數字不在檔頭裡：source 容器是一堆
// **獨立的 bzip2 block**，要解壓後才知道有多少 UTF-16 code unit（＝ corpus-scan
// 的 chars 欄，13j 831,156／佛光大辭典 6,619,481／印順 8,847,831）。
//
// 所以只能在背景算一次（前端會快取）。放在 Go 這裡做，是因為一次呼叫就掃完，
// 不必每個 block 走一趟 Wails IPC（809 個 block 那會是幾秒）。

// SourceCharCount 回傳 source 容器所有 block 解壓、截到第一個 NUL 之後的
// UTF-16 code unit 總數。與 TypeScript 端 sourceText() 的截斷規則一致。
func (h *AdbHost) SourceCharCount(path string) (int, error) {
	f, err := h.searchFile(path)
	if err != nil {
		return 0, err
	}
	c, ok := f.container("source")
	if !ok {
		return 0, fmt.Errorf("no source container")
	}
	total := 0
	for i := 0; i < c.count; i++ {
		start, end := blockRangeOf(c, i)
		raw, err := bunzip(f.view[start:end])
		if err != nil {
			return 0, err
		}
		if n := firstNulUnit(raw); n >= 0 {
			raw = raw[:n*2]
		}
		total += len(raw) / 2
	}
	return total, nil
}
