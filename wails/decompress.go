package main

import (
	"bytes"
	"compress/bzip2"
	"fmt"
	"io"
)

// ---- bzip2 解壓：有 Go 版就用 Go（作者 2026-10） --------------------------------
//
// adb 的 source 每個 block 都是一個獨立的 bzip2 stream，所以標準庫的 compress/bzip2
// （一次讀一個 stream）剛好夠用，不必自己解碼。前端在**沒有宿主**時仍然走 TypeScript 的
// vendor bzip2（file:// 版就是那條路）；有宿主時走這裡，省掉前端一次解壓＋一次 UTF-16 解碼。
//
// 兩個入口都直接吃 mmap 的切片：
//   DecompressText   → 解壓 + UTF-16LE + 截到第一個 NUL，回字串（JSON 傳輸比 base64 小）
//   DecompressBase64 → 解壓後的原生位元組（physicalBytes 要位元組，不要字串）

// withRange 取得 [offset, offset+length) 的映射切片並呼叫 fn，用完自動 release。
// 越界或負數回 error（不 panic）。
func (h *AdbHost) withRange(path string, offset int64, length int, fn func(view []byte) error) error {
	if length < 0 {
		return fmt.Errorf("negative length: %d", length)
	}
	if offset < 0 {
		return fmt.Errorf("negative offset: %d", offset)
	}
	m, err := h.acquire(path)
	if err != nil {
		return err
	}
	defer h.release(m)
	end := offset + int64(length)
	if end < offset || end > m.size {
		return fmt.Errorf("range [%d,%d) out of bounds (size %d)", offset, end, m.size)
	}
	return fn(m.view[offset:end])
}

// bunzip 解一個 bzip2 stream（一個 source block）成原生位元組。
// 多 stream 串接的檔案這裡不需要處理：呼叫端一次只給一個 block 的範圍。
func bunzip(src []byte) ([]byte, error) {
	out, err := io.ReadAll(bzip2.NewReader(bytes.NewReader(src)))
	if err != nil {
		return nil, fmt.Errorf("bzip2: %w", err)
	}
	return out, nil
}

// firstNulUnit 回傳第一個 UTF-16LE NUL（兩個 0）的 code unit 索引，沒有就回 -1。
// 這與 TypeScript 端 sourceText 的截斷規則一致。
func firstNulUnit(raw []byte) int {
	units := len(raw) / 2
	for i := 0; i < units; i++ {
		if raw[i*2] == 0 && raw[i*2+1] == 0 {
			return i
		}
	}
	return -1
}

// DecompressText 解壓 [offset, offset+length) 這一個 source block，回傳它的文字。
// 這是 sourceText() 在桌面版的快速路徑（前端不必再解壓、也不必再解 UTF-16）。
func (h *AdbHost) DecompressText(path string, offset int64, length int) (string, error) {
	var out string
	err := h.withRange(path, offset, length, func(view []byte) error {
		raw, err := bunzip(view)
		if err != nil {
			return err
		}
		if i := firstNulUnit(raw); i >= 0 {
			raw = raw[:i*2]
		}
		out = decodeUTF16LE(raw)
		return nil
	})
	return out, err
}
