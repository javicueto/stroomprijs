/*
 * Stroom — shared price logic: Amsterdam time, the Eneco price formula,
 * tiers, windows and best start times.
 *
 * Single source of truth. Runs unchanged in Google Apps Script (V8), the
 * browser and Node. Edit it here in shared/ only — scripts/sync_shared.sh
 * copies it into apps-script/ and web/shared/.
 */
var StroomCore = (function () {
  'use strict';

  const HOUR = 3600000;

  // ---- Amsterdam time ------------------------------------------------------
  // EU summer time runs from the last Sunday of March 01:00 UTC to the last
  // Sunday of October 01:00 UTC. Computed by rule instead of Intl so Apps
  // Script, browsers and Node give identical answers. If the EU ever drops
  // daylight saving time, this is the one place to change.

  function lastSunday0100Utc(year, monthIndex) {
    const d = new Date(Date.UTC(year, monthIndex + 1, 0, 1));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.getTime();
  }

  function offsetHours(ms) {
    const year = new Date(ms).getUTCFullYear();
    return ms >= lastSunday0100Utc(year, 2) && ms < lastSunday0100Utc(year, 9) ? 2 : 1;
  }

  function localParts(ms) {
    const shifted = new Date(ms + offsetHours(ms) * HOUR);
    return {
      date: shifted.toISOString().slice(0, 10),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      weekday: shifted.getUTCDay(),
    };
  }

  function splitDate(dateStr) {
    return dateStr.split('-').map(Number);
  }

  // Local midnight always falls before the 01:00 UTC switch, so the offset in
  // force three hours before UTC midnight is the one that applies.
  function localMidnightMs(y, m, d) {
    const base = Date.UTC(y, m - 1, d);
    return base - offsetHours(base - 3 * HOUR) * HOUR;
  }

  function dayRange(dateStr) {
    const [y, m, d] = splitDate(dateStr);
    return { start: localMidnightMs(y, m, d), end: localMidnightMs(y, m, d + 1) };
  }

  function addDays(dateStr, n) {
    const [y, m, d] = splitDate(dateStr);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function todayLocal(nowMs) {
    return localParts(nowMs).date;
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // ---- Price formula -------------------------------------------------------

  function allInPrice(spotExVat, tariff) {
    return spotExVat * tariff.vatMultiplier + (tariff.energyTaxInclVat + tariff.supplierMarkupInclVat);
  }

  // Raw feed rows {startMs, spotExVat} → one complete local day of hours.
  // Rows shorter than an hour (15-minute prices) are averaged per hour, the
  // way Eneco bills an hourly contract.
  function buildDay(dateStr, rows, tariff) {
    const range = dayRange(dateStr);
    const buckets = {};
    rows.forEach((r) => {
      if (!isFinite(r.startMs) || !isFinite(r.spotExVat)) return;
      if (r.startMs < range.start || r.startMs >= range.end) return;
      const hourStart = r.startMs - ((r.startMs - range.start) % HOUR);
      (buckets[hourStart] = buckets[hourStart] || []).push(r.spotExVat);
    });

    const expectedHours = Math.round((range.end - range.start) / HOUR);
    const hours = [];
    for (let i = 0; i < expectedHours; i++) {
      const startMs = range.start + i * HOUR;
      const values = buckets[startMs];
      if (!values) continue;
      const spot = values.reduce((s, v) => s + v, 0) / values.length;
      const lp = localParts(startMs);
      hours.push({
        startMs: startMs,
        endMs: startMs + HOUR,
        date: dateStr,
        hour: lp.hour,
        label: pad(lp.hour) + ':00',
        spot: spot,
        allIn: allInPrice(spot, tariff),
      });
    }
    return { date: dateStr, range: range, expectedHours: expectedHours, complete: hours.length === expectedHours, hours: hours };
  }

  // ---- Tiers ---------------------------------------------------------------
  // Relative to the day, with absolute safety rails. Kept in step with
  // scripts/calibrate_thresholds.py — tests/core.test.js checks both agree on
  // every day of the calibration year.

  function classify(hours, rules) {
    const n = hours.length;
    if (!n) return { hours: [], stats: null };

    let sum = 0;
    for (let i = 0; i < n; i++) sum += hours[i].allIn;
    const average = sum / n;
    const sorted = hours.map((h) => h.allIn).sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[n - 1];
    const flat = max - min < rules.flatDaySpread;
    const cheapCut = sorted[Math.min(rules.cheapMaxHours, n) - 1];
    const expensiveCut = sorted[n - Math.min(rules.expensiveMaxHours, n)];

    const out = hours.map((h) => {
      let tier = 'normal';
      if (h.spot <= 0) {
        tier = 'free';
      } else if (h.allIn <= rules.cheapAlways ||
          (!flat && h.allIn <= average - rules.cheapBelowAverage && h.allIn <= cheapCut)) {
        tier = 'cheap';
      } else if (h.allIn >= rules.expensiveAlways ||
          (!flat && h.allIn >= average + rules.expensiveAboveAverage && h.allIn >= expensiveCut)) {
        tier = 'expensive';
      }
      return Object.assign({}, h, { tier: tier });
    });

    return { hours: out, stats: { average: average, min: min, max: max, flat: flat } };
  }

  function windows(classified) {
    const out = [];
    classified.forEach((h) => {
      if (h.tier === 'normal') return;
      const last = out[out.length - 1];
      if (last && last.tier === h.tier && last.endMs === h.startMs) {
        last.endMs = h.endMs;
        last.hours.push(h);
      } else {
        out.push({ tier: h.tier, startMs: h.startMs, endMs: h.endMs, hours: [h] });
      }
    });
    out.forEach((w) => {
      const prices = w.hours.map((h) => h.allIn);
      w.min = Math.min.apply(null, prices);
      w.max = Math.max.apply(null, prices);
      w.average = prices.reduce((s, v) => s + v, 0) / prices.length;
    });
    return out;
  }

  // ---- Blocks and runs -----------------------------------------------------

  function blocks(hours, length, fromMs) {
    const res = [];
    for (let i = 0; i + length <= hours.length; i++) {
      const first = hours[i];
      if (fromMs != null && first.startMs < fromMs) continue;
      const slice = hours.slice(i, i + length);
      if (slice[length - 1].startMs - first.startMs !== (length - 1) * HOUR) continue;
      const average = slice.reduce((s, h) => s + h.allIn, 0) / length;
      res.push({ startMs: first.startMs, endMs: first.startMs + length * HOUR, average: average, hours: slice });
    }
    return res;
  }

  // Earliest block wins a tie.
  function cheapestBlock(hours, length, fromMs) {
    return blocks(hours, length, fromMs).reduce((best, b) => (!best || b.average < best.average ? b : best), null);
  }

  function dearestBlock(hours, length, fromMs) {
    return blocks(hours, length, fromMs).reduce((worst, b) => (!worst || b.average > worst.average ? b : worst), null);
  }

  function runAt(hours, appliance, startMs) {
    const i = hours.findIndex((h) => h.startMs === startMs);
    if (i < 0) return null;
    const slice = hours.slice(i, i + appliance.hours);
    const average = slice.reduce((s, h) => s + h.allIn, 0) / slice.length;
    return { startMs: startMs, average: average, cost: appliance.kwh * average };
  }

  function asRun(appliance, block) {
    return block ? { startMs: block.startMs, average: block.average, cost: appliance.kwh * block.average } : null;
  }

  // ---- Day plan ------------------------------------------------------------

  // A lone cheap or expensive hour is noise: no appliance run fits in it, yet
  // it would still set off a reminder. Those hours go back to normal, so the
  // hour list and the events always agree. Free hours are rare and always kept.
  function dropShortWindows(hours, minHours) {
    const demote = {};
    windows(hours).forEach((w) => {
      if (w.tier !== 'free' && w.hours.length < minHours) w.hours.forEach((h) => { demote[h.startMs] = true; });
    });
    return hours.map((h) => (demote[h.startMs] ? Object.assign({}, h, { tier: 'normal' }) : h));
  }

  function planDay(day, config) {
    const c = classify(day.hours, config.tiers);
    const hours = dropShortWindows(c.hours, config.tiers.minWindowHours);
    const wins = windows(hours);
    const best = cheapestBlock(hours, config.bestWindowHours);
    const hasGood = wins.some((w) => w.tier === 'free' || w.tier === 'cheap');
    return {
      date: day.date,
      complete: day.complete,
      stats: c.stats,
      hours: hours,
      windows: wins,
      best: best,
      showBest: !hasGood && !!best,
      appliances: config.appliances.map((a) => ({
        appliance: a,
        best: asRun(a, cheapestBlock(c.hours, a.hours)),
        worst: asRun(a, dearestBlock(c.hours, a.hours)),
      })),
    };
  }

  // ---- Outlook from now (the web page) --------------------------------------
  // Joins the day plans that are known (today, tomorrow once published) and
  // answers: what does power cost now, when is the next cheap stretch, and when
  // should each appliance start to be cheapest from here on.

  function outlook(plans, nowMs, config) {
    const hours = plans.reduce((all, p) => all.concat(p.hours), []).sort((a, b) => a.startMs - b.startMs);
    const wins = plans.reduce((all, p) => all.concat(p.windows), []).sort((a, b) => a.startMs - b.startMs);
    const current = hours.find((h) => h.startMs <= nowMs && nowMs < h.endMs) || null;
    const ahead = hours.filter((h) => h.endMs > nowMs);
    const fromMs = ahead.length ? ahead[0].startMs : null;
    const isGood = (w) => w.tier === 'free' || w.tier === 'cheap';
    return {
      current: current,
      currentWindow: wins.find((w) => w.startMs <= nowMs && nowMs < w.endMs) || null,
      nextGood: wins.find((w) => isGood(w) && w.startMs > nowMs) || null,
      nextExpensive: wins.find((w) => w.tier === 'expensive' && w.startMs > nowMs) || null,
      bestAhead: cheapestBlock(ahead, config.bestWindowHours, fromMs),
      knownUntilMs: hours.length ? hours[hours.length - 1].endMs : null,
      appliances: config.appliances.map((a) => ({
        appliance: a,
        now: current ? runAt(ahead, a, current.startMs) : null,
        best: asRun(a, cheapestBlock(ahead, a.hours, fromMs)),
      })),
    };
  }

  const api = {
    HOUR: HOUR,
    outlook: outlook,
    offsetHours: offsetHours,
    localParts: localParts,
    dayRange: dayRange,
    addDays: addDays,
    todayLocal: todayLocal,
    pad: pad,
    allInPrice: allInPrice,
    buildDay: buildDay,
    classify: classify,
    windows: windows,
    blocks: blocks,
    cheapestBlock: cheapestBlock,
    dearestBlock: dearestBlock,
    runAt: runAt,
    planDay: planDay,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
