package main

// ---- 更新鏡像（作者 2026-10-29）--------------------------------------------------
//
// 主站 https://shutonggui.cn/accelon26/（大陸）＋鏡像 https://nissaya.cn/accelon26/
// （境外）。大陸使用者一般連不到 nissaya.cn，所以**預設主站**；前端探測兩站的延遲後
// 呼叫 SetUpdateMirror() 切換（見 ts/src/accelon26/mirror.ts）。
//
// 這裡只負責「目前用哪一個 base」與「探測某個 base 的延遲」。exe 更新與 adb manifest
// 都從同一個 base 組網址（.../accelon26.exe、.../versions.json、.../adb/manifest.json）。
//
// 檢查失敗時 checkUpdateNow() 會退回另一個已知的 base（例如鏡像被牆、主站臨時壞掉），
// 但只有「已知的兩個站」才回退；測試／自架用 ACCELON26_UPDATE_URL 指到本機時不回退，
// 免得測試偷偷連到正式站。

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	mirrorPrimaryBase  = "https://shutonggui.cn/accelon26/"
	mirrorOverseasBase = "https://nissaya.cn/accelon26/"
)

var mirrorSel = struct {
	mu   sync.RWMutex
	base string
}{base: mirrorPrimaryBase}

// normalizeMirrorBase 只收 http(s) 的「資料夾」網址，補上結尾的 `/`。
func normalizeMirrorBase(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", false
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return "", false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", false
	}
	if u.User != nil {
		return "", false
	}
	u.RawQuery, u.Fragment = "", ""
	if !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	return u.String(), true
}

func currentMirrorBase() string {
	mirrorSel.mu.RLock()
	defer mirrorSel.mu.RUnlock()
	return mirrorSel.base
}

// knownMirrorBases 是「可以互相回退」的正式站點（順序：主站、鏡像）。
func knownMirrorBases() []string { return []string{mirrorPrimaryBase, mirrorOverseasBase} }

// candidateBases 是這次檢查要依序嘗試的 base：目前選的站優先，再試另一個正式站。
// 目前 base 不是正式站（測試／自架）時只試它自己。
func candidateBases() []string {
	cur := currentMirrorBase()
	if !isKnownMirror(cur) {
		return []string{cur}
	}
	out := []string{cur}
	for _, b := range knownMirrorBases() {
		if b != cur {
			out = append(out, b)
		}
	}
	return out
}

func isKnownMirror(base string) bool {
	for _, b := range knownMirrorBases() {
		if b == base {
			return true
		}
	}
	return false
}

// SetUpdateMirror 由前端設定目前要用的站（自動探測或使用者指定）。
// 回傳 false＝網址不合法（不會改動目前設定）。
func (h *AdbHost) SetUpdateMirror(base string) bool {
	b, ok := normalizeMirrorBase(base)
	if !ok {
		return false
	}
	if currentMirrorBase() == b {
		return true            // 沒變：不要清掉剛檢查好的快取
	}
	mirrorSel.mu.Lock()
	mirrorSel.base = b
	mirrorSel.mu.Unlock()
	// 換站以後舊的檢查結果（遠端時間／下載網址）不能再用。
	h.mu.Lock()
	h.updateSt = UpdateStatus{}
	h.mu.Unlock()
	return true
}

// UpdateMirror 回傳目前設定的 base（前端顯示用）。
func (h *AdbHost) UpdateMirror() string { return currentMirrorBase() }

// MirrorProbe 是探測結果（前端用它決定自動要選哪一站）。
type MirrorProbe struct {
	OK    bool   `json:"ok"`
	MS    int    `json:"ms"`
	Error string `json:"error,omitempty"`
}

// ProbeMirror 量一個站點的延遲：對 versions.json 發 HEAD（加亂數避開快取），
// 量到回應標頭為止。timeoutMS<=0 時用 2000 ms。
//
// 不重用連線（DisableKeepAlives）：量的是「從這台機器連過去」的真實成本，
// 包含 DNS／TCP／TLS，而不是快取後的連線。
func (h *AdbHost) ProbeMirror(base string, timeoutMS int) MirrorProbe {
	b, ok := normalizeMirrorBase(base)
	if !ok {
		return MirrorProbe{Error: "網址不合法"}
	}
	if timeoutMS <= 0 {
		timeoutMS = 2000
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()
	u := b + "versions.json?probe=" + strconv.FormatInt(time.Now().UnixNano(), 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, u, nil)
	if err != nil {
		return MirrorProbe{Error: err.Error()}
	}
	req.Header.Set("Cache-Control", "no-cache")
	client := &http.Client{Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DisableKeepAlives:     true,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 8 * time.Second,
	}}
	start := time.Now()
	resp, err := client.Do(req)
	ms := int(time.Since(start).Milliseconds())
	if err != nil {
		return MirrorProbe{MS: ms, Error: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return MirrorProbe{MS: ms, Error: fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}
	return MirrorProbe{OK: true, MS: ms}
}
