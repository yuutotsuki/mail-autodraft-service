正規化

1. unicode_nfkc

目的：合成文字を正規化（見た目は同じでも内部コードを統一）。

変化：基本変わらない（日本語や ASCII のメールはそのまま）。

2. to_halfwidth：（全角→半角）

目的：全角英数字や括弧を半角に。

3. normalize_numbers：全角数字や桁区切りが揃うか（例：「１，０００」→"1000"）

4. unify_dash：複数種のダッシュが - に揃うか（例: — → -）

5. unify_quotes：“ ” を " に揃えるか（引用符の見た目）

6. normalize_kigou：丸括弧/中点など記号が標準化されるか

7. lowercase：英字が小文字化される（メールアドレスなど）

8. trim：先頭末尾の空白が消えるか

9. collapse_spaces：連続空白が1つにまとまるか

10. strip_quotes：引用行（>）が除去されるか → 返信判定に影響するので要注目（初期は disabled 推奨）

11. mask_emails / mask_phones / mask_urls：PIIが置換される（masking_phase が after なら判定前は生のまま） → 抽出可否の要確認

判定

1. Exact（完全に一致するワード） → とても強い（例：「新規メール作って」「メール作って」）

2. Regex（メールアドレス / 日付） → 中強度（例：xxx@example.com）

3. Marker（宛先・件名の語） → 中程度（例：「宛先:」「件名:」）

4. Context（スレッド内/引用率） → 小さい加点（例：引用多＝reply寄り）

5. Blocker（「テスト」「FYI」「議事録」「送らないで」など） → 即時除外（実行禁止）

効きそうなルール:
 - Exact: "<語句>" (+X)
 - Regex: "<email/datetime>" (+Y)
 - Markers: 宛先/件名/本文 (+Z)
 - Context: in_thread=<true/false> (reply寄りかどうか)
 
記入例
 - Exact: "新規でメール作成して" (+5)
 - Regex: email detected "foo@example.com" (+3)
 - Markers: 宛先、件名、本文 (+2 each)
 - Context: in_thread=false (reply寄りではない)

 - extraction_rules（抽出ルール）
to:
  - pattern: "(宛先|to)[:：]\\s*([\\w._%+-]+@[\\w.-]+)"
    group: 2
宛先: hanako@example.com のような書き方から、実際のメールアドレス（ここでは正規表現の 第2グループ）を取り出すためのルール。

抽出された値は「宛先」にセットできるから、確認カードに自動で入れられる。

想定判定: compose / reply / other / ambiguous

乖離（期待と違う場合）: <あり/なし>
原因メモ: <例: masking_phaseがbeforeなら抽出出来ない等>
改善候補: <例: mask_after にする / marker追加 / trigger重み+0.25>