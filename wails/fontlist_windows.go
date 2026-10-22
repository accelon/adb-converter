//go:build windows

package main

// 已安裝字型（Windows）：讀登錄檔的 Fonts 機碼（作者 2026-10-22 的需求：
// exe 要列出使用者安裝的字型；網頁版只列內建清單）。
//
// 為什麼是登錄檔而不是 DirectWrite：不需要 COM／CGO，兩張檢視表（64／32 位元）
// 與每位使用者的字型都涵蓋；值名是「家族＋樣式 (TrueType)」，把樣式與括號去掉
// 就是 CSS 要的 font-family。讀不到就回空陣列（前端會退回內建清單）。

import (
	"sort"
	"strings"

	"golang.org/x/sys/windows/registry"
)

func systemFonts() []string {
	seen := map[string]bool{}
	var out []string
	for _, root := range []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER} {
		for _, sub := range []string{
			`SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts`,
			`SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Fonts`,
		} {
			readFontKey(root, sub, seen, &out)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i]) < strings.ToLower(out[j])
	})
	return out
}

func readFontKey(root registry.Key, sub string, seen map[string]bool, out *[]string) {
	k, err := registry.OpenKey(root, sub, registry.READ)
	if err != nil {
		return
	}
	defer k.Close()
	names, err := k.ReadValueNames(0)
	if err != nil {
		return
	}
	for _, name := range names {
		for _, family := range fontFamilies(name) {
			key := strings.ToLower(family)
			if seen[key] {
				continue
			}
			seen[key] = true
			*out = append(*out, family)
		}
	}
}

// fontFamilies 把登錄值名變成家族名：
//
//	"Arial Bold (TrueType)"                       → Arial
//	"Microsoft JhengHei & Microsoft JhengHei UI (TrueType)" → 兩個家族
//	"PMingLiU-ExtB (TrueType)"                    → PMingLiU-ExtB（ExtB 是家族的一部分）
func fontFamilies(valueName string) []string {
	s := strings.TrimSpace(valueName)
	for _, suffix := range []string{
		" (TrueType)", " (OpenType)", " (All res)", " (PostScript)", " (Type 1)",
		" (TrueType Collection)", " (OpenType Collection)",
	} {
		s = strings.TrimSuffix(s, suffix)
	}
	var families []string
	for _, part := range strings.Split(s, "&") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		// 去掉樣式字尾（重複幾次，像 "Bold Italic" 這種）
		for changed := true; changed; {
			changed = false
			for _, style := range []string{
				" Bold Italic", " Bold Oblique", " Bold", " Italic", " Oblique",
				" Light Italic", " Light", " Semibold Italic", " Semibold",
				" Demibold", " Medium Italic", " Medium", " Black Italic", " Black",
				" Heavy", " Thin Italic", " Thin", " ExtraLight", " ExtraBold",
				" Regular", " Normal",
			} {
				if strings.HasSuffix(part, style) {
					part = strings.TrimSuffix(part, style)
					changed = true
				}
			}
		}
		part = strings.TrimSpace(part)
		if part != "" {
			families = append(families, part)
		}
	}
	return families
}
