# 手動テスト手順（実行なし）

目的: 設定（config/*.yaml）の内容が意図どおりか、ゴールデンセット（tests/golden/ja/email.yaml）で“読み合わせ”を行い、改善点を洗い出す。実行コマンドは不要。

## ステップ
- 1) 前提の確認
  - `config/normalize.yaml` の `safe_mode: true` を確認
  - `config/compose_detection.yaml` の `thresholds` と `safe_mode: true` を確認
  - `test_manifest` が `tests/golden/ja/email.yaml` を指していることを確認
- 2) 正規化イメージ
  - ゴールデンセットの各`input`に対して、normalizeのパイプラインを目で追う（例: lowercase → trim → … → mask_emails）
  - マスクやトリム後に意味が変わらないかをメモ
- 3) 判定イメージ
  - `triggers`/`reply_triggers`/`markers`/`regexes`/`blockers`/`context_signals` を眺め、各ケースがどの加点・減点を受けるかをざっくり想定
  - 合計スコアが `compose_min_score` / `reply_min_score` を超えそうか感覚チェック
- 4) 抽出イメージ
  - `extraction_rules` で `to`/`subject`/`body` が拾えるかを目視確認
- 5) 乖離の記録
  - 期待（`expected.label`/`params`）と乖離するケースを下の表に記録
  - 乖離理由を「ルール不足」「重み不足」「blocker過強/過弱」などで分類

## 乖離記録テンプレート
| Case ID | 期待 | 想定判定 | 乖離 | 原因メモ | 改善候補 |
|---|---|---|---|---|---|
| GJ-00X | compose | reply | ラベル | 返信トリガ過強 | composeトリガ重み+0.5 |
| GJ-00Y | compose.to=1件 | to抽出0件 | 抽出 | 正規表現不足 | マーカー表現追加 |

## チェック観点
- 正規化: マスク前後の順序で意味が変わらないか（`masking_phase_default`や個別`masking_phase`）
- スコア: 強トリガ（weight=2.0）が適切に閾値を超えられるか
- blocker: 「テスト」「FYI」などが誤って実行側に寄与していないか
- 抽出: マーカー+正規表現の組み合わせで最低限の抽出ができるか

## 次のアクション例（実行なし）
- 重みの微調整（±0.25〜0.5）
- `phrases`/`terms`の追加（言い換え拡張）
- `blockers`の追加・重み調整
- `extraction_rules`の正規表現チューニング
