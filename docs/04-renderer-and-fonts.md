# 第4章 描画層 — TeXのグリフ座標をブラウザで寸分違わず再現する

対象ファイル：`engine/checkpoint/mathmap.js`（186行）、
`web/app.js`（522行）、`web/style.css`、`server.js` のフォント配信部、
および `engine-v3.js` の `#displayList()` / `#registerFont()`。

## 4.1 問題設定

第3章のガレー抽出で、私たちは「どのフォントの・どの文字を・どの座標に
置くか」をTeX自身の計算結果として持っています。残る問題は、それを
ブラウザに**同じ字形・同じ位置**で描かせることです。素朴にHTMLテキスト
として流すとブラウザが独自に行分割・カーニング・リガチャを行い、
TeXの結果と乖離します。

解法は3つの契約から成ります：

1. **フォントはTeXが使ったファイルそのものを配る**
2. **ブラウザの整形機能をすべて無効化する**
3. **位置調整の情報はrun分割として運ぶ**（第3章§3.7）

## 4.2 フォント配信

デーモンはガレー中に初出のフォントごとに
`{file: 実ファイルパス, name, size}` を報告します（`note_font`）。
オーケストレータの `#registerFont()` はこれを次の2つに正規化します：

- **family鍵**：ファイル内容ハッシュから `f-xxxxxxxx`（代替が要る
  レガシーフォントは `twin-<代替ファイル名>`）
- **配信パス**：`fontFiles: family鍵 → 絶対パス`

ブラウザは `/doc` で鍵一覧を受け取り、`injectFonts()` が

```css
@font-face {
  font-family: 'f-7cb4ba9a';
  src: url('/font/f-7cb4ba9a');
  font-display: block;
}
```

を動的に注入します。つまり**Latin Modernも原ノ味フォント（luatexja）も、
TeX Liveのディスクにある実ファイルがそのままブラウザフォントになり
ます**。`server.js` は `Cache-Control: immutable` を付けるので、
2回目以降のロードはネットワークにすら出ません。

## 4.3 ブラウザ整形の無効化と描画

ページはSVGで組み立てます（`app.js` `svgFor()`）。glyphsコマンド1つが
`<text>` 要素1つです：

```html
<text x="133.77" y="182.15" font-size="9.963"
      font-family="f-7cb4ba9a"
      style="font-kerning:none;font-variant-ligatures:none;letter-spacing:0"
      xml:space="preserve">machinery.</text>
```

- `font-kerning:none` — TeXのカーニングはkernノードとしてrun分割に
  反映済み。ブラウザに二重適用させない
- `font-variant-ligatures:none` — リガチャはTeX（HarfBuzz/luaotfload）が
  すでに実行済みで、runの文字列には「ﬁ」のような**合字コードポイント
  そのもの**が入っている。ブラウザの再合字は不要かつ有害
- run内部の字送りはフォントのadvance幅そのもの＝TeXの計算と同一
  ソースなので、開始xさえ合っていれば残りはピクセル未満の丸め差しか
  生じない

rule/folioコマンドは `<rect>`/`<text>` に、チャンク（精密SVG）は
ページdiv上の**クリップ窓つき`<img>`オーバーレイ**になります：

```html
<div class="chunkwin" style="left:21.8%;top:70.9%;width:56.1%;height:11.1%">
  <img src="/chunk/b13%231.svg?v=2" style="margin-top:-9.3%">
</div>
```

`margin-top` のパーセントがコンテナ**幅**基準であることを利用して、
チャンク内オフセット `sy` を解像度非依存に表現しています（この
CSSの仕様上の癖は意図的な採用です）。

## 4.4 数式フォント問題 — Type1をブラウザは描けない

現代のlualatexでも、**数式**の既定フォントは1980年代のComputer Modern
（Type1形式：cmmi10, cmsy10, cmex10, cmr10...）です。ブラウザの
`@font-face` は Type1 を一切サポートしません。ここが「実フォント配信」
戦略の唯一の破れ目で、`mathmap.js` が埋めます。

### 二重の変換

**（a）字形の置換**：Latin Modern は Computer Modern の公式後継
（同じメトリクス思想でOpenType化されたもの）です。そこで

| レガシーフォント | 双子（OTF） |
|---|---|
| cmmi\*（数式イタリック） | latinmodern-math.otf |
| cmsy\*（数式記号） | latinmodern-math.otf |
| cmex\*（大型演算子・括弧） | latinmodern-math.otf |
| cmr/cmbx/cmti/cmsl/cmtt/cmss/cmcsc（OT1テキスト） | lmroman/lmmono/lmsans等の対応OTF（サイズは5/6/7/8/9/10/12/17ptの最近傍） |

**（b）スロット→Unicodeの写像**：Type1時代のフォントは256スロットの
独自配置で、例えば cmmi10 のスロット0x19は「π」、cmsy10 の0x31は
「∞」です。`mathmap.js` はOML（数式イタリック）・OMS（記号）・OMX
（大型）・OT1（テキスト）の4エンコーディングについてスロット→
Unicodeコードポイントの静的表を持ちます（例：OML 0x0b→𝛼、
OMS 0x14→≤、OMX 0x5A→∫）。display list生成時に `remapText()` が
文字列を写像し、family鍵を双子に差し替えます。

### JSONを生き延びるためのPUAシフト

スロット値が32未満のグリフ（ギリシャ小文字の大半！）は、そのまま
文字列にするとJSONの制御文字として除去されてしまいます。デーモンは
**0xE000+slot（私用領域）にシフトして送信**し、`remapText()` が
受信側で 0xE000..0xE01F を元のスロットに戻してから表を引きます
（第6章・罠12）。

### cmexの幾何学とTWIN計測

cmex（大型記号）はさらに厄介で、**グリフのインクが基準点より下に
垂れ下がる**という特殊なメトリクス設計です（Σや√の大型版）。Unicode
双子は普通のベースライン設計なので、単純置換すると縦位置がずれます。

そこで2つの実寸を突き合わせます：

- **TeX側の実寸**：デーモンがglyphノード処理時にフォント表から
  高さ/深さを取り、runに `gh/gd` として添付
- **双子側の実寸**：起動時にdriver.texが `latinmodern-math.otf` を
  実際にロードし、`tdom_twin_metrics()` が全グリフの高さ/深さを
  TWINメッセージで送信（オーケストレータの `twinMetrics`）

display list生成時、cmex由来のrunは
`y' = y − gh + twinHeight(cp)·(size/10)` で**インク上端を厳密に一致**
させます。それでも「大型の可変サイズ字形（3段階の√など）はUnicodeに
1字しかない」という本質的ギャップが残るため、大型スロット
（0x10–0x4F, 0x58–0x77）を含むブロックは `blk_gfx=true` として
**精密レンダー層が最終表示を保証**します（即時層は近似・第3章§3.10）。

## 4.5 ブラウザ側の残りの仕事（web/app.js）

クライアントは徹底して薄く作られています：

- **編集送信**：textareaの旧値と新値の共通prefix/suffixから最小の
  `{start,end,text}` を計算してPOST。IME（日本語入力）中は
  compositionendまで送信を保留。checkpointバックエンドではデバウンス
  なし（毎打鍵送信——直列プロミスチェーンが自然にバースト合流させる）
- **パッチ適用**：`replace-page` はそのページのSVGを差し替えるだけ。
  黄色い枠のフラッシュで「どのページが貼り替わったか」を可視化
- **SSE**：`update`（他ウィンドウの編集）と `patches`（レンダー子完了
  やバックグラウンド連鎖からの非同期差分）を受けて同じ適用経路へ
- **逆引きソースマップ**：プレビューの任意の文字をクリック→
  `data-src` のブロックid→ `/dom` で行番号を引いてエディタをジャンプ
- **Engine Inspector**：毎編集のレポート（dirtyチェーン・依存・
  キャッシュ/再利用統計・フェーズ別時間・履歴）を右ペインに描画。
  「この1文字で何がdirtyになったか」という当初の成功条件を、
  常時目視できるようにするためのUI

---

次章は、参照実装として残している旧2バックエンドです。
