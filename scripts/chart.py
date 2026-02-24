import pandas as pd
import plotly.express as px

df = pd.read_json("logs/log-2026-02-10T21-50-43-397Z.ndjson", lines=True)

# Ensure tokenId is treated as a discrete string key
df["tokenId"] = df["tokenId"].astype(str)

# Readable label (your names are identical; show short id + disposition)
df["tokenLabel"] = (
    df["name"].fillna("token")
    + ":"
    + df["tokenId"].str.slice(0, 6)
    + " (disp="
    + df["disposition"].astype(str)
    + ")"
)

hp = df.dropna(subset=["hp"]).copy()
hp["hp"] = pd.to_numeric(hp["hp"], errors="coerce")

# If there are multiple rows per (turn, token), keep the last one
hp = (
    hp.sort_values(["turn", "round"])
      .groupby(["turn", "tokenId", "tokenLabel"], as_index=False)
      .agg(hp=("hp", "last"), round=("round", "max"))
)

fig = px.line(
    hp,
    x="turn",
    y="hp",
    color="tokenLabel",          # <-- this is "by token"
    hover_data=["tokenId", "round"],
    line_shape="hv",
)
fig.show()