"""
Summarize wall-clock rollout durations from NDJSON log timestamps.

Usage:
    python scripts/rollout_wallclock_stats.py
    python scripts/rollout_wallclock_stats.py --dir logs
    python scripts/rollout_wallclock_stats.py --parent logs
    python scripts/rollout_wallclock_stats.py logs/fight-1 logs/fight-2 ...
"""

import argparse
import sys
from pathlib import Path
from statistics import mean, pstdev


def parse_args(argv=None):
    argv = [a for a in (sys.argv[1:] if argv is None else argv) if a != "--"]
    p = argparse.ArgumentParser(description="Summarize rollout wall-clock durations from log timestamps")
    p.add_argument("paths", nargs="*", help="Files or folders to scan for .ndjson logs")
    p.add_argument("--dir", type=str, metavar="DIR", help="Directory to scan recursively for .ndjson files")
    p.add_argument("--parent", type=str, metavar="DIR", help="Scan every immediate subfolder of DIR")
    p.add_argument("--minimum-seconds", type=float, default=1.0, metavar="N", help="Ignore rollout gaps shorter than N seconds")
    p.add_argument("--verbose", action="store_true", help="Print per-folder statistics as well as the overall summary")
    return p.parse_args(argv)


def _iter_target_dirs(args) -> list[Path]:
    candidates: list[Path] = []
    if args.parent:
        parent = Path(args.parent)
        if parent.is_dir():
            candidates.extend(sorted(d for d in parent.iterdir() if d.is_dir()))
        else:
            print(f"--parent is not a folder: {parent}", file=sys.stderr)
    if args.dir:
        path = Path(args.dir)
        if path.is_dir():
            candidates.append(path)
        else:
            print(f"--dir is not a folder: {path}", file=sys.stderr)
    for raw in args.paths:
        path = Path(raw)
        if path.is_dir():
            candidates.append(path)
        elif path.is_file():
            candidates.append(path.parent)
        else:
            print(f"Path not found: {path}", file=sys.stderr)

    seen: set[Path] = set()
    ordered: list[Path] = []
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        ordered.append(candidate)
    return ordered


def _collect_log_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(root.rglob("*.ndjson"), key=lambda p: _timestamp_for_path(p))


def _timestamp_for_path(path: Path) -> float:
    st = path.stat()
    for attr in ("st_mtime", "st_ctime"):
        value = getattr(st, attr, None)
        if value:
            return float(value)
    return 0.0


def _filter_outlier_durations(durations: list[float], *, multiplier: float = 10.0, minimum_seconds: float = 1.0) -> list[float]:
    if len(durations) < 3:
        return [duration for duration in durations if minimum_seconds <= duration]
    median = float(sorted(durations)[len(durations) // 2])
    threshold = max(60.0, median * multiplier)
    return [duration for duration in durations if minimum_seconds <= duration <= threshold]


def summarize_rollout_durations(targets: list[Path], root_dir: Path | None = None, *, minimum_seconds: float = 1.0, multiplier: float = 10.0) -> dict:
    root_dir = root_dir or Path.cwd()
    all_durations: list[float] = []
    per_folder: list[dict] = []

    for target in targets:
        log_files = _collect_log_files(target)
        if not log_files:
            continue

        by_parent: dict[Path, list[Path]] = {}
        for log_path in log_files:
            by_parent.setdefault(log_path.parent, []).append(log_path)

        for folder, files in sorted(by_parent.items(), key=lambda item: str(item[0])):
            ordered = sorted(files, key=_timestamp_for_path)
            durations = [
                _timestamp_for_path(curr) - _timestamp_for_path(prev)
                for prev, curr in zip(ordered, ordered[1:])
            ]
            if not durations:
                continue
            filtered_durations = _filter_outlier_durations(durations, multiplier=multiplier, minimum_seconds=minimum_seconds)
            if not filtered_durations:
                continue
            all_durations.extend(filtered_durations)
            per_folder.append({
                "folder": str(folder.relative_to(root_dir)) if folder.is_relative_to(root_dir) else str(folder),
                "interval_count": len(filtered_durations),
                "mean_seconds": float(mean(filtered_durations)),
                "stddev_seconds": float(pstdev(filtered_durations)) if len(filtered_durations) > 1 else 0.0,
                "min_seconds": float(min(filtered_durations)),
                "max_seconds": float(max(filtered_durations)),
            })

    if not all_durations:
        return {
            "interval_count": 0,
            "mean_seconds": 0.0,
            "stddev_seconds": 0.0,
            "min_seconds": 0.0,
            "max_seconds": 0.0,
            "per_folder": per_folder,
        }

    return {
        "interval_count": len(all_durations),
        "mean_seconds": float(mean(all_durations)),
        "stddev_seconds": float(pstdev(all_durations)) if len(all_durations) > 1 else 0.0,
        "min_seconds": float(min(all_durations)),
        "max_seconds": float(max(all_durations)),
        "per_folder": per_folder,
    }


def _format_seconds(seconds: float) -> str:
    minutes, secs = divmod(int(round(seconds)), 60)
    hours, minutes = divmod(minutes, 60)
    parts: list[str] = []
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    if secs or not parts:
        parts.append(f"{secs}s")
    return " ".join(parts)


def main(argv=None):
    args = parse_args(argv)
    targets = _iter_target_dirs(args)
    if not targets:
        print("No folders or files supplied.", file=sys.stderr)
        return 1

    summary = summarize_rollout_durations(
        targets,
        root_dir=Path.cwd(),
        minimum_seconds=args.minimum_seconds,
    )
    print(f"Intervals: {summary['interval_count']}")
    print(f"Mean rollout duration: {_format_seconds(summary['mean_seconds'])} ({summary['mean_seconds']:.2f}s)")
    print(f"Std dev rollout duration: {_format_seconds(summary['stddev_seconds'])} ({summary['stddev_seconds']:.2f}s)")
    print(f"Min rollout duration: {_format_seconds(summary['min_seconds'])}")
    print(f"Max rollout duration: {_format_seconds(summary['max_seconds'])}")

    if args.verbose and summary["per_folder"]:
        print("\nPer-folder breakdown:")
        for row in summary["per_folder"]:
            print(
                f"- {row['folder']}: {row['interval_count']} intervals, "
                f"mean {_format_seconds(row['mean_seconds'])}"
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
