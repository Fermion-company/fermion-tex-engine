# Fermion TeX Engine — TeX DOM Runtime

TeX / LaTeX互換の入力を受け取り、**文書状態を常駐保持**し、**ソース変更差分から表示差分を生成**する、
新しいインクリメンタルTeX組版ランタイムです。

エディタでも、latexmkのラッパーでも、PDFリロードでもありません。
本体は中央にいる**組版エンジン**であり、エディタとビューアはただの薄いクライアントです。

```text
┌──────────┐       ┌────────────────────┐       ┌──────────┐
│ Editor   │──────▶│ Fermion TeX Engine │──────▶│ Preview  │
└──────────┘ edit  └────────────────────┘ patch └──────────┘
```

## 実行方法

```bash
npm start        # エンジンが常駐し http://127.0.0.1:4633 で待機
npm test         # 内部エンジン10本 + lualatex統合8本のテスト
```

ブラウザで `http://127.0.0.1:4633` を開くと、
**エディタ / プレビュー / Engine Inspector** の3ペインが表示されます。

## 2つのバックエンド

### 1. lualatexバックエンド（TeX Live検出時のデフォルト）

**本物のLuaLaTeXを組版エンジンとして使い、ブロック単位で差分再組版**します。
Knuth-Plass行分割・Latin Modernフォント・amsmath・amsthm・TikZ・booktabsが
そのままの品質でライブプレビューされます。

- 文・数式の編集 → **そのブロックだけ** lualatexが再組版（約0.4〜0.5秒）
- マクロ再定義 → 依存グラフをたどり**使用ブロックだけ**再コンパイル
- 式の挿入 → **カウンタ連鎖**で下流の式番号・定理番号・参照だけが更新
- アンドゥ → **チャンクキャッシュヒットでコンパイル0回**（1ms）
- プリアンブル変更（パッケージ追加等の構造変更）→ 正直にフル再構築
  （format再ダンプ + 全ブロック再コンパイル。これは仕様上「再コンパイルでよい」領域）

仕組み:

```text
編集
 → ブロックdiff（内容ハッシュ、ID安定）
 → 状態連鎖パス:
     各ブロックに entry状態（section/equation/theorem等のカウンタ）と
     既知ラベル値（\global\@namedef{r@...}）を注入し、
     dirtyブロックだけを1回のlualatex実行でまとめて組版。
     LuaコールバックがvboxをTeX本物の行ボックス列
     （高さ・深さ・行間グルー・ペナルティ）に分解して記録し、
     ブロック全体を1つのタイトページとして出力。
     exit状態はデルタとして記録され、次ブロックのentryに連鎖。
     カウンタ/ラベルが動けば消費ブロックだけ追加パスで再組版（LaTeXの
     マルチパスをブロック単位に局所化したもの）。
 → pdftocairoでブロックPDF→SVGチャンク化（内容アドレスでキャッシュ）
 → Page DOM: 行ユニット流を再ページ分割。無変更ブロックの行ユニットは
   参照同一なので、一致ページは表示リストごと再利用
 → 表示リストはチャンク配置命令（クリップ窓つき）。ハッシュが変わった
   ページだけ replace-page パッチ
```

- 実カウンタ値・実ラベル値は**TeX自身の実行結果**（auxストリーム）から取得
- PDF書き出しはフルlualatexコンパイル（2パス）— ライブ状態と一致することが
  そのまま増分組版の正しさの検証になる
- ブロック内エラーは前回の正常チャンクを保持して診断表示（打鍵中も生存）

### 2. 内部バックエンド（`TDOM_BACKEND=internal`）

依存ゼロの自前組版エンジン（Times系メトリクス・グルー/ボックス行分割・
自前数式・自前PDFライタ）。TeX不要の環境で全アーキテクチャが動きます。
更新は約1ms。品質はデモ水準（greedy行分割・ハイフネーションなし）。

## 試すべき実験（lualatexバックエンド）

1. **文中の1単語を編集** — Inspectorに `src-bN → blk-bN → page N` のチェーン、
   「lualatex再コンパイル 1 / ブロック再利用 18」が出る。
2. **数式ブロックに項を追加**（例: `+ 2ab`）— その式だけ再組版。
3. **新しい numbered equation を挿入** — `counter:chain → …` で下流の
   式・定理・参照ブロックが再番号付けされ、パッチは変わったページのみ。
4. **`\term 再定義` ボタン** — ソース無変更のまま `macro:\term → 4ブロック` が
   再組版。2回目以降はチャンクキャッシュでコンパイル0回。
5. **`label 改名` ボタン** — 参照ブロックだけがdirtyになり `??` ⇄ 解決 が往復。
6. **TikZの座標をいじる** — 図のブロックだけが約0.5秒で更新。
7. **PDF書き出し** — フルコンパイル結果がライブ表示と一致。

## アーキテクチャ（ファイル対応）

```text
Source Store          engine/source-store.js     テキストバッファ + 範囲編集
Source DOM            engine/segmenter.js        ブロック分割・ハッシュdiff・ID安定化
Macro VM              engine/macro-vm.js         定義走査・展開・依存ハッシュ（両バックエンド共用）
Dependency Graph      engine/engine-lua.js       macro閉包 / label / counter連鎖
LuaTeX compile svc    engine/luatex/backend.js   format管理・状態注入・aux解析・SVG化
galley抽出            engine/luatex/linesplit.lua vbox→行ボックス/グルー/ペナルティ+entry/exit
Page DOM              engine/page.js             行ユニット流のページ分割・参照同一性再利用
Display List / Patch  engine/engine-lua.js       チャンク配置＋クリップ、replace-page
常駐サーバー          server.js                  /edit /doc /chunk /pdf /events(SSE)
内部エンジン一式      engine/{engine,semantic,layout,math-layout,metrics,display-list,pdf}.js
```

## エンジンAPI

```js
const eng = new LuaTDOMEngine({ workDir: '.tdom-cache' });
await eng.open(texSource);        // フルビルドはこの1回（以後常駐）
await eng.edit(start, end, text); // 差分 → dirtyレポート + パッチ
eng.getDOM();                     // ブロック/依存/ラベル/ページ対応の観測
eng.getDisplayLists();            // チャンク配置命令列
await eng.exportPDF();            // フルコンパイルPDF
```

## 成功条件（仕様 §26）の実出力（lualatexバックエンド）

```json
{
  "edit": "main.tex:26:6-26:11",
  "dirtySourceNodes": ["src-b3"],
  "dirtySemanticNodes": ["blk-b3"],
  "dirtyDependencies": [],
  "dirtyPages": [1],
  "patches": [{ "type": "replace-page", "page": 1 }],
  "stats": { "blocksCompiled": 1, "blocksTotal": 19, "lualatexMs": 420, "pagesReused": 1 }
}
```

## 既知の制限（lualatexバックエンド）

- **float**（figure/table）は宣言位置にインライン描画（浮動配置しない）。
  PDF書き出しはフルコンパイルなので正しく浮動する。
- **脚注・目次・bibliography** はライブ表示では未対応（書き出しでは有効）。
- 段落間は行単位で改ページできるが、widow/orphan制御は簡略。
- `\input` による複数ファイル、文書中盤での `\newcommand` 再定義は未対応。
- `\setcounter` の絶対代入を含むブロックはカウンタ連鎖（デルタ方式）と相性が
  悪い場合がある。
- 日本語はプリアンブルにluatexja等を足せば通るが、ブロック分割は空行基準の
  ままなので長文段落の分割粒度が粗くなる。

これらはすべて「構造が変わる編集はフル再コンパイルでよい」という設計上の
割り切りの内側にあり、アーキテクチャはそれらを受け入れる形になっています。
