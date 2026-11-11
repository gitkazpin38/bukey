# CLAUDE.md — 部室の鍵ボード

このリポジトリで作業するときの前提です。作業を始める前に読んでください。

## これは何か

大学のサークル（部活）の部室の鍵を管理するWebアプリ。
鍵は守衛室にあり、部員は守衛さんに鍵番号を伝えて借り、少し離れた部室を開ける。
部員みんなで「いま誰が鍵を持っているか」「部室は開いているか」をリアルタイムに共有する。

**一番大事なルール: 鍵は絶対に家に持ち帰らせない。**（過去に持ち帰って怒られた事例がある）
部室を離れるときは必ず施錠し、鍵を守衛に返すか、自分で持っていることを明記する。
機能を足すときも、この目的を弱める変更（持ち帰りを見逃す、保持者が曖昧になる）はしないこと。

## 構成

- 画面: GitHub Pages で配信する静的ファイルのみ。ビルドなし、フレームワークなし、バニラJS（ES Modules）
- データとログイン: Firebase（Firestore + Firebase Authentication の Google ログイン）
- Firebase JS SDK は gstatic の CDN から読み込み（`app.js` 冒頭、バージョン固定 10.12.2）

| ファイル | 役割 |
|---|---|
| `index.html` | 画面の骨組み。ビューは `v-signin` / `v-home` / `v-join` / `v-missing` / `v-board` を `hidden` で切り替え |
| `style.css` | 見た目。色は `:root` のトークン経由で、ライト/ダーク両対応 |
| `app.js` | すべてのロジック |
| `firebase-config.js` | Firebase のウェブアプリ設定。公開前提の値で秘密ではない |
| `firestore.rules` | セキュリティルール。**データを守っているのはここ** |
| `firebase.json` | Firebase CLI 用（`firebase deploy --only firestore:rules`） |

URL は `?club=部活ID`（参加時は `&code=招待コード` 付き）。部活IDなしならホーム画面。

## データ構造（Firestore）

```
users/{uid}                      { clubs: [{id, name}] }  自分が参加している部活
clubs/{clubId}                   { name, keyNo, closeTime "HH:MM", ownerUid, createdAt }
clubs/{clubId}/private/invite    { code, updatedAt }       管理者だけ読める
clubs/{clubId}/members/{uid}     { uid, name, role: "admin"|"member", joinCode?, joinedAt }
clubs/{clubId}/state/main        いまの状態（下記）
clubs/{clubId}/log/{id}          { ms, action, text, prev, next, undone, undoneBy?, by, byUid }
```

時刻は `Date.now()` のミリ秒（クライアントの時計）。最終返却時刻などの判定もクライアント側。

## 状態モデル（state/main）

```
key:  "guard"（守衛室・返した） | "borrowed"（借りた） | "holding"（持っている＝保持宣言済み）
room: "open" | "closed"
holder: 鍵を持っている人の表示名（guard のときは ""）
holderUid: holder が部員ならその uid（部員以外・訂正で名前のみのときは ""）
holderGuest: true なら holder は部員以外（特別な事情での譲渡）。画面では紫の名前と「部員以外」タグ、文言には「（部員以外）」を付ける
returnBy: holding のときの返却予定 "HH:MM"
note, since(ms), by(表示名), byUid
```

画面のランプはユーザーが最初に求めた5つ: **借りた / 持っている / 返した / 開いている / 閉まっている**。

あり得る組み合わせ:
- guard + closed … 通常（鍵は守衛室）
- borrowed + closed … 借りて部室へ向かう途中、または施錠直後（このあと返却か保持宣言が必要）
- borrowed + open … 部室使用中
- holding + closed … 施錠済みで、holder が鍵を持っていると宣言済み
- **guard + open は禁止**（訂正でも記録できない）

## 操作（`plan()` が遷移を決める）

| action | 条件 | 結果 |
|---|---|---|
| borrow 鍵を借りた | key=guard | borrowed, holder=自分, closed |
| open 部室を開けた | key≠guard, closed | borrowed, open |
| lock 部室を閉めた | open | closed（鍵はそのまま。返却・保持はこのあと別に記録） |
| return 守衛さんに返した | key≠guard, closed | guard |
| hold 自分で持っている | borrowed, closed | holding, holder=自分。返却時刻必須・最終返却時刻より後は不可・「家に持ち帰らない」チェック必須 |
| hand 鍵を別の人に渡した | key≠guard | holder だけ変更。**部室が開いたままでも渡せる**（ユーザーの要望）。受け取る人は参加中の部員から選ぶ。「部員以外の人に渡す」をチェックしたときだけ自由入力で、holderGuest=true |
| fix 記録の訂正 | いつでも | 指定した状態に直す。履歴に「訂正」で残る |
| undo 取り消し | 下記 | 直前の操作を戻す |

「部室を閉めた」と「鍵を渡した」は別ボタン（開けたまま鍵だけ譲渡できるようにするため）。

「誰として記録する？」（操作カード上部のプルダウン、既定は自分）で、借りた・開けた・閉めた・返した・持っている を別の部員として記録できる（代理記録）。
「＋ 部員以外の人…」を選ぶと名前を入れて部員以外として記録できる（`actorGuest` / 借りた・持っているなら `holderGuest`）。部員以外の名前は state の `guests` に残り、鍵を守衛さんに返す（key=guard）と空になって選択肢から消える。
state と log に `actor` / `actorUid`（誰として）を持ち、`by` / `byUid` は押した本人のまま（ルールで byUid == auth.uid）。代理のときは文言に「（記録: 本人）」を付け、記録後は自分に戻す。渡した・訂正は常に本人として記録。

## 誤操作対策（ユーザーの要望で必須）

- **すべての操作は確認画面を出してから書き込む**（`confirmBox()`。`window.confirm` は使わない）。確認画面には「操作 / いま / 記録後」を表示
- **取り消し**: 記録直後のメッセージと、履歴の最新行に「取り消す」ボタン
  - 取り消せるのは「取り消し・元に戻す」以外で最新の記録だけ。現在の state がその記録の `next` と一致するとき（key, holder, room, since を比較する `sameState()`）だけ。**押した本人（byUid）だけ**（ルールでも log の update は `resource.data.byUid == auth.uid`）
  - 取り消すと state を `prev` に戻し、元の記録に `undone: true` を付け、新たに action:"undo" の記録（`target`, `prev`, `next`, `redone`）を残す
  - **元に戻す**: 最新の記録が自分の undo で、state がその `next` と一致するときだけ。state を undo の `prev` に戻し、undo に `redone: true`、元の記録の `undone` を false にし、action:"redo" の記録を残す。元に戻した記録はまた取り消せる
- 記録と取り消しは `runTransaction` で state と log をまとめて書く（同時押しで食い違わないように）

## 警告（renderAlerts）

- 最終返却時刻を過ぎて鍵が守衛室にない → 赤
- 前日から鍵が返っていない → 赤
- borrowed + closed のまま30分 → 黄（返却か保持宣言を促す）
- 保持中で返却予定時刻を過ぎた → 黄

## 権限（firestore.rules）

- 部活のデータ（state, log, members）は**その部活の部員だけ**が読み書きできる。ほかの部活の部員は読めない
- 部員一覧は部員全員に表示する（権限変更・削除のボタンは管理者だけ）
- `clubs/{clubId}` 本体（名前・鍵番号・最終返却時刻）は参加画面のため、ログイン済みなら ID 指定で1件読める（一覧は不可）。ユーザーはこれで了承済み
- 参加は正しい招待コードが必要。作成者は管理者として作られ、降格・削除されない
- 管理者: 部活設定、招待コードの作り直し、部員の権限変更・削除、履歴の削除、部活の削除
- 部活の削除（管理者なら誰でも）: 確認のため部活IDの入力が必要。履歴・state・招待コード・ほかの部員を先に消し、最後に「部活本体＋作成者と自分の部員データ」を1回のまとめ書き込みで消す。作成者の部員データは、部活本体が同時に消えるとき（`!existsAfter(clubPath(c))`）だけ消せる
- ほかの部員の `users/{uid}.clubs` は本人しか書けないので、削除した部活が一覧に残る。開いたときに「見つかりません」を出し、本人の一覧から自動で外す
- state/log の書き込みは `byUid == request.auth.uid` 必須
- log の update は `undone` / `undoneBy` だけ

**新しいフィールドやコレクションを足したら、必ず `firestore.rules` も合わせて直すこと。**

## デプロイの注意

- 画面（HTML/CSS/JS）は main に入れれば GitHub Pages が自動で更新される
- **`firestore.rules` は GitHub に入れても Firebase には反映されない。** Firebase コンソールに貼るか `firebase deploy --only firestore:rules` が必要。ルールを変えたら、そのことを必ずユーザーに伝える
- Firebase Auth の承認済みドメインに `<user>.github.io` が必要
- ログインはポップアップが基本。使えないときのリダイレクトは、github.io と firebaseapp.com が別ドメインのためブラウザによっては戻ってきてもログインできない。そのときとアプリ内ブラウザ（LINE など）では、Safari / Chrome で開き直す案内を出している（`showSigninHelp()`）
- サービスアカウントの鍵などの秘密情報はリポジトリに入れない

## 作業の進め方

- 動作確認は `python3 -m http.server 8000` で http://localhost:8000/ を開く（ES Modules のため file:// では動かない）。
- 変更はブランチを切ってプルリクエストにする。main への直接 push は初回だけ。
- 画面の文言は日本語。部員がスマホで、守衛室や部室の前で使う前提なので、ボタンは大きく、文言は短く具体的に。
- 依存ライブラリやビルド工程は、必要になるまで足さない。

## まだやっていないこと・今後の候補

- 実際の Firebase プロジェクトでの通し確認（構文チェックのみ済み）
- `firestore.rules` を main への push で自動反映する GitHub Actions
- 部活IDを誰でも登録できる状態の制限（許可メールアドレス、App Check など）
- 古い履歴の整理（今は最新40件を表示、削除は管理者のみ）
