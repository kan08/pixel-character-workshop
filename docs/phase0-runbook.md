# Phase 0 実機検証

ルウの試験素材で、Muse から言葉で依頼し、スマホで動きを見て、修正と採用を返す。最後に、実際に詰まった工程を1件だけ改善し、同じ素材で再検証する。

## 1. 接続を準備する

- 制作専用 GitHub リポジトリの `owner/repo`、閲覧範囲、Muse が Issue を起票・コメントできるアカウント、Mac 側で状態を投稿する `gh` アカウントを決める。リポジトリを作成して Issues を有効にし、両者の接続を確認する。
- 専用の静的配信先を用意し、配信 URL と公開方式を決める。Phase 0 の公開候補はルウの試験素材に限り、Mac から認証なしで HTML・GIF・PNG を取得できる設定にする。`preview/` の中身を配信ルートに置き、元の `jobs/` と `docs/` は公開物に含めない。
- [Muse 運用プロンプト](muse-2d-prompt.md)の対象リポジトリ、プレビュー URL 基盤、投稿アカウントを埋めて Active Memory に登録する。最初の往復は Mac で Issue 番号を指定して手動で処理する。

Mac の前提は Node.js 22 以上、認証済みの `gh`、版を引き継げる同じ作業フォルダ。パイプラインは `jobs/` を参照して次版と採用状態を作るため、検証中はその内容を保持する。

## 2. スマホで一往復する

1. Muse に「ルウの右向き歩きを作りたい。まず基準画から」と伝える。復唱に OK を返し、Muse が起票した基準画 Issue を Mac 側で処理する。
2. Muse が届けたリンクをスマホで開き、原寸と拡大の基準画を確認する。Muse に「この v1 を採用。次は右向き歩きを作って」と返す。基準画の採用処理後、Muse が採用版を `reference` に指定した別 Issue を起票する。
3. 歩きの Issue を処理し、Muse の v1 リンクからスマホで自動ループと原寸の見え方を確認する。表示時間は `120 / 110 / 120 / 110 ms`。Muse に「テンポをゆっくりにして。コマの絵と順番はそのまま」と返す。
4. 同じ Issue を処理し、Muse の v2 リンクで前版と今回が横並びに見えるか、暗い表示でも読めるか、テンポが遅くなったかを見る。v2 は `180 / 170 / 180 / 170 ms`。Muse に「この v2 を採用」と返す。
5. 採用の結果を Muse で受け取る。運用側は `jobs/<jobId>/adopted.json` の採用番号と `spriteSheet`・`frameJson` のファイルを確認する。

各 Issue またはコメントの処理は、下のコマンドを対象 Issue 番号に合わせて実行する。公開権限のある担当者が配信先へ `preview/` をアップロードし、前版も残す。`--publish` では対象版の HTML と画像の配信内容をローカルと照合してから、Issue に状態を1回投稿する。採用や改善記録の処理は画像のアップロードを挟まず `--publish` で実行できる。

```sh
REPO='kan08/pixel-character-workshop'
ISSUE=1
PREVIEW_BASE='https://kan08.github.io/pixel-character-workshop/'
npm run pipeline -- process-issue --repo "$REPO" --issue "$ISSUE" --preview-base-url "$PREVIEW_BASE"
# preview/ を gh-pages へ配信した後、同じ Issue を指定する
npm run publish-preview
npm run pipeline -- process-issue --repo "$REPO" --issue "$ISSUE" --preview-base-url "$PREVIEW_BASE" --publish
```

配信が未反映なら投稿は保留される。ファイルを再配信して同じコマンドを再実行する。検品で停止した版は `result.json` と `blocked` の状態コメントで原因を確認し、修正は新しいコメントで依頼する。確認リンクが届いたら、スマホでは Issue を開かずに採否を Muse へ返せたかを記録する。

## 3. 詰まりを1件直す

Muse で出た原文と期待する動作を基に、[運用プロンプト](muse-2d-prompt.md)の `log-improvement` コメントを残す。Mac で直接記録する場合は次を使う。

```sh
npm run pipeline -- log-improvement --step step4-export --job-id '<jobId>' --rev 2 \
  --symptom '<実際に起きた症状>' --expected '<期待した動作>' \
  --cause '<確認できた原因>' --action '<対策と再検証方法>'
```

`docs/improvement-log.md` から版と再現条件をたどり、原因の工程を直す。同じ素材・指示を別の作業フォルダで再実行し、改善前後の結果を確認して追記する。書き出しの検品を確認したい場合は `node --test --test-name-pattern '1コマ GIF' test/pipeline.test.js` で、静止 GIF が停止し、正常 GIF が通る例を再現できる。

## ローカルで先に試す

```sh
npm test
npm run pipeline -- run-local --job-id luu-base --kind illustration --request 'ルウの基準画'
npm run pipeline -- adopt --job-id luu-base --rev 1
npm run pipeline -- run-local --job-id luu-walk --kind animation --request 'ルウの右向き歩き' \
  --reference jobs/luu-base/v1/output/base.png
npm run pipeline -- run-local --job-id luu-walk --kind animation --rev 2 --base-rev 1 \
  --request 'テンポをゆっくりにして' --keep 'コマの絵と順番'
npm run pipeline -- adopt --job-id luu-walk --rev 2
```

比較ページは `preview/luu-walk/v2/index.html`、一覧は `preview/index.html`。Issue 接続前に通知を確認するには、`process-issue --dry-run --issue-file <issue.json>` を使用する。フィクスチャは `id`、`number`、`body`、`author.login`、`comments` を持つ JSON で、`body` は運用プロンプトのマーカーと JSON コードブロックを含む。`--issue-file` を省略した dry-run は `gh` で読み取る。どちらも一時作業フォルダで処理し、GitHub への投稿は行わない。

サンプルエンジンが扱う素材はルウの基準画と歩き・まばたき。テンポと指定コマの袖を試せる。制作エンジンを接続するときは `runEngine({ jobDir, job })` で `output/` へ出力し、`jobId`、`revision`、`artifacts`、`preview` を返す。ランナーが検品と版の状態を `result.json` に保存する。作業中の異常終了後に `.pipeline.lock` が残った場合は、記載された PID のランナーが終了したことを確かめてからロックを取り除き、同じコマンドを再実行する。
