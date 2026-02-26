import sys
from pathlib import Path

import pandas as pd
import plotly.express as px
from plotly.subplots import make_subplots
import plotly.graph_objects as go

if len(sys.argv) > 1:
    log_path = sys.argv[1]
else:
    logs_dir = Path("logs")
    log_path = str(max(logs_dir.glob("*.ndjson"), key=lambda p: p.stat().st_mtime))

df = pd.read_json(log_path, lines=True)

# Split by row type (backwards-compatible: rows without 'type' are treated as state)
if "type" not in df.columns:
    df["type"] = "state"
df["type"] = df["type"].fillna("state")

state_df = df[df["type"] == "state"].copy()
attack_df = df[df["type"] == "attack"].copy()

# ── HP chart ──────────────────────────────────────────────────────
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

fig = make_subplots(
    rows=3, cols=1,
    shared_xaxes=False,
    vertical_spacing=0.12,
    subplot_titles=("HP Over Time", "Damage Dealt Per Turn", "Total Damage by Entity & Weapon"),
    row_heights=[0.45, 0.3, 0.25],
    specs=[[{"type": "scatter"}], [{"type": "bar"}], [{"type": "bar"}]],
)

# Link x-axes of rows 1 & 2 so they share the same horizontal scale
fig.update_layout(xaxis2=dict(matches="x", showticklabels=True))

# HP lines
for label in hp["tokenLabel"].unique():
    subset = hp[hp["tokenLabel"] == label]
    fig.add_trace(
        go.Scatter(
            x=subset["turn"],
            y=subset["hp"],
            mode="lines",
            name=label,
            line_shape="hv",
            legendgroup=label,
        ),
        row=1, col=1,
    )

# ── Attack event markers on HP chart ──────────────────────────────
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

        # Place markers at the target's HP at that turn (use merge_asof to
        # find the most recent HP snapshot at or before the hit turn)
        hp_lookup = (
            hp[["turn", "tokenId", "hp"]]
            .sort_values("turn")
        )
        hits_sorted = hits.sort_values("turn")
        hits_sorted = pd.merge_asof(
            hits_sorted,
            hp_lookup.rename(columns={"tokenId": "_tkId"}),
            on="turn",
            left_by="targetTokenId",
            right_by="_tkId",
            direction="backward",
            suffixes=("", "_state"),
        )

        hits_sorted = hits_sorted.dropna(subset=["hp_state", "turn"])

        if not hits_sorted.empty:
            fig.add_trace(
                go.Scatter(
                    x=hits_sorted["turn"],
                    y=hits_sorted["hp_state"],
                    mode="markers",
                    marker=dict(symbol="x", size=10, color="red", line=dict(width=1)),
                    name="Hits",
                    text=hits_sorted["hoverText"],
                    hoverinfo="text+x+y",
                    showlegend=True,
                    legendgroup="__hits",
                ),
                row=1, col=1,
            )
        else:
            # No HP data matched; still show hits in the legend at y=0
            fig.add_trace(
                go.Scatter(
                    x=hits["turn"],
                    y=[0] * len(hits),
                    mode="markers",
                    marker=dict(symbol="x", size=10, color="red", line=dict(width=1)),
                    name="Hits",
                    text=hits["hoverText"],
                    hoverinfo="text+x+y",
                    showlegend=True,
                    legendgroup="__hits",
                ),
                row=1, col=1,
            )

    # ── Damage bar chart ──────────────────────────────────────────
    attack_df["attackerLabel"] = (
        attack_df["attacker"].fillna("unknown")
        + ":" + attack_df["attackerId"].astype(str).str.slice(0, 6)
    )
    dmg_per_turn = (
        attack_df[attack_df["hit"] == True]  # noqa: E712
        .groupby(["turn", "attackerLabel"], as_index=False)
        .agg(totalDamage=("damageDealt", "sum"))
    )
    for attacker in dmg_per_turn["attackerLabel"].unique():
        subset = dmg_per_turn[dmg_per_turn["attackerLabel"] == attacker]
        fig.add_trace(
            go.Bar(
                x=subset["turn"],
                y=subset["totalDamage"],
                name=attacker,
                legendgroup=attacker,
            ),
            row=2, col=1,
        )

# Compute the actual turn range from state and attack data
all_turns = hp["turn"]
if not attack_df.empty:
    all_turns = pd.concat([all_turns, attack_df["turn"]])
turn_min = int(all_turns.min()) if not all_turns.empty else 0
turn_max = int(all_turns.max()) if not all_turns.empty else 1

fig.update_layout(
    barmode="stack",
    xaxis_title="Turn",
    xaxis2_title="Turn",
    xaxis_range=[turn_min - 0.5, turn_max + 0.5],
    yaxis_title="HP",
    yaxis2_title="Damage",
    xaxis3_title="Entity",
    yaxis3_title="Total Damage",
    hovermode="x unified",
)

# ── Total damage by entity & weapon (row 3) ──────────────────────
if not attack_df.empty:
    hit_totals = attack_df[attack_df["hit"] == True].copy()  # noqa: E712
    if not hit_totals.empty:
        hit_totals["attackerLabel"] = (
            hit_totals["attacker"].fillna("unknown")
            + ":" + hit_totals["attackerId"].astype(str).str.slice(0, 6)
        )
        by_weapon = (
            hit_totals
            .groupby(["attackerLabel", "weapon"], as_index=False)
            .agg(totalDamage=("damageDealt", "sum"), hitCount=("damageDealt", "count"))
        )
        for weapon in by_weapon["weapon"].unique():
            subset = by_weapon[by_weapon["weapon"] == weapon]
            fig.add_trace(
                go.Bar(
                    x=subset["attackerLabel"],
                    y=subset["totalDamage"],
                    name=weapon,
                    text=subset["hitCount"].astype(str) + " hits",
                    hovertemplate="%{x}<br>%{fullData.name}: %{y} dmg (%{text})<extra></extra>",
                    legendgroup="wpn_" + weapon,
                ),
                row=3, col=1,
            )

fig.show()