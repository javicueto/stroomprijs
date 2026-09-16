# ⚡ Stroom

Is electricity cheap right now? A phone page for an Eneco Dynamisch contract:
**https://javicueto.github.io/stroomprijs/**

## Put the page on your phone’s home screen

- **iPhone (Safari):** open the link → Share button → **Add to Home Screen**.
- **Android (Chrome):** open the link → ⋮ menu → **Add to Home screen**.

The page also shows a small banner with these steps until it’s added or hidden.

It opens like an app and answers three things at a glance, in colour:

- **Now:** one big word — FREE, CHEAP, NORMAL or EXPENSIVE — and until when.
- **Next cheap / next expensive:** the day and the hours.
- **Tomorrow:** its cheap and expensive hours, plus a colour strip from now to
  the end of tomorrow. Drag along the strip to look ahead hour by hour.

A switch at the top changes every time between 24h and 12h. No prices, no
charts. It still shows what it last loaded when you’re offline.

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
| Flat day | cheapest-to-dearest spread under €0.06 → no 🟢/🔴 |

Cheap or expensive stretches shorter than 2 hours are not shown; free ones
always are.

## Change something

| To change | Edit | Then |
|---|---|---|
| A threshold or the best-window length | `config/tariff.json` | test, sync, push |
| Eneco’s fee or the energy tax (e.g. 1 January) | `config/tariff.json` → `tariff` | test, sync, push |
| Logic | `shared/*.js` — never the copies in `web/shared/` | test, sync, push |
| The page itself | `web/app.js`, `web/styles.css`, `web/index.html` | preview, push |

```bash
node --test tests/
```

```bash
bash scripts/sync_shared.sh
```

```bash
python3 scripts/dev_server.py
```

Pushing to `main` publishes the page; GitHub runs the tests first and refuses
to publish if they fail or if `web/shared/` is out of date. The preview server
sends no-cache headers so a reload never shows old code.

`sync_shared.sh` refuses to overwrite a copy that was edited by hand, so a
change made in the wrong place is never lost silently.

After changing thresholds, check them against a year of real prices:

```bash
python3 scripts/calibrate_thresholds.py
```

## History

The first version also wrote the hours into a shared Google Calendar. It was
removed on 17 September 2026 as not useful; the code is in the git history.
