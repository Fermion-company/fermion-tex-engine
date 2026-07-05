# Codex goal: ページ割りを本物の TeX に組ませる差分アーキテクチャへ移行

## ゴール（Definition of Done）

プレビューのページ割り（改ページ位置・フロート配置・脚注・段組）を、JS の再現
ページビルダーではなく、**チェックポイントから resume した本物の lualatex に
組ませる**方式へ移行する。

- 編集中は「逆流」（後ろの変更が手前ページへ波及する要素）を**凍結**する。
- 逆流を含む完全一致は、**最後のフルコンパイル時のみ**保証する。
- 段組（2〜6段・starred/非starred）が**単一経路**でクラッシュせず、各段に編集
  ヒットボックスが出る。
- 編集プレビューと最終フルコンパイルの差が「凍結した逆流だけ」であることを
  テストで固定する。

## なぜ（動機）

現状プレビューは2層でできている:

- **行組み**（改行=Knuth–Plass・数式・フォント）＝本物の lualatex の galley。TeX と一致。
- **ページ割り**＝JS の再現（`pagebuilder.js` が `tex.web §1005–1008` と `ltoutput`
  を移植）。**ここが"再現"で、TeX との差異の源**。

再現ページビルダーは `\output` を眠らせる（`engine-v3.js`：`\vsize=\maxdimen`,
`\holdinginserts=1`, `\output={tdom_absorb_output}`）ことで、どの block からでも
可逆にページを組み直せる＝高速な増分を実現している。だがその副作用として:

- 段組は自前 `\output` で JS ビルダーをバイパス → `\@outputpage` 横取り＋
  `\@colroom` 注入という**特別扱い**が要る（`engine-v3.js` の #bootRoot と #jobBlock）。
- 段組の balancing は眠らせた非標準ページ状態と干渉して**決定的にクラッシュ**する
  （実測：非starred 4段 / 38段落で 12/12 hard crash。列数×本文量の組合せ依存で、
  非決定ではない）。よって非starred 4+ はフルページ（実 TeX 全文）へ退避し、そこに
  列ヒットボックスを合成している（`columnRectsForWords` / `#fullPageHitboxes`）。

これらは全部「JS でページを再現している」ことの帰結。**ページ割りを本物に返せば
根本から消える。**

## 設計方針（新）

1. **ページ境界チェックポイント**：`\output` を生かした"普通の TeX"状態で、各ページ
   確定直後のプロセス状態を fork スナップショットする（現状の block 境界 checkpoint
   を、通常ページ組み状態のページ境界に拡張）。
2. **編集時 resume**：編集ブロックが乗るページの直前チェックポイントから resume し、
   そこから後ろを普通の TeX として組ませ、**本物の改ページ位置・ページ内容・グリフ
   位置を採用**する。
3. **逆流の凍結**：resume 地点より前のページは触らない。フロート繰上げ・balancing の
   手前波及・widow/orphan の手前波及は編集中は反映しない。
4. **完全一致はフルコンパイル時のみ**：保存/明示コンパイル時に全文を通しで組み、
   逆流込みで一致させる。
5. **速度緩和**：resume 地点から「可視範囲＋数ページ」だけ即組みし、残りはバック
   グラウンドで組む（既存の `#scheduleBackground` を流用）。

**速度特性の変化に注意**：後ろの編集ほど安く（後ろだけ組む）、前の編集ほど重い
（resume 地点から後ろを組む量に比例）。現状の「どこを直しても一律に安い」とは
トレードオフが変わる。ここを (5) の可視範囲優先で吸収するのが実装の肝。

## 撤去対象（新方式が動いたら消す — それまでは壊さず残す）

- JS ページ組み：`pagebuilder.js` の `buildPages` のページ分割・フロート/脚注配置
  （行組み galley の扱いは残す）。
- 段組特別扱い：`\@outputpage` 横取り・`\@colroom` 注入・`multicolBlockInfo` の
  layout 判定・`addMulticolHitboxes`。
- フルページ退避一式：`fullPagePreviewReason` の multicols 分岐、`#fullPagePreview`、
  `#fullPageHitboxes` / `columnRectsForWords`。本物ページ組みが標準になれば「フル
  ページ」と「差分ページ」は同じ経路に統合される。
- 編集ヒットボックスは、本物ページの block↔位置対応（Lua callback / SyncTeX）から
  作り直す。段組の列も TeX が組んだ実座標から取れる。

（＝現状の multicol 実装一式は"新方式への繋ぎ"。新方式が動けば不要。）

## 実装ステップ（提案）

1. **PoC**：通常状態の lualatex を全文で走らせ、各ページ確定（`\output` または
   `pre_output_filter` / `buildpage` callback）で「その時点のプロセス状態」と「その
   ページの block 範囲・グリフ位置」を Lua から吸い出す。ソース↔ページ対応は SyncTeX
   でも取れる。
2. **resume 差分**：block 編集 → 直前ページ checkpoint から resume → 後ろのページを
   再取得 → 変わったページだけ display list 差し替え（既存の hash 差分機構を再利用）。
3. **ヒットボックス**：本物ページの「矩形 ↔ block / 列」の対応を作る。
4. **撤去**：上の「撤去対象」を段階的に外し、テストを新経路へ寄せる。
5. **一致テスト**：編集後プレビュー ↔ 最終フルコンパイルの差が「凍結した逆流」だけで
   あることを固定する。

## 触る中心

- `engine/checkpoint/engine-v3.js`（#update / checkpoint / 現 #fullPagePreview 周辺）
- `engine/checkpoint/daemon.lua`（`\output` を生かす通常経路、page/output callback、
  状態吸い出し）
- `engine/checkpoint/pagebuilder.js`（撤去 or 縮小）
- `tests/engine-v3.test.js`

## 検証

- `node --test tests/engine-v3.test.js` / `npm test`
- 段組 2〜6段・starred/非starred が単一経路でクラッシュせず、列編集ヒットボックスが出る。
- 「後ろ編集＝数ページのみ再取得 / 前編集＝範囲拡大」の速度特性を計測。
- 編集プレビューと最終フルコンパイルの差が逆流要素のみ。

## 罠（繰り返さないこと）

- **段組 balancing を"眠らせた"常駐状態で動かすと決定的にクラッシュする**（実測
  12/12）。新方式では必ず**通常状態の TeX**で組むこと。ここが崩れると同じクラッシュが
  再発する。フルコンパイル経路（普通の lualatex 全文）は段組で落ちない、という事実が
  新方式の安全性の根拠。
- 現 `#update` には、早期フルページ分岐が先に return するため主経路の
  `fullPagePreview` 分岐が到達不能な dead code がある。撤去時に一緒に整理。
