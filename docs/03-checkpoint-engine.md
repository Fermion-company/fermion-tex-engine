# 第3章 checkpointバックエンド完全詳解

この章が本書の中心です。対象ファイル：

- `engine/checkpoint/tdomfork.c`（71行）
- `engine/checkpoint/daemon.lua`（666行）
- `engine/checkpoint/engine-v3.js`（1,373行）
- `engine/checkpoint/pagebuilder.js`（258行）

## 3.1 発想 — fork(2)はTeX状態の完全なスナップショットである

TeXの内部状態は巨大です：数万のマクロ定義、catcode表、ロード済み
フォント、カウンタ、ボックスレジスタ、ハイフネーションパターン……。
これを「ある時点の状態に巻き戻せる形」でアプリケーションレベルで
保存・復元するのは絶望的です（TeX自身の `\dump` はフォーマット作成
専用で、文書処理の途中では使えません）。

しかしOSの視点では、TeXの状態は**ただのプロセスメモリ**です。
POSIXの `fork(2)` はプロセスを複製するシステムコールで、現代のOSでは
**コピーオンライト（COW）**で実装されています：fork直後は親子が
物理メモリを共有し、どちらかが書き込んだページだけがその時点で
複製されます。つまり：

- fork自体は数百マイクロ秒（実測0.21ms）
- 複製のメモリコストは「その後書き換わったページ分」だけ
- **forkした親プロセスを凍結しておけば、それが「その瞬間のTeX状態の
  完全なスナップショット」になる**

そこで文書を先頭からブロックごとに組版しながら、**各ブロック境界で
forkして親を残す**と、こういうプロセスの鎖ができます：

```text
ckpt0 ──fork──▶ ckpt1 ──fork──▶ ckpt2 ──fork──▶ ... ──▶ ckptN
(プリアンブル     (ブロック1       (ブロック2                (文書末尾
 処理済みの状態)   まで組版済み)     まで組版済み)              まで組版済み)
```

ckpt_k は「ブロック1..kを組版し終えた時点のTeX完全状態」です。
ユーザーがブロックKを編集したら：

1. ckpt_K 以降（古い続きに基づく状態）を殺す
2. ckpt_{K-1} に「新しいブロックKを組版せよ」と命じる
3. ckpt_{K-1} は fork し、子が新ブロックを組版して新しい ckpt_K になる

プロセス起動もフォーマットロードもフォントロードも発生しません。
編集の表側コストは「fork 0.2ms ＋ 変更段落のKnuth-Plass数ms」まで
落ちます。これが本エンジンの心臓です。

## 3.2 登場人物とプロセス構成

```text
                    ┌────────────────────────────┐
     HTTP/SSE       │  Node.js オーケストレータ      │
ブラウザ ◀━━━━━━━━▶ │  (server.js + engine-v3.js)  │
                    │  ・ブロック差分／依存管理        │
                    │  ・ページビルダー／表示リスト     │
                    │  ・TCPサーバー(127.0.0.1:動的) │
                    └──────────┬─────────────────┘
                               │ 行指向TCPプロトコル(§3.5)
        ┌──────────────┬───────┴──────┬─────────────────┐
        ▼              ▼              ▼                 ▼
   ckpt0 (root)     ckpt1          ckpt2 ...        レンダー子
   lualatexプロセス  (ckpt0の子)    (ckpt1の子)        (任意ckptの子;
   Lua内で凍結待機   同左           同左               TikZ等を実PDFに
                                                     出荷して即死)
```

- **オーケストレータ**（Node.js）：文書の真実を握る側。ソース・ブロック
  配列・ラベル表・ページ・フォント登録・チャンク（精密画像）を保持
- **root**：`lualatex --shell-escape -interaction=nonstopmode driver.tex`
  として起動される唯一の「exec由来」プロセス。プリアンブルを処理し、
  ckpt0 として待機に入る
- **チェックポイント（ckpt_k）**：すべてforkの子孫。Luaの
  `conn:receive()` でブロックしたまま凍結している
- **ジョブ子**：JOB命令でforkされ、1ブロック組版→結果送信→
  **そのまま次のチェックポイントに昇格**する
- **レンダー子**：RENDER命令でforkされ、ブロックを実PDFページとして
  出荷してから `_exit` する使い捨て（§3.10）

## 3.3 起動 — driver.tex の解剖

オーケストレータは起動時（およびプリアンブル変更時）に、ユーザー文書の
プリアンブルへ制御コードを継ぎ足した `driver.tex` を生成します
（`engine-v3.js` `#driverSource()`）。構造は：

```tex
%%（1）ユーザーのプリアンブルを一字一句そのまま
\documentclass{article}
\usepackage{amsmath}
...
\begin{document}
%%（2）ここから注入部。\begin{document}の後なのは、fork前に
%%    LaTeXの初期化（aux処理・フォント既定）を済ませるため
\directlua{dofile('<abs>/daemon.lua')}
\makeatletter
\newbox\TDOMgalley  \directlua{TDOM_BOXNUM=\number\TDOMgalley}
\directlua{tdom_boot(<port>, '<workdir>', {'section','equation',...})}
%%（3）シム群 — 第2章§2.4の表のとおり（\label,\ref,\cite,float環境,
%%    \@starttoc,\@bibitem,...）
%%（4）ページビルダー用ジオメトリの送信
\directlua{tdom_dim('footinsskip',\number\dimexpr\skip\footins\relax)}
...（floatsep/textfloatsep/intextsep/topfraction/bottomfraction）
\directlua{tdom_geo()}
%%（5）既知ラベルの注入（再起動時に前方参照を1パスで解決するため）
\global\@namedef{r@sec:intro}{{1}{1}} ...
%%（6）フォントウォームアップ：本文・太字・斜体・等幅・数式一式を
%%    ダミーboxで一度組む → ckpt0のメモリにフォント常駐
\setbox0=\vbox{...The quick brown fox ... $\int\sum\frac{1}{2}$...}
%%（7）数式代替フォントの実寸計測（第4章）
\font\TDOMtwinmath={file:latinmodern-math.otf} at 10pt
\directlua{tdom_twin_metrics(font.id('TDOMtwinmath'))}
\makeatother
\pagestyle{empty}
\hoffset=-1in \voffset=-1in   %% タイトページ出荷の原点合わせ(§3.10)
%%（8）永久ループへ
\def\TDOMloop{\directlua{tdom_wait()}\TDOMloop}
\TDOMloop
\end{document}   %% ← 実際にはここへ到達しない
```

`--shell-escape` はCシムを `package.loadlib` するために必要です
（LuaTeXは制限モードでライブラリロードを禁止します）。信頼できる
ローカル文書を自分のマシンで組む前提のフラグです。

## 3.4 tdomfork.c — 71行のCシム

LuaTeX（非JIT版）にはFFIライブラリが同梱されていますが、ARM64
（Apple Silicon）非対応です（第6章・罠1）。そこでLua C APIで書いた
最小の共有ライブラリを用意しました。全体は次の5関数だけです：

```c
static int l_fork(lua_State *L)   { lua_pushinteger(L, fork());  return 1; }
static int l_getpid(lua_State *L) { lua_pushinteger(L, getpid()); return 1; }
static int l_waitpid(lua_State *L){ /* waitpid(pid,&st,0) → pid,st */ }
static int l_exit(lua_State *L)   { _exit(arg1); }
static int l_ignore_sigchld(...)  { signal(SIGCHLD, SIG_IGN); }
```

技巧が2つあります。

**ヘッダ不要ビルド**：`lua_pushinteger` などの宣言をファイル内に自前で
externし、macOSでは `-undefined dynamic_lookup` でリンクします。
シンボルは実行時に**ホストのlualatexプロセス自身**から解決されるので、
Luaのヘッダもライブラリも要りません（Linuxでは `-fPIC -shared` で同効果）。
ビルドはオーケストレータが初回に自動実行します
（`engine-v3.js` `#ensureShim()`、`cc` 一発）。

**SIGCHLD無視**：チェックポイントは子（次のチェックポイントや
レンダー子）をwaitしません。放置するとゾンビが溜まるので、
`signal(SIGCHLD, SIG_IGN)` を最初に一度呼び、カーネルに自動回収させます。

`_exit`（`exit`ではなく）を使うのも重要です。チェックポイントの子孫は
親から継承したstdioやatexitフックを共有しているため、通常の `exit` で
バッファのフラッシュ等が走ると親の世界を壊しかねません。

## 3.5 daemon.lua（前半）— プロトコルと凍結のからくり

### 通信路

デーモンはlualatex側からオーケストレータのTCPポート（127.0.0.1、
エフェメラル）へ**接続しに行きます**（LuaTeX同梱のluasocketを使用。
`tdom_boot()`）。forkされた子は親とソケットFDを共有してしまうため、
**子は必ず自分の接続を張り直します**（`reconnect()` — 継承FDを閉じて
新規connect。これを怠ると親子の送信が混線します）。

### メッセージ一覧（ワイヤプロトコル）

行指向＋長さ前置きペイロードの単純なプロトコルです。

**オーケストレータ → デーモン**

| 形式 | 意味 |
|---|---|
| `JOB <blockId> <newCkptIdx> <noindent0/1>:<bodyLen>\n<body>` | forkして子にブロックを組版させよ。子は完了後 ckpt `<newCkptIdx>` に昇格 |
| `RENDER <blockId> <jobDir> <bodyLen>\n<body>` | forkして子にブロックを実PDFとして`<jobDir>`へ出荷させよ（子は使い捨て） |
| `DIE\n` | このチェックポイントを破棄（`_exit(0)`） |
| `PING\n` | 生存確認 |

**デーモン → オーケストレータ**

| 形式 | 意味 |
|---|---|
| `HELLO <role> <idx> <pid>\n` | 接続直後の名乗り（role = ckpt / job / render） |
| `GEO <len>\n<json>` | 版面ジオメトリ（§3.3(4)。paperwidth〜parindent＋footinsskip等） |
| `TWIN <len>\n<json>` | 数式代替フォントのグリフ寸法表（unicode→[高さ,深さ]bp） |
| `GALLEY <blockId> <len>\n<json>` | ブロックの組版結果（§3.7のガレーJSON） |
| `CKPT <idx> <pid>\n` | 「私はいまチェックポイントidxになった」 |
| `FORKED <blockId> <pid>\n` | 親からの「子を産んだ」通知 |
| `DONE <blockId>\n` | レンダー子のPDF完成通知（finish_pdffileコールバック内） |
| `PONG <idx>\n` | PINGへの応答 |

Node側の受信はフレーミングクラス `Peer`（`engine-v3.js`）が行い、
`GEO/TWIN/GALLEY` は「行を読む→len分のバイトを溜めてからJSON.parse」
という2段構えです。

### 凍結と再開のからくり — \TDOMloop

デーモンの待機は次の3行のTeXマクロと `tdom_wait()` の組み合わせで
実現されています。ここが本エンジンで最も繊細な箇所です。

```tex
\def\TDOMloop{\directlua{tdom_wait()}\TDOMloop}
\TDOMloop
```

```lua
function tdom_wait()
  while true do
    local line = conn:receive('*l')          -- ★ここでブロック＝凍結
    ...
    elseif cmd == 'JOB' then
      local body = conn:receive(len)
      local pid = fk.fork()
      if pid == 0 then                       -- 子プロセス
        JOB = {...}
        reconnect('job', newckpt)
        inject_job(body, false)              -- tex.printで組版コードを注入
        return                               -- ★Luaから抜けてTeXへ戻る
      else                                   -- 親プロセス
        conn:send('FORKED ...')
        -- returnしない！whileの先頭へ戻り、次の命令を待ち続ける
      end
    ...
```

ポイント：

- **親は `tdom_wait()` の中のwhileループから決して出ません**。TeXの
  実行位置は `\directlua{tdom_wait()}` の内部で永久停止しており、
  これが「凍結」の実体です。プロセスはブロッキングreadで眠っている
  だけなのでCPUは食いません。
- **forkの子だけが `return` します**。すると`\directlua`が終わり、TeXは
  入力の続きを読みます。その続きとは——直前に `inject_job()` が
  `tex.print()` で挿入したブロック組版コードです（§1.10で述べた
  「tex.printは現在のLua呼び出し直後の入力に挿入される」意味論）。
- 注入コードの最後は再び `\directlua{tdom_report()}`（結果送信）で、
  それが済むとTeXは `\TDOMloop` の末尾再帰に到達し、子は
  `tdom_wait()` へ入って**次のチェックポイントとして凍結**します。

つまり1つのマクロループの上を、fork世代が次々に流れていく構造です。
親は何度でもfork可能なので、同一チェックポイントから**複数の別の未来**
（編集Aの世界と編集Bの世界）を派生させることもできます。

### ジョブの注入 — inject_job

```lua
function inject_job(body, ship)
  local lines = {}
  lines[#] = '\\global\\setbox\\TDOMgalley=\\vbox{\\hsize=\\textwidth'
  if JOB.noindent then lines[#] = '\\noindent' end
  ...body を行ごとに...
  lines[#] = '\\par}'
  if ship then ...§3.10... else
    -- カウンタの出口値を1つずつLuaへ返す
    lines[#] = '\\ifcsname c@section\\endcsname\\directlua{
                  tdom_counter(\'section\',\\number\\value{section})}\\fi'
    ...（追跡カウンタ全部）...
    lines[#] = '\\directlua{tdom_report()}'
  end
  tex.print(lines)
end
```

ブロックは**メイン垂直リストではなく `\vbox` の中**で組みます。理由は
2つ：(a) ページビルダー（TeX内蔵の）を発火させないため——改ページは
私たちの仕事です；(b) PDFバックエンドを汚さないため——チェックポイント
が1ページも出荷していなければ、子孫のレンダー子がいつでもまっさらな
PDFを開けます。

`\vbox` 内でも `\section` のカウンタ加算はグローバルに効き、
`\footnote` の insノードはvbox内のリストに残るので、状態と脚注は
正しく捕捉できます（フロート環境が `\vbox` 内でエラーになる問題は
シムで解決——§3.9）。

## 3.6 ジョブ子の一生（まとめ）

```text
fork → 自分用ソケット接続(HELLO job) → tex.printで注入 → Luaからreturn
 → TeXが \vbox 組版（★ここが本物のKnuth-Plass。数ms）
 → カウンタ出口値をLuaへ → tdom_report():
      ガレー抽出(§3.7) → GALLEY送信 → CKPT送信
 → \TDOMloop → tdom_wait() で凍結（＝新チェックポイント誕生）
```

## 3.7 ガレー抽出 — ノードリスト→JSON

`tdom_report()` が呼ぶ `extract_galley()`（→ `extract_items()` →
`walk_h`/`walk_v`）が、組み上がった `\TDOMgalley` ボックスを歩いて
**描画に必要な全情報**をJSONにします。これが「PDFを作らずにPDFと同じ
絵を描く」ための核心データです。

### 出力形（ガレーJSON）

```jsonc
{
  "block": "b7",
  "gfx": false,            // pdf_literal（TikZ等）や大型cmexを含むか
  "w": 345.0, "h": 61.2, "d": 2.1,   // ボックス外寸（bp）
  "items": [               // 垂直方向の並び（上から順）
    {"k":"box","h":7.47,"d":2.49,"w":345.0,
     "runs":[ /* この行の描画runとrule。下記 */ ],
     "fm":[1]},            // ←この行の直後にフロートアンカー#1
    {"k":"glue","a":4.31}, // 行間グルー（伸縮適用後の実寸）
    {"k":"pen","v":150},   // ペナルティ（widow/club等。改ページ判断に使用）
    {"k":"kern","a":3.0},
    {"k":"ins","class":126,"h":18.2,"items":[...]} // 脚注（中身も同形式で再帰）
  ],
  "floats":[               // このブロックで捕捉したフロート
    {"n":1,"placement":"t","type":"figure","w":..,"h":..,"d":..,
     "gfx":true,"items":[...]}
  ],
  "fonts": {"32":{"file":"/usr/.../lmroman10-regular.otf",
                  "name":"[lmroman10-regular]:+tlig;","size":9.963}},
  "labels":[{"k":"fig:plot","v":"1"}],   // \label/\bibitemシムの記録
  "refs":["sec:intro","cite:knuth84"],   // \ref/\citeシムの記録
  "state":{"section":2,"equation":3,...} // カウンタ出口値
}
```

### run（描画単位）の契約

各行（hlist）は `walk_h` が歩き、**グリフの連なり run** と **rule** の
フラット列にします。runは
`{f:フォントid, s:サイズbp, x:行頭からの開始x, dy:ベースライン相対の
縦ずれ, c:"#rrggbb", t:"文字列", gh/gd:グリフ実寸}` です。

最重要の設計判断：**runはkernまたはglueが現れるたびに分割**します。
なぜか。TeXは単語内のカーニングを「グリフ間のkernノード」として実体化
します。runをkernで割っておけば、run内部にはもう位置調整が存在せず、
**「開始xだけ送れば、あとはフォントの字送り幅を足すだけでTeXと同じ
座標になる」**ことが保証されます（ブラウザ側は同じフォントファイルを
使い、独自カーニング/リガチャを無効化して描く——第4章）。おかげで
1グリフごとの座標を送らずに済み、ペイロードが1桁縮みます。

`walk_h` の各ノード処理を要約すると：

| ノード | 処理 |
|---|---|
| glyph | runに追加。`x += 幅`。`xoffset/yoffset`（luatexjaが使う）も反映。フォント初出なら `note_font` で登録。**スロット<32はU+E000+slotにシフト**（JSON制御文字対策・第4章）。cmexの大型スロットなら `blk_gfx=true`（精密レンダー行き）。グリフ実寸(gh/gd)をTeXのフォント表から採取 |
| kern | run分割。`x += kern` |
| glue | run分割。`x += node.effective_glue(n, parent)` ←両端揃えの伸縮適用後実寸（§1.7） |
| hlist(入れ子) | `walk_h(child, x, dy+shift)`。shiftは「箱を基準線から下げる量」で、数式の上付き・下付きはこれで表現されている |
| vlist(入れ子) | `walk_v`。分数・表のセルなど |
| rule | 矩形として出力。**幅/高さ/深さが「running」（-2^30）なら親の寸法で解決**（`\hrule`は幅未指定で親いっぱいに走る） |
| disc | ハイフネーション残骸。行分割後は`replace`側が可視なので `node.hpack` で仮詰めして再帰 |
| whatsit(pdf_colorstack) | 色スタックをpush/pop/set（`1 0 0 rg`等のPDF色命令をパースして#rrggbbへ） |
| whatsit(pdf_literal) | `blk_gfx=true`（グリフでは描けない生PDF命令＝TikZ等。精密レンダー層へ） |
| whatsit(special) | `tdomfloat:N` ならフロートアンカーとして記録（§3.9） |
| ins | 脚注。`n.head` の中身を同じ `extract_items` で再帰抽出し、`{k:'ins',...}` として親リストに残す |

`walk_v`（縦リスト）は y カーソルを進めながら各行の基準線を計算して
`walk_h` に渡すだけの対です。

## 3.8 オーケストレータ engine-v3.js

Node側の `CheckpointEngine` クラス。公開APIは
`open(text)` / `edit(start,end,repl)` / `getDisplayLists()` /
`getDOM()` / `getChunkSVG(id)` / `getFontFile(key)` / `exportPDF()` /
`refresh()` / `close()`。

### 保持する状態（主要フィールド）

| フィールド | 内容 |
|---|---|
| `store` | ソーステキスト（`SourceStore`、範囲編集と行列変換） |
| `blocks[]` | ブロック配列。各要素は `{id, text, hash, galley, galleyHash, stateVec, gfx, needsRender, consumesToc, units, unitsSig, kind, file?}` |
| `checkpoints` | Map: idx → Peer（生きているチェックポイント） |
| `labelTable` | Map: ラベルキー→表示値。`cite:`接頭辞で文献も同居 |
| `fonts` / `fontFiles` | フォントid→メタ（family鍵・代替表）／family鍵→実ファイルパス |
| `chunks` | Map: チャンク鍵→`{svg,wBp,hBp,v}`（精密レンダー結果。鍵は `blockId` または `blockId#n`） |
| `pages` | 前回のページ配列（再利用判定のため保持） |
| `twinMetrics` | 数式代替フォントのグリフ寸法（TWINメッセージ） |
| `tocHash` / `includes` / `watchers` | 目次内容のハッシュ／`\input`ファイルのmtimeキャッシュ／fs.watch |
| `bgTask` / `bgAbort` | バックグラウンド連鎖再構築の制御 |

### #update — 編集1回のパイプライン全順序

`open` も `edit` も最終的に `#update()` に入ります。実行順どおりに：

```text
(0) bgAbort=true にして進行中のバックグラウンド連鎖再構築を止め、await
(1) プリアンブルhash比較 → 変わっていたら #bootRoot()（全プロセス破棄→
    driver.tex再生成→root再起動→GEO/TWIN受信）。全ブロックのgalleyを無効化
(2) segmentBody() で本文をブロック分割 → #expandIncludes() で \input 展開
    （mtimeキャッシュ・fs.watch登録・深さ3まで再帰）
(3) diffBlocks() 旧配列と内容hashで突き合わせ：
    共通prefix/suffixはオブジェクトごと再利用（=galley等のキャッシュ温存）、
    変更ブロックはid維持で作り直し、追加は新id
(4) firstDirty = 「ここから先のチェックポイントは無効」となる最小idx。
    dirtyブロックの位置と、旧新配列の共通prefix長のmin（純粋な削除・挿入
    でもチェーンは無効化される）
(5) idx > firstDirty のチェックポイントへ DIE
(6) ★フォアグラウンド組版ループ：
      i = nearestCheckpoint(firstDirty)   ← スパース化で手前になり得る
      while i < blocks.length:
        galley = await #jobBlock(i)       ← fork→組版→GALLEY受信
        #adoptGalley()                    ← hash/stateVec/フォント登録...
        ラベル差分を changedLabels へ蓄積
        「クリーンなブロックを組み直したのに galleyHash も stateVec も
         前回と一致」かつ「この先に影響を受けるブロック（galleyなし or
         changedLabels を参照）がない」→ ★収束、break
(7) 消滅ラベルの掃き出し（labelTableから削除し changedLabels へ）
(8) ★後方参照パス：changedLabels を参照している全ブロックのうち、
    ガレー上でまだ現在値を映していないものを nearestCheckpoint から
    再組版（§下の「プレリュード」参照）
(9) ★目次固定点ループ（最大3周）：
      仮ページ分割 → #computeToc()（見出し表からdriver.toc内容を合成、
      \contentsline 4引数形式）→ hashが動いたらファイルへ書き、
      \tableofcontents を含むブロックを再組版 → もう一周
(10) #paginateNow() → pagebuilder.buildPages()（§3.9）
     → reconcile() で前回ページと同一性比較（drawエントリの参照一致）
     → 一致ページはdisplay listごと採用
(11) 変わったページだけ #displayList() を生成し、hash比較で
     replace-page / remove-pages パッチを作る
(12) #scheduleBackground()：
     a) 連鎖の残り（収束でスキップした部分）を非同期でJOBし直し、
        チェックポイント網を文書末尾まで復元（次の編集への備え）
     b) gfx/フロートgfxブロックのレンダー子を発火（awaitしない）
(13) rev++、レポート（dirtyノード一覧・依存・タイミング・ページ再利用数）
     を返す
```

### プレリュード注入 — 分岐宇宙のラベル問題

`#jobBlock(idx)` は本文の前に小さな**プレリュード**を挿入します：

```tex
\makeatletter
\global\@namedef{r@fig:plot}{{1}{1}}          % 現在の真実の値
\global\expandafter\let\csname r@old\endcsname\relax  % 消えたラベルの中和
\makeatother
```

なぜ必要か。`\r@key` の即時定義（`token.set_macro`）は**それを実行した
プロセスの子孫にしか存在しません**。ラベルが文書の後方で定義された
場合、前方のチェックポイントの系統はそれを知らない——そこから
再組版した子も知らないままです。逆に、一度あるチェックポイント系統に
定義されたラベルは、ソースから消しても系統内に亡霊として残ります。
プレリュードは「このブロックが参照するキーについて、オーケストレータが
握る文書全体の真実」を毎回上書きすることで、系統の分岐と時間差を
吸収します（第6章・罠5）。

### 収束の自己検証

増分計算の正しさは通常「依存を完全に列挙できたか」に懸かりますが、
TeXでは完全列挙は不可能です（catcodeもマクロも動的）。本エンジンの
収束判定はより強い性質を持ちます：**「クリーンなはずのブロックを実際に
もう1つ組版してみて、出力（galleyHash）と状態ベクトル（追跡カウンタの
出口値）が前回と完全一致したら止まる」**。つまり停止判定そのものが
検算です。一致しなければ（式番号がずれた等）そのまま次のブロックへ
進み、一致するまで倒し続けます——LaTeXの「もう一回コンパイル」を
ブロック単位に局所化した形です。

### スパースチェックポイント

チェックポイント＝プロセスなので、巨大文書では数を絞ります
（`maxCheckpoints=64`）。`#ckptGrid()` が保持間隔を決め、格子外の
チェックポイントは**後継が生まれた直後に** DIE で退役します
（`#retireOffGrid`）。編集時は `#nearestCheckpoint(K)` が手前の生存
スナップショットを選び、そこからKまでのクリーンなブロックを
数個余分に組版するだけです（1個3ms程度なので体感差なし）。

### \input と外部変更

`#expandIncludes()` は `\input{file}` / `\include{file}` だけの行の
ブロックを、そのファイルの中身のブロック列に置換します（ファイル
属性つき、内容hashにファイルパスを混ぜて衝突回避）。`fs.watch` で
監視し、外部エディタでの保存を検知すると `onExternalChange` →
サーバーが `engine.refresh()` を直列キューで実行してSSE配信します。

## 3.9 pagebuilder.js — ライブ出力ルーチン

v3.1で追加された、LaTeXの `\output`（`\@makecol`＋`\@combinefloats`）に
相当する自前実装です。入力は「全ブロックのunits（行単位）を連結した
ストリーム」、出力はページ配列。

### unitsへの変換（engine-v3.js buildUnits/miniUnits）

ガレーitemsを改ページ可能な単位に直します：

- `box` → unit `{h=高さ+深さ, pre=直前に溜まったglue/kern, ln={runs,...}}`
- ブロック先頭のunitには**ブロック間グルー**を合成して足す：
  `max(lineskip, baselineskip − 前ブロック最終行の深さ − 自行の高さ) + parskip`
  （\vbox単位で組んだことで失われる「段落間の行送り」の再現。
  TeXの `\prevdepth` 機構の等価式）
- `pen ≥ 10000` → 直前unitに `keepWithNext`（見出し直後で改ページ
  しない等、TeXのペナルティ意図をそのまま利用）
- `ins` → 直前unitの `inserts[]` に脚注ミニガレー（`miniUnits`で
  行単位化済み）としてぶら下げる
- `fm`（フロートアンカー）→ そのunitの `floats[]` にフロート実体
  （置き場所指定・寸法・ミニガレー・精密チャンク参照）を接続

### 配置アルゴリズム（buildPages）

LaTeX既定と同じページ構造
**［上部フロート］［本文］［\skip\footins＋脚注罫＋脚注］［下部フロート］**
を、実測ジオメトリ（`\topfraction` 等はdriver.texから実値を送信）で
組み立てます：

```text
for unit in stream:
    keepWithNext保留処理（見出し＋次行をまとめて載るか判定）
    必要高さ = pre + unit.h + そのunitの脚注高さ(+初回なら footins skip+罫線分)
    入らなければページを閉じる（閉じた直後、繰越フロート列 queue を
      新ページの top/bottom へ再配置試行）
    unitを本文に置き、脚注を feet に積み、footH を増やす
    unitのフロートを配置試行：
      'h': その場に入るなら本文へインライン（intextsep付き）→ダメならtへ
      't': 本文がまだ空のページなら topFloats へ（topfraction・全体高を
           チェック）→ダメなら queue
      'b': botFloats へ（bottomfraction チェック）→ダメなら queue
      'p' or 巨大: 空ページを独占するフロートページ化
末尾: 残った queue をフロートページとして吐き切る
```

その後、各ページについて**絶対座標での描画列 `page.draw`** を確定します
（上部フロートのy→本文各行のベースライン→脚注罫rule→脚注行→下部
フロート）。`page.identity` には載った実体（unit参照とフロートid）を
並べ、`reconcile()` が**参照同一性**で前回ページと比較——変わっていない
ページはオブジェクトごと（=display listごと）再利用され、パッチ対象から
自然に外れます。

簡略化している点も明記します（第6章§既知の限界と重複）：
`\footnoterule` は「0.4×版面幅の0.4pt罫＋固定間隙」で近似、脚注の
ページまたぎ分割・`\clearpage`によるフロート強制放流・二段組は未実装。

## 3.10 レンダー子 — 精密レンダー層

グリフ描画（第4章）で表現できないもの＝**pdf_literalを含むブロック**
（TikZ・pgf全般）と**cmexの大型可変グリフ**は、「即時はグリフ近似で
表示→数百ms〜2秒後に本物のPDF由来SVGに自動置換」という2層戦略を
取ります。後段を担うのがレンダー子です。

流れ（`daemon.lua` RENDER分岐 と `engine-v3.js` `#renderBlock`）：

```text
オーケストレータ: RENDER <id> <jobdir> <len> を該当ckptへ
ckpt: fork → 子:
  lfs.chdir(jobdir)          ← ★PDFファイルは「最初のshipout時にcwdへ
                                jobname.pdfとして開かれる」ため、先に
                                作業ディレクトリを移す（チェックポイント
                                側は無出荷なのでファイル未オープン）
  finish_pdffile コールバック登録（PDFクローズ完了→DONE送信）
    ※LaTeX下では luatexbase.add_to_callback を使う（生callbackは禁止）
  ブロックを \vbox で組版
  tdom_ship(): boxをコピーして \box255 へ、tex.pagewidth/pageheight を
    box寸法ぴったりに設定 → \shipout\box255 （タイトページ1枚目＝本体）
  tdom_ship_floats(): 捕捉済みフロートboxのコピーを1つずつ同様に出荷
    （ページ2..N ← ページ番号とフロートの対応は出現順で確定）
  \csname @@end\endcsname   ← \endプリミティブ。PDFファイナライズ→プロセス終焉
オーケストレータ: DONE受信 → pdftocairo -svg -f k -l k で各ページをSVG化
  → chunks[blockId] / chunks[blockId#n] に格納（版番号vを増やす）
  → #asyncRepaginate() → 変わったページをSSE 'patches' で配信
  → ビューアが該当領域の<img>を差し替え（クリップ窓つきオーバーレイ）
```

driver.texの `\hoffset=-1in \voffset=-1in` はここで効きます。TeXの
出荷原点は歴史的に(1in,1in)なので、打ち消さないとタイトページの中身が
右下にずれて切れます（第6章・罠10）。

## 3.11 表示リストとHTTP境界

最終出力は**ページごとの描画命令列（display list）**です。コマンドは
4種：

| op | フィールド | 意味 |
|---|---|---|
| `glyphs` | fam,size,x,y,text,color?,src | 実フォントで文字列を描く（y=ベースライン。TeX座標そのまま、単位bp） |
| `rule` | x,y,w,h,color?,src | 矩形（分数線・booktabs罫・脚注罫） |
| `chunk` | chunk,x,y,w,h,sy,ch,cv,src | 精密SVGチャンクをy=sy起点でクリップして貼る（cvは版番号＝キャッシュバスター） |
| `folio` | x,y,text | ページ番号 |

`src` には由来ブロックidが入っており、プレビューのクリック→ソース
ジャンプ（SyncTeX相当）に使われます。ページ全体のJSONをFNV-1aで
ハッシュし、変わったページだけが
`{type:'replace-page', page, displayList}` パッチとしてPOST応答
（およびSSE）で届きます。

HTTPエンドポイント（`server.js`）：

| ルート | 内容 |
|---|---|
| `POST /edit {start,end,text}` | 範囲編集→dirtyレポート＋パッチ（本文§3.8の(13)） |
| `GET /doc` | 初期ロード一式（ソース・全ページDL・ジオメトリ・フォント鍵一覧） |
| `GET /font/<key>` | TeXが実際に使ったフォントファイル（immutableキャッシュ） |
| `GET /chunk/<key>.svg?v=` | 精密チャンク |
| `GET /events` | SSE（他ウィンドウ同期・非同期パッチ・外部ファイル変更） |
| `GET /pdf` | 素のlualatex 2パスによる正式PDF |
| `GET /dom` | ブロック/依存/ページ対応の観測用JSON |
| `POST /open` | 文書リセット |

---

次章は、このdisplay listをブラウザがどう「印刷と同じ絵」にするか——
フォント配信と数式フォント置換の詳細です。
