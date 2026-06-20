"""
Export per-encounter difficult stats to CSV

Usage:
    python export_difficulty.py logs/a logs/b ...
    python export_difficulty.py --parent logs
    python export_difficulty.py --parent logs --model 2014 --out stats.csv
"""

import argparse
import csv
import sys

from chart_difficulty import resolve_folders, summarize_folder

FIELDS = [
    "label", "winrate", "wins", "n", "ci95",
    "draw_wins", "draw_losses",
    "difficulty", "rating", "model",
    "totalEnemyXp", "enemyCount", "partySize", "partyLevels",
]


def parse_args():
    # Drop bare "--" tokens some runners (yarn on Linux) inject, so flags like --model
    # don't get swallowed into the positional folders. See chart_difficulty.parse_args.
    argv = [a for a in sys.argv[1:] if a != "--"]
    p = argparse.ArgumentParser(description="Export encounter difficulty vs win-rate to CSV")
    p.add_argument("folders", nargs="*", help="Folders, each an encounter scenario of .ndjson runs")
    p.add_argument("--parent", type=str, metavar="DIR", help="Use every immediate subfolder of DIR")
    p.add_argument("--model", choices=["2014", "2024"], default="2024", help="Difficulty model (default: 2024)")
    p.add_argument("--out", type=str, metavar="CSV", help="Write to a CSV file instead of stdout")
    return p.parse_args(argv)


def row_for(summary: dict, model: str) -> dict:
    levels = summary.get("partyLevels") or []
    return {
        "label": summary["folder"],
        "winrate": round(summary["winrate"], 6),
        "wins": summary["wins"],
        "n": summary["n"],
        "ci95": round(summary["ci95"], 6),
        "draw_wins": summary["draw_wins"],
        "draw_losses": summary["draw_losses"],
        "difficulty": round(summary["difficulty"], 6),
        "rating": summary["rating"],
        "model": model,
        "totalEnemyXp": summary["totalEnemyXp"],
        "enemyCount": summary["enemyCount"],
        "partySize": len(levels),
        "partyLevels": " ".join(str(int(lv)) for lv in levels),
    }


def main():
    args = parse_args()
    folders = resolve_folders(args)
    if not folders:
        print("No valid folders given. Pass folders or specify a --parent.", file=sys.stderr)
        sys.exit(1)

    rows = [row_for(s, args.model) for f in folders if (s := summarize_folder(f, args.model))]
    if not rows:
        print("No folders produced usable data.", file=sys.stderr)
        sys.exit(1)
    rows.sort(key=lambda r: r["difficulty"])

    out = open(args.out, "w", newline="", encoding="utf-8") if args.out else sys.stdout
    try:
        writer = csv.DictWriter(out, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    finally:
        if args.out:
            out.close()
            print(f"Wrote {len(rows)} rows to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
