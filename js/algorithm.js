// algorithm.js v2 — 監査可能・検証可能なシフト最適化エンジン
//
// 設計方針:
//   ハード制約 (HARD_CONSTRAINTS): 違反ゼロを保証 (post-condition で検証)
//   ソフト制約 (SCORE_FACTORS):    全要素を 0..1 に正規化 + 重み付き合計
//   多重スタート (RANDOM_RESTARTS): 局所最適を脱出
//   結果検証:                       生成後に必ず検査、違反は明示
//
// 仕様の詳細: docs/algorithm.md
(function () {
  const { calcHours, timeOverlap, timeContains, dayOfWeek, uid } = window.ShiftyData;

  // =====================================================================
  // ハード制約（HARD CONSTRAINTS）— 違反は絶対に発生させない
  // =====================================================================
  const HARD_CONSTRAINTS = [
    {
      id: "position_match",
      label: "ポジション適合",
      rationale: "スタッフが本職または兼任可能なポジションのみ配置",
      check(staff, slot, _state, _lr) {
        return staff.position === slot.position || (staff.canCover || []).includes(slot.position);
      },
    },
    {
      id: "fixed_day_off",
      label: "固定休日",
      rationale: "契約上の固定休日には配置しない",
      check(staff, slot) {
        return !(staff.fixedDayOff || []).includes(dayOfWeek(slot.date));
      },
    },
    {
      id: "no_time_overlap",
      label: "時間重複なし",
      rationale: "同時間帯の二重配置は物理的に不可能",
      check(staff, slot, state) {
        return !(state.byStaff[staff.id] || []).some(
          (a) => a.date === slot.date && timeOverlap(a, slot)
        );
      },
    },
    {
      id: "personal_max_hours_week",
      label: "個人契約週上限",
      rationale: "スタッフとの労働契約上の週時間上限を超えない",
      check(staff, slot, state) {
        const slotHours = calcHours(slot.startTime, slot.endTime);
        return (state.hours[staff.id] || 0) + slotHours <= staff.maxHoursPerWeek;
      },
    },
    {
      id: "labor_max_hours_week",
      label: "労務週上限",
      rationale: "労務ルールで定められた週上限（労基順守）",
      check(staff, slot, state, lr) {
        if (!lr || !lr.maxHoursPerWeek) return true;
        const slotHours = calcHours(slot.startTime, slot.endTime);
        return (state.hours[staff.id] || 0) + slotHours <= lr.maxHoursPerWeek;
      },
    },
    {
      id: "labor_max_hours_day",
      label: "労務1日上限",
      rationale: "1日あたりの労働時間上限",
      check(staff, slot, state, lr) {
        if (!lr || !lr.maxHoursPerDay) return true;
        const sameDay = (state.byStaff[staff.id] || []).filter((a) => a.date === slot.date);
        const dayHours =
          sameDay.reduce((s, a) => s + calcHours(a.startTime, a.endTime), 0) +
          calcHours(slot.startTime, slot.endTime);
        return dayHours <= lr.maxHoursPerDay;
      },
    },
    {
      id: "labor_max_consecutive_days",
      label: "連勤上限",
      rationale: "連続勤務日数の上限（疲労・事故防止）",
      check(staff, slot, state, lr) {
        if (!lr || !lr.maxConsecutiveDays) return true;
        return consecutiveDaysIfAdded(staff, slot, state) <= lr.maxConsecutiveDays;
      },
    },
    {
      id: "labor_min_rest_days_per_week",
      label: "週最低休日",
      rationale: "週あたり最低休日数を確保（労基34条準拠）",
      check(staff, slot, state, lr) {
        if (!lr || !lr.minRestDaysPerWeek) return true;
        const wk = weekKey(slot.date);
        const workedDays = new Set(
          (state.byStaff[staff.id] || [])
            .filter((a) => weekKey(a.date) === wk)
            .map((a) => a.date)
        );
        workedDays.add(slot.date);
        return 7 - workedDays.size >= lr.minRestDaysPerWeek;
      },
    },
    {
      id: "min_rest_hours_between_shifts",
      label: "シフト間最低休息",
      rationale: "前後シフトの間に最低休息時間を確保（労基インターバル制度）",
      check(staff, slot, state, lr) {
        const minRest = lr && lr.minRestHoursBetweenShifts;
        if (!minRest) return true;
        for (const a of state.byStaff[staff.id] || []) {
          if (a.date === slot.date) continue; // 同日は labor_max_hours_day で扱う
          if (hoursBetween(a, slot) < minRest) return false;
        }
        return true;
      },
    },
  ];

  function checkAllHardConstraints(staff, slot, state, lr) {
    const violated = [];
    for (const c of HARD_CONSTRAINTS) {
      if (!c.check(staff, slot, state, lr)) violated.push(c.id);
    }
    return violated;
  }

  function isEligible(staff, slot, state, lr) {
    return checkAllHardConstraints(staff, slot, state, lr).length === 0;
  }

  // =====================================================================
  // ソフト制約（SCORE FACTORS）— すべて 0..1 に正規化
  // =====================================================================
  const SCORE_FACTORS = {
    preference: {
      label: "希望充足",
      rationale: "スタッフの提出した希望と一致するほど高得点",
      compute(staff, slot, _state, prefs, _lr) {
        const pref = findPreference(prefs, staff.id, slot);
        if (!pref) return { value: 0.30, detail: "希望未提出（中立）" };
        if (pref.priority === "avoid") return { value: 0.0, detail: "回避希望" };
        const within = timeContains(pref, slot);
        if (pref.priority === "must") {
          return within
            ? { value: 1.0, detail: "必須（完全包含）" }
            : { value: 0.55, detail: "必須（部分一致）" };
        }
        return within
          ? { value: 0.85, detail: "希望（完全包含）" }
          : { value: 0.40, detail: "希望（部分一致）" };
      },
    },
    positionMatch: {
      label: "ポジション適合",
      rationale: "本職に配置するほど高得点",
      compute(staff, slot) {
        if (staff.position === slot.position) return { value: 1.0, detail: "本職" };
        return { value: 0.5, detail: "兼任" };
      },
    },
    fairness: {
      label: "公平性",
      rationale: "未充足時間が多いほど優先（既配置時間が少ないほど高得点）",
      compute(staff, _slot, state, _prefs, lr) {
        const cap = Math.min(staff.maxHoursPerWeek, lr?.maxHoursPerWeek ?? Infinity);
        const cur = state.hours[staff.id] || 0;
        if (cur < staff.minHoursPerWeek) {
          return { value: 1.0, detail: `最低時間未達 (${cur.toFixed(1)}/${staff.minHoursPerWeek}h)` };
        }
        const room = Math.max(1, cap - staff.minHoursPerWeek);
        const used = Math.max(0, cur - staff.minHoursPerWeek);
        return { value: Math.max(0, 1 - used / room), detail: `余裕 ${(room - used).toFixed(1)}h` };
      },
    },
    cost: {
      label: "コスト",
      rationale: "時給が低いほど高得点（人件費抑制）",
      compute(staff) {
        const f = staff._costFactor;
        return { value: f != null ? f : 0.5, detail: `時給¥${staff.hourlyWage}` };
      },
    },
    skill: {
      label: "スキル",
      rationale: "スキルレベルが高いほど高得点（1〜5を 0..1 に正規化）。Round 22: ポジション別スキル優先",
      compute(staff, slot) {
        // Round 22: タスク別スキル (slot.position に対する熟練度) を優先、無ければ本職スキル
        let skillVal = (staff.skills && staff.skills[slot.position] != null)
          ? staff.skills[slot.position]
          : (staff.skill || 1);
        return { value: skillVal / 5, detail: `${slot.position} スキル ${skillVal}/5` };
      },
    },
  };

  // 既定の重み（合計1.0）
  const DEFAULT_WEIGHTS = {
    preference: 0.40,
    positionMatch: 0.15,
    fairness: 0.20,
    cost: 0.15,
    skill: 0.10,
  };

  function normalizeWeights(input) {
    const w = { ...DEFAULT_WEIGHTS, ...(input || {}) };
    let sum = 0;
    for (const k of Object.keys(SCORE_FACTORS)) sum += Math.max(0, w[k] || 0);
    if (sum === 0) return { ...DEFAULT_WEIGHTS };
    const out = {};
    for (const k of Object.keys(SCORE_FACTORS)) out[k] = Math.max(0, w[k] || 0) / sum;
    return out;
  }

  function scoreCandidate(staff, slot, state, prefs, lr, weights) {
    let total = 0;
    const breakdown = [];
    for (const [k, factor] of Object.entries(SCORE_FACTORS)) {
      const { value, detail } = factor.compute(staff, slot, state, prefs, lr);
      const weight = weights[k] || 0;
      const contrib = value * weight;
      total += contrib;
      breakdown.push({
        id: k,
        label: factor.label,
        value,
        weight,
        contrib,
        detail,
      });
    }
    return { score: total, breakdown };
  }

  // =====================================================================
  // ヘルパー
  // =====================================================================
  function findPreference(prefs, staffId, slot) {
    return (prefs || []).find(
      (p) => p.staffId === staffId && p.date === slot.date && timeOverlap(p, slot)
    );
  }

  // ISO 週の月曜を返す（YYYY-MM-DD）— 同一週判定に使用
  // 注: TZ 依存を避けるため明示的に T00:00:00 を付与してローカル日付として解釈
  function weekKey(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  // 2 つのシフト間（同日 / 異日）の休息時間を時間単位で返す。重複時 0
  function hoursBetween(a, b) {
    const aStart = new Date(`${a.date}T${a.startTime}:00`).getTime();
    const aEnd = new Date(`${a.date}T${a.endTime}:00`).getTime();
    const bStart = new Date(`${b.date}T${b.startTime}:00`).getTime();
    const bEnd = new Date(`${b.date}T${b.endTime}:00`).getTime();
    if (aEnd <= bStart) return (bStart - aEnd) / 3600000;
    if (bEnd <= aStart) return (aStart - bEnd) / 3600000;
    return 0;
  }

  function hasAvoidPreference(staff, slot, prefs) {
    return (prefs || []).some(
      (p) =>
        p.staffId === staff.id &&
        p.date === slot.date &&
        p.priority === "avoid" &&
        timeOverlap(p, slot)
    );
  }

  // 各 unfilled スロットについて「なぜ埋まらなかったか」を人間可読に返す
  function explainUnfilled(slot, allStaff, state, lr, prefs) {
    const blockers = [];
    let posMatchCount = 0;
    for (const s of allStaff) {
      const posMatch = s.position === slot.position || (s.canCover || []).includes(slot.position);
      if (!posMatch) continue;
      posMatchCount++;
      const violatedIds = checkAllHardConstraints(s, slot, state, lr);
      const hasAvoid = hasAvoidPreference(s, slot, prefs);
      const labels = violatedIds.map(
        (v) => HARD_CONSTRAINTS.find((c) => c.id === v)?.label || v
      );
      if (hasAvoid) labels.push("回避希望");
      if (labels.length === 0) {
        // ポジション適合・制約違反なし → なぜ埋まらないかの汎用ラベル
        labels.push("他枠で既配置 / スコア劣位");
      }
      blockers.push({ staffId: s.id, staffName: s.name, reasons: labels });
    }
    if (posMatchCount === 0) {
      blockers.push({ staffId: null, staffName: "(該当ポジションのスタッフなし)", reasons: ["ポジション要件 " + slot.position + " を満たすスタッフがいません"] });
    }
    return blockers;
  }

  function consecutiveDaysIfAdded(staff, slot, state) {
    const dates = new Set((state.byStaff[staff.id] || []).map((a) => a.date));
    dates.add(slot.date);
    const sorted = [...dates].sort();
    let max = 1, cur = 1;
    for (let i = 1; i < sorted.length; i++) {
      const diff =
        (new Date(sorted[i]) - new Date(sorted[i - 1])) / (1000 * 60 * 60 * 24);
      if (diff === 1) {
        cur++;
        max = Math.max(max, cur);
      } else cur = 1;
    }
    return max;
  }

  // 決定的な乱数（seed入力で同じ結果）— Mulberry32
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // =====================================================================
  // Phase 1: Coverage（困難スロット優先で必要人数を埋める）
  // =====================================================================
  function phase1Coverage({ staff, slots, preferences, laborRules, weights, seed }) {
    const rand = mulberry32(seed);
    const state = {
      hours: Object.fromEntries(staff.map((s) => [s.id, 0])),
      byStaff: Object.fromEntries(staff.map((s) => [s.id, []])),
      assignments: [],
      unfilled: [],
    };

    const instances = [];
    for (const sl of slots) {
      for (let i = 0; i < sl.requiredCount; i++) {
        instances.push({ ...sl, instanceIdx: i, _r: rand() });
      }
    }

    // 困難度順初期ソート: 候補が少ないスロット先 → 同率はランダム
    const computeDifficulty = (sl) =>
      staff.filter((s) => isEligible(s, sl, state, laborRules)).length;
    instances.sort((a, b) => {
      const aCand = computeDifficulty(a);
      const bCand = computeDifficulty(b);
      if (aCand !== bCand) return aCand - bCand;
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.startTime !== b.startTime) return a.startTime.localeCompare(b.startTime);
      return a._r - b._r;
    });

    // 注: 動的再ソートは実測でカバー率を下げる場合があり採用せず
    //  (シナリオ C: 89.7% → 86.5%、A/B/D/E は不変)
    //  代わりに Phase 2 の swap 最適化で局所最適を脱出する
    let pending = instances;

    while (pending.length > 0) {
      const slot = pending.shift();
      // ハード制約上の eligible 全集合
      const eligibleAll = staff.filter((s) => isEligible(s, slot, state, laborRules));
      if (eligibleAll.length === 0) {
        state.unfilled.push({
          ...slot,
          reasons: explainUnfilled(slot, staff, state, laborRules, preferences),
        });
        continue;
      }
      // avoid 希望者を可能なら除外（候補が残るなら強制ハード化、残らないならソフト扱い）
      const eligibleStrict = eligibleAll.filter(
        (s) => !hasAvoidPreference(s, slot, preferences)
      );
      const eligible = eligibleStrict.length > 0 ? eligibleStrict : eligibleAll;
      const isAvoidRelaxed = eligibleStrict.length === 0 && eligibleAll.length > 0;

      const scored = eligible
        .map((s) => ({
          staff: s,
          ...scoreCandidate(s, slot, state, preferences, laborRules, weights),
        }))
        .sort((a, b) => b.score - a.score || rand() - 0.5);
      const picked = scored[0];

      const cost =
        picked.staff.hourlyWage * calcHours(slot.startTime, slot.endTime);
      const a = {
        id: uid("a_"),
        date: slot.date,
        staffId: picked.staff.id,
        position: slot.position,
        startTime: slot.startTime,
        endTime: slot.endTime,
        cost,
        score: picked.score,
        breakdown: picked.breakdown,
        avoidRelaxed: isAvoidRelaxed || undefined,
        // 監査ログ: この時点での候補トップ3を記録
        topCandidates: scored.slice(0, 3).map((x) => ({
          staffId: x.staff.id,
          name: x.staff.name,
          score: x.score,
        })),
      };
      state.assignments.push(a);
      state.byStaff[picked.staff.id].push(a);
      state.hours[picked.staff.id] += calcHours(slot.startTime, slot.endTime);

    }
    return state;
  }

  // =====================================================================
  // Phase 2: Optimize
  //  Step A: 単方向置換 — 各 assignment を別スタッフに置き換えで改善
  //  Step B: 2-opt スワップ — 2 つの assignment を相互に入れ替えて両者改善
  // =====================================================================
  function phase2Optimize(state, { staff, preferences, laborRules, weights }) {
    let improved = true;
    let rounds = 0;
    const MAX_ROUNDS = 8;
    const IMPROVEMENT_THRESHOLD = 0.005; // 0.5% 以上の改善のみ採用

    while (improved && rounds < MAX_ROUNDS) {
      improved = false;
      rounds++;

      // ----- Step A: 単方向置換 -----
      for (let i = 0; i < state.assignments.length; i++) {
        const a = state.assignments[i];
        const slotLike = {
          date: a.date,
          position: a.position,
          startTime: a.startTime,
          endTime: a.endTime,
        };
        const stateMinusA = removeAssignmentVirtual(state, a);
        const eligibleAll = staff.filter((s) => isEligible(s, slotLike, stateMinusA, laborRules));
        if (eligibleAll.length === 0) continue;
        // avoid 2-pass フィルタを Phase 1 と同じく適用 (Phase 2 で巻き戻されるバグ防止)
        const eligibleStrict = eligibleAll.filter((s) => !hasAvoidPreference(s, slotLike, preferences));
        const eligible = eligibleStrict.length > 0 ? eligibleStrict : eligibleAll;
        const stepAvoidRelaxed = eligibleStrict.length === 0 && eligibleAll.length > 0;
        const scored = eligible
          .map((s) => ({
            staff: s,
            ...scoreCandidate(s, slotLike, stateMinusA, preferences, laborRules, weights),
          }))
          .sort((x, y) => y.score - x.score);
        const best = scored[0];
        if (best.staff.id !== a.staffId && best.score > a.score + IMPROVEMENT_THRESHOLD) {
          const newCost = best.staff.hourlyWage * calcHours(a.startTime, a.endTime);
          const newA = {
            ...a,
            staffId: best.staff.id,
            cost: newCost,
            score: best.score,
            breakdown: best.breakdown,
            avoidRelaxed: stepAvoidRelaxed || undefined,
            topCandidates: scored.slice(0, 3).map((x) => ({
              staffId: x.staff.id, name: x.staff.name, score: x.score,
            })),
          };
          state.byStaff[a.staffId] = state.byStaff[a.staffId].filter((x) => x.id !== a.id);
          state.hours[a.staffId] -= calcHours(a.startTime, a.endTime);
          state.byStaff[best.staff.id].push(newA);
          state.hours[best.staff.id] += calcHours(a.startTime, a.endTime);
          state.assignments[i] = newA;
          improved = true;
        }
      }

      // ----- Step B: 2-opt スワップ -----
      // 計算量最適化:
      //  - staff index で O(1) 検索（staff.find は O(N)）
      //  - 同日同ポジションは positionMatch スコア同じなので無意味、即スキップ
      //  - 既に score >= 0.95 のアサインは改善余地小、スキップ
      //  - 同タイム重複は時間重複バリデーションで自然に弾かれる
      const SWAP_THRESHOLD = 0.005;
      const NEAR_OPTIMAL = 0.95;
      const staffById = {};
      for (const s of staff) staffById[s.id] = s;

      const byDate = {};
      for (const a of state.assignments) {
        (byDate[a.date] = byDate[a.date] || []).push(a);
      }
      // H6 fix: 同日内 swap が成立したら次の round 全体を再開（stale 参照防止）
      let stepBSwapped = false;
      for (const date of Object.keys(byDate)) {
        if (stepBSwapped) break;
        const dayAss = byDate[date];
        for (let i = 0; i < dayAss.length && !stepBSwapped; i++) {
          const a = dayAss[i];
          // 早期スキップ: aがほぼ最適なら swap で改善期待値低い
          if (a.score >= NEAR_OPTIMAL) continue;
          for (let j = i + 1; j < dayAss.length && !stepBSwapped; j++) {
            const b = dayAss[j];
            if (a.staffId === b.staffId) continue;
            // 同ポジション + 同時間 = positionMatch スコアが同じなのでコスト要因しか効かない
            // 「コスト効率改善のみ」のスワップは改善幅小さいので skip (時短)
            if (a.position === b.position && a.startTime === b.startTime) continue;
            if (b.score >= NEAR_OPTIMAL) continue;
            const sa = staffById[a.staffId];
            const sb = staffById[b.staffId];
            if (!sa || !sb) continue;
            const slotA = { date: a.date, position: a.position, startTime: a.startTime, endTime: a.endTime };
            const slotB = { date: b.date, position: b.position, startTime: b.startTime, endTime: b.endTime };
            // 両方の状態から自分を抜いた仮想 state
            const stateMinusBoth = removeAssignmentsVirtual(state, [a, b]);
            // sa が slotB に, sb が slotA に入れるか?
            if (!isEligible(sa, slotB, stateMinusBoth, laborRules)) continue;
            if (!isEligible(sb, slotA, stateMinusBoth, laborRules)) continue;
            // avoid 2-pass: スワップで avoid 違反を新しく作るなら拒否
            const swapWouldCreateAvoid =
              hasAvoidPreference(sa, slotB, preferences) ||
              hasAvoidPreference(sb, slotA, preferences);
            const swapResolvesAvoid =
              hasAvoidPreference(sa, slotA, preferences) ||
              hasAvoidPreference(sb, slotB, preferences);
            if (swapWouldCreateAvoid && !swapResolvesAvoid) continue;
            const newScoreA = scoreCandidate(sb, slotA, stateMinusBoth, preferences, laborRules, weights).score;
            const newScoreB = scoreCandidate(sa, slotB, stateMinusBoth, preferences, laborRules, weights).score;
            const oldSum = a.score + b.score;
            const newSum = newScoreA + newScoreB;
            if (newSum > oldSum + SWAP_THRESHOLD) {
              // 入れ替え実行 — avoidRelaxed 状態を引き継ぐ
              const newAvoidRelaxedA = hasAvoidPreference(sb, slotA, preferences);
              const newAvoidRelaxedB = hasAvoidPreference(sa, slotB, preferences);
              const newA = {
                ...a, staffId: sb.id,
                cost: sb.hourlyWage * calcHours(a.startTime, a.endTime),
                score: newScoreA,
                avoidRelaxed: newAvoidRelaxedA || undefined,
              };
              const newB = {
                ...b, staffId: sa.id,
                cost: sa.hourlyWage * calcHours(b.startTime, b.endTime),
                score: newScoreB,
                avoidRelaxed: newAvoidRelaxedB || undefined,
              };
              state.byStaff[a.staffId] = state.byStaff[a.staffId].filter((x) => x.id !== a.id);
              state.byStaff[b.staffId] = state.byStaff[b.staffId].filter((x) => x.id !== b.id);
              state.hours[a.staffId] -= calcHours(a.startTime, a.endTime);
              state.hours[b.staffId] -= calcHours(b.startTime, b.endTime);
              state.byStaff[sb.id].push(newA);
              state.byStaff[sa.id].push(newB);
              state.hours[sb.id] += calcHours(a.startTime, a.endTime);
              state.hours[sa.id] += calcHours(b.startTime, b.endTime);
              const ia = state.assignments.indexOf(a);
              const ib = state.assignments.indexOf(b);
              if (ia >= 0) state.assignments[ia] = newA;
              if (ib >= 0) state.assignments[ib] = newB;
              improved = true;
              stepBSwapped = true; // 1 swap で round を抜けて再構築
            }
          }
        }
      }
    }
    state._optimizeRounds = rounds;
    return state;
  }

  function removeAssignmentVirtual(state, a) {
    const clone = {
      hours: { ...state.hours },
      byStaff: Object.fromEntries(
        Object.entries(state.byStaff).map(([k, v]) => [k, v.filter((x) => x.id !== a.id)])
      ),
      assignments: state.assignments,
      unfilled: state.unfilled,
    };
    clone.hours[a.staffId] -= calcHours(a.startTime, a.endTime);
    return clone;
  }

  function removeAssignmentsVirtual(state, list) {
    const ids = new Set(list.map((a) => a.id));
    const clone = {
      hours: { ...state.hours },
      byStaff: Object.fromEntries(
        Object.entries(state.byStaff).map(([k, v]) => [k, v.filter((x) => !ids.has(x.id))])
      ),
      assignments: state.assignments,
      unfilled: state.unfilled,
    };
    for (const a of list) {
      clone.hours[a.staffId] -= calcHours(a.startTime, a.endTime);
    }
    return clone;
  }

  // =====================================================================
  // Post-condition 検証（生成後の正当性チェック）
  // =====================================================================
  function verifyHardConstraints(state, { staff, laborRules }) {
    // 各 assignment を空状態から積み上げて、各時点で全制約を満たすか確認
    const replay = {
      hours: Object.fromEntries(staff.map((s) => [s.id, 0])),
      byStaff: Object.fromEntries(staff.map((s) => [s.id, []])),
    };
    const violations = [];
    // 日付・時刻順に再生
    const ordered = [...state.assignments].sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)
    );
    for (const a of ordered) {
      const s = staff.find((x) => x.id === a.staffId);
      if (!s) {
        violations.push({ assignmentId: a.id, type: "staff_not_found", staffId: a.staffId });
        continue;
      }
      const violatedIds = checkAllHardConstraints(s, a, replay, laborRules);
      if (violatedIds.length) {
        for (const vid of violatedIds) {
          violations.push({
            assignmentId: a.id,
            staffId: a.staffId,
            staffName: s.name,
            date: a.date,
            position: a.position,
            constraintId: vid,
            label: HARD_CONSTRAINTS.find((c) => c.id === vid)?.label || vid,
          });
        }
      }
      replay.byStaff[s.id].push(a);
      replay.hours[s.id] += calcHours(a.startTime, a.endTime);
    }
    return violations;
  }

  // =====================================================================
  // Metrics（カバー率・希望充足・公平性・コスト）
  // =====================================================================
  function calcMetrics(state, { staff, slots, preferences }) {
    const totalSlots = slots.reduce((s, x) => s + x.requiredCount, 0);
    const filled = state.assignments.length;
    const coverageRate = totalSlots ? filled / totalSlots : 1;

    // 希望充足: 提出された want/must の何%が assignment と一致したか
    const offeredPrefs = (preferences || []).filter((p) => p.priority !== "avoid");
    const totalWants = offeredPrefs.length;
    let prefHit = 0;
    for (const p of offeredPrefs) {
      const hit = state.assignments.find(
        (a) =>
          a.staffId === p.staffId &&
          a.date === p.date &&
          timeOverlap(a, p)
      );
      if (hit) prefHit++;
    }
    const prefSat = totalWants ? prefHit / totalWants : 0;

    // 回避希望違反 (avoid と一致した assignment)
    const avoidViolations = (preferences || [])
      .filter((p) => p.priority === "avoid")
      .filter((p) =>
        state.assignments.some(
          (a) =>
            a.staffId === p.staffId &&
            a.date === p.date &&
            timeOverlap(a, p)
        )
      ).length;

    const totalCost = state.assignments.reduce((s, a) => s + a.cost, 0);

    // 公平性指標
    const hoursList = staff.map((s) => state.hours[s.id] || 0);
    const mean = hoursList.length ? hoursList.reduce((a, b) => a + b, 0) / hoursList.length : 0;
    const variance = hoursList.length
      ? hoursList.reduce((a, h) => a + (h - mean) ** 2, 0) / hoursList.length
      : 0;
    const std = Math.sqrt(variance);
    const cv = mean > 0 ? std / mean : 0; // 変動係数（低いほど均等）
    const minMet = staff.filter((s) => (state.hours[s.id] || 0) >= s.minHoursPerWeek).length;
    const minMetRate = staff.length ? minMet / staff.length : 0;
    const overMaxCount = staff.filter((s) => (state.hours[s.id] || 0) > s.maxHoursPerWeek).length;

    const perStaff = staff.map((s) => {
      const hours = state.hours[s.id] || 0;
      const cost = (state.byStaff[s.id] || []).reduce((sm, a) => sm + a.cost, 0);
      return {
        staffId: s.id,
        name: s.name,
        position: s.position,
        hours,
        cost,
        meetsMin: hours >= s.minHoursPerWeek,
        overMax: hours > s.maxHoursPerWeek,
      };
    });

    return {
      totalSlots,
      filled,
      coverageRate,
      preferenceSatisfaction: prefSat,
      preferenceHit: prefHit,
      preferenceTotal: totalWants,
      avoidViolations,
      totalCost,
      fairness: { mean, std, cv, minMetRate, overMaxCount },
      perStaff,
      unfilled: state.unfilled,
    };
  }

  // 目的関数（重み付き合計、多重スタートでこれが最大の解を採用）
  function objectiveValue(metrics, weights) {
    const w = weights || DEFAULT_WEIGHTS;
    // coverage を最重要、希望充足、公平性 (1-cv)、コスト効率
    // ?? を使うことで明示的な 0 を尊重 (UI で重みを 0 にできる)
    const wCov = 0.40;
    const wPref = w.preference ?? 0.30;
    const wFair = w.fairness ?? 0.15;
    const wCost = w.cost ?? 0.10;
    const fairnessScore = 1 - Math.min(1, metrics.fairness.cv);
    const costScore = 1; // コストはハード予算なら別途扱い、ここでは中立（生成内では最小化を scoreCandidate で実現）
    return (
      wCov * metrics.coverageRate +
      wPref * metrics.preferenceSatisfaction +
      wFair * fairnessScore +
      wCost * costScore -
      0.2 * metrics.avoidViolations -
      0.1 * metrics.fairness.overMaxCount
    );
  }

  // =====================================================================
  // Public API
  // =====================================================================
  // =====================================================================
  // Slot 細分化 (Round 18 TOP 3a) — スタッフの希望時間境界で slot を分割
  // 「17-22 を 2 人」 + 「A は 17-20 want」 + 「B は 19-22 want」
  //   → 「17-19 × 2」「19-20 × 2」「20-22 × 2」に分割
  // 各 sub-slot を埋めることで、staff のpartial 希望に AI が応えられる
  // =====================================================================
  function _toMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
  function _fromMin(m) {
    const h = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    return `${h}:${mm}`;
  }
  function decomposeSlots(slots, preferences) {
    const out = [];
    const decompositionMap = {}; // parentId -> [child slot ids]
    for (const slot of slots) {
      // 該当 slot の時間内に start/end が落ちる pref を集める (avoid 含めて分割理由にする)
      const slotStartMin = _toMin(slot.startTime);
      const slotEndMin = _toMin(slot.endTime);
      const points = new Set([slotStartMin, slotEndMin]);
      for (const p of preferences) {
        if (p.date !== slot.date) continue;
        const pStart = _toMin(p.startTime);
        const pEnd = _toMin(p.endTime);
        // pref が slot と重なるか
        if (pStart >= slotEndMin || pEnd <= slotStartMin) continue;
        if (pStart > slotStartMin && pStart < slotEndMin) points.add(pStart);
        if (pEnd > slotStartMin && pEnd < slotEndMin) points.add(pEnd);
      }
      const sortedPoints = Array.from(points).sort((a, b) => a - b);
      if (sortedPoints.length === 2) {
        // 分割不要
        out.push({ ...slot, parentSlotId: slot.id });
        decompositionMap[slot.id] = [slot.id];
      } else {
        // 分割
        const childIds = [];
        for (let i = 0; i < sortedPoints.length - 1; i++) {
          const childId = `${slot.id}_seg${i}`;
          out.push({
            ...slot,
            id: childId,
            startTime: _fromMin(sortedPoints[i]),
            endTime: _fromMin(sortedPoints[i + 1]),
            parentSlotId: slot.id,
            _segIndex: i,
            _segCount: sortedPoints.length - 1,
          });
          childIds.push(childId);
        }
        decompositionMap[slot.id] = childIds;
      }
    }
    return { decomposedSlots: out, decompositionMap };
  }

  // 連続する同一スタッフ・同日・同ポジションのアサインメントを 1 件にマージ
  // 細分化された結果を「人間にとって自然な勤務シフト」に戻す
  function mergeAdjacentAssignments(assignments, staff) {
    const groups = new Map();
    for (const a of assignments) {
      const key = `${a.staffId}|${a.date}|${a.position}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const merged = [];
    const staffMap = new Map(staff.map(s => [s.id, s]));
    for (const list of groups.values()) {
      list.sort((a, b) => a.startTime.localeCompare(b.startTime));
      let i = 0;
      while (i < list.length) {
        let j = i;
        while (j + 1 < list.length && list[j].endTime === list[j + 1].startTime) j++;
        const first = list[i], last = list[j];
        if (i === j) {
          merged.push(first);
        } else {
          const s = staffMap.get(first.staffId);
          const totalHours = calcHours(first.startTime, last.endTime);
          // breakdown / score は最初のセグメントを採用 (代表値として)
          merged.push({
            ...first,
            startTime: first.startTime,
            endTime: last.endTime,
            cost: (s ? s.hourlyWage : 0) * totalHours,
            mergedFrom: list.slice(i, j + 1).map(x => x.id),
          });
        }
        i = j + 1;
      }
    }
    return merged;
  }

  function generateShift({
    staff,
    slots,
    preferences,
    laborRules,
    weights: rawWeights,
    randomStarts = 5,
    decompose = true, // Round 18 TOP 3: 希望ベース slot 細分化を有効化
  }) {
    const weights = normalizeWeights(rawWeights);

    // staff のコスト要素を事前計算（最安=1.0、最高=0.0）
    const wages = staff.map((s) => s.hourlyWage);
    const minW = Math.min(...wages);
    const maxW = Math.max(...wages);
    const range = Math.max(1, maxW - minW);
    const staffWithCost = staff.map((s) => ({
      ...s,
      _costFactor: 1 - (s.hourlyWage - minW) / range,
    }));

    // Slot 細分化 (Round 18 TOP 3a)
    let workingSlots = slots;
    let decompMap = null;
    let decompStats = { originalSlots: slots.length, decomposedSlots: slots.length, splitCount: 0 };
    if (decompose && preferences && preferences.length > 0) {
      const r = decomposeSlots(slots, preferences);
      workingSlots = r.decomposedSlots;
      decompMap = r.decompositionMap;
      decompStats = {
        originalSlots: slots.length,
        decomposedSlots: workingSlots.length,
        splitCount: Object.values(decompMap).filter(arr => arr.length > 1).length,
      };
    }

    let bestState = null;
    let bestObj = -Infinity;
    let bestSeed = -1;
    const trial = [];

    for (let r = 0; r < Math.max(1, randomStarts); r++) {
      const seed = (r + 1) * 12345;
      let state = phase1Coverage({
        staff: staffWithCost,
        slots: workingSlots,
        preferences,
        laborRules,
        weights,
        seed,
      });
      state = phase2Optimize(state, {
        staff: staffWithCost,
        preferences,
        laborRules,
        weights,
      });
      const m = calcMetrics(state, { staff: staffWithCost, slots: workingSlots, preferences });
      const obj = objectiveValue(m, weights);
      trial.push({ seed, obj, coverage: m.coverageRate, prefSat: m.preferenceSatisfaction });
      if (obj > bestObj) {
        bestObj = obj;
        bestState = state;
        bestSeed = seed;
      }
    }

    // 細分化前の assignment 数 (= sub-slot 充足数) でカバー率を測る
    const preMergeCount = bestState.assignments.length;
    // 連続する細分化アサインメントを統合 (Round 18 TOP 3a)
    let finalAssignments = bestState.assignments;
    if (decompose) {
      finalAssignments = mergeAdjacentAssignments(finalAssignments, staffWithCost);
    }

    // メトリクスは元の slots ベースで計算 (ユーザー視点)
    const metricsState = {
      ...bestState,
      assignments: finalAssignments,
      byStaff: Object.fromEntries(staffWithCost.map(s => [s.id, finalAssignments.filter(a => a.staffId === s.id)])),
      hours: Object.fromEntries(staffWithCost.map(s => [s.id, finalAssignments.filter(a => a.staffId === s.id).reduce((sum, a) => sum + calcHours(a.startTime, a.endTime), 0)])),
    };
    const metrics = calcMetrics(metricsState, {
      staff: staffWithCost,
      slots,
      preferences,
    });
    // カバー率を細分化前ベース (sub-slot ベース) で再計算
    if (decompose) {
      const decomposedTotal = workingSlots.reduce((s, x) => s + x.requiredCount, 0);
      metrics.coverageRate = decomposedTotal ? preMergeCount / decomposedTotal : 1;
      metrics.filled = preMergeCount;
      metrics.totalSlots = decomposedTotal;
    }
    const violations = verifyHardConstraints(metricsState, {
      staff: staffWithCost,
      laborRules,
    });

    return {
      assignments: finalAssignments,
      metrics,
      unfilled: bestState.unfilled,
      audit: {
        weights,
        randomStarts: Math.max(1, randomStarts),
        bestSeed,
        bestObjective: bestObj,
        trials: trial,
        decomposition: decompStats,
        hardConstraintsChecked: HARD_CONSTRAINTS.map((c) => ({
          id: c.id,
          label: c.label,
          rationale: c.rationale,
        })),
        scoreFactors: Object.entries(SCORE_FACTORS).map(([id, f]) => ({
          id,
          label: f.label,
          rationale: f.rationale,
          weight: weights[id],
        })),
        hardViolations: violations,
        passed: violations.length === 0,
      },
    };
  }

  function recommendSubstitute(target, { staff, preferences, assignments, laborRules, weights: rawWeights }) {
    const weights = normalizeWeights(rawWeights);
    const wages = staff.map((s) => s.hourlyWage);
    const minW = Math.min(...wages);
    const maxW = Math.max(...wages);
    const range = Math.max(1, maxW - minW);
    const staffWithCost = staff.map((s) => ({
      ...s,
      _costFactor: 1 - (s.hourlyWage - minW) / range,
    }));

    const state = {
      hours: Object.fromEntries(staffWithCost.map((s) => [s.id, 0])),
      byStaff: Object.fromEntries(staffWithCost.map((s) => [s.id, []])),
    };
    for (const a of assignments) {
      if (a.id === target.id) continue;
      state.hours[a.staffId] = (state.hours[a.staffId] || 0) + calcHours(a.startTime, a.endTime);
      (state.byStaff[a.staffId] = state.byStaff[a.staffId] || []).push(a);
    }
    const slotLike = {
      date: target.date,
      position: target.position,
      startTime: target.startTime,
      endTime: target.endTime,
    };
    const eligibleAll = staffWithCost.filter(
      (s) => s.id !== target.staffId && isEligible(s, slotLike, state, laborRules)
    );
    // avoid 2-pass: 候補が他にいる場合は avoid 持ちを除外
    const eligibleStrict = eligibleAll.filter(
      (s) => !hasAvoidPreference(s, slotLike, preferences)
    );
    const eligible = eligibleStrict.length > 0 ? eligibleStrict : eligibleAll;
    const isAvoidRelaxed = eligibleStrict.length === 0 && eligibleAll.length > 0;
    return eligible
      .map((s) => ({
        staff: s,
        ...scoreCandidate(s, slotLike, state, preferences, laborRules, weights),
        avoidRelaxed: isAvoidRelaxed && hasAvoidPreference(s, slotLike, preferences),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  // =====================================================================
  // Self-test ユーティリティ（外部から呼び出し可能）
  // =====================================================================
  function runSelfTest(seedInput) {
    const result = generateShift(seedInput);
    const checks = [
      {
        name: "ハード制約違反ゼロ",
        passed: result.audit.hardViolations.length === 0,
        detail: `違反 ${result.audit.hardViolations.length} 件`,
      },
      {
        name: "全 assignment にスコア内訳がある",
        passed: result.assignments.every((a) => Array.isArray(a.breakdown) && a.breakdown.length > 0),
        detail: `${result.assignments.length} assignment`,
      },
      {
        name: "全 assignment のスコアが 0..1 の範囲",
        passed: result.assignments.every((a) => a.score >= 0 && a.score <= 1.0001),
        detail: "正規化スコア",
      },
      {
        name: "重み合計が 1.0（許容誤差 0.01）",
        passed: Math.abs(Object.values(result.audit.weights).reduce((s, x) => s + x, 0) - 1) < 0.01,
        detail: `合計 ${Object.values(result.audit.weights).reduce((s, x) => s + x, 0).toFixed(3)}`,
      },
      {
        name: "再現性（同入力で同結果）",
        passed: (() => {
          const r2 = generateShift(seedInput);
          return JSON.stringify(r2.assignments.map((a) => `${a.date}|${a.position}|${a.startTime}|${a.staffId}`).sort())
            === JSON.stringify(result.assignments.map((a) => `${a.date}|${a.position}|${a.startTime}|${a.staffId}`).sort());
        })(),
        detail: "決定的シード",
      },
    ];
    return { result, checks, allPassed: checks.every((c) => c.passed) };
  }

  window.ShiftyAlgo = {
    generateShift,
    recommendSubstitute,
    calcMetrics,
    runSelfTest,
    HARD_CONSTRAINTS,
    SCORE_FACTORS,
    DEFAULT_WEIGHTS,
  };
})();
