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
    "%{customdata[0]}<br>difficulty=%{customdata[6]:.3f} (%{customdata[3]})"
    "<br>win-rate=%{y:.1f}% (%{customdata[1]}/%{customdata[2]})"
    "<br>enemy XP=%{customdata[4]:.0f}, enemies=%{customdata[5]}"
    "<extra></extra>"
)


def add_tier_trace(fig, sub, name, color, symbol="circle", xfn=None):
    xvals = sub["difficulty"] if xfn is None else xfn(sub["difficulty"])
    fig.add_trace(go.Scatter(
        x=xvals, y=sub["winrate"] * 100,
        error_y=dict(type="data", array=(sub["ci95"] * 100).tolist(), visible=True, color="rgba(80,80,80,0.45)"),
        mode="markers",
        marker=dict(size=15, color=color, symbol=symbol, line=dict(width=1, color="rgba(40,40,40,0.7)")),
        customdata=list(zip(sub["folder"], sub["wins"] + sub["draw_wins"], sub["n"], sub["rating"],
                            sub["totalEnemyXp"], sub["enemyCount"], sub["difficulty"])),
        hovertemplate=HOVER_TEMPLATE,
        name=name,
    ))


def add_encounter_labels(fig, data, xfn=None):
    xfn = xfn or (lambda v: v)
    xpos = xfn(data["difficulty"])
    x_span = max(float(xpos.max() - xpos.min()), 1e-9)
    line_h = 2                      # label vertical spacing %
    marker_gap = 0             # min clearance from a marker centre %
    char_w = 0.013 * x_span           # per-character width
    placed: list[tuple[float, float, float]] = []  # (x, y_label, half_width)
    # jank
    for _, row in data.sort_values("winrate", ascending=False).iterrows():
        name = str(row["folder"])
        x, y = float(xfn(float(row["difficulty"]))), float(row["winrate"] * 100)
        half_w = max(0.5 * len(name) * char_w, 0.02 * x_span)
        direction = -1 if y > 90 else 1
        base = y + direction * (marker_gap + float(row["ci95"]) * 100)
        y_label = base
        for k in range(1, 40):
            if not any(abs(px - x) < (phw + half_w) and abs(pyl - y_label) < line_h
                       for px, pyl, phw in placed):
                break
            y_label = base + direction * k * line_h
        y_label = min(max(y_label, 1.0), 99.0)
        placed.append((x, y_label, half_w))
        fig.add_annotation(
            x=x, y=y, ax=x, ay=y_label, xref="x", yref="y", axref="x", ayref="y",
            text=name, showarrow=True, arrowhead=0, arrowwidth=1, arrowcolor="rgba(110,110,110,0)",
            bgcolor="rgba(255,255,255,1)", bordercolor="rgba(120,120,120,1)",
            borderwidth=1, borderpad=2, font=dict(size=17),
        )


def build_break_transform(difficulty):
    vals = np.unique(np.asarray(difficulty, dtype=float))
    if vals.size < 3:
        return None, None
    gaps = np.diff(vals)
    i = int(np.argmax(gaps))
    span = float(vals[-1] - vals[0])
    other_gaps = np.delete(gaps, i)
    typical = float(np.median(other_gaps)) if other_gaps.size else 0.0
    if span <= 0 or gaps[i] < 0.25 * span or gaps[i] < 3.0 * typical:
        return None, None
    a = float(vals[0])        # smallest difficulty
    b = float(vals[i])        # right edge of the lower cluster
    c = float(vals[i + 1])    # left edge of the outlier group
    gap = max(0.12 * (b - a), 0.08)   # collapsed width of the empty region
    pad = 0.3 * gap                    # breathing room between a point and the break band

    def xfn(v):
        v = np.asarray(v, dtype=float)
        mid = b + gap * (v - b) / (c - b)   # interior of the gap
        right = b + gap + (v - c)            # outlier side
        out = np.where(v <= b, v, np.where(v < c, mid, right))
        return out if out.ndim else float(out)

    return xfn, {"band": (b + pad, b + gap - pad), "b": b, "c": c, "gap": gap}


def parse_args():
    # on windows you have to do '--' but on linux it does that automatically so i just strip it here
    # so it works on both
    argv = [a for a in sys.argv[1:] if a != "--"]
    p = argparse.ArgumentParser(description="Scatter encounter difficulty vs win-rate")
    p.add_argument("folders", nargs="*", help="Folders which are an encounter scenario of .ndjson rollouts")
    p.add_argument("--parent", type=str, metavar="DIR", help="Use every immediate subfolder of DIR")
    p.add_argument("--model", choices=["2014", "2024"], default="2024", help="Difficulty model (default: 2024)")
    p.add_argument("--out", type=str, metavar="HTML", help="Write to an HTML file instead of opening a window")
    p.add_argument("--verbose", "-v", action="store_true", help="Label each point with its encounter name")
    p.add_argument("--clip", action="store_true", help="Add a gap between outliers and main information")
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

    xfn, brk = (build_break_transform(difficulty) if args.clip else (None, None))
    break_band = brk["band"] if brk else None
    if args.clip and xfn is None:
        print("No dominant outlier gap to clip, using linear.", file=sys.stderr)

    fig = go.Figure()

    rating_lower = data["rating"].astype(str).str.lower()
    plotted = pd.Series(False, index=data.index)
    for key, label, color, symbol in TIER_COLORS[args.model]:
        mask = rating_lower == key
        if mask.any():
            add_tier_trace(fig, data[mask], label, color, symbol, xfn=xfn)
            plotted |= mask
    leftover = data[~plotted]
    if not leftover.empty:
        add_tier_trace(fig, leftover, "Other", "#999999", "cross", xfn=xfn)
    if args.verbose:
        add_encounter_labels(fig, data, xfn=xfn)

    plot_x = (lambda v: float(xfn(v))) if xfn else (lambda v: float(v))

    if len(difficulty) >= 2 and np.ptp(difficulty) > 0:
        slope, intercept = np.polyfit(difficulty, win_pct, 1)
        r = float(np.corrcoef(difficulty, win_pct)[0, 1])
        y_of = lambda v: slope * v + intercept
        dmin, dmax = float(difficulty.min()), float(difficulty.max())
        if brk:
            b, c, gap, band = brk["b"], brk["c"], brk["gap"], brk["band"]
            off = slope * (c - b - gap)   # the drop the band represents
            xmax = float(xfn(dmax))
            fit_plot_x = [dmin, band[0], band[1], xmax]
            fit_y = [y_of(dmin),
                     intercept + slope * band[0],
                     intercept + slope * band[1] + off,
                     intercept + slope * xmax + off]
        else:
            fit_x = np.linspace(dmin, dmax, 100)
            fit_plot_x, fit_y = fit_x, y_of(fit_x)
        fig.add_trace(go.Scatter(
            x=fit_plot_x, y=fit_y, mode="lines",
            line=dict(color="rgba(40,40,40,0.7)", dash="dash"),
            name=f"Best Fit (r={r:.2f})", hoverinfo="skip",
        ))

    # crop bc almost everything is deadly on 2014 lol (computed in plotted x-space)
    plotted_pts = [plot_x(v) for v in difficulty] + [plot_x(1.0)]
    lo, hi = min(plotted_pts), max(plotted_pts)
    pad = max(0.05, (hi - lo) * 0.08)
    x_lo, x_hi = lo - pad, hi + pad

    # shade the collapsed break so the axis discontinuity is obvious
    if break_band:
        fig.add_vrect(
            x0=break_band[0], x1=break_band[1], fillcolor="rgba(120,120,120,0.10)",
            line_width=0, annotation_text="⁓", annotation_position="bottom",
            annotation=dict(font=dict(size=24, color="rgba(90,90,90,1)")),
        )

    # reference line for hardest difficulty at 1.0
    fig.add_vline(
        x=plot_x(1.0),
        line=dict(color="rgba(150,150,150,0.6)", dash="dot"),
        annotation_text=TIER_COLORS[args.model][-1][1], annotation_position="top",
        annotation=dict(font=dict(size=18, color="rgba(90,90,90,1)")),
    )

    fig.update_layout(
        title=dict(text=f"Party Win-rate vs Encounter Difficulty ({args.model} model)", font=dict(size=32)),
        xaxis_title=dict(text=f"Difficulty ratio ({args.model})", font=dict(size=26)),
        yaxis_title=dict(text="Party win-rate (%)", font=dict(size=26)),
        xaxis_range=[x_lo, x_hi],
        yaxis_range=[-2, 102],
        hovermode="closest",
        legend=dict(
            title=dict(text="Difficulty tier", font=dict(size=22)), font=dict(size=20),
            xanchor="left", yanchor="bottom", x=0.01, y=0.02,
            bgcolor="rgba(255,255,255,0.75)", bordercolor="rgba(150,150,150,0.6)", borderwidth=1,
        ),
        font=dict(size=22),
    )
    fig.update_xaxes(tickfont=dict(size=20))
    fig.update_yaxes(tickfont=dict(size=20))
    if xfn:
        nice = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0]
        # the cluster is everything left of the break band; outliers are to its right
        cluster_vals = [float(v) for v in np.unique(difficulty) if plot_x(v) <= break_band[0] + 1e-9]
        outlier_vals = [float(v) for v in np.unique(difficulty) if plot_x(v) > break_band[1] - 1e-9]
        cmax = max(cluster_vals) if cluster_vals else float(difficulty.max())
        left_ticks = [t for t in nice if difficulty.min() - 0.05 <= t <= cmax + 1e-9]
        tick_reals = left_ticks + outlier_vals
        fig.update_xaxes(tickmode="array", tickvals=[plot_x(t) for t in tick_reals],
                         ticktext=[f"{t:g}" for t in tick_reals])

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
