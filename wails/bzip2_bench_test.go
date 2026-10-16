package main

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"testing"
	"time"
)

// 真實 source block 的 bzip2 解壓量測（與 TypeScript 版同一批位元組）。
// 位元組由 `cd ts && bun run tools/bzip2-bench.ts` 寫出來（每個檔一個 bzip2 stream）。
//
//	cd wails
//	go test -run TestBzip2Throughput -v
//	go test -run XXX -bench . -benchtime=2s
func loadBlocks(tb testing.TB) [][]byte {
	tb.Helper()
	names, err := filepath.Glob(filepath.Join("..", "build", "bzip2-blocks", "block-*.bin"))
	if err != nil || len(names) == 0 {
		tb.Skip("沒有 block：先跑 `bun run build/probe-bzip2.ts`")
	}
	sort.Strings(names)
	out := make([][]byte, 0, len(names))
	for _, n := range names {
		b, err := os.ReadFile(n)
		if err != nil {
			tb.Fatal(err)
		}
		out = append(out, b)
	}
	return out
}

func totals(blocks [][]byte) (compressed, decoded int64) {
	for _, blk := range blocks {
		compressed += int64(len(blk))
		raw, err := bunzip(blk)
		if err != nil {
			panic(err)
		}
		decoded += int64(len(raw))
	}
	return
}

// TestBzip2Throughput 印出單核與多核的實際吞吐（MiB/s 以解壓後位元組計）。
func TestBzip2Throughput(t *testing.T) {
	blocks := loadBlocks(t)
	compressed, decoded := totals(blocks)
	const reps = 5

	start := time.Now()
	for r := 0; r < reps; r++ {
		for _, blk := range blocks {
			if _, err := bunzip(blk); err != nil {
				t.Fatal(err)
			}
		}
	}
	seqMs := float64(time.Since(start).Microseconds()) / 1000 / reps

	// 每個 block 的單獨延遲（中位數）
	lats := make([]float64, 0, len(blocks))
	for _, blk := range blocks {
		t0 := time.Now()
		if _, err := bunzip(blk); err != nil {
			t.Fatal(err)
		}
		lats = append(lats, float64(time.Since(t0).Microseconds())/1000)
	}
	sort.Float64s(lats)
	median := lats[len(lats)/2]

	workers := runtime.NumCPU()
	parStart := time.Now()
	for r := 0; r < reps; r++ {
		ch := make(chan []byte)
		var wg sync.WaitGroup
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for blk := range ch {
					if _, err := bunzip(blk); err != nil {
						t.Error(err)
					}
				}
			}()
		}
		for _, blk := range blocks {
			ch <- blk
		}
		close(ch)
		wg.Wait()
	}
	parMs := float64(time.Since(parStart).Microseconds()) / 1000 / reps

	mib := func(bytes int64, ms float64) float64 { return float64(bytes) / 1048576 / (ms / 1000) }
	t.Logf("%d 個 block：壓縮 %.2f MiB → 解壓 %.2f MiB", len(blocks), float64(compressed)/1048576, float64(decoded)/1048576)
	t.Logf("Go compress/bzip2 單核：%.1f ms/輪、%.0f MiB/s（解壓後）；每 block 中位數 %.2f ms",
		seqMs, mib(decoded, seqMs), median)
	t.Logf("Go 平行 %d 核：%.1f ms/輪、%.0f MiB/s（加速 %.1fx）",
		workers, parMs, mib(decoded, parMs), seqMs/parMs)
}

func BenchmarkBunzip(b *testing.B) {
	blocks := loadBlocks(b)
	_, decoded := totals(blocks)
	b.SetBytes(decoded / int64(len(blocks)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, blk := range blocks {
			if _, err := bunzip(blk); err != nil {
				b.Fatal(err)
			}
		}
	}
}

func BenchmarkBunzipParallel(b *testing.B) {
	blocks := loadBlocks(b)
	_, decoded := totals(blocks)
	b.SetBytes(decoded / int64(len(blocks)))
	workers := runtime.NumCPU()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ch := make(chan []byte)
		var wg sync.WaitGroup
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for blk := range ch {
					if _, err := bunzip(blk); err != nil {
						b.Error(err)
					}
				}
			}()
		}
		for _, blk := range blocks {
			ch <- blk
		}
		close(ch)
		wg.Wait()
	}
}
