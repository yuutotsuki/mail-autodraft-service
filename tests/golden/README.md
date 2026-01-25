# Golden Set for Intent Routing (JA/Email)

目的: 設定変更（normalize / compose_detection）の良し悪しを、同じデータで反復検証できるようにするための“ゴールデンセット”です。実行系は使わず、判定と抽出の品質評価のみを想定します。

- ファイル: `ja/email.yaml` にケースをまとめます（最初は単一ファイル運用）。
- 項目:
  - `id`: 一意なケースID（例: `GJ-001`）
  - `input`: Slackメッセージの想定原文（短文でOK）
  - `context`: ルーティングに影響しうるメタ
    - `in_thread` (bool): スレッド内か
    - `quoted_ratio` (0.0-1.0): 引用行の割合目安
    - `has_email` (bool): アドレスの有無（前処理や検出に依存）
  - `expected`:
    - `label`: `compose` | `reply` | `other`
    - `params` (任意): `to`/`subject`/`body` の期待抽出（分かる範囲で）
  - `notes` (任意): 背景・判断根拠など

使い方（イメージ）
- 設定（config/*.yaml）を更新 → このケース群で判定・抽出結果を比較 → 閾値/重み/ルールを微調整。
- 失敗ケースは`notes`に理由を書き残し、次回の改善対象に。

将来の拡張
- ドメイン別のファイル分割（例: `ja/calendar.yaml`）
- CIでの自動検証（diffサマリ、precision/recall集計など）
