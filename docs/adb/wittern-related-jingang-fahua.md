# Wittern「Related Texts」：金剛、法華為起點

> 2026-10-29。資料來源：Christian Wittern, **WWW Database of Chinese Buddhist texts**
> （Release 2.0A, 2002-12-02）。網站聲明：non-commercial use，需註明作者。
> 這份只是拿我們現有的金剛、法華家族去比對，还没有改 `jingqun.tsv`。
>
> **金剛平行本不用重做**：六漢譯＋梵本已在 `D:\2026\wisdomlight\samples\jingang`
> 做好（T235、T236、T237、T238、T220.577、T239＋梵本；見其 `works.tsv`、
> `anchor_map.tsv`）。Wittern 的 T237／T238／T220.577 只是拿來核對，不另建一套。

## 怎麼抓

Wittern 的定位方式是「冊＋經號」，例如：

```text
T2250（T63）→ http://www.kanji.zinbun.kyoto-u.ac.jp/~wittern/can/can2/t63/t63n2250.htm
T235 （T08）→ .../t08/t08n0235.htm
```

網址規則：`t{vol:02}/t{vol:02}n{no}.htm`；`no` 四位數，`a/b` 後綴小寫。
頁面是 Big5；`Related Texts` 是 `<H2>` 下面的一個 `<OL>`。

## 比對結果

以 `build/jingqun/jingqun.tsv` 的 `f_jingang`（21 部）與 `f_fahua`（26 部）為起點，
共抓 47 個頁面（其中 T1510A/B、T0236A/B 是 T1510、T0236 的分卷別名，Wittern 只有
base 頁，404 不影響）；得到 125 筆關聯，去掉我們已有的（含 base 別名）後 **20 筆新關聯**（其中 3 筆金剛已由 wisdomlight 做過，實際待補 17 筆）。

### 金剛

| 新增 | 標題 | 來源 | 建議 |
|---|---|---|---|
| T08N0237 | 金剛般若波羅蜜經 | T0235、T0239 | 已在 wisdomlight（真諦譯）；不重做 |
| T08N0238 | 金剛能斷般若波羅蜜經 | T0235、T0239 | 已在 wisdomlight（笈多譯）；不重做 |
| T05N0220 | 九會第九會能斷金剛分序 | T0235、T0239 | 已在 wisdomlight 的 T220.577；不重做 |
| T85N2732 | 梁朝傅大師頌金剛經 | T0235 | T85 古逸／敦煌系，注疏候選 |
| T85N2733 | 御注金剛般若波羅蜜經宣演 | T0235 | 注疏候選 |
| T85N2735 | 金剛般若經旨贊 | T0235 | 注疏候選 |
| T85N2736 | 金剛般若經依天親菩薩論贊略釋秦本義記卷上 | T0235 | 注疏候選 |
| T85N2737 | 金剛經疏 | T0235 | 注疏候選 |
| T85N2738 | 金剛經疏 | T0235 | 注疏候選（與 2737 同名，不同本） |
| T85N2739 | 金剛般若經挾注 | T0235 | 注疏候選 |
| T85N2740 | 金剛般若義記 | T0235 | 注疏候選 |
| T85N2741 | 金剛般若經疏 | T0235 | 注疏候選 |

### 法華

| 新增 | 標題 | 來源 | 建議 |
|---|---|---|---|
| T09N0263 | 正法華經 | T0262 | 同經異譯，加入 `f_fahua` 根節點 |
| T09N0264 | 添品妙法蓮華經 | T0262 | 同經異譯，加入根節點 |
| T09N0265 | 薩曇分陀利經 | T0262 | 同經異譯（小品），加入根節點 |
| T85N2748 | 法華義記卷第三 | T0262 | T85 古逸／敦煌系，注疏候選 |
| T85N2749 | 法華經疏 | T0262 | 注疏候選 |
| T85N2750 | 法華經疏 | T0262 | 注疏候選 |
| T85N2751 | 法華經疏 | T0262 | 注疏候選 |
| T85N2752 | 法華問答 | T0262 | 注疏候選 |

### 不是新的

- `T08N0236`、`T25N1510`：我們已有 `T0236A/B`、`T1510A/B`，只是 Wittern 合併成 base；
  不列新。
- `T08N0235`、`T08N0239`、`T09N0262` 及我們已有的注疏：原本就在家族裡。

## 判斷

1. **金剛平行本已完成，不要重做**：T0237、T0238、T220.577 都在 `wisdomlight` 的
   六譯＋梵本裡；之後接它的 `works.tsv`／`anchor_map.tsv` 即可。
2. **法華平行本先加**：T0263、T0264、T0265 目前沒有對應樣本，都是完整經文，已在
   `taisho.adb` 的 T09，不需要新增資料。
3. **T85 的 14 部**（金剛 9、法華 5）都已在 T85，適合當「相關注疏」；但它們多為古逸／
   敦煌殘卷，建議先人工看過 title／卷次再決定是否進 `jingqun` 的 `注` 類。
4. **T0220 只做節／卷層級**：它只有「第九會能斷金剛分」與金剛經有關，不要整部 600 卷
   拉進金剛家族；wisdomlight 已經有 T220.577 的全文。
4. 這些都是 **text-level related**，可補 CBETA TEI 只留 `nkr_note_cf._` 錨點、沒有實際
   `cf.` 內容的不足；逐句 cf. 仍要另外處理。

## 產物

- `build/jingqun/wittern-related.json`：47 頁的原始 Related Texts（含來源 URL、標題、錯誤）。
- `build/jingqun/wittern-related.tsv`：逐筆關聯，`new` 欄標記新舊。
- `build/jingqun/wittern-new.tsv`：20 筆新關聯，含 `family`、`related_from` 與 `covered_by`（wisdomlight）；實際待補 17 筆。
- `build/jingqun/fetch-wittern.ts`：可重跑的抓取器（Big5、volume+number 規則）。

## Wittern 有比 CBETA 全嗎？

**整體沒有。** CBETA 2026R2 是全文庫（T 2,459 檔／3,000 書／6.7M 行，另有 X、Y 等），
Wittern 是 2002 年的**書目／關聯目錄**，沒有全文，也不再更新。Wittern 的優勢是
**text-level Related Texts** 這種人工整理；CBETA 的優勢是全文、校勘、新資料與 canon 範圍。
在我們的樣本裡，Wittern 補了 20 筆 `jingqun` 沒有的關聯，但其中 3 筆金剛（T237／T238／
T220.577）已在 wisdomlight；而且這 20 筆的目標全文，CBETA 的 T05／T08／T09／T85 都已經有。
所以它是**互補的關聯索引**，不是「比 CBETA 全」的全文庫；CBETA 的 `nkr_note_cf._` 是
頁行層級、粒度更細，但我們目前的管線沒有把它的內容轉出來，Wittern 正好補 text-level 這一層。

下一步若要實作，會先把這 17 筆（扣掉 wisdomlight 已做的 3 筆）寫進 `jingqun.tsv` 的候選欄，
或做成獨立 `taisho-cf.adb`；不會直接改 `taisho.adb` 底座。
