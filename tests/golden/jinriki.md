Case: <GJ-001>
原文: <input 新規でメール作成して 宛先: foo@example.com 件名: 見積の件 本文: よろしくお願いします。>

>>> 各ステップ想定（上から）
1. unicode_nfkc -> 新規でメール作成して 宛先: foo@example.com 件名: 見積の件 本文: よろしくお願いします。
2. to_halfwidth -> 同上
3. normalize_numbers -> 同上
4. unify_dash -> 同上
5. unify_quotes -> 同上
6. normalize_kigou -> 同上
7. lowercase -> 同上
8. trim -> 同上
9. collapse_spaces -> 同上
10. strip_quotes -> 同上
11. mask_emails / mask_phones / mask_urls(after) -> 新規でメール作成して 宛先: <email_masked> 件名: 見積の件 本文: よろしくお願いします。 after 11

正規化後（判定用）想定: 新規でメール作成して 宛先: foo@example.com 件名: 見積の件 本文: よろしくお願いします。

compose (+5.25)
 - triggers 新規、作成　(compose +2)
 markers (+2.5)
 - to markers 宛先　(+1)
 - subject markers 件名　(+1)
 - body markers 本文　(+0.5)
 regexes foo@example.com (compose +0.75)
 context:- Context: in_thread=<false>
 
extraction_rules 
抽出可否:
 - to: [ foo@example.com ] 
 - subject: "見積の件"
 - body: "よろしくお願いします"

想定判定: compose

乖離（期待と違う場合）: <なし>
原因メモ: 
改善候補: 


乖離記録テーブル
| Case ID | 期待      | 想定判定    | 乖離  | 原因メモ               | 改善候補             |
| ------: | ------- | ------- | --- | ------------------ | ---------------- |
|  GJ-001 | compose | compose | なし  | ー                  | ー                |
|  GJ-00X | compose | reply   | ラベル | reply\_triggersが強い | composeトリガ重み+0.5 |

