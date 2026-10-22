//go:build darwin

package main

// 已安裝字型（macOS）：用 `system_profiler SPFontsDataType` 的文字輸出抓
// 「Family:」行（不用 CGO／CoreText，跨版本也穩定）。第一次呼叫可能幾秒，
// 所以快取；失敗就回空陣列，前端會退回內建清單。

import (
	"os/exec"
	"sort"
	"strings"
	"sync"
)

var (
	fontOnce  sync.Once
	fontCache []string
)

func systemFonts() []string {
	fontOnce.Do(func() {
		out, err := exec.Command("system_profiler", "SPFontsDataType").Output()
		if err != nil {
			return
		}
		seen := map[string]bool{}
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			const prefix = "Family:"
			if !strings.HasPrefix(line, prefix) {
				continue
			}
			name := strings.TrimSpace(strings.TrimPrefix(line, prefix))
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			fontCache = append(fontCache, name)
		}
		sort.Slice(fontCache, func(i, j int) bool {
			return strings.ToLower(fontCache[i]) < strings.ToLower(fontCache[j])
		})
	})
	return fontCache
}
