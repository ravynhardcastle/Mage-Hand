"""
Mean HP over rounds, with a separate line per entity per outcome.

Usage:
    python chart_health_by_outcome.py --dir logs/encounter
    python chart_health_by_outcome.py a.ndjson b.ndjson ...
    python chart_health_by_outcome.py --last 50 --pct
    python chart_health_by_outcome.py --dir logs/x --out health.html
"""

import argparse
import sys
import tempfile
from colorsys import hls_to_rgb, rgb_to_hls
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go

from chart import (
    CI_Z95, DISP_LABELS,
    build_entity_color_map, classify_run_outcomes,
    disambiguate_duplicate_names, load_ndjson, resolve_paths,
)

OUTCOME_STYLE = {
    "friendly": ("win", "solid"),
    "hostile": ("loss", "dash"),
    "draw": ("draw", "dot"),
}


def parse_args():
    argv = [a for a in sys.argv[1:] if a != "--"]
    p = argparse.ArgumentParser(description="Mean HP over rounds, split by win/loss per entity")
    p.add_argument("files", nargs="*")
    p.add_argument("--last", type=int, metavar="N")
    p.add_argument("--dir", type=str, metavar="FOLDER")
    p.add_argument("--pct", action="store_true", help="Plot HP as %% of max instead")
    p.add_argument("--merge", action="store_true",
                   help="Combine tokens that share a name into one unit with their summed HP")
    p.add_argument("--no-ci", action="store_true", help="Hide the 95%% confidence bands")
    p.add_argument("--out", type=str, metavar="HTML", help="Write to this HTML file instead of a temp file")
    return p.parse_args(argv)


def _rgba(color: str | None, alpha: float) -> str:
    if color and color.startswith("rgb(") and color.endswith(")"):
        return f"rgba({color[4:-1]},{alpha})"
    return f"rgba(128,128,128,{alpha})"


def _readable(color: str | None) -> str | None:
    """Darken yellow/lime hues so they're legible on white."""
    if not (color and color.startswith("rgb(") and color.endswith(")")):
        return color
    try:
        r, g, b = (int(p) for p in color[4:-1].split(","))
    except ValueError:
        return color
    h, l, s = rgb_to_hls(r / 255, g / 255, b / 255)
    if 40 / 360 <= h <= 115 / 360:
        l, s = min(l, 0.42), max(s, 0.6)
        r, g, b = (round(c * 255) for c in hls_to_rgb(h, l, s))
        return f"rgb({r},{g},{b})"
    return color


def main():
    args = parse_args()
    paths = resolve_paths(args)
    n_runs = len(paths)

    df = load_ndjson(paths)
    state_df = df[df["type"] == "state"].copy()
    if "round" in state_df.columns:
        state_df["round"] = state_df["round"].astype(int)
    if not args.merge:
        state_df, _ = disambiguate_duplicate_names(state_df, df[df["type"] == "attack"].copy())

    state_df["entityKey"] = (
        state_df["name"].fillna("token")
        + " (" + state_df["disposition"].map(lambda d: DISP_LABELS.get(int(d), str(d))) + ")"
    )
    state_df["tokenId"] = state_df["tokenId"].astype(str)

    hp = state_df.dropna(subset=["hp"]).copy()
    hp["hp"] = pd.to_numeric(hp["hp"], errors="coerce")
    hp = (
        hp.sort_values(["round"])
        .groupby(["run", "round", "tokenId", "entityKey"], as_index=False)
        .agg(hp=("hp", "last"))
    )

    hp["hpMaxUnit"] = hp.groupby(["run", "tokenId"])["hp"].transform("max")
    if args.merge:

        hp = hp.groupby(["run", "round", "entityKey"], as_index=False).agg(
            hp=("hp", "sum"), hpMaxUnit=("hpMaxUnit", "sum")
        )

    hp["hpPct"] = (hp["hp"] / hp["hpMaxUnit"].replace(0, float("nan")) * 100).fillna(0)
    value_col = "hpPct" if args.pct else "hp"

    outcomes = classify_run_outcomes(state_df)
    if outcomes is None or outcomes.empty:
        print("No resolvable runs to split by win/loss.", file=sys.stderr)
        sys.exit(1)
    hp["outcome"] = hp["run"].map(dict(zip(outcomes["run"].astype(int), outcomes["outcome"])))
    hp = hp[hp["outcome"].isin(OUTCOME_STYLE)]
    if hp.empty:
        print("No win/loss/draw runs to chart.", file=sys.stderr)
        sys.exit(1)

    entity_colors = build_entity_color_map(sorted(hp["entityKey"].dropna().unique().tolist()))
    entity_colors = {k: _readable(v) for k, v in entity_colors.items()}
    cap = 100 if args.pct else None

    fig = go.Figure()
    for entity in sorted(hp["entityKey"].unique()):
        color = entity_colors.get(entity)
        for outcome, (suffix, dash) in OUTCOME_STYLE.items():
            runs_df = hp[(hp["entityKey"] == entity) & (hp["outcome"] == outcome)]
            if runs_df.empty:
                continue
            n_outcome = runs_df["run"].nunique()
            stats = (
                runs_df.groupby("round", as_index=False)
                .agg(mean=(value_col, "mean"), std=(value_col, "std"), cnt=(value_col, "count"))
                .sort_values("round")
            )
            stats["std"] = stats["std"].fillna(0)
            stats["ci95"] = CI_Z95 * stats["std"] / stats["cnt"] ** 0.5

            label = f"{entity} [{suffix}, n={n_outcome}]"
            fig.add_trace(go.Scatter(
                x=stats["round"], y=stats["mean"], mode="lines", name=label,
                line=dict(color=color, dash=dash), line_shape="hv", legendgroup=label,
                hovertemplate=f"round %{{x}}<br>{label}: %{{y:.1f}}{'%' if args.pct else ' HP'}<extra></extra>",
            ))
            if not args.no_ci:
                upper = (stats["mean"] + stats["ci95"]).clip(upper=cap)
                lower = (stats["mean"] - stats["ci95"]).clip(lower=0)
                fig.add_trace(go.Scatter(
                    x=pd.concat([stats["round"], stats["round"].iloc[::-1]]),
                    y=pd.concat([upper, lower.iloc[::-1]]),
                    fill="toself", fillcolor=_rgba(color, 0.10), line=dict(width=0),
                    name=f"{label} CI", legendgroup=label, showlegend=False, hoverinfo="skip",
                ))

    fig.update_layout(
        title=f"Mean {'Combined ' if args.merge else ''}HP by Outcome. Solid = win, Dashed = loss (n={n_runs} runs)",
        xaxis_title="Round", yaxis_title="Mean HP (%)" if args.pct else "Mean HP",
        hovermode="x unified", legend=dict(groupclick="togglegroup"),
    )

    if args.out:
        fig.write_html(args.out)
        print(f"Wrote {args.out}", file=sys.stderr)
    else:
        path = Path(tempfile.gettempdir()) / "dnd_health_by_outcome.html"
        fig.write_html(path)
        print(f"Chart ready, open: {path.as_uri()}", file=sys.stderr)


if __name__ == "__main__":
    main()
