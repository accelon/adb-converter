---
title: 親愛的我把CBETA的字形變漂亮了
subtitle: 從「查得到」到「看得見」——缺字不再需要腦補
author: 葉健欣（碼僧善那）
coauthor: 與 DeepSeek 合寫
date: 2026-11-01
slug: cb-gaiji
note: 圖片路徑以發佈後的 /yap/cb-gaiji.html 為基準（gaiji-assets/…、../huixintang/…）。
---

一九九二年，我剛接觸電腦，最著迷的一件事是：能不能把整部大正藏放進去，讓它替我查。三年後有了「電子小黑皮」，那是大正藏的經名、譯者、卷數資料庫，功能相當有限，但無論如何，查起來遠比翻書快。往後三十年，我大半的時間都在處理同一個問題的各種變形——**字**。

<figure>
  <div class="fig-box wall">
    <img src="gaiji-assets/gaiji-wall.jpg" alt="CBETA 缺字一覽表的一小部分">
  </div>
  <figcaption>這是 CBETA 為《大正藏》整理的缺字表的一小片：每一格一個字、一個編號（CB02901 這種），有些格子連字都畫不出來，只剩一個方框。這樣的一萬五千個字，當時沒有一個能直接在電腦上打出來；到今天，只剩幾百個還沒收進 Unicode。</figcaption>
</figure>

一九九九年，我在中央研究院資訊所林晰先生的啟發下，用 C 寫了一個全文檢索引擎，叫 Accelon。源碼是我直接拷給周海文的——沒有授權書，只有 email 為證。CBReader 是用 C++ Builder 開發的，C 的源碼他正好接得上，於是它成了 CBETA 桌面版讀經器 CBReader 的搜尋核心。

那年太年輕。心想他們也在做佛經，正缺技術，給就給了。只是後來 CBETA 對這段來源，始終沒有多說一句。

說到底，主要的原因是我年少氣盛，單槍匹馬就幹了。CBETA 收了施主的供養金，承載著佛教界的殷殷期盼，卻被一個小伙子趕在前頭，臉上自然掛不住。

這件事與海文無關——他是幹活的人，不搞政治；有問題的是後面的決策者。

那些人，有些已往生，為逝者諱；有些還活著，姑隱其名。

那個引擎的限制我很清楚：它是一個字一個字建索引（unigram），查「之之」「的的」這種詞就慢——兩個字的索引都長得嚇人，交集起來卻一個結果也沒有，白忙一場。解法並不難，後來的版本也真的解決了；但他們既然這樣對我，改進也就不想再提供。真正損失的，其實是廣大的用戶。

同一時期，我的光碟比他們早一步：大正藏全文檢索，和《印順法師佛學著作集》bundle 在一起出版。CBETA 那時用的還是 Microsoft HTMLHelp，只有目錄，沒有全文檢索。

技術上的勝負，往往不在技術本身。這件事我記了很多年。

還有更過份的事，不過與本文無關，敬請期待後文。

以上都是檢索的事。真正麻煩的，是字本身。

## 組字：三十年的執念

二〇一五年，我總算想通了組字最難的一點：光告訴電腦「部件擺哪裡」不夠，還要告訴它「**減掉什麼、換上什麼**」。要寫「初」字少一點的錯字，就寫「初衤礻」——拿「初」當基字，把「衤」換成「礻」。這個「減法」的表達式，後來寫成〈漢字拼形 提案〉，也做成一支字形伺服器：把構形序送進去，圖片就出來了。

<figure>
  <div class="fig-box" style="display:flex;align-items:center;justify-content:center;gap:26px;flex-wrap:wrap">
    <span style="text-align:center"><img src="gaiji-assets/zhang-base.jpg" alt="彰" style="width:96px;height:96px"><br><span style="font-family:var(--sans);font-size:.72rem;color:var(--soft)">基字：彰</span></span>
    <span class="arrow">→</span>
    <span style="text-align:center"><img src="gaiji-assets/zhang-swap.jpg" alt="彰章示" style="width:96px;height:96px"><br><span style="font-family:var(--sans);font-size:.72rem;color:var(--soft)">把「章」換成「示」</span></span>
  </div>
  <figcaption>同一個機制，換一個看得清楚的例子：表達式只寫「彰章示」——基字是「彰」，把裡面的「章」換成「示」。字形引擎當場重畫，不必造字、不必修圖。</figcaption>
</figure>

繞這麼遠，是因為漢字有一個先天的缺口：*字，永遠比編碼多。*

## CBETA 的難處

一九九一年，IBM、Microsoft、Apple 聯手制定 Unicode，大家以為兩萬字就夠了。三十多年過去，擴充 A 一路加到 I，還是不夠。

佛經裡的字尤其麻煩。CBETA 整理大正藏，光是前五十六冊，就收集了**一萬五千個電腦缺字**，比大五碼的一萬三千零五十三字還多。缺字總要有個辦法，CBETA 的辦法叫「**組字式**」：用加減乘除描述一個字的長相。例如 [彰-章+示]，是「彰」去掉「章」換成「示」；[結-吉+且] 是「結」去掉「吉」換成「且」。每個缺字配一個 CB 碼（如 CB14491）、一句組字式、一張缺字圖，存進 gaiji 表。

這辦法很聰明：不必安裝造字檔，任何一台電腦都打得出來。但它有一個代價——**組字式是給人讀的，不是給人看的**。你看到 [彰-章+示]，腦子裡要自己把部件拆開、疊起來、畫一遍，我們管這叫「*腦補*」。要放進書裡、講義裡，就得有人開 Photoshop，一個字一個字 P 出來。

## 中間那一站：IDS

組字式是給人讀的。要讓機器組字，中間還有一站，叫 **IDS**（表意描述序，Ideographic Description Sequence）：用一組描述符寫出「誰在誰的左邊、上面」（左右、上下、包圍…），Unicode 也用同一套來描述罕用字。二〇〇〇年代前後，我們理所當然地用過它——反正只要知道部件怎麼擺，字就組得出來。

我們花了將近二十年，才確認這件事不成立。**IDS 的資訊不夠**：它只說得出部件的相對位置，說不出比例，也說不出框。同樣一句「上下」，上面該佔三分之二還是二分之一，它不管；部件該縮到多小才不擠，它也不管。少了這一層，組出來的字一定是等比分配——能看，但不好看。

下面是「好學孔孟」——「學」的頭、女、孔、皿，四個部件疊成一個字。前一個畫面是照 IDS 畫的，後一個是按構形序重排的：同一個字，差的只是「布局資訊」。

<figure class="glyph-demo">
  <div class="fig-box">
    <a class="gif-link" href="../huixintang/pinxing.html" target="_blank" rel="noopener" title="打開〈剎那拼形〉自己試"><img src="gaiji-assets/ids-to-pinxi.gif?v=4" alt="同一個「好學孔孟」：IDS 等比分配與構形序重排的對照"></a>
  </div>
  <figcaption>同一個「好學孔孟」：上排是 IDS 的寫法，下排是構形序。動畫是兩個狀態的 62 條輪廓逐點內插（30 fps，緩入緩出）——IDS 只給結構，部件只好等比分配、互相推擠；構形序把每個部件的框定下來，字就位了。<br>字形取自〈剎那拼形〉，按魔杖前後的兩個狀態；<b>點圖可以自己開來玩</b>。</figcaption>
</figure>

所以才有構形序：把「基字、減去、替代為」寫成機器算得出來的式子，讓每一個部件的框自己算出來。

## 轉機：字形引擎＋AI

轉機有兩個。一是字形引擎：只要給它「基字、減去、替代為」這種構形序，它當場就畫出外框，筆畫粗細、部件比例都算得出來。二是 AI：它讀得懂 CBETA 的組字式，把一萬五千句組字式翻成構形序，一句一句核對。

字形引擎是我做的，翻譯的苦工交給 AI。於是，缺字第一次有了自己的長相。

<figure>
  <div class="pairs">
    <div class="ex">
      <div class="ex-code">CB06373</div>
      <div class="ex-line"><span class="ex-k">組字式</span> <span class="mono">[飢-几+專]</span></div>
      <div class="ex-arrow">↓</div>
      <div class="ex-line"><span class="ex-k">構形序</span> <span class="mono hi">飢几專</span></div>
      <div class="ex-pics">
        <span><img class="gif" src="gaiji-assets/CB06373.gif" alt="CBETA 缺字圖"><br><em>CBETA 缺字圖</em></span>
        <span class="arrow">→</span>
        <span><img src="gaiji-assets/CB06373.svg" alt="我們組的字形"><br><em>我們組的字</em></span>
      </div>
    </div>
    <div class="ex">
      <div class="ex-code">CB05288</div>
      <div class="ex-line"><span class="ex-k">組字式</span> <span class="mono">[惚-勿+喿]</span></div>
      <div class="ex-arrow">↓</div>
      <div class="ex-line"><span class="ex-k">構形序</span> <span class="mono hi">惚勿喿</span></div>
      <div class="ex-pics">
        <span><img class="gif" src="gaiji-assets/CB05288.gif" alt="CBETA 缺字圖"><br><em>CBETA 缺字圖</em></span>
        <span class="arrow">→</span>
        <span><img src="gaiji-assets/CB05288.svg" alt="我們組的字形"><br><em>我們組的字</em></span>
      </div>
    </div>
  </div>
  <figcaption>CBETA 的組字式用加減乘除描述字形（<span class="mono">[飢-几+專]</span>），是給人讀的；我們的構形序（<span class="mono">飢几專</span>）是給機器算的。左邊是 CBETA 沿用了二十幾年的點陣缺字圖，右邊是照構形序即時畫出來的字形——放大、列印、嵌進講義都不會糊。</figcaption>
</figure>

## 意義：不必等 Unicode

從此，人不必再腦補，也不必辛苦 P 圖；眼睛直接看到字形，複製、貼上、放大、列印都不會糊。更關鍵的是，**不必等 Unicode 收錄**——一個字要進 Unicode，少則數年，多則十幾年，還不一定進得去。

這件事的意義，不只是好看。字形出來了，缺字才能被檢索、被引用、被註解；否則它永遠是經文裡的一個洞，讀者只能繞過去。



> **限制說在前頭：**目前為止，十二個例子全部對得上 CBETA 原本的缺字圖（可逐一比對：[缺字範例](../gaiji-locations.html)）。一萬五千個要全部跑完，還要時間；組得不夠好看的，也得回頭調部件比例。這條路還沒有走完。

## 三十年，說長不長

當年一起輸入經文的朋友，有些已經不在了；當年那台 386，開機都要等。今天我們做的事，其實和一九九二年一樣——讓下一個讀經的人，少花一點力氣。

<figure>
  <div class="fig-box">
    <img class="hero-glyph" src="../huixintang/zhaocaijinbao.svg" alt="招財進寶合體字">
  </div>
  <figcaption>「招財進寶」——四個字疊成一個字形，民間貼在門上的那種。它不在任何編碼表裡，三十年來，我們就是靠這種本領，把一個一個不存在的字畫出來的。</figcaption>
</figure>

**所以，親愛的，我把 CBETA 的字形變漂亮了。**

<div class="further">
  <h2>延伸閱讀</h2>
  <p><a href="../huixintang/gouxingji.html">《構形記》</a>——同一件事的另一種寫法：以〈托付〉〈煉丹〉〈試丹〉〈品丹〉〈鑑丹〉〈問診〉〈裁衣〉〈服丹〉〈過江〉九篇寓言，把這三十年的組字工作重寫一遍。從把資料清乾淨、煉出字庫，一路寫到把爐子搬到別人的地盤上開。</p>
</div>
