# ide-pane

Claude Code の横に、IDE のサイドバーのようなペインを出す Mod です。TODO・問題・変更の 3 つのタブがあり、Claude がファイルを書き換えるたびに数え直します。

- **1: TODO** — コメントの中の TODO・FIXME・HACK・XXX をファイルごとに並べます。起動したあとに増えたものには「+新規」、消えたものには打ち消し線と「済」が付きます。
- **2: 問題** — `tsc` と `eslint` のエラー・警告を並べ、件数の移り変わり（3 → 1 → 0）を出します。
- **3: 変更** — `git status` の一覧です。Claude が書いたファイルには「Claude」、書いている最中のファイルには「← いまここ」が付きます。行を開くと、その下に差分が出ます。

幅が足りるときは一覧の右にエディタが並び、選んだ行のファイルをその場で書き換えて保存できます。

## 入れ方

Claude Code の入力欄で:

```
/plugin install ide-pane --marketplace nogu66/claude-ide-pane
```

マーケットプレイスを足すか聞かれたら `y`、入れる範囲は Enter でユーザー全体を選びます。

シェルから入れる場合:

```
claude plugin install ide-pane --marketplace nogu66/claude-ide-pane
```

デスクトップアプリでは `/plugin` が使えません。入力欄の横の + から Plugins を開き、Add marketplace に `nogu66/claude-ide-pane` を入れてから Add plugin を選びます。

## 使い方

端末が 144 列以上あれば、起動したときにペインが開きます。狭いときや閉じたあとは `/ide-pane` で開きます。

| キー | 動き |
|---|---|
| `ctrl+x` → `tab`、またはクリック | ペインにフォーカスを移す（下のキーはフォーカスがあるときだけ効く） |
| `1` `2` `3` | タブを切り替える |
| `↑` `↓` | 行を選ぶ（幅が足りれば右のエディタに開く） |
| Enter | TODO・問題の行: 依頼文を入力欄に入れる / 変更の行: 差分を開く・閉じる |
| `a` | 問題を全部まとめて依頼文にする |
| `r` | 数え直す |
| `e` / `x` | 狭いとき: 選んだ行をエディタで開く / 閉じて一覧に戻る |
| Esc | 入力欄に戻る |

依頼文は入力欄に入るだけで、送信はしません。中身を確かめてから Enter で送ってください。

エディタはクリックするとキーを受け付け、`⌃S` で保存、`⌃R` でディスクから読み直します。未保存のまま Claude が同じファイルを書き換えたときは、上書きせずに知らせます。

タブは引数でも開けます: `/ide-pane todo`、`/ide-pane problems`、`/ide-pane changes`、`/ide-pane close`。

## 必要なもの

- `rg`（ripgrep）。無ければ `git grep` で探します
- `git`（変更タブ）
- 問題タブは、`tsconfig.json` があれば `tsc`（`node_modules/.bin/tsc`、無ければ PATH の `tsc`）、eslint の設定と `node_modules/.bin/eslint` があれば `eslint` を使います

`node_modules`・`dist`・`build`・`.next`・`coverage`・`out` は、`.gitignore` が無くても数えません。
