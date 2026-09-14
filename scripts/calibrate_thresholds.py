"""Simulate the tier rules against 12 months of real hourly prices.

Reads data/spot_2025-09_2026-09_energyzero.json (UTC hour -> spot incl. VAT)
and the rules in config/tariff.json, and reports cheap / expensive / free hours
per day, per month.

    python3 scripts/calibrate_thresholds.py            # monthly report
    python3 scripts/calibrate_thresholds.py --export   # also write tests/fixtures/python_tiers_12m.json

The export is an independent implementation of shared/classify.js — the Node
tests check both give the same tier for every hour of the year. Keep the
arithmetic (sum / len, UTC order) identical to the JavaScript.
"""
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
AMS = ZoneInfo("Europe/Amsterdam")

config = json.loads((ROOT / "config/tariff.json").read_text())
T = config["tariff"]
R = config["tiers"]
FIXED = T["energyTaxInclVat"] + T["supplierMarkupInclVat"]
ABSOLUTE = dict(cheap=0.22, expensive=0.38)  # the rejected v1 rule, for comparison


def classify_adaptive(day):
    prices = [a for _, a, _ in day]
    n = len(prices)
    total = 0.0
    for p in prices:
        total += p
    avg = total / n
    ranked = sorted(prices)
    flat = ranked[-1] - ranked[0] < R["flatDaySpread"]
    cheap_cut = ranked[min(R["cheapMaxHours"], n) - 1]
    dear_cut = ranked[n - min(R["expensiveMaxHours"], n)]
    out = []
    for _, a, spot in day:
        if spot <= 0:
            out.append("free")
        elif a <= R["cheapAlways"] or (not flat and a <= avg - R["cheapBelowAverage"] and a <= cheap_cut):
            out.append("cheap")
        elif a >= R["expensiveAlways"] or (not flat and a >= avg + R["expensiveAboveAverage"] and a >= dear_cut):
            out.append("expensive")
        else:
            out.append("normal")
    return out


def classify_absolute(day):
    return ["free" if s <= 0 else "cheap" if a <= ABSOLUTE["cheap"] else "expensive" if a >= ABSOLUTE["expensive"] else "normal"
            for _, a, s in day]


def load_days():
    raw = json.loads((ROOT / "data/spot_2025-09_2026-09_energyzero.json").read_text())
    days = defaultdict(list)
    for t, spot in raw.items():
        utc = datetime.fromisoformat(t.replace("Z", "+00:00"))
        days[utc.astimezone(AMS).date().isoformat()].append((utc, spot + FIXED, spot))
    return {d: sorted(v) for d, v in days.items() if len(v) >= 23}


def report(days, name, fn):
    print(f"\n== {name} ==")
    print("month    cheap h/day  expensive h/day  free h/day  days no-cheap  days no-expensive")
    bym = defaultdict(list)
    for d, day in days.items():
        bym[d[:7]].append(fn(day))
    for m in sorted(bym):
        ds = bym[m]
        per = lambda k: sum(c.count(k) for c in ds) / len(ds)
        no_cheap = sum(1 for c in ds if "cheap" not in c and "free" not in c)
        no_dear = sum(1 for c in ds if "expensive" not in c)
        print(f"{m}  {per('cheap'):10.1f}  {per('expensive'):15.1f}  {per('free'):10.1f}  {no_cheap:13d}  {no_dear:17d}")


def main():
    days = load_days()
    report(days, "absolute (rejected v1)", classify_absolute)
    report(days, "adaptive (config/tariff.json)", classify_adaptive)
    if "--export" in sys.argv:
        out = ROOT / "tests/fixtures/python_tiers_12m.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({d: classify_adaptive(day) for d, day in sorted(days.items())}))
        print(f"\nexported {len(days)} days -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
