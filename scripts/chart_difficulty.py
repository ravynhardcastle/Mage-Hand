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
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go

from chart import CI_Z95, classify_run_outcomes, load_ndjson

MODEL_COLUMNS = {
    "2014": {"ratio": "d2014_ratio", "rating": "d2014_rating"},
    "2024": {"ratio": "d2024_ratio", "rating": "d2024_rating"},
}

# viridis and shape for colourblindness
TIER_COLORS = {
    "2014": [
        ("trivial", "Trivial", "#fde725", "circle"),
        ("easy", "Easy", "#5ec962", "square"),
        ("medium", "Medium", "#21918c", "diamond"),
        ("hard", "Hard", "#3b528b", "triangle-up"),
        ("deadly", "Deadly", "#440154", "star"),
    ],
    "2024": [
        ("trivial", "Trivial", "#fde725", "circle"),
        ("low", "Low", "#5ec962", "square"),
        ("moderate", "Moderate", "#3b528b", "diamond"),
        ("high", "High", "#440154", "star"),
    ],
}

HOVER_TEMPLATE = (
    "%{customdata[0]}<br>difficulty=%{x:.3f} (%{customdata[3]})"
    "<br>win-rate=%{y:.1f}% (%{customdata[1]}/%{customdata[2]})"
    "<br>enemy XP=%{customdata[4]:.0f}, enemies=%{customdata[5]}"
    "<extra></extra>"
)


def add_tier_trace(fig, sub, name, color, symbol="circle"):
    fig.add_trace(go.Scatter(
        x=sub["difficulty"], y=sub["winrate"] * 100,
        error_y=dict(type="data", array=(sub["ci95"] * 100).tolist(), visible=True, color="rgba(80,80,80,0.45)"),
        mode="markers+text",
        text=sub["folder"], textposition="top center",
        marker=dict(size=12, color=color, symbol=symbol, line=dict(width=1, color="rgba(40,40,40,0.7)")),
        customdata=list(zip(sub["folder"], sub["wins"] + sub["draw_wins"], sub["n"], sub["rating"],
                            sub["totalEnemyXp"], sub["enemyCount"])),
        hovertemplate=HOVER_TEMPLATE,
        name=name,
    ))

def parse_args():
    # on windows you have to do '--' but on linux it does that automatically so i just strip it here
    # so it works on both
    argv = [a for a in sys.argv[1:] if a != "--"]
    p = argparse.ArgumentParser(description="Scatter encounter difficulty vs win-rate")
    p.add_argument("folders", nargs="*", help="Folders, each an encounter scenario of .ndjson runs")
    p.add_argument("--parent", type=str, metavar="DIR", help="Use every immediate subfolder of DIR")
    p.add_argument("--model", choices=["2014", "2024"], default="2024", help="Difficulty model (default: 2024)")
    p.add_argument("--out", type=str, metavar="HTML", help="Write to an HTML file instead of opening a window")
    return p.parse_args(argv)


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
    resolved = (
        outcomes["resolved_by_hp"].astype(bool)
        if "resolved_by_hp" in outcomes.columns
        else pd.Series(False, index=outcomes.index)
    )
    is_friendly = outcomes["outcome"] == "friendly"
    is_hostile = outcomes["outcome"] == "hostile"
    wins = int((is_friendly & ~resolved).sum())
    losses = int((is_hostile & ~resolved).sum())
    draw_wins = int((is_friendly & resolved).sum())
    draw_losses = int((is_hostile & resolved).sum())
    ties = n - wins - losses - draw_wins - draw_losses
    winrate = (wins + draw_wins) / n

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
        "losses": losses,
        "draw_wins": draw_wins,
        "draw_losses": draw_losses,
        "ties": ties,
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

    rating_lower = data["rating"].astype(str).str.lower()
    plotted = pd.Series(False, index=data.index)
    for key, label, color, symbol in TIER_COLORS[args.model]:
        mask = rating_lower == key
        if mask.any():
            add_tier_trace(fig, data[mask], label, color, symbol)
            plotted |= mask
    leftover = data[~plotted]
    if not leftover.empty:
        add_tier_trace(fig, leftover, "Other", "#999999", "cross")

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
    x_lo = min(float(difficulty.min()) - x_margin, 1.0 - x_margin)
    x_hi = max(float(difficulty.max()) + x_margin, 1.0 + x_margin)

    # reference line for hardest difficulty at 1.0
    fig.add_vline(
        x=1.0, line=dict(color="rgba(150,150,150,0.6)", dash="dot"),
        annotation_text=TIER_COLORS[args.model][-1][1], annotation_position="top",
        annotation=dict(font=dict(size=10, color="rgba(90,90,90,1)")),
    )

    fig.update_layout(
        title=f"Party Win-rate vs Encounter Difficulty ({args.model} model)",
        xaxis_title=f"Difficulty ratio ({args.model})",
        yaxis_title="Party win-rate (%)",
        xaxis_range=[x_lo, x_hi],
        yaxis_range=[-2, 102],
        hovermode="closest",
        legend_title_text="Difficulty tier",
    )

    if args.out:
        fig.write_html(args.out)
        print(f"Wrote {args.out}", file=sys.stderr)
    else:
        # normally you do fig.show() but i wanna open it on other browsers
        path = Path(tempfile.gettempdir()) / "dnd_difficulty_chart.html"
        fig.write_html(path)
        print(f"Chart: {path.as_uri()}", file=sys.stderr)


if __name__ == "__main__":
    main()
