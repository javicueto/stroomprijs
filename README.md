# ⚡ Stroom

Cheap, free and expensive electricity hours for an Eneco Dynamisch contract —
in a shared Google Calendar, and (soon) on a phone-friendly page.

Every afternoon a Google Apps Script reads tomorrow’s market prices, applies
Eneco’s formula and writes events like:

- `🆓 Gratis · Free power 12:00–15:00 · €0.07`
- `🟢 Goedkoop · Cheap 11:00–16:00 · €0.18–0.26`
- `🔴 Duur · Avoid 18:00–22:00 · €0.40–0.46`
- `⭐ Beste tijd · Best 3h 03:00–06:00 · €0.23` (only on days with no cheap hours)

Each event lists what a dishwasher, washer or dryer run costs then vs. the
worst (or best) time, plus all 24 hourly prices.

## How the price is calculated

```
all-in €/kWh = market price × 1.21 VAT + €0.11085 energy tax + €0.02296 Eneco fee
```

Market prices (EPEX day-ahead) come from EnergyZero, with Frank Energie as a
fallback. Both are public — no Eneco login is involved.

## How hours are sorted

Relative to each day, with fixed limits as a backstop — see
`config/tariff.json`:

| | Rule |
|---|---|
| 🆓 Free | market price at or below zero |
| 🟢 Cheap | ≤ €0.20, or one of the day’s 6 cheapest hours and ≥ €0.04 below its average |
| 🔴 Expensive | ≥ €0.40, or one of the day’s 5 dearest hours and ≥ €0.05 above its average |
| Flat day | cheapest-to-dearest spread under €0.06 → no 🟢/🔴, only ⭐ |

## Change something

| To change | Edit | Then |
|---|---|---|
| A threshold, appliance, reminder time, run hours | `config/tariff.json` | sync + push |
| Eneco’s fee or the energy tax (e.g. 1 January) | `config/tariff.json` → `tariff` | sync + push |
| Who the calendar is shared with, alert email | `config/private.json` (not in git) | sync + push, run `setup()` |
| Logic or wording | `shared/*.js` — never the copies in `apps-script/` or `web/shared/` | test + sync + push |

```bash
node --test tests/
```

```bash
bash scripts/sync_shared.sh
```

```bash
clasp push --force
```

`sync_shared.sh` refuses to overwrite a copy that was edited by hand, so a
change made in the wrong place is never lost silently.

After changing thresholds, check them against a year of real prices:

```bash
python3 scripts/calibrate_thresholds.py
```

## Calendar job

Script: “Stroom calendar” on script.google.com (id in `.clasp.json`).

| Function | What it does |
|---|---|
| `setup()` | Creates the calendar, shares it read-only, sets reminders, installs triggers, writes today and tomorrow. Safe to run again. |
| `runDaily()` | Trigger at 14:00, 15:00, 16:00. First run with prices writes tomorrow; the 16:00 run emails an alert if there are still no prices. |
| `rewriteTomorrow()` / `rewriteToday()` | Replace that day’s events now. |

Only events the script wrote are ever touched.

## For people the calendar is shared with

Reminders are personal in Google Calendar, so each person turns them on once:

1. Open the “Javi has shared a calendar” email and click **Add this calendar**.
2. On a computer: calendar.google.com → ⚙ Settings → **⚡ Stroom** under
   “Settings for other calendars” → **Event notifications** → Add notification
   → **30 minutes**.
3. On the phone: Google Calendar → Settings → make sure **⚡ Stroom** is
   switched on.
