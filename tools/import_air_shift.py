#!/usr/bin/env python3
"""Air シフト等の汎用 CSV → Shifty CSV 変換ツール

使い方:
  python tools/import_air_shift.py input.csv [--output staff.csv]

入力 CSV (Air シフトエクスポート想定):
  名前,役職,時給,週上限,週下限,固定休曜日,スキル
  山田太郎,ホール,1100,28,15,日,4
  ...

出力 Shifty CSV:
  名前,本職ID,時給,週最低,週最大,固定休(0-6スペース区切り),スキル
"""
import argparse
import csv
import sys
from pathlib import Path

# 役職名 → Shifty position id マッピング
POSITION_MAP = {
    # ホール系
    "ホール": "hall", "サービス": "hall", "フロア": "hall", "接客": "hall",
    "Hall": "hall", "hall": "hall", "Floor": "hall",
    # キッチン系
    "キッチン": "kitchen", "調理": "kitchen", "厨房": "kitchen", "料理": "kitchen",
    "Kitchen": "kitchen", "kitchen": "kitchen", "Cook": "kitchen",
    # レジ系
    "レジ": "cashier", "会計": "cashier", "Cashier": "cashier", "cashier": "cashier",
    # 店長系
    "店長": "manager", "マネージャー": "manager", "Manager": "manager", "manager": "manager",
}

# 曜日名 → 0-6 マッピング（日=0, 月=1, ..., 土=6）
DOW_MAP = {
    "日": 0, "日曜": 0, "日曜日": 0, "Sun": 0, "sun": 0, "Sunday": 0,
    "月": 1, "月曜": 1, "月曜日": 1, "Mon": 1, "mon": 1, "Monday": 1,
    "火": 2, "火曜": 2, "火曜日": 2, "Tue": 2, "tue": 2, "Tuesday": 2,
    "水": 3, "水曜": 3, "水曜日": 3, "Wed": 3, "wed": 3, "Wednesday": 3,
    "木": 4, "木曜": 4, "木曜日": 4, "Thu": 4, "thu": 4, "Thursday": 4,
    "金": 5, "金曜": 5, "金曜日": 5, "Fri": 5, "fri": 5, "Friday": 5,
    "土": 6, "土曜": 6, "土曜日": 6, "Sat": 6, "sat": 6, "Saturday": 6,
}


def parse_position(s: str) -> str:
    s = (s or "").strip()
    if s in POSITION_MAP:
        return POSITION_MAP[s]
    # 曖昧マッチ
    for k, v in POSITION_MAP.items():
        if k in s or s in k:
            return v
    return "hall"  # 既定: ホール


def parse_fixed_days(s: str) -> str:
    """『日 月』『日,月』『日/月』『Sun, Mon』等を 0-6 のスペース区切りに変換"""
    s = (s or "").strip()
    if not s:
        return ""
    # 区切り文字: スペース, カンマ, 中点, 全角スペース, スラッシュ, 半角＆全角点
    import re
    parts = re.split(r"[\s,、・/／。]+", s)
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if p.isdigit() and 0 <= int(p) <= 6:
            out.append(p)
            continue
        if p in DOW_MAP:
            out.append(str(DOW_MAP[p]))
            continue
        # 部分マッチ
        for k, v in DOW_MAP.items():
            if k in p:
                out.append(str(v))
                break
    return " ".join(out)


def detect_columns(header: list) -> dict:
    """ヘッダから列名を推定"""
    mapping = {}
    for i, col in enumerate(header):
        c = col.strip().lower()
        if "名前" in col or "氏名" in col or c in ("name",):
            mapping["name"] = i
        elif "役職" in col or "ポジション" in col or "本職" in col or c in ("position", "role"):
            mapping["position"] = i
        elif "時給" in col or c in ("wage", "hourly", "rate"):
            mapping["wage"] = i
        elif "週上限" in col or "週最大" in col or "max" in c:
            mapping["max"] = i
        elif "週下限" in col or "週最低" in col or "min" in c:
            mapping["min"] = i
        elif "固定休" in col or "休日" in col or "off" in c:
            mapping["off"] = i
        elif "スキル" in col or c in ("skill", "level"):
            mapping["skill"] = i
        elif "メール" in col or c in ("email", "mail"):
            mapping["email"] = i
    return mapping


def convert(input_path: Path, output_path: Path):
    print(f"📄 読込: {input_path}")
    with open(input_path, "r", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        rows = list(reader)

    if len(rows) < 2:
        print("❌ データ行がありません")
        sys.exit(1)

    header = rows[0]
    cols = detect_columns(header)
    print(f"🔍 検出された列: {cols}")

    if "name" not in cols:
        print("❌ 名前列が見つかりません。手動で列名を確認してください。")
        sys.exit(1)

    converted = []
    skipped = 0
    for row in rows[1:]:
        if len(row) < len(header):
            row = row + [""] * (len(header) - len(row))
        name = row[cols.get("name", 0)].strip() if cols.get("name") is not None else ""
        if not name:
            skipped += 1
            continue
        position = parse_position(row[cols.get("position", 1)] if cols.get("position") is not None else "ホール")
        try:
            wage = int(float(row[cols.get("wage")])) if cols.get("wage") is not None else 1100
        except Exception:
            wage = 1100
        try:
            wmax = int(float(row[cols.get("max")])) if cols.get("max") is not None else 28
        except Exception:
            wmax = 28
        try:
            wmin = int(float(row[cols.get("min")])) if cols.get("min") is not None else 10
        except Exception:
            wmin = 10
        off = parse_fixed_days(row[cols.get("off")] if cols.get("off") is not None else "")
        try:
            skill = int(float(row[cols.get("skill")])) if cols.get("skill") is not None else 3
            skill = max(1, min(5, skill))
        except Exception:
            skill = 3
        converted.append([name, position, wage, wmin, wmax, off, skill])

    with open(output_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["名前", "本職ID", "時給", "週最低", "週最大", "固定休", "スキル"])
        for r in converted:
            w.writerow(r)

    print(f"✅ 変換完了: {len(converted)}名 → {output_path}")
    if skipped:
        print(f"   ⚠️  スキップ: {skipped}行（名前が空）")
    print()
    print("📋 次のステップ:")
    print("  1. shifty 管理画面の スタッフタブ → 「📥 CSV取込」")
    print(f"  2. {output_path} の中身を貼り付け")
    print("  3. 「取込」ボタンクリック")
    print()
    print("プレビュー（最初の3名）:")
    print("  名前 本職ID 時給 週最低 週最大 固定休 スキル")
    for r in converted[:3]:
        print("  " + " ".join(map(str, r)))


def main():
    p = argparse.ArgumentParser(description="Air シフト等 CSV → Shifty CSV 変換")
    p.add_argument("input", help="変換元 CSV ファイル")
    p.add_argument("--output", "-o", default="staff_for_shifty.csv", help="出力 CSV (既定: staff_for_shifty.csv)")
    args = p.parse_args()
    convert(Path(args.input), Path(args.output))


if __name__ == "__main__":
    main()
