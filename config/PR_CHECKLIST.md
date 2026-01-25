# PR チェックリスト（config 用）

対象: `config/normalize.yaml` / `config/compose_detection.yaml` の変更PR。
実行なしでレビュー時に確認する観点です。

## 共通
- [ ] `config_version` を更新（semver、変更内容に応じて桁判断）
- [ ] `updated_at` を更新（UTC ISO8601）
- [ ] `safe_mode: true` のまま（当面は安全側運用）
- [ ] `log_level` は `info` か `warn` 程度
- [ ] `test_manifest` が `tests/golden/ja/email.yaml` を参照（または妥当な相対パス）
- [ ] `_notes` に意図が1行で記載（任意だが推奨）

## normalize.yaml
- [ ] `on_error` は `log` か `skip`（fail は要理由）
- [ ] `masking_phase_default` は `after`（個別指定が必要な場合のみ `before`）
- [ ] `max_text_length` / `max_length_apply_at` の設定が妥当
- [ ] `pipeline` 手順の順序が「副作用小 → マスク → 軽いノイズ除去」に沿う
- [ ] `mask_*`系に個別 `masking_phase` を付ける場合、理由が明記されている

## compose_detection.yaml
- [ ] `thresholds.compose_min_score` / `reply_min_score` は 2.0 前後から開始（変える場合は理由）
- [ ] `triggers` / `reply_triggers` に過度な重みがない（2.0を超える場合は理由）
- [ ] `blockers` の `block: true` は限定的（誤抑止のリスクを理解）
- [ ] すべてのルールに `rule_id` と `explanation` がある
- [ ] `rule_id` 命名規約に一致（例: `TRIG_COMPOSE_ja_001`）
- [ ] `rule_id` は重複なし
- [ ] `markers` / `regexes` / `context_signals` / `extraction_rules` の構成が過不足ない

## ゴールデンセットへの反映
- [ ] 新しい言い回しや誤判定は `tests/golden/ja/email.yaml` にケースを追記
- [ ] 乖離が出た場合は `tests/golden/MANUAL_RUN.md` のテンプレに記録

補足: スキーマ適合性はエディタのスキーマ連携（JSONCの`$schema`／YAML拡張設定）で赤線確認。CI導入は次フェーズで検討。
