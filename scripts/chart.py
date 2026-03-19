"""
Chart combat-log metrics from one or more NDJSON files.

Usage:
    python chart.py                         # newest single .ndjson
    python chart.py <file.ndjson>           # single file
    python chart.py --last N                # average over N newest .ndjson logs
    python chart.py a.ndjson b.ndjson ...   # average over listed files
    python chart.py --dir logs/             # average over all .ndjson in a folder
"""

import argparse
import sys
from pathlib import Path

import pandas as pd
from plotly.subplots import make_subplots
import plotly.graph_objects as go

DISP_LABELS = {1: "friendly", 0: "neutral", -1: "hostile", -2: "secret"}

def parse_args():
    parser = argparse.ArgumentParser(description="Chart combat log metrics")
    parser.add_argument("files", nargs="*", help="NDJSON file(s) to chart")
    parser.add_argument(
        "--last", type=int, metavar="N",
        help="Use the n most recent .ndjson files from logs/",
    )
    parser.add_argument(
        "--dir", type=str, metavar="FOLDER",
        help="Average over all .ndjson files in FOLDER",
    )
    return parser.parse_args()


def resolve_paths(args) -> list[Path]:
    """Return ordered list of .ndjson paths to load."""
    logs_dir = Path("logs")

    if args.dir:
        folder = Path(args.dir)
        paths = sorted(folder.glob("*.ndjson"), key=lambda p: p.stat().st_mtime)
        if not paths:
            print(f"No .ndjson files found in {folder}", file=sys.stderr)
            sys.exit(1)
        return paths

    if args.last:
        paths = sorted(logs_dir.glob("*.ndjson"), key=lambda p: p.stat().st_mtime, reverse=True)
        paths = paths[: args.last]
        if not paths:
            print(f"No .ndjson files found in {logs_dir}", file=sys.stderr)
            sys.exit(1)
        paths.reverse()
        return paths

    if args.files:
        return [Path(f) for f in args.files]

    candidates = list(logs_dir.glob("*.ndjson"))
    if not candidates:
        print(f"No .ndjson files found in {logs_dir}", file=sys.stderr)
        sys.exit(1)
    return [max(candidates, key=lambda p: p.stat().st_mtime)]

def load_ndjson(paths: list[Path]) -> pd.DataFrame:
    """Load one or more NDJSON files, tagging each row with a run index."""
    frames = []
    for i, p in enumerate(paths):
        df = pd.read_json(p, lines=True)
        df["run"] = i
        df["runFile"] = p.stem
        frames.append(df)
    combined = pd.concat(frames, ignore_index=True)
    if "type" not in combined.columns:
        combined["type"] = "state"
    combined["type"] = combined["type"].fillna("state")
    return combined

def disp_label(d) -> str:
    return DISP_LABELS.get(int(d), str(d))


def create_figure(subtitles: tuple[str, str, str]) -> go.Figure:
    """Create the standard 3-row subplot figure."""
    fig = make_subplots(
        rows=3, cols=1,
        shared_xaxes=False,
        vertical_spacing=0.12,
        subplot_titles=subtitles,
        row_heights=[0.45, 0.3, 0.25],
        specs=[[{"type": "scatter"}], [{"type": "bar"}], [{"type": "bar"}]],
    )
    fig.update_layout(xaxis2=dict(matches="x", showticklabels=True))
    return fig


def compute_turn_range(
    hp_turns: pd.Series, attack_df: pd.DataFrame
) -> tuple[int, int]:
    """Derive the (min, max) turn range from HP and attack data."""
    all_turns = hp_turns
    if not attack_df.empty:
        all_turns = pd.concat([all_turns, attack_df["turn"]])
    turn_min = int(all_turns.min()) if not all_turns.empty else 0
    turn_max = int(all_turns.max()) if not all_turns.empty else 1
    return turn_min, turn_max


def apply_layout(
    fig: go.Figure,
    turn_min: int,
    turn_max: int,
    *,
    title: str | None = None,
    y1_label: str = "HP",
    y2_label: str = "Damage",
    y3_label: str = "Total Damage",
):
    """Apply the final layout settings common to both chart modes."""
    fig.update_layout(
        barmode="stack",
        title_text=title,
        xaxis_title="Turn", xaxis2_title="Turn",
        xaxis_range=[turn_min - 0.5, turn_max + 0.5],
        yaxis_title=y1_label, yaxis2_title=y2_label,
        xaxis3_title="Entity", yaxis3_title=y3_label,
        hovermode="x unified",
    )


def add_hp_mode_toggle(
    fig: go.Figure,
    actual_trace_indices: list[int],
    pct_trace_indices: list[int],
    *,
    hp_actual_label: str = "HP",
    hp_pct_label: str = "HP (%)",
):
    """Add a Plotly button group to toggle row-1 HP traces between absolute and percentage."""
    if not actual_trace_indices or not pct_trace_indices:
        return

    total = len(fig.data)
    base_visible = [True] * total
    for i, trace in enumerate(fig.data):
        trace_visible = getattr(trace, "visible", True)
        base_visible[i] = (trace_visible is not False)

    actual_visible = base_visible.copy()
    for idx in pct_trace_indices:
        actual_visible[idx] = False
    for idx in actual_trace_indices:
        actual_visible[idx] = True

    pct_visible = base_visible.copy()
    for idx in actual_trace_indices:
        pct_visible[idx] = False
    for idx in pct_trace_indices:
        pct_visible[idx] = True

    fig.update_layout(
        updatemenus=[
            dict(
                type="buttons",
                direction="left",
                x=1.0,
                y=1.01,
                xanchor="right",
                yanchor="bottom",
                buttons=[
                    dict(
                        label="HP",
                        method="update",
                        args=[{"visible": actual_visible}, {"yaxis.title": hp_actual_label}],
                    ),
                    dict(
                        label="HP %",
                        method="update",
                        args=[{"visible": pct_visible}, {"yaxis.title": hp_pct_label}],
                    ),
                ],
            )
        ]
    )


def add_damage_bars(
    fig: go.Figure,
    hits: pd.DataFrame,
    label_col: str,
    *,
    per_run: bool = False,
):
    """
    Add per-turn damage bar traces to row 2.

    When per_run=True, averages across runs and adds std error bars.
    """
    if hits.empty:
        return

    if per_run:
        dmg_run_turn = (
            hits.groupby(["run", "turn", label_col], as_index=False)
                .agg(totalDamage=("damageDealt", "sum"))
        )
        dmg = (
            dmg_run_turn.groupby(["turn", label_col], as_index=False)
                .agg(y=("totalDamage", "mean"), std=("totalDamage", "std"))
        )
        dmg["std"] = dmg["std"].fillna(0)
    else:
        dmg = (
            hits.groupby(["turn", label_col], as_index=False)
                .agg(y=("damageDealt", "sum"))
        )

    for attacker in sorted(dmg[label_col].unique()):
        subset = dmg[dmg[label_col] == attacker].sort_values("turn")
        error_y = (
            dict(type="data", array=subset["std"].tolist(), visible=True)
            if per_run else None
        )
        fig.add_trace(
            go.Bar(
                x=subset["turn"], y=subset["y"],
                error_y=error_y,
                name=attacker, legendgroup="dmg_" + attacker,
            ),
            row=2, col=1,
        )


def add_weapon_bars(
    fig: go.Figure,
    hits: pd.DataFrame,
    label_col: str,
    *,
    per_run: bool = False,
):
    """
    Add total-damage-by-weapon bar traces to row 3.

    When per_run=True, averages across runs and adds std error bars.
    """
    if hits.empty:
        return

    if per_run:
        run_totals = (
            hits.groupby(["run", label_col, "weapon"], as_index=False)
                .agg(totalDamage=("damageDealt", "sum"), hitCount=("damageDealt", "count"))
        )
        by_weapon = (
            run_totals.groupby([label_col, "weapon"], as_index=False)
                .agg(
                    y=("totalDamage", "mean"),
                    std=("totalDamage", "std"),
                    hits_label=("hitCount", "mean"),
                )
        )
        by_weapon["std"] = by_weapon["std"].fillna(0)
        by_weapon["hits_label"] = by_weapon["hits_label"].round(1).astype(str) + " hits/run"
        hover_tpl = (
            "%{x}<br>%{fullData.name}: %{y:.1f}±%{error_y.array:.1f} dmg"
            " (%{text})<extra></extra>"
        )
    else:
        by_weapon = (
            hits.groupby([label_col, "weapon"], as_index=False)
                .agg(y=("damageDealt", "sum"), hitCount=("damageDealt", "count"))
        )
        by_weapon["hits_label"] = by_weapon["hitCount"].astype(str) + " hits"
        hover_tpl = "%{x}<br>%{fullData.name}: %{y} dmg (%{text})<extra></extra>"

    for weapon in sorted(by_weapon["weapon"].unique()):
        subset = by_weapon[by_weapon["weapon"] == weapon]
        error_y = (
            dict(type="data", array=subset["std"].tolist(), visible=True)
            if per_run else None
        )
        fig.add_trace(
            go.Bar(
                x=subset[label_col], y=subset["y"],
                error_y=error_y,
                name=weapon,
                text=subset["hits_label"],
                hovertemplate=hover_tpl,
                legendgroup="wpn_" + weapon,
            ),
            row=3, col=1,
        )

def chart_single(state_df: pd.DataFrame, attack_df: pd.DataFrame):
    state_df["tokenId"] = state_df["tokenId"].astype(str)
    state_df["tokenLabel"] = (
        state_df["name"].fillna("token")
        + ":"
        + state_df["tokenId"].str.slice(0, 6)
        + " (disp="
        + state_df["disposition"].astype(str)
        + ")"
    )

    hp = state_df.dropna(subset=["hp"]).copy()
    hp["hp"] = pd.to_numeric(hp["hp"], errors="coerce")
    hp = (
        hp.sort_values(["turn", "round"])
          .groupby(["turn", "tokenId", "tokenLabel"], as_index=False)
          .agg(hp=("hp", "last"), round=("round", "max"))
    )
    hp_max = hp.groupby("tokenId")["hp"].transform("max")
    hp["hpPct"] = (hp["hp"] / hp_max.replace(0, pd.NA) * 100).fillna(0)

    fig = create_figure((
        "HP Over Time",
        "Damage Dealt Per Turn",
        "Total Damage by Entity & Weapon",
    ))

    hp_actual_indices: list[int] = []
    hp_pct_indices: list[int] = []

    # HP lines
    for label in hp["tokenLabel"].unique():
        subset = hp[hp["tokenLabel"] == label]
        fig.add_trace(
            go.Scatter(
                x=subset["turn"], y=subset["hpPct"],
                mode="lines", name=label, line_shape="hv",
                legendgroup=label, visible=False,
            ),
            row=1, col=1,
        )
        hp_pct_indices.append(len(fig.data) - 1)

        fig.add_trace(
            go.Scatter(
                x=subset["turn"], y=subset["hp"],
                mode="lines", name=label, line_shape="hv",
                legendgroup=label,
            ),
            row=1, col=1,
        )
        hp_actual_indices.append(len(fig.data) - 1)

    # Attack event markers on HP chart
    if not attack_df.empty:
        hits = attack_df[attack_df["hit"] == True].copy()  # noqa: E712
        if not hits.empty:
            hits["targetTokenId"] = hits["targetTokenId"].astype(str)
            hits["turn"] = hits["turn"].astype(int)
            hits["hoverText"] = (
                hits["attacker"] + " → " + hits["targetName"]
                + " (" + hits["weapon"] + ")"
                + "<br>" + hits["kind"].fillna("action")
                + " | dmg=" + hits["damageDealt"].astype(str)
                + " atk=" + hits["attackTotal"].astype(str)
                + hits["isCritical"].apply(lambda c: " CRIT" if c else "")
            )
            hp_lookup = hp[["turn", "tokenId", "hp"]].sort_values("turn")
            hp_lookup_pct = hp[["turn", "tokenId", "hpPct"]].sort_values("turn")
            hits_sorted = hits.sort_values("turn")
            hits_sorted = pd.merge_asof(
                hits_sorted,
                hp_lookup.rename(columns={"tokenId": "_tkId"}),
                on="turn",
                left_by="targetTokenId", right_by="_tkId",
                direction="backward", suffixes=("", "_state"),
            )
            hits_sorted = hits_sorted.dropna(subset=["hp_state", "turn"])

            y_vals = hits_sorted["hp_state"] if not hits_sorted.empty else [0] * len(hits)
            x_vals = hits_sorted["turn"] if not hits_sorted.empty else hits["turn"]
            text_vals = hits_sorted["hoverText"] if not hits_sorted.empty else hits["hoverText"]

            hits_sorted_pct = pd.merge_asof(
                hits.sort_values("turn"),
                hp_lookup_pct.rename(columns={"tokenId": "_tkId", "hpPct": "hpPct_state"}),
                on="turn",
                left_by="targetTokenId", right_by="_tkId",
                direction="backward",
            ).dropna(subset=["hpPct_state", "turn"])
            y_vals_pct = (
                hits_sorted_pct["hpPct_state"]
                if not hits_sorted_pct.empty
                else [0] * len(hits)
            )

            fig.add_trace(
                go.Scatter(
                    x=x_vals, y=y_vals_pct, mode="markers",
                    marker=dict(symbol="x", size=10, color="red", line=dict(width=1)),
                    name="Hits", text=text_vals, hoverinfo="text+x+y",
                    showlegend=True, legendgroup="__hits", visible=False,
                ),
                row=1, col=1,
            )
            hp_pct_indices.append(len(fig.data) - 1)

            fig.add_trace(
                go.Scatter(
                    x=x_vals, y=y_vals, mode="markers",
                    marker=dict(symbol="x", size=10, color="red", line=dict(width=1)),
                    name="Hits", text=text_vals, hoverinfo="text+x+y",
                    showlegend=True, legendgroup="__hits",
                ),
                row=1, col=1,
            )
            hp_actual_indices.append(len(fig.data) - 1)

        # Damage and weapon bars
        attack_df["attackerLabel"] = (
            attack_df["attacker"].fillna("unknown")
            + ":" + attack_df["attackerId"].astype(str).str.slice(0, 6)
        )
        all_hits = attack_df[attack_df["hit"] == True].copy()  # noqa: E712
        add_damage_bars(fig, all_hits, "attackerLabel")
        add_weapon_bars(fig, all_hits, "attackerLabel")

    turn_min, turn_max = compute_turn_range(hp["turn"], attack_df)
    apply_layout(fig, turn_min, turn_max)
    add_hp_mode_toggle(fig, hp_actual_indices, hp_pct_indices)
    fig.show()

def chart_averaged(state_df: pd.DataFrame, attack_df: pd.DataFrame, n_runs: int):
    """
    Average HP and damage metrics across multiple runs.

    Entities are matched across runs by (name, disposition) rather than tokenId,
    since token IDs can change between sessions. Sanity check that everything has
    a different name before doing this.
    """

    state_df["entityKey"] = (
        state_df["name"].fillna("token")
        + " (" + state_df["disposition"].map(disp_label) + ")"
    )

    hp = state_df.dropna(subset=["hp"]).copy()
    hp["hp"] = pd.to_numeric(hp["hp"], errors="coerce")
    hp = (
        hp.sort_values(["turn", "round"])
          .groupby(["run", "turn", "tokenId", "entityKey"], as_index=False)
          .agg(hp=("hp", "last"))
    )
    hp_max = hp.groupby(["run", "entityKey"])["hp"].transform("max")
    hp["hpPct"] = (hp["hp"] / hp_max.replace(0, pd.NA) * 100).fillna(0)

    hp_stats = (
        hp.groupby(["turn", "entityKey"], as_index=False)
          .agg(hp_mean=("hp", "mean"), hp_std=("hp", "std"), hp_count=("hp", "count"))
    )
    hp_stats["hp_std"] = hp_stats["hp_std"].fillna(0)

    hp_stats_pct = (
        hp.groupby(["turn", "entityKey"], as_index=False)
          .agg(hp_mean=("hpPct", "mean"), hp_std=("hpPct", "std"), hp_count=("hpPct", "count"))
    )
    hp_stats_pct["hp_std"] = hp_stats_pct["hp_std"].fillna(0)

    fig = create_figure((
        f"Mean HP Over Time (n={n_runs} runs)",
        f"Mean Damage Dealt Per Turn (n={n_runs} runs)",
        f"Mean Total Damage by Entity & Weapon (n={n_runs} runs)",
    ))

    hp_actual_indices: list[int] = []
    hp_pct_indices: list[int] = []

    for key in sorted(hp_stats["entityKey"].unique()):
        subset = hp_stats[hp_stats["entityKey"] == key].sort_values("turn")
        turns = subset["turn"]
        mean = subset["hp_mean"]
        std = subset["hp_std"]

        subset_pct = hp_stats_pct[hp_stats_pct["entityKey"] == key].sort_values("turn")
        turns_pct = subset_pct["turn"]
        mean_pct = subset_pct["hp_mean"]
        std_pct = subset_pct["hp_std"]

        fig.add_trace(
            go.Scatter(
                x=turns_pct, y=mean_pct,
                mode="lines", name=key, line_shape="hv",
                legendgroup=key, visible=False,
            ),
            row=1, col=1,
        )
        hp_pct_indices.append(len(fig.data) - 1)
        fig.add_trace(
            go.Scatter(
                x=pd.concat([turns_pct, turns_pct[::-1]]),
                y=pd.concat([(mean_pct + std_pct), (mean_pct - std_pct).iloc[::-1]]),
                fill="toself", fillcolor="rgba(128,128,128,0.15)",
                line=dict(width=0), showlegend=False,
                legendgroup=key, hoverinfo="skip", visible=False,
            ),
            row=1, col=1,
        )
        hp_pct_indices.append(len(fig.data) - 1)

        fig.add_trace(
            go.Scatter(
                x=turns, y=mean,
                mode="lines", name=key, line_shape="hv",
                legendgroup=key,
            ),
            row=1, col=1,
        )
        hp_actual_indices.append(len(fig.data) - 1)
        fig.add_trace(
            go.Scatter(
                x=pd.concat([turns, turns[::-1]]),
                y=pd.concat([(mean + std), (mean - std).iloc[::-1]]),
                fill="toself", fillcolor="rgba(128,128,128,0.15)",
                line=dict(width=0), showlegend=False,
                legendgroup=key, hoverinfo="skip",
            ),
            row=1, col=1,
        )
        hp_actual_indices.append(len(fig.data) - 1)

    # Damage and weapon bars (averaged with error bars)
    if not attack_df.empty:
        attack_df["attackerKey"] = (
            attack_df["attacker"].fillna("unknown")
            + " (" + attack_df["disposition_attacker"].map(disp_label) + ")"
            if "disposition_attacker" in attack_df.columns
            else attack_df["attacker"].fillna("unknown")
        )

        hits = attack_df[attack_df["hit"] == True].copy()  # noqa: E712
        add_damage_bars(fig, hits, "attackerKey", per_run=True)
        add_weapon_bars(fig, hits, "attackerKey", per_run=True)

    turn_min, turn_max = compute_turn_range(hp_stats["turn"], attack_df)
    apply_layout(
        fig, turn_min, turn_max,
        title=f"Combat Metrics — Averaged Over {n_runs} Runs",
        y1_label="Mean HP", y2_label="Mean Damage", y3_label="Mean Total Damage",
    )
    add_hp_mode_toggle(
        fig,
        hp_actual_indices,
        hp_pct_indices,
        hp_actual_label="Mean HP",
        hp_pct_label="Mean HP (%)",
    )
    fig.show()

def main():
    args = parse_args()
    paths = resolve_paths(args)
    n_runs = len(paths)
    avg_mode = n_runs > 1

    if avg_mode:
        print(f"Averaging over {n_runs} runs:", file=sys.stderr)
        for p in paths:
            print(f"  {p}", file=sys.stderr)
    else:
        print(f"Single run: {paths[0]}", file=sys.stderr)

    df = load_ndjson(paths)
    state_df = df[df["type"] == "state"].copy()
    attack_df = df[df["type"] == "attack"].copy()

    if avg_mode:
        chart_averaged(state_df, attack_df, n_runs)
    else:
        chart_single(state_df, attack_df)


if __name__ == "__main__":
    main()