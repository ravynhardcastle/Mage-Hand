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
from colorsys import hls_to_rgb, rgb_to_hls
from pathlib import Path

import pandas as pd
from plotly.subplots import make_subplots
import plotly.graph_objects as go
from plotly.colors import qualitative

DISP_LABELS = {1: "friendly", 0: "neutral", -1: "hostile", -2: "secret"}
CI_Z95, CI_Z99 = 1.96, 2.576
CI_ERROR_COLOR = "rgba(80,80,80,0.45)"
TEAM_KEYS = {"friendly", "hostile", "neutral", "secret", "other"}
TEAM_ORDER = ["friendly", "neutral", "hostile", "secret", "other"]
TEAM_LIGHTNESS_CYCLE = [0.53, 0.59, 0.65, 0.71, 0.57, 0.67]
TEAM_SATURATION_CYCLE = [0.78, 0.85, 0.92, 0.82, 0.89]
HIT_TRUE_VALUES = {"true", "t", "yes", "y", "1"}
YELLOW_LIME_LOW, YELLOW_LIME_HIGH = 50 / 360, 105 / 360


def parse_args():
    # on windows you have to do '--' but on linux it does that automatically so i just strip it here
    argv = [a for a in sys.argv[1:] if a != "--"]
    p = argparse.ArgumentParser(description="Chart combat log metrics")
    p.add_argument("files", nargs="*")
    p.add_argument("--last", type=int, metavar="N")
    p.add_argument("--dir", type=str, metavar="FOLDER")
    return p.parse_args(argv)


def resolve_paths(args) -> list[Path]:
    logs_dir = Path("logs")
    if args.dir:
        paths = sorted(Path(args.dir).glob("*.ndjson"), key=lambda p: p.stat().st_mtime)
        if not paths:
            print(f"No .ndjson files found in {args.dir}", file=sys.stderr)
            sys.exit(1)
        return paths
    if args.last:
        paths = sorted(logs_dir.glob("*.ndjson"), key=lambda p: p.stat().st_mtime, reverse=True)[: args.last]
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


def filter_hit_rows(df: pd.DataFrame, *, column: str = "hit") -> pd.DataFrame:
    if column not in df.columns:
        return df.iloc[0:0].copy()
    values = df[column]
    if pd.api.types.is_bool_dtype(values):
        return df[values.fillna(False)].copy()
    numeric = pd.to_numeric(values, errors="coerce")
    if numeric.notna().any():
        return df[numeric.fillna(0).ne(0)].copy()
    return df[values.astype(str).str.strip().str.lower().isin(HIT_TRUE_VALUES)].copy()


def _entity_team_key(label: str) -> str:
    if not isinstance(label, str) or "(" not in label or not label.endswith(")"):
        return "other"
    candidate = label.rsplit("(", 1)[-1].rstrip(")").strip().lower()
    return candidate if candidate in TEAM_KEYS else "other"


def _hls_rgb_string(h, l, s) -> str:
    r, g, b = hls_to_rgb(h % 1.0, max(0.0, min(1.0, l)), max(0.0, min(1.0, s)))
    return f"rgb({int(round(r * 255))},{int(round(g * 255))},{int(round(b * 255))})"


def _plotly_color_to_rgb(color: str):
    c = color.strip()
    if c.startswith("#") and len(c) == 7:
        return tuple(int(c[i : i + 2], 16) / 255 for i in (1, 3, 5))
    if c.startswith("rgb(") and c.endswith(")"):
        parts = c[4:-1].split(",")
        if len(parts) == 3:
            return tuple(float(p) / 255 for p in parts)
    return None


def _hues() -> list[float]:
    hues = []
    for color in qualitative.Plotly:
        rgb = _plotly_color_to_rgb(color)
        if rgb is None:
            continue
        hue, _, _ = rgb_to_hls(*rgb)
        if YELLOW_LIME_LOW <= hue <= YELLOW_LIME_HIGH:
            continue
        if all(abs(hue - h) > 0.035 for h in hues):
            hues.append(hue)
    return hues or [210 / 360, 350 / 360, 280 / 360, 180 / 360, 20 / 360]


def _avoid_yellow_lime(hue: float) -> float:
    h = hue % 1.0
    if YELLOW_LIME_LOW <= h <= YELLOW_LIME_HIGH:
        return YELLOW_LIME_LOW - 0.015 if (h - YELLOW_LIME_LOW) < (YELLOW_LIME_HIGH - h) else YELLOW_LIME_HIGH + 0.015
    return h


def build_entity_color_map(entity_labels: list[str]) -> dict[str, str]:
    by_team: dict[str, list[str]] = {}
    for label in sorted(entity_labels):
        by_team.setdefault(_entity_team_key(label), []).append(label)
    if not by_team:
        return {}
    color_map = {}
    base_hues = _hues()
    for team_idx, team_key in enumerate(t for t in TEAM_ORDER if t in by_team):
        labels = by_team[team_key]
        count = len(labels)
        base = base_hues[team_idx % len(base_hues)]
        band = min(0.48, 0.16 + 0.04 * max(0, count - 1))
        for i, label in enumerate(labels):
            hue = _avoid_yellow_lime(base if count == 1 else base + (i / (count - 1) - 0.5) * band)
            l = TEAM_LIGHTNESS_CYCLE[(i + team_idx) % len(TEAM_LIGHTNESS_CYCLE)]
            s = TEAM_SATURATION_CYCLE[(i * 2 + team_idx) % len(TEAM_SATURATION_CYCLE)]
            color_map[label] = _hls_rgb_string(hue, l, s)
    return color_map


def create_figure(subtitles):
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


def compute_round_range(hp_rounds, attack_df):
    all_rounds = hp_rounds if attack_df.empty else pd.concat([hp_rounds, attack_df["round"]])
    return (int(all_rounds.min()) if not all_rounds.empty else 0,
            int(all_rounds.max()) if not all_rounds.empty else 1)


def apply_layout(fig, round_min, round_max, *, title=None, y1_label="HP", y2_label="Damage", y3_label="Total Damage"):
    fig.update_layout(
        barmode="stack",
        title_text=title,
        xaxis_title="Round", xaxis2_title="Round",
        xaxis_range=[round_min - 0.5, round_max + 0.5],
        yaxis_title=y1_label, yaxis2_title=y2_label,
        xaxis3_title="Token", yaxis3_title=y3_label,
        hovermode="x unified",
        legend=dict(groupclick="togglegroup"),
    )


def add_hp_mode_toggle(fig, actual_indices, pct_indices, *, hp_actual_label="HP", hp_pct_label="HP (%)"):
    if not actual_indices or not pct_indices:
        return
    base = [getattr(t, "visible", True) is not False for t in fig.data]
    actual_vis, pct_vis = base.copy(), base.copy()
    for i in pct_indices:
        actual_vis[i] = False
    for i in actual_indices:
        actual_vis[i] = True
    for i in actual_indices:
        pct_vis[i] = False
    for i in pct_indices:
        pct_vis[i] = True
    menus = list(fig.layout.updatemenus) if fig.layout.updatemenus else []
    menus.append(dict(
        type="buttons", direction="left", x=1.0, y=1.01,
        xanchor="right", yanchor="bottom", active=0,
        buttons=[
            dict(label="HP %", method="update", args=[{"visible": pct_vis}, {"yaxis.title.text": hp_pct_label}]),
            dict(label="HP", method="update", args=[{"visible": actual_vis}, {"yaxis.title.text": hp_actual_label}]),
        ],
    ))
    fig.update_layout(updatemenus=menus)


def add_ci_level_toggle(
    fig, ci_trace_indices, ci95_polygons, ci99_polygons,
    row2_ci_trace_indices=None, row2_ci95_arrays=None, row2_ci99_arrays=None,
    row2_ci95_minus_arrays=None, row2_ci99_minus_arrays=None,
    row3_ci_trace_indices=None, row3_ci95_arrays=None, row3_ci99_arrays=None,
    row3_ci95_minus_arrays=None, row3_ci99_minus_arrays=None,
):
    if not ci_trace_indices:
        return
    r2 = row2_ci_trace_indices or []
    r3 = row3_ci_trace_indices or []
    r2_95 = row2_ci95_arrays or []
    r2_99 = row2_ci99_arrays or []
    r2_95m = row2_ci95_minus_arrays or []
    r2_99m = row2_ci99_minus_arrays or []
    r3_95 = row3_ci95_arrays or []
    r3_99 = row3_ci99_arrays or []
    r3_95m = row3_ci95_minus_arrays or []
    r3_99m = row3_ci99_minus_arrays or []
    all_ci = ci_trace_indices + r2 + r3

    def cur_y(indices):
        return [list(fig.data[i].y) if fig.data[i].y is not None else [] for i in indices]

    if r2 or r3:
        y95 = ci95_polygons + cur_y(r2) + cur_y(r3)
        y99 = ci99_polygons + cur_y(r2) + cur_y(r3)
        err95 = [None] * len(ci_trace_indices) + r2_95 + r3_95
        err99 = [None] * len(ci_trace_indices) + r2_99 + r3_99
        err95m = [None] * len(ci_trace_indices) + r2_95m + r3_95m
        err99m = [None] * len(ci_trace_indices) + r2_99m + r3_99m
    else:
        y95, y99 = ci95_polygons, ci99_polygons
        err95 = err99 = err95m = err99m = [None] * len(ci_trace_indices)

    menus = list(fig.layout.updatemenus) if fig.layout.updatemenus else []
    menus.append(dict(
        type="buttons", direction="left", x=0.88, y=1.01,
        xanchor="right", yanchor="bottom", active=0,
        buttons=[
            dict(label="95% CI", method="update", args=[{"y": y95, "error_y.array": err95, "error_y.arrayminus": err95m}, {}, all_ci]),
            dict(label="99% CI", method="update", args=[{"y": y99, "error_y.array": err99, "error_y.arrayminus": err99m}, {}, all_ci]),
        ],
    ))
    fig.update_layout(updatemenus=menus)


def classify_run_outcomes(state_df):
    required = {"run", "round", "tokenId", "disposition", "hp"}
    if not required.issubset(state_df.columns):
        return None
    snaps = state_df.dropna(subset=["hp", "disposition"]).copy()
    if snaps.empty:
        return None
    snaps["hp"] = pd.to_numeric(snaps["hp"], errors="coerce").fillna(0)
    snaps["tokenId"] = snaps["tokenId"].astype(str)
    # grab hpmax or highest hp if that doesnt exist cuz we're parsing an old log
    # realistically. it doesn't need to be logged but whatever
    snaps["hpMax_src"] = (
        pd.to_numeric(snaps["hpMax"], errors="coerce") if "hpMax" in snaps.columns else float("nan")
    )
    per_token = (
        snaps.sort_values(["run", "round"])
        .groupby(["run", "tokenId", "disposition"], as_index=False)
        .agg(hp_last=("hp", "last"), hp_seen_max=("hp", "max"), hp_max=("hpMax_src", "max"))
    )
    per_token["hp_max"] = per_token["hp_max"].fillna(per_token["hp_seen_max"])
    per_token["hp_max"] = per_token[["hp_max", "hp_last"]].max(axis=1)

    side = per_token.groupby(["run", "disposition"], as_index=False).agg(
        remaining=("hp_last", "sum"), total=("hp_max", "sum")
    )
    rem = side.pivot(index="run", columns="disposition", values="remaining").fillna(0)
    tot = side.pivot(index="run", columns="disposition", values="total").fillna(0)
    if rem.empty:
        return None
    for col in [1, -1]:
        if col not in rem.columns:
            rem[col] = 0
        if col not in tot.columns:
            tot[col] = 0

    f_alive, h_alive = rem[1] > 0, rem[-1] > 0
    f_pct = rem[1] / tot[1].replace(0, float("nan"))
    h_pct = rem[-1] / tot[-1].replace(0, float("nan"))

    result = pd.DataFrame({"run": rem.index.astype(int)})
    result["outcome"] = "draw"
    result["resolved_by_hp"] = False

    dec_f = (f_alive & ~h_alive).values
    dec_h = (h_alive & ~f_alive).values
    result.loc[dec_f, "outcome"] = "friendly"
    result.loc[dec_h, "outcome"] = "hostile"

    # remaining hp determines winners for draws
    both = (f_alive & h_alive).values
    res_f = both & (f_pct > h_pct).values
    res_h = both & (h_pct > f_pct).values
    res_tie = both & ~res_f & ~res_h
    result.loc[res_f, "outcome"] = "friendly"
    result.loc[res_h, "outcome"] = "hostile"
    result.loc[both, "resolved_by_hp"] = True
    result.loc[res_tie, "outcome"] = "draw"

    return result[["run", "outcome", "resolved_by_hp"]]


def add_winrate_annotation(fig, state_df):
    outcomes_df = classify_run_outcomes(state_df)
    if outcomes_df is None or outcomes_df.empty:
        return
    counts = outcomes_df["outcome"].value_counts()
    total = len(outcomes_df)

    def fmt(key):
        n = int(counts.get(key, 0))
        return f"{100 * n / total:.1f}% ({n}/{total})", n

    fw_str, _ = fmt("friendly")
    hw_str, _ = fmt("hostile")
    draw_str, draws = fmt("draw")
    unr_str, unr = fmt("unresolved")
    summary = f"Friendly Wins: {fw_str} | Hostile Wins: {hw_str}"
    if draws:
        summary += f" | Draws: {draw_str}"
    if unr:
        summary += f" | Unresolved: {unr_str}"
    fig.add_annotation(x=0, y=1.01, xref="paper", yref="paper",
                       xanchor="left", yanchor="bottom", showarrow=False, align="left", text=summary)


def add_damage_bars(
    fig, hits, label_col, *, per_run=False, color_map=None, showlegend=True,
    legendgroup_prefix=None,
    row2_ci_trace_indices=None, row2_ci95_arrays=None, row2_ci99_arrays=None,
    row2_ci95_minus_arrays=None, row2_ci99_minus_arrays=None,
):
    added = []
    if hits.empty:
        return added
    if per_run:
        dmg = (
            hits.groupby(["run", "round", label_col], as_index=False)
            .agg(totalDamage=("damageDealt", "sum"))
            .groupby(["round", label_col], as_index=False)
            .agg(y=("totalDamage", "mean"), std=("totalDamage", "std"), n=("totalDamage", "count"))
        )
        dmg["std"] = dmg["std"].fillna(0)
        dmg["ci95"] = CI_Z95 * dmg["std"] / dmg["n"] ** 0.5
        dmg["ci99"] = CI_Z99 * dmg["std"] / dmg["n"] ** 0.5
    else:
        dmg = hits.groupby(["round", label_col], as_index=False).agg(y=("damageDealt", "sum"))
    for attacker in sorted(dmg[label_col].unique()):
        sub = dmg[dmg[label_col] == attacker].sort_values("round")
        ci95p = sub["ci95"].tolist() if per_run else []
        ci99p = sub["ci99"].tolist() if per_run else []
        ci95m = sub[["ci95", "y"]].min(axis=1).tolist() if per_run else []
        ci99m = sub[["ci99", "y"]].min(axis=1).tolist() if per_run else []
        fig.add_trace(go.Bar(
            x=sub["round"], y=sub["y"],
            error_y=(dict(type="data", array=ci95p, arrayminus=ci95m, symmetric=False, visible=True, color=CI_ERROR_COLOR) if per_run else None),
            name=attacker,
            legendgroup=(f"{legendgroup_prefix}{attacker}" if legendgroup_prefix else f"dmg_{attacker}"),
            marker_color=color_map.get(attacker) if color_map else None,
            showlegend=showlegend,
            customdata=list(zip(ci95p, ci95m, ci99p, ci99m)) if per_run else None,
            hovertemplate=(
                "%{x}<br>%{fullData.name}: %{y:.1f} dmg"
                "<br>95% CI: +%{customdata[0]:.1f}/-%{customdata[1]:.1f}"
                "<br>99% CI: +%{customdata[2]:.1f}/-%{customdata[3]:.1f}"
                "<extra></extra>"
            ) if per_run else None,
        ), row=2, col=1)
        added.append(len(fig.data) - 1)
        if per_run and all(x is not None for x in [row2_ci_trace_indices, row2_ci95_arrays, row2_ci99_arrays, row2_ci95_minus_arrays, row2_ci99_minus_arrays]):
            row2_ci_trace_indices.append(len(fig.data) - 1)
            row2_ci95_arrays.append(ci95p)
            row2_ci99_arrays.append(ci99p)
            row2_ci95_minus_arrays.append(ci95m)
            row2_ci99_minus_arrays.append(ci99m)
    return added


def add_weapon_bars(
    fig, hits, label_col, *, per_run=False, weapon_color_map=None, showlegend=True,
    legendgroup_prefix=None,
    row3_ci_trace_indices=None, row3_ci95_arrays=None, row3_ci99_arrays=None,
    row3_ci95_minus_arrays=None, row3_ci99_minus_arrays=None,
):
    added = []
    if hits.empty:
        return added
    if per_run:
        run_totals = hits.groupby(["run", label_col, "weapon"], as_index=False).agg(
            totalDamage=("damageDealt", "sum"), hitCount=("damageDealt", "count")
        )
        by_weapon = run_totals.groupby([label_col, "weapon"], as_index=False).agg(
            y=("totalDamage", "mean"), std=("totalDamage", "std"),
            n=("totalDamage", "count"), hits_label=("hitCount", "mean"),
        )
        by_weapon["std"] = by_weapon["std"].fillna(0)
        by_weapon["ci95"] = CI_Z95 * by_weapon["std"] / by_weapon["n"] ** 0.5
        by_weapon["ci99"] = CI_Z99 * by_weapon["std"] / by_weapon["n"] ** 0.5
        by_weapon["hits_label"] = by_weapon["hits_label"].round(1).astype(str) + " hits/run"
        hover_tpl = (
            "%{x}<br>%{fullData.name}: %{y:.1f} dmg (%{text})"
            "<br>95% CI: +%{customdata[0]:.1f}/-%{customdata[1]:.1f}"
            "<br>99% CI: +%{customdata[2]:.1f}/-%{customdata[3]:.1f}"
            "<extra></extra>"
        )
    else:
        by_weapon = hits.groupby([label_col, "weapon"], as_index=False).agg(
            y=("damageDealt", "sum"), hitCount=("damageDealt", "count")
        )
        by_weapon["hits_label"] = by_weapon["hitCount"].astype(str) + " hits"
        hover_tpl = "%{x}<br>%{fullData.name}: %{y} dmg (%{text})<extra></extra>"
    by_weapon = by_weapon.sort_values([label_col, "weapon"])
    cumulative: dict[str, float] = {}
    shown_weapons: set[str] = set()
    for _, row in by_weapon.iterrows():
        label, weapon = row[label_col], row["weapon"]
        lgroup = f"{legendgroup_prefix}{label}" if legendgroup_prefix else f"wpn_{weapon}"
        ci95p = [row["ci95"]] if per_run else []
        ci99p = [row["ci99"]] if per_run else []
        ci95m = [min(row["ci95"], row["y"])] if per_run else []
        ci99m = [min(row["ci99"], row["y"])] if per_run else []
        cumulative[str(label)] = cumulative.get(str(label), 0.0) + float(row["y"])
        fig.add_trace(go.Bar(
            x=[label], y=[row["y"]], name=weapon,
            text=[row["hits_label"]], hovertemplate=hover_tpl,
            customdata=[[ci95p[0], ci95m[0], ci99p[0], ci99m[0]]] if per_run else None,
            marker_color=weapon_color_map.get(weapon) if weapon_color_map else None,
            legendgroup=lgroup,
            showlegend=(showlegend and weapon not in shown_weapons),
        ), row=3, col=1)
        shown_weapons.add(str(weapon))
        added.append(len(fig.data) - 1)
        if per_run:
            fig.add_trace(go.Scatter(
                x=[label], y=[cumulative[str(label)]],
                mode="markers", marker=dict(size=1, opacity=0),
                error_y=dict(type="data", array=ci95p, arrayminus=ci95m,
                             symmetric=False, visible=True, color=CI_ERROR_COLOR),
                hoverinfo="skip", showlegend=False, legendgroup=lgroup, name=weapon,
            ), row=3, col=1)
            added.append(len(fig.data) - 1)
            if all(x is not None for x in [row3_ci_trace_indices, row3_ci95_arrays, row3_ci99_arrays, row3_ci95_minus_arrays, row3_ci99_minus_arrays]):
                row3_ci_trace_indices.append(len(fig.data) - 1)
                row3_ci95_arrays.append(ci95p)
                row3_ci99_arrays.append(ci99p)
                row3_ci95_minus_arrays.append(ci95m)
                row3_ci99_minus_arrays.append(ci99m)
    return added


def chart_single(state_df, attack_df):
    state_df["tokenId"] = state_df["tokenId"].astype(str)
    state_df["tokenLabel"] = (
        state_df["name"].fillna("token") + ":"
        + state_df["tokenId"].str.slice(0, 6)
        + " (disp=" + state_df["disposition"].astype(str) + ")"
    )
    hp = state_df.dropna(subset=["hp"]).copy()
    hp["hp"] = pd.to_numeric(hp["hp"], errors="coerce")
    hp = (
        hp.sort_values(["round"])
        .groupby(["round", "tokenId", "tokenLabel"], as_index=False)
        .agg(hp=("hp", "last"))
    )
    hp_max = hp.groupby("tokenId")["hp"].transform("max")
    hp["hpPct"] = (hp["hp"] / hp_max.replace(0, float("nan")) * 100).fillna(0)

    fig = create_figure(("HP Over Time", "Damage Dealt Per Round", "Total Damage by Token & Weapon"))
    hp_actual_indices, hp_pct_indices = [], []

    for label in hp["tokenLabel"].unique():
        sub = hp[hp["tokenLabel"] == label]
        fig.add_trace(go.Scatter(x=sub["round"], y=sub["hpPct"], mode="lines", name=label,
                                 line_shape="hv", legendgroup=label), row=1, col=1)
        hp_pct_indices.append(len(fig.data) - 1)
        fig.add_trace(go.Scatter(x=sub["round"], y=sub["hp"], mode="lines", name=label,
                                 line_shape="hv", legendgroup=label, visible=False), row=1, col=1)
        hp_actual_indices.append(len(fig.data) - 1)

    if not attack_df.empty:
        hits = filter_hit_rows(attack_df)
        if not hits.empty:
            hits["targetTokenId"] = hits["targetTokenId"].astype(str)
            hits["round"] = hits["round"].astype(int)
            hits["hoverText"] = (
                hits["attacker"] + " → " + hits["targetName"]
                + " (" + hits["weapon"] + ")"
                + "<br>" + hits["kind"].fillna("action")
                + " | dmg=" + hits["damageDealt"].astype(str)
                + " atk=" + hits["attackTotal"].astype(str)
                + hits["isCritical"].apply(lambda c: " CRIT" if c else "")
            )
            hits_sorted = pd.merge_asof(
                hits.sort_values("round"),
                hp[["round", "tokenId", "hp"]].sort_values("round").rename(columns={"tokenId": "_tkId"}),
                on="round", left_by="targetTokenId", right_by="_tkId",
                direction="backward", suffixes=("", "_state"),
            ).dropna(subset=["hp_state", "round"])
            hits_sorted_pct = pd.merge_asof(
                hits.sort_values("round"),
                hp[["round", "tokenId", "hpPct"]].sort_values("round").rename(columns={"tokenId": "_tkId", "hpPct": "hpPct_state"}),
                on="round", left_by="targetTokenId", right_by="_tkId",
                direction="backward",
            ).dropna(subset=["hpPct_state", "round"])

            marker = dict(symbol="x", size=10, color="red", line=dict(width=1))
            fig.add_trace(go.Scatter(
                x=hits_sorted_pct["round"], y=hits_sorted_pct["hpPct_state"], mode="markers",
                marker=marker, name="Hits", text=hits_sorted_pct["hoverText"],
                hoverinfo="text+x+y", showlegend=True, legendgroup="__hits",
            ), row=1, col=1)
            hp_pct_indices.append(len(fig.data) - 1)
            fig.add_trace(go.Scatter(
                x=hits_sorted["round"], y=hits_sorted["hp_state"], mode="markers",
                marker=marker, name="Hits", text=hits_sorted["hoverText"],
                hoverinfo="text+x+y", showlegend=True, legendgroup="__hits", visible=False,
            ), row=1, col=1)
            hp_actual_indices.append(len(fig.data) - 1)

        attack_df["attackerLabel"] = (
            attack_df["attacker"].fillna("unknown") + ":"
            + attack_df["attackerId"].astype(str).str.slice(0, 6)
        )
        add_damage_bars(fig, hits, "attackerLabel")
        add_weapon_bars(fig, hits, "attackerLabel")

    round_min, round_max = compute_round_range(hp["round"], attack_df)
    apply_layout(fig, round_min, round_max, y1_label="HP (%)")
    add_winrate_annotation(fig, state_df)
    add_hp_mode_toggle(fig, hp_actual_indices, hp_pct_indices)
    fig.show()


def _add_hit_markers(fig, hits, hp_sub, *, outcome_key, visible, hp_pct_bucket, hp_actual_bucket):
    """Add red-X hit markers anchored to the HP curve for single-run filters."""
    hits = hits.copy()
    hits["targetTokenId"] = hits["targetTokenId"].astype(str)
    hits["round"] = hits["round"].astype(int)
    hits["hoverText"] = (
        hits["attacker"].fillna("?") + " \u2192 " + hits["targetName"].fillna("?")
        + " (" + hits["weapon"].fillna("?") + ")"
        + "<br>" + hits["kind"].fillna("action")
        + " | dmg=" + hits["damageDealt"].astype(str)
        + " atk=" + hits["attackTotal"].astype(str)
        + hits["isCritical"].apply(lambda c: " CRIT" if c else "")
    )
    hp_max = hp_sub.groupby("tokenId")["hp"].transform("max")
    hp_sub = hp_sub.assign(hpPct=(hp_sub["hp"] / hp_max.replace(0, float("nan")) * 100).fillna(0))

    hits_actual = pd.merge_asof(
        hits.sort_values("round"),
        hp_sub[["round", "tokenId", "hp"]].sort_values("round").rename(columns={"tokenId": "_tkId"}),
        on="round", left_by="targetTokenId", right_by="_tkId",
        direction="backward", suffixes=("", "_state"),
    ).dropna(subset=["hp", "round"])
    hits_pct = pd.merge_asof(
        hits.sort_values("round"),
        hp_sub[["round", "tokenId", "hpPct"]].sort_values("round").rename(columns={"tokenId": "_tkId"}),
        on="round", left_by="targetTokenId", right_by="_tkId",
        direction="backward",
    ).dropna(subset=["hpPct", "round"])

    marker = dict(symbol="x", size=10, color="red", line=dict(width=1))
    fig.add_trace(go.Scatter(
        x=hits_pct["round"], y=hits_pct["hpPct"], mode="markers",
        marker=marker, name="Hits", text=hits_pct["hoverText"],
        hoverinfo="text+x+y", showlegend=True,
        legendgroup=f"{outcome_key}::__hits", visible=visible,
    ), row=1, col=1)
    hp_pct_bucket.append(len(fig.data) - 1)
    fig.add_trace(go.Scatter(
        x=hits_actual["round"], y=hits_actual["hp"], mode="markers",
        marker=marker, name="Hits", text=hits_actual["hoverText"],
        hoverinfo="text+x+y", showlegend=True,
        legendgroup=f"{outcome_key}::__hits", visible=False,
    ), row=1, col=1)
    hp_actual_bucket.append(len(fig.data) - 1)


def chart_averaged(state_df, attack_df, n_runs):
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
    hp_max = hp.groupby(["run", "entityKey"])["hp"].transform("max")
    hp["hpPct"] = (hp["hp"] / hp_max.replace(0, float("nan")) * 100).fillna(0)

    attack_df = attack_df.copy()
    if not attack_df.empty:
        attack_df["attackerId"] = attack_df["attackerId"].astype(str)
        attacker_lookup = (
            state_df.sort_values(["run", "round"])
            .groupby(["run", "tokenId"], as_index=False)
            .agg(entityKey=("entityKey", "last"))
            .rename(columns={"tokenId": "attackerId"})
        )
        attack_df = attack_df.merge(attacker_lookup, on=["run", "attackerId"], how="left")
        fallback = (
            attack_df["attacker"].fillna("unknown")
            + " (" + attack_df["disposition_attacker"].map(lambda d: DISP_LABELS.get(int(d), str(d))) + ")"
            if "disposition_attacker" in attack_df.columns
            else attack_df["attacker"].fillna("unknown")
        )
        attack_df["attackerKey"] = attack_df["entityKey"].fillna(fallback)
        attack_df = attack_df.drop(columns=["entityKey"])

    color_labels = sorted(hp["entityKey"].dropna().unique().tolist())
    if not attack_df.empty and "attackerKey" in attack_df.columns:
        color_labels = sorted(set(color_labels) | set(attack_df["attackerKey"].dropna().unique()))
    entity_colors = build_entity_color_map(color_labels)

    palette = qualitative.Plotly
    weapon_labels = sorted(attack_df["weapon"].dropna().unique()) if not attack_df.empty and "weapon" in attack_df.columns else []
    weapon_colors = {label: palette[i % len(palette)] for i, label in enumerate(weapon_labels)}

    def build_hp_stats(hp_sub):
        def stats(col):
            s = hp_sub.groupby(["round", "entityKey"], as_index=False).agg(
                hp_mean=(col, "mean"), hp_std=(col, "std"), hp_count=(col, "count")
            )
            s["hp_std"] = s["hp_std"].fillna(0)
            s["hp_ci95"] = CI_Z95 * s["hp_std"] / s["hp_count"] ** 0.5
            s["hp_ci99"] = CI_Z99 * s["hp_std"] / s["hp_count"] ** 0.5
            return s
        return stats("hp"), stats("hpPct")

    outcomes = classify_run_outcomes(state_df)
    all_runs = sorted(hp["run"].unique().tolist())
    run_groups = {"all": all_runs}
    if outcomes is not None and not outcomes.empty:
        for k in ["friendly", "hostile", "draw", "unresolved"]:
            run_groups[k] = sorted(outcomes.loc[outcomes["outcome"] == k, "run"].astype(int).tolist())
    else:
        run_groups.update({"friendly": [], "hostile": [], "draw": [], "unresolved": []})
    available_outcomes = ["all"] + [k for k in ["friendly", "hostile", "draw", "unresolved"] if run_groups.get(k)]

    fig = create_figure((
        f"Mean HP Over Time (n={n_runs} runs)",
        f"Mean Damage Dealt Per Round (n={n_runs} runs)",
        f"Mean Total Damage by Token & Weapon (n={n_runs} runs)",
    ))

    hp_actual_by = {k: [] for k in available_outcomes}
    hp_pct_by = {k: [] for k in available_outcomes}
    non_hp_by = {k: [] for k in available_outcomes}
    row3_by = {k: [] for k in available_outcomes}
    row2_ci_idxs, row2_ci95, row2_ci99, row2_ci95m, row2_ci99m = [], [], [], [], []
    row3_ci_idxs, row3_ci95, row3_ci99, row3_ci95m, row3_ci99m = [], [], [], [], []
    ci_trace_indices, ci95_polygons, ci99_polygons = [], [], []

    def add_hp_traces(hp_stats, *, key, outcome_key, visible, is_pct, bucket):
        sub = hp_stats[hp_stats["entityKey"] == key].sort_values("round")
        rounds, mean, ci95, ci99 = sub["round"], sub["hp_mean"], sub["hp_ci95"], sub["hp_ci99"]
        cap = 100 if is_pct else None
        ci95_upper = (mean + ci95).clip(upper=cap)
        ci95_lower = (mean - ci95).clip(lower=0)
        ci99_upper = (mean + ci99).clip(upper=cap)
        ci99_lower = (mean - ci99).clip(lower=0)
        ci95_poly = pd.concat([ci95_upper, ci95_lower.iloc[::-1]])
        ci99_poly = pd.concat([ci99_upper, ci99_lower.iloc[::-1]])
        pct_sfx = "%" if is_pct else ""
        fig.add_trace(go.Scatter(
            x=rounds, y=mean, mode="lines", name=key, line_shape="hv",
            line=dict(color=entity_colors.get(key)),
            customdata=list(zip((ci95_upper - mean).tolist(), (mean - ci95_lower).tolist(),
                                (ci99_upper - mean).tolist(), (mean - ci99_lower).tolist())),
            hovertemplate=(
                f"%{{x}}<br>%{{fullData.name}}: %{{y:.1f}}{pct_sfx}"
                "<br>95% CI: +%{customdata[0]:.1f}/-%{customdata[1]:.1f}"
                "<br>99% CI: +%{customdata[2]:.1f}/-%{customdata[3]:.1f}"
                "<extra></extra>"
            ),
            legendgroup=f"{outcome_key}::{key}", visible=visible,
        ), row=1, col=1)
        bucket.append(len(fig.data) - 1)
        fig.add_trace(go.Scatter(
            x=pd.concat([rounds, rounds[::-1]]), y=ci95_poly,
            mode="lines",
            fill="toself", fillcolor="rgba(128,128,128,0.15)", line=dict(width=0),
            name="CI band", showlegend=False, legendgroup=f"{outcome_key}::{key}",
            hoverinfo="skip", visible=visible,
        ), row=1, col=1)
        bucket.append(len(fig.data) - 1)
        ci_trace_indices.append(len(fig.data) - 1)
        ci95_polygons.append(ci95_poly.tolist())
        ci99_polygons.append(ci99_poly.tolist())

    for outcome_key in available_outcomes:
        runs = run_groups[outcome_key]
        hp_sub = hp[hp["run"].isin(runs)].copy()
        if hp_sub.empty:
            continue
        hp_stats, hp_stats_pct = build_hp_stats(hp_sub)
        default_vis = outcome_key == "all"
        for key in sorted(hp_stats["entityKey"].unique()):
            add_hp_traces(hp_stats_pct, key=key, outcome_key=outcome_key,
                          visible=default_vis, is_pct=True, bucket=hp_pct_by[outcome_key])
            add_hp_traces(hp_stats, key=key, outcome_key=outcome_key,
                          visible=False, is_pct=False, bucket=hp_actual_by[outcome_key])
        if not attack_df.empty:
            attack_sub = attack_df[attack_df["run"].isin(runs)].copy()
            if not attack_sub.empty:
                hits = filter_hit_rows(attack_sub)
                if len(runs) == 1 and not hits.empty:
                    _add_hit_markers(
                        fig, hits, hp_sub,
                        outcome_key=outcome_key, visible=default_vis,
                        hp_pct_bucket=hp_pct_by[outcome_key],
                        hp_actual_bucket=hp_actual_by[outcome_key],
                    )
                non_hp_by[outcome_key].extend(add_damage_bars(
                    fig, hits, "attackerKey", per_run=True, color_map=entity_colors,
                    showlegend=False, legendgroup_prefix=f"{outcome_key}::",
                    row2_ci_trace_indices=row2_ci_idxs, row2_ci95_arrays=row2_ci95,
                    row2_ci99_arrays=row2_ci99, row2_ci95_minus_arrays=row2_ci95m,
                    row2_ci99_minus_arrays=row2_ci99m,
                ))
                r3 = add_weapon_bars(
                    fig, hits, "attackerKey", per_run=True, weapon_color_map=weapon_colors,
                    showlegend=False, legendgroup_prefix=f"{outcome_key}::",
                    row3_ci_trace_indices=row3_ci_idxs, row3_ci95_arrays=row3_ci95,
                    row3_ci99_arrays=row3_ci99, row3_ci95_minus_arrays=row3_ci95m,
                    row3_ci99_minus_arrays=row3_ci99m,
                )
                row3_by[outcome_key].extend(r3)
                non_hp_by[outcome_key].extend(r3)
                if not default_vis:
                    for idx in non_hp_by[outcome_key]:
                        fig.data[idx].visible = False

    round_min, round_max = compute_round_range(hp["round"], attack_df)
    apply_layout(fig, round_min, round_max,
                 title=f"D&D Combat Metrics over {n_runs} Runs",
                 y1_label="Mean HP (%)", y2_label="Mean Damage", y3_label="Mean Total Damage")

    for text, y in [("Shaded = CI", 0.953), ("Whiskers = CI", 0.49), ("Whiskers = CI", 0.14)]:
        fig.add_annotation(x=0.995, y=y, xref="paper", yref="paper",
                           xanchor="right", yanchor="bottom", showarrow=False, align="right",
                           text=text, bgcolor="rgba(255,255,255,0.5)",
                           bordercolor="rgba(120,120,120,0.5)", borderwidth=1, borderpad=4,
                           font=dict(size=11, color="rgba(60,60,60,1)"))
    add_winrate_annotation(fig, state_df)

    total = len(fig.data)
    outcome_labels = {"all": "All", "friendly": "Friendly Wins", "hostile": "Hostile Wins",
                      "draw": "Draws", "unresolved": "Unresolved"}
    vis_by = {}
    round_range_by = {}
    for outcome_key in available_outcomes:
        runs = run_groups[outcome_key]
        atk_sub = attack_df[attack_df["run"].isin(runs)] if not attack_df.empty else attack_df
        round_range_by[outcome_key] = compute_round_range(hp[hp["run"].isin(runs)]["round"], atk_sub)
        base = non_hp_by[outcome_key]
        vis_actual = [False] * total
        for i in base + hp_actual_by[outcome_key]:
            vis_actual[i] = True
        vis_pct = [False] * total
        for i in base + hp_pct_by[outcome_key]:
            vis_pct[i] = True
        vis_by[outcome_key] = {"hp": vis_actual, "hp_pct": vis_pct}

    menus = list(fig.layout.updatemenus) if fig.layout.updatemenus else []
    base_menu_idx = len(menus)
    outcome_hp_dd = base_menu_idx
    outcome_pct_dd = base_menu_idx + 1
    hp_mode_start = base_menu_idx + 2
    hp_mode_menus = {k: hp_mode_start + i for i, k in enumerate(available_outcomes)}
    hp_active = {f"updatemenus[{i}].active": 1 for i in hp_mode_menus.values()}
    pct_active = {f"updatemenus[{i}].active": 0 for i in hp_mode_menus.values()}

    outcome_buttons_hp, outcome_buttons_pct = [], []
    for outcome_key in available_outcomes:
        rmin, rmax = round_range_by[outcome_key]
        range_args = {"xaxis.range": [rmin - 0.5, rmax + 0.5],
                      "xaxis2.range": [rmin - 0.5, rmax + 0.5], "xaxis3.autorange": True}
        menu_vis = {f"updatemenus[{v}].visible": (k == outcome_key) for k, v in hp_mode_menus.items()}
        outcome_buttons_hp.append(dict(
            label=outcome_labels[outcome_key], method="update",
            args=[{"visible": vis_by[outcome_key]["hp"]}, {
                **hp_active, **range_args, "yaxis.title.text": "Mean HP",
                f"updatemenus[{outcome_hp_dd}].visible": True,
                f"updatemenus[{outcome_pct_dd}].visible": False,
                **menu_vis,
            }],
        ))
        outcome_buttons_pct.append(dict(
            label=outcome_labels[outcome_key], method="update",
            args=[{"visible": vis_by[outcome_key]["hp_pct"]}, {
                **pct_active, **range_args, "yaxis.title.text": "Mean HP (%)",
                f"updatemenus[{outcome_hp_dd}].visible": False,
                f"updatemenus[{outcome_pct_dd}].visible": True,
                **menu_vis,
            }],
        ))

    for vis, buttons in [(False, outcome_buttons_hp), (True, outcome_buttons_pct)]:
        menus.append(dict(
            type="dropdown", direction="down", x=0.74, y=1.01,
            xanchor="right", yanchor="bottom", active=0, visible=vis, buttons=buttons,
        ))

    all_row3 = [i for k in available_outcomes for i in row3_by[k]]
    weapon_filter_buttons = [dict(
        label="All Weapons", method="restyle",
        args=[{"y": [list(fig.data[i].y) if fig.data[i].y is not None else [] for i in all_row3]}, all_row3],
    )]
    for weapon in sorted(weapon_colors):
        weapon_filter_buttons.append(dict(
            label=weapon, method="restyle",
            args=[{"y": [
                list(fig.data[i].y) if fig.data[i].name == weapon else [None] * len(fig.data[i].y)
                for i in all_row3
            ]}, all_row3],
        ))

    for outcome_key in available_outcomes:
        menus.append(dict(
            type="buttons", direction="left", x=1.0, y=1.01,
            xanchor="right", yanchor="bottom",
            visible=(outcome_key == "all"), active=0,
            buttons=[
                dict(label="HP %", method="update", args=[
                    {"visible": vis_by[outcome_key]["hp_pct"]},
                    {**pct_active, "yaxis.title.text": "Mean HP (%)",
                     f"updatemenus[{outcome_hp_dd}].visible": False,
                     f"updatemenus[{outcome_pct_dd}].visible": True},
                ]),
                dict(label="HP", method="update", args=[
                    {"visible": vis_by[outcome_key]["hp"]},
                    {**hp_active, "yaxis.title.text": "Mean HP",
                     f"updatemenus[{outcome_hp_dd}].visible": True,
                     f"updatemenus[{outcome_pct_dd}].visible": False},
                ]),
            ],
        ))

    if all_row3:
        menus.append(dict(
            type="dropdown", direction="down", x=1.0, y=0.2,
            xanchor="right", yanchor="bottom", active=0,
            buttons=weapon_filter_buttons,
        ))

    fig.update_layout(updatemenus=menus)
    add_ci_level_toggle(
        fig, ci_trace_indices, ci95_polygons, ci99_polygons,
        row2_ci_trace_indices=row2_ci_idxs, row2_ci95_arrays=row2_ci95,
        row2_ci99_arrays=row2_ci99, row2_ci95_minus_arrays=row2_ci95m,
        row2_ci99_minus_arrays=row2_ci99m,
        row3_ci_trace_indices=row3_ci_idxs, row3_ci95_arrays=row3_ci95,
        row3_ci99_arrays=row3_ci99, row3_ci95_minus_arrays=row3_ci95m,
        row3_ci99_minus_arrays=row3_ci99m,
    )
    fig.show()


def disambiguate_duplicate_names(state_df, attack_df):
    if state_df.empty:
        return state_df, attack_df
    state_df = state_df.copy()
    state_df["name"] = state_df["name"].fillna("token")
    state_df["tokenId"] = state_df["tokenId"].astype(str)

    distinct = state_df[["run", "name", "disposition", "tokenId"]].drop_duplicates()
    rename: dict[tuple, str] = {}
    for (run, name, disp), grp in distinct.groupby(["run", "name", "disposition"], sort=False):
        tids = sorted(grp["tokenId"].unique())
        if len(tids) <= 1:
            continue
        for i, tid in enumerate(tids, start=1):
            rename[(run, tid)] = f"{name} #{i}"

    if not rename:
        return state_df, attack_df

    key = list(zip(state_df["run"], state_df["tokenId"]))
    state_df["name"] = [rename.get(k, n) for k, n in zip(key, state_df["name"])]

    if not attack_df.empty and "attackerId" in attack_df.columns:
        attack_df = attack_df.copy()
        attack_df["attackerId"] = attack_df["attackerId"].astype(str)
        akey = list(zip(attack_df["run"], attack_df["attackerId"]))
        attack_df["attacker"] = [
            rename.get(k, a) for k, a in zip(akey, attack_df["attacker"].fillna("unknown"))
        ]
    return state_df, attack_df


def main():
    args = parse_args()
    paths = resolve_paths(args)
    n_runs = len(paths)
    if n_runs > 1:
        print(f"Averaging over {n_runs} runs:", file=sys.stderr)
        for p in paths:
            print(f"  {p}", file=sys.stderr)
    else:
        print(f"Single run: {paths[0]}", file=sys.stderr)
    df = load_ndjson(paths)
    state_df = df[df["type"] == "state"].copy()
    attack_df = df[df["type"] == "attack"].copy()
    # encounter rows dont have round so Be Careful
    if "round" in state_df.columns:
        state_df["round"] = state_df["round"].astype(int)
    state_df, attack_df = disambiguate_duplicate_names(state_df, attack_df)
    if n_runs > 1:
        chart_averaged(state_df, attack_df, n_runs)
    else:
        chart_single(state_df, attack_df)


if __name__ == "__main__":
    main()