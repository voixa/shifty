# Shifty シフト最適化アルゴリズム仕様書

> **目的**: シフト生成の判断基準を完全に明文化し、第三者が監査・検証可能な状態にする。

## 1. 全体フロー

```
入力: staff[], slots[], preferences[], laborRules, weights, randomStarts
  │
  ├─ コスト要素事前計算 (時給→0..1正規化)
  │
  ├─ ループ N 回（randomStarts、決定的シード mulberry32）
  │    ├─ Phase 1: Coverage    困難スロット優先で必要人数を埋める
  │    └─ Phase 2: Optimize    局所交換でスコア改善（最大8ラウンド）
  │
  ├─ 最良解を採用（目的関数値が最大のもの）
  │
  └─ Post-condition 検証
       ├─ 全 assignment を再生してハード制約全充足を確認
       └─ 違反があれば report.audit.hardViolations に記録

出力: { assignments[], metrics, unfilled[], audit }
```

## 2. ハード制約（Hard Constraints）

**違反したスタッフは候補から除外**。生成後に再検証し、違反ゼロを保証。

| ID | 制約 | 根拠 |
|---|---|---|
| `position_match` | ポジション適合 | スタッフの本職または兼任可能リストに含まれるポジションのみ |
| `fixed_day_off` | 固定休日 | 契約上の固定休日には配置しない |
| `no_time_overlap` | 時間重複なし | 同時間帯の二重配置は物理的に不可能 |
| `personal_max_hours_week` | 個人契約週上限 | スタッフとの労働契約上の週時間上限 |
| `labor_max_hours_week` | 労務週上限 | 労務ルールで定められた週上限（労基順守） |
| `labor_max_hours_day` | 労務1日上限 | 1日あたりの労働時間上限 |
| `labor_max_consecutive_days` | 連勤上限 | 連続勤務日数の上限 |

実装: [`js/algorithm.js`](../js/algorithm.js) の `HARD_CONSTRAINTS` 配列。

## 3. ソフト制約（Score Factors）

**違反は許容**するが、スコアに反映される。**全要素を 0..1 に正規化**し、重み付き加重平均で総合スコアを算出。

| ID | 要素 | 既定重み | 値の決まり方 |
|---|---|---|---|
| `preference` | 希望充足 | 40% | `must`+完全包含=1.0 / `must`+部分=0.55 / `want`+完全=0.85 / `want`+部分=0.40 / 未提出=0.30 / `avoid`=0 |
| `positionMatch` | ポジション適合 | 15% | 本職=1.0 / 兼任=0.5 |
| `fairness` | 公平性 | 20% | 最低時間未達=1.0 / 上限に近づくほど 0 へ |
| `cost` | コスト | 15% | 最安スタッフ=1.0 / 最高=0.0（線形） |
| `skill` | スキル | 10% | `staff.skill / 5` |

**スコア計算式**:
```
total = Σ ( factor.value × factor.weight )
```

`weight` は合計が 1.0 になるよう自動正規化される。

## 4. 目的関数（Objective）

多重スタートで最良解を選ぶための関数（生成全体の品質指標）：

```
objective = 0.40 × coverage
          + w_pref × preferenceSatisfaction
          + w_fair × (1 − CV(hours))
          + w_cost × 1
          − 0.20 × avoidViolations
          − 0.10 × overMaxCount
```

- `coverage`: 必要人数に対する実配置数の比率
- `preferenceSatisfaction`: 提出された希望のうち実シフトと一致した割合
- `CV(hours)`: スタッフ間労働時間の変動係数（低いほど均等）
- `avoidViolations`: `avoid` 希望に反した配置数
- `overMaxCount`: 個人上限超過のスタッフ数（理論上 0）

## 5. アルゴリズム

### Phase 1: Coverage（被覆優先）

```
1. requiredCount を 1 単位の slot-instance に展開
2. 各 instance について「現状で eligible なスタッフ数」を計算
3. 候補が少ない instance から優先処理（同率は時系列→決定的乱数）
4. 各 instance で全 eligible スタッフをスコアリング
5. 最高スコアを採用、state を更新
6. 候補ゼロなら unfilled に積む
```

### Phase 2: Optimize（局所改善）

```
最大 8 ラウンド、改善が無くなるまで:
  各 assignment について:
    - 仮にこの assignment を抜いた状態を作る
    - 他の eligible スタッフを再スコアリング
    - 現スタッフより 0.5% 以上スコアの高い候補がいれば入替
```

### 多重スタート（Random Restarts）

```
1. seed = (round + 1) × 12345
2. mulberry32 で決定的乱数生成（同 seed → 同結果）
3. 同点スコア時の選択順序を乱数で決定
4. randomStarts 回（既定 5 回）試行
5. 各試行で目的関数値を計算
6. 最大の目的関数値を持つ解を採用
```

## 6. Post-condition 検証

```
1. 採用された assignments を date / startTime 順にソート
2. 空の state に 1 件ずつ追加していく
3. 各追加時点で全ハード制約をチェック
4. 違反があれば audit.hardViolations に記録
5. 違反ゼロのとき audit.passed = true
```

## 7. 出力データ

```typescript
interface GenerateResult {
  assignments: Assignment[];        // 採用された配置
  metrics: Metrics;                 // カバー率・希望充足・公平性・コスト
  unfilled: Slot[];                 // 候補なしで埋まらなかったスロット
  audit: {
    weights: Record<string, number>;            // 使用された重み
    randomStarts: number;                       // 試行回数
    bestSeed: number;                           // 採用された試行のseed
    bestObjective: number;                      // 最良目的関数値
    trials: { seed, obj, coverage, prefSat }[]; // 全試行の結果
    hardConstraintsChecked: { id, label, rationale }[];
    scoreFactors: { id, label, rationale, weight }[];
    hardViolations: Violation[];                // 違反一覧（空なら通過）
    passed: boolean;                            // 全制約通過か
  };
}

interface Assignment {
  id, date, staffId, position, startTime, endTime, cost;
  score: number;                  // 0..1 の正規化スコア
  breakdown: {                    // スコア要素ごとの詳細
    id, label, value, weight, contrib, detail
  }[];
  topCandidates: {                // 候補上位3名（採用判断の根拠）
    staffId, name, score
  }[];
}
```

## 8. 既知の限界・将来課題

| 項目 | 現状 | 課題 |
|---|---|---|
| 探索範囲 | 局所探索 + 多重スタート | 大規模 instance では局所最適に陥る可能性。CP-SAT 等の厳密解法へ移行候補 |
| 公平性 | CV(hours) で評価 | 性別・年齢別の偏り検出は未実装 |
| 動的調整 | 静的重み | スタッフ離職率・満足度から重みを自動学習する余地 |
| マルチ目的 | 重み線形合成 | パレート最適解の提示（複数案を並べる）は未実装 |

## 9. テスト

ブラウザで [`tests/algorithm.test.html`](../tests/algorithm.test.html) を開くと自動テストが走り、以下を確認できます：

- ハード制約違反ゼロ
- 全 assignment にスコア内訳がある
- スコアが 0..1 の範囲内
- 重みの合計が 1.0
- 同入力で同結果（決定論）

## 10. アルゴリズム変更時のチェックリスト

1. ハード制約を追加するとき → `HARD_CONSTRAINTS` に追加 + UI（検証レポート）に表示される
2. ソフト制約を追加するとき → `SCORE_FACTORS` に追加 + 設定タブの重み調整 UI に項目追加
3. 既定重みを変えるとき → `DEFAULT_WEIGHTS` 修正 + `data.js` の migrate も更新
4. 新しいテストケース → `tests/algorithm.test.html` に追加
5. 仕様書（このファイル）も更新

---

**最終更新**: 2026-05-05
**実装**: [`js/algorithm.js`](../js/algorithm.js)
**監査用 UI**: シフト編成タブ → 検証レポート → 詳細を見る
