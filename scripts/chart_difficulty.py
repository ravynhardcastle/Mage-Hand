"""
Scatter encounter difficulty vs. observed party win-rate across folders.

Usage:
    python chart_difficulty.py logs/fight-1 logs/fight-2 ...
    python chart_difficulty.py --parent logs            # each subfolder of logs/
    python chart_difficulty.py --parent logs --model 2014
    python chart_difficulty.py logs/a logs/b --out compare.html
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go

from chart import CI_Z95, classify_run_outcomes, load_ndjson

MODEL_COLUMNS = {
    "2014": {"ratio": "d2014_ratio", "rating": "d2014_rating"},
    "2024": {"ratio": "d2024_ratio", "rating": "d2024_rating"},
}

# xp thresholds for 4 characters
XP_THRESHOLDS_2014 = {
    1: [25, 50, 75, 100], 2: [50, 100, 150, 200], 3: [75, 150, 225, 400], 4: [125, 250, 375, 500],
    5: [250, 500, 750, 1100], 6: [300, 600, 900, 1400], 7: [350, 750, 1100, 1700], 8: [450, 900, 1400, 2100],
    9: [550, 1100, 1600, 2400], 10: [600, 1200, 1900, 2800], 11: [800, 1600, 2400, 3600], 12: [1000, 2000, 3000, 4500],
    13: [1100, 2200, 3400, 5100], 14: [1250, 2500, 3800, 5700], 15: [1400, 2800, 4300, 6400], 16: [1600, 3200, 4800, 7200],
    17: [2000, 3900, 5900, 8800], 18: [2100, 4200, 6300, 9500], 19: [2400, 4900, 7300, 10900], 20: [2800, 5700, 8500, 12700],
}
ENCOUNTER_DIFFICULTY_2024 = {
    1: [50, 75, 100], 2: [100, 150, 200], 3: [150, 225, 400], 4: [250, 375, 500], 5: [500, 750, 1100],
    6: [600, 1000, 1400], 7: [750, 1300, 1700], 8: [1000, 1700, 2100], 9: [1300, 2000, 2600], 10: [1600, 2300, 3100],
    11: [1900, 2900, 4100], 12: [2200, 3700, 4700], 13: [2600, 4200, 5400], 14: [2900, 4900, 6200], 15: [3300, 5400, 7800],
    16: [3800, 6100, 9800], 17: [4500, 7200, 11700], 18: [5000, 8700, 14200], 19: [5500, 10700, 17200], 20: [6400, 13200, 22000],
}


def threshold_boundaries(model: str, party_levels: list) -> list | None:
    levels = [max(1, min(20, int(round(lv)))) for lv in party_levels]
    if not levels:
        return None
    if model == "2014":
        easy = med = hard = deadly = 0
        for lv in levels:
            a, b, c, d = XP_THRESHOLDS_2014[lv]
            easy += a; med += b; hard += c; deadly += d
        if deadly <= 0:
            return None
        return [("Easy", easy / deadly), ("Medium", med / deadly), ("Hard", hard / deadly), ("Deadly", 1.0)]
    low = mod = high = 0
    for lv in levels:
        a, b, c = ENCOUNTER_DIFFICULTY_2024[lv]
        low += a; mod += b; high += c
    if high <= 0:
        return None
    return [("Low", low / high), ("Moderate", mod / high), ("High", 1.0)]


def parse_args():
    p = argparse.ArgumentParser(description="Scatter encounter difficulty vs win-rate")
    p.add_argument("folders", nargs="*", help="Folders, each an encounter scenario of .ndjson runs")
    p.add_argument("--parent", type=str, metavar="DIR", help="Use every immediate subfolder of DIR")
    p.add_argument("--model", choices=["2014", "2024"], default="2024", help="Difficulty model (default: 2024)")
    p.add_argument("--out", type=str, metavar="HTML", help="Write to an HTML file instead of opening a window")
    return p.parse_args()


def resolve_folders(args) -> list[Path]:
    candidates: list[Path] = []
    if args.parent:
        parent = Path(args.parent)
        if parent.is_dir():
            candidates.extend(sorted(d for d in parent.iterdir() if d.is_dir()))
        else:
            print(f"--parent is not a folder: {parent}", file=sys.stderr)
    candidates.extend(Path(f) for f in args.folders)

    folders: list[Path] = []
    seen: set[Path] = set()
    for f in candidates:
        if f in seen:
            continue
        seen.add(f)
        if not f.is_dir():
            print(f"Not a folder: {f}", file=sys.stderr)
            continue
        if not list(f.glob("*.ndjson")):
            print(f"No .ndjson: {f}", file=sys.stderr)
            continue
        folders.append(f)
    return folders


def summarize_folder(folder: Path, model: str) -> dict | None:
    paths = sorted(folder.glob("*.ndjson"), key=lambda p: p.stat().st_mtime)
    df = load_ndjson(paths)
    if "type" not in df.columns:
        print(f"No typed records: {folder}", file=sys.stderr)
        return None

    outcomes = classify_run_outcomes(df[df["type"] == "state"].copy())
    if outcomes is None or outcomes.empty:
        print(f"No resolvable runs: {folder}", file=sys.stderr)
        return None
    n = len(outcomes)
    wins = int((outcomes["outcome"] == "friendly").sum())
    winrate = wins / n

    cols = MODEL_COLUMNS[model]
    enc = df[df["type"] == "encounter"]
    ratio_col = cols["ratio"]
    if ratio_col not in enc.columns or enc[ratio_col].dropna().empty:
        print(f"No {model} difficulty: {folder}", file=sys.stderr)
        return None

    def first(col):
        return enc[col].dropna().iloc[0] if col in enc.columns and not enc[col].dropna().empty else None

    # se via normal approximation to the binomial
    se = (winrate * (1 - winrate) / n) ** 0.5
    return {
        "folder": folder.name,
        "difficulty": float(enc[ratio_col].dropna().mean()),
        "winrate": winrate,
        "n": n,
        "wins": wins,
        "ci95": CI_Z95 * se,
        "rating": str(first(cols["rating"])) if first(cols["rating"]) is not None else "?",
        "totalEnemyXp": float(first("totalEnemyXp") or 0),
        "enemyCount": int(first("enemyCount") or 0),
        "partyLevels": list(first("partyLevels") or []),
    }


def main():
    args = parse_args()
    folders = resolve_folders(args)
    if not folders:
        print("No valid folders given. Pass folders or specify a --parent.", file=sys.stderr)
        sys.exit(1)

    rows = [r for r in (summarize_folder(f, args.model) for f in folders) if r]
    if not rows:
        print("No folders produced usable data.", file=sys.stderr)
        sys.exit(1)

    data = pd.DataFrame(rows).sort_values("difficulty").reset_index(drop=True)
    difficulty = data["difficulty"].to_numpy(dtype=float)
    win_pct = data["winrate"].to_numpy(dtype=float) * 100

    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=difficulty, y=win_pct,
        error_y=dict(type="data", array=(data["ci95"] * 100).tolist(), visible=True, color="rgba(80,80,80,0.45)"),
        mode="markers+text",
        text=data["folder"], textposition="top center",
        marker=dict(size=11, color=difficulty, colorscale="RdYlGn_r", line=dict(width=1, color="rgba(40,40,40,0.6)")),
        customdata=list(zip(data["folder"], data["wins"], data["n"], data["rating"],
                            data["totalEnemyXp"], data["enemyCount"])),
        hovertemplate=(
            "%{customdata[0]}<br>difficulty=%{x:.3f} (%{customdata[3]})"
            "<br>win-rate=%{y:.1f}% (%{customdata[1]}/%{customdata[2]})"
            "<br>enemy XP=%{customdata[4]:.0f}, enemies=%{customdata[5]}"
            "<extra></extra>"
        ),
        name="Encounters",
    ))

    # best fit
    if len(difficulty) >= 2 and np.ptp(difficulty) > 0:
        slope, intercept = np.polyfit(difficulty, win_pct, 1)
        r = float(np.corrcoef(difficulty, win_pct)[0, 1])
        fit_x = np.linspace(float(difficulty.min()), float(difficulty.max()), 100)
        fig.add_trace(go.Scatter(
            x=fit_x, y=slope * fit_x + intercept, mode="lines",
            line=dict(color="rgba(40,40,40,0.7)", dash="dash"),
            name=f"best fit (R²={r * r:.2f})", hoverinfo="skip",
        ))
        fig.add_annotation(
            x=0.99, y=0.99, xref="paper", yref="paper", xanchor="right", yanchor="top",
            showarrow=False, align="right",
            text=f"r={r:.2f} · R²={r * r:.2f} · {len(difficulty)} encounters",
            bgcolor="rgba(255,255,255,0.6)", bordercolor="rgba(120,120,120,0.5)",
            borderwidth=1, borderpad=4,
        )

    # crop bc almost everything is deadly on 2014 lol
    x_margin = max(0.05, float(np.ptp(difficulty)) * 0.08)
    x_lo = float(difficulty.min()) - x_margin
    x_hi = float(difficulty.max()) + x_margin

    # these tier boundaries are not guaranteed to be correct
    # bc it's normalized to the highest tier, it may be the case that it doesn't line up perfectly
    # but this is close enough
    per_folder = [b for b in (threshold_boundaries(args.model, pl) for pl in data["partyLevels"]) if b]
    if per_folder:
        tier_labels = [lbl for lbl, _ in per_folder[0]]
        for i, label in enumerate(tier_labels):
            lx = min(b[i][1] for b in per_folder)
            if lx < x_lo:
                continue
            x_hi = max(x_hi, lx + x_margin)
            fig.add_vline(
                x=lx,
                line=dict(color="rgba(150,150,150,0.5)", dash="dot"),
                annotation_text=label, annotation_position="top",
                annotation=dict(font=dict(size=10, color="rgba(90,90,90,1)")),
            )

    fig.update_layout(
        title=f"Party Win-rate vs Encounter Difficulty ({args.model} model)",
        xaxis_title=f"Difficulty ratio ({args.model})",
        yaxis_title="Party win-rate (%)",
        xaxis_range=[x_lo, x_hi],
        yaxis_range=[-2, 102],
        hovermode="closest",
    )

    if args.out:
        fig.write_html(args.out)
        print(f"Wrote {args.out}", file=sys.stderr)
    else:
        fig.show()


if __name__ == "__main__":
    main()
