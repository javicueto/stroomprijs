/*
 * ⚡ Stroom — the web page. Fetches, keeps a local copy, draws.
 * Every price rule lives in shared/ (StroomCore, StroomText, StroomFeeds),
 * the same code the calendar uses — never add price logic here.
 */
(function () {
  'use strict';

  const C = StroomCore;
  const T = StroomText;
  const F = StroomFeeds;
  const CFG = STROOM_CONFIG;

  const STORE = 'stroom:v1:';
  const RECHECK_MS = 15 * 60 * 1000;
  const TICK_MS = 60 * 1000;

  const NAMES = {
    free: ['🆓', 'Gratis', 'Free'],
    cheap: ['🟢', 'Goedkoop', 'Cheap'],
    normal: ['⚪', 'Normaal', 'Normal'],
    expensive: ['🔴', 'Duur', 'Expensive'],
  };
  const ADVICE = { free: 'run everything you can', cheap: 'good time to run', expensive: 'wait if you can', normal: '' };

  const state = {
    rows: {},        // date → [{startMs, spotExVat}] — raw prices, so a tariff change applies to saved days too
    sources: {},
    savedAt: {},
    problems: {},    // date → 'unpublished' | 'offline'
    checkedAt: null,
    loading: true,
    selected: {},    // date → hour index picked in the chart
    tableOpen: {},
  };

  // ---- Local copy — a convenience; the page works without it ---------------

  function readStore(key) {
    try { return JSON.parse(localStorage.getItem(STORE + key)); } catch (e) { return null; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch (e) { /* private mode, full */ }
  }

  function pruneStore(keepDates) {
    try {
      Object.keys(localStorage)
        .filter((k) => k.indexOf(STORE + 'day:') === 0 && keepDates.indexOf(k.slice((STORE + 'day:').length)) < 0)
        .forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
  }

  // ---- Data ----------------------------------------------------------------

  function dates(now) {
    const today = C.todayLocal(now);
    return { today: today, tomorrow: C.addDays(today, 1) };
  }

  function dayFor(date) {
    if (!state.rows[date]) return null;
    const day = C.buildDay(date, state.rows[date], CFG.tariff);
    return day.complete ? day : null;
  }

  function loadSaved() {
    const d = dates(Date.now());
    [d.today, d.tomorrow].forEach((date) => {
      const saved = readStore('day:' + date);
      if (saved && Array.isArray(saved.rows)) {
        state.rows[date] = saved.rows;
        state.sources[date] = saved.source;
        state.savedAt[date] = saved.savedAt;
      }
    });
    pruneStore([d.today, d.tomorrow]);
  }

  async function fetchJson(req) {
    const res = await fetch(req.url, {
      method: req.method.toUpperCase(),
      headers: req.body ? { 'Content-Type': 'application/json' } : {},
      body: req.body,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  let inflight = null;

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const d = dates(Date.now());
      const wanted = [d.today, d.tomorrow].filter((date) => !dayFor(date));
      // Both days at once — one after the other made the first load take seconds.
      const results = await Promise.all(wanted.map((date) => F.loadDay(date, fetchJson, CFG.tariff)));
      wanted.forEach((date, i) => {
        const result = results[i];
        if (result.day) {
          const rows = result.day.hours.map((h) => ({ startMs: h.startMs, spotExVat: h.spot }));
          state.rows[date] = rows;
          state.sources[date] = result.source;
          state.savedAt[date] = Date.now();
          writeStore('day:' + date, { rows: rows, source: result.source, savedAt: state.savedAt[date] });
          delete state.problems[date];
        } else {
          // A feed answering "0 of 24 hours" is reachable but has nothing yet;
          // only when no feed answered at all are we offline.
          const reachable = result.notes.some((n) => / of \d+ hours$/.test(n));
          state.problems[date] = reachable ? 'unpublished' : 'offline';
        }
      });
      state.checkedAt = Date.now();
      pruneStore([d.today, d.tomorrow]);
    })()
      .catch((e) => console.error(e))
      .finally(() => {
        inflight = null;
        state.loading = false;
        render();
      });
    return inflight;
  }

  // ---- DOM helpers ---------------------------------------------------------

  function h(tag, attrs) {
    const el = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    Array.prototype.slice.call(arguments, 2).flat(Infinity).forEach((c) => {
      if (c == null || c === false || c === '') return;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return el;
  }

  const byId = (id) => document.getElementById(id);
  const nl = (text) => h('span', { lang: 'nl' }, text);

  function clock(ms) {
    const lp = C.localParts(ms);
    return C.pad(lp.hour) + ':' + C.pad(lp.minute);
  }

  function relDay(date, d) {
    if (date === d.today) return 'today';
    if (date === d.tomorrow) return 'tomorrow';
    return T.dayLabel(date);
  }

  function tierLabel(tier) {
    const n = NAMES[tier];
    return [n[0] + ' ', nl(n[1]), ' · ' + n[2]];
  }

  // ---- Now -----------------------------------------------------------------

  function renderNow(o, d) {
    const box = byId('now');
    box.replaceChildren();
    const eyebrow = (extra) => h('p', { class: 'eyebrow' }, nl('Nu'), ' · Now' + (extra || ''));

    if (!o || !o.current) {
      box.append(eyebrow(), h('p', { class: 'now-empty' },
        state.loading ? 'Loading prices…' : 'No price for this hour — check your connection.'));
      return;
    }

    const cur = o.current;
    const win = o.currentWindow;
    const until = win ? ' until ' + T.timeLabel(win.endMs, win.hours[0].date) : '';
    const advice = ADVICE[cur.tier] ? ' — ' + ADVICE[cur.tier] : '';

    box.append(
      eyebrow(' · ' + cur.label + '–' + T.timeLabel(cur.endMs, cur.date)),
      h('p', { class: 'now-price' }, T.euro(cur.allIn), h('span', { class: 'unit' }, ' per kWh')),
      h('p', { class: 'tier-line' }, tierLabel(cur.tier), until + advice),
      nextLine(o, d)
    );
  }

  function nextLine(o, d) {
    if (o.nextGood) {
      const w = o.nextGood;
      const date = w.hours[0].date;
      return h('p', { class: 'now-next' },
        'Next ' + (w.tier === 'free' ? 'free' : 'cheap') + ': ' + relDay(date, d) + ' ' +
        T.span(w.startMs, w.endMs, date) + ' · ' + T.euroRange(w.min, w.max));
    }
    if (o.bestAhead) {
      const b = o.bestAhead;
      const date = C.localParts(b.startMs).date;
      const known = dayFor(d.tomorrow) ? '' : ' so far';
      return h('p', { class: 'now-next' },
        'No cheap hours ahead' + known + '. Cheapest ' + CFG.bestWindowHours + ' hours: ' + relDay(date, d) + ' ' +
        T.span(b.startMs, b.endMs, date) + ' · ' + T.euro(b.average));
    }
    return null;
  }

  // ---- Appliances ----------------------------------------------------------

  // A phone charge costs a fraction of a cent; "€0.00" reads like a bug.
  function runCost(eur) {
    return eur > 0 && eur < 0.01 ? '< €0.01' : T.euro(eur);
  }

  function renderAppliances(o, d) {
    const list = byId('appliances');
    list.replaceChildren();
    if (!o) {
      list.append(h('li', { class: 'appliance-empty' }, state.loading ? 'Loading…' : 'No prices yet.'));
      return;
    }
    o.appliances.forEach((a) => {
      if (!a.best) return;
      const date = C.localParts(a.best.startMs).date;
      const startsNow = !!o.current && a.best.startMs === o.current.startMs;
      list.append(h('li', { class: 'appliance' },
        h('span', { class: 'appliance-name' }, a.appliance.name, h('span', { class: 'muted' }, ' · ' + a.appliance.hours + 'h')),
        h('span', { class: 'appliance-when' },
          startsNow ? h('strong', {}, 'Start now') : ['Start ', h('strong', {}, T.timeLabel(a.best.startMs, date)), ' ' + relDay(date, d)]),
        h('span', { class: 'appliance-cost' },
          h('strong', {}, runCost(a.best.cost)),
          a.now && !startsNow ? h('span', { class: 'muted' }, 'now ' + runCost(a.now.cost)) : null)
      ));
    });
  }

  // ---- Day chart -----------------------------------------------------------

  function scaleFor(plans) {
    const max = Math.max.apply(null, [0.1].concat(plans.map((p) => p.stats.max)));
    const step = max <= 0.3 ? 0.1 : max <= 0.8 ? 0.2 : 0.5;
    const top = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let t = step; t <= top + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);
    return { top: top, ticks: ticks };
  }

  const pct = (v, scale) => Math.max(0, Math.min(100, (v / scale.top) * 100));

  function readoutParts(hr) {
    return [hr.label + '–' + T.timeLabel(hr.endMs, hr.date) + '  ', h('strong', {}, T.euro(hr.allIn)), ' per kWh  ', tierLabel(hr.tier)];
  }

  function defaultSelection(plan, now) {
    if (state.selected[plan.date] != null) return state.selected[plan.date];
    const current = plan.hours.findIndex((x) => x.startMs <= now && now < x.endMs);
    if (current >= 0) return current;
    return plan.hours.reduce((best, x, i) => (x.allIn < plan.hours[best].allIn ? i : best), 0);
  }

  function chart(plan, now, scale) {
    const n = plan.hours.length;
    const readout = h('p', { class: 'readout', 'aria-live': 'polite' });
    const cols = h('div', { class: 'cols', style: '--cols:' + n });

    const select = (i) => {
      state.selected[plan.date] = i;
      readout.replaceChildren.apply(readout, readoutParts(plan.hours[i]).flat());
      Array.prototype.forEach.call(cols.children, (c, j) => c.classList.toggle('is-selected', j === i));
    };

    plan.hours.forEach((hr, i) => {
      const isNow = hr.startMs <= now && now < hr.endMs;
      const col = h('button', {
        type: 'button',
        class: 'col' + (isNow ? ' is-now' : ''),
        'aria-label': hr.label + ', ' + T.euro(hr.allIn) + ' per kWh, ' + NAMES[hr.tier][2],
      }, h('span', { class: 'bar tier-' + hr.tier, style: 'height:' + Math.max(pct(hr.allIn, scale), 1) + '%' }));
      col.addEventListener('pointerenter', () => select(i));
      col.addEventListener('focus', () => select(i));
      col.addEventListener('click', () => select(i));
      cols.append(col);
    });

    const grid = h('div', { class: 'grid', 'aria-hidden': 'true' },
      scale.ticks.map((t) => h('div', { class: 'gridline', style: 'bottom:' + pct(t, scale) + '%' }, h('span', { class: 'tick' }, T.euro(t)))));

    const plot = h('div', { class: 'plot' }, grid, cols);
    const first = plan.hours[0].startMs;
    const last = plan.hours[n - 1].endMs;
    if (now >= first && now < last) {
      const at = ((now - first) / (last - first)) * 100;
      // Late in the day the label would run off the right edge, so it flips left.
      plot.append(h('div', { class: 'now-marker' + (at > 80 ? ' label-left' : ''), style: 'left:' + at + '%', 'aria-hidden': 'true' },
        h('span', {}, 'now')));
    }

    let bestRow = null;
    if (plan.best) {
      const i0 = plan.hours.findIndex((x) => x.startMs === plan.best.startMs);
      bestRow = h('div', { class: 'best-row', style: '--cols:' + n, 'aria-hidden': 'true' },
        h('span', { class: 'best-mark', style: 'grid-column:' + (i0 + 1) + ' / span ' + CFG.bestWindowHours }, '⭐ best ' + CFG.bestWindowHours + 'h'));
    }

    const axis = h('div', { class: 'axis', style: '--cols:' + n, 'aria-hidden': 'true' },
      plan.hours.map((hr) => h('span', {}, hr.hour % 6 === 0 ? C.pad(hr.hour) : '')));

    select(defaultSelection(plan, now));
    return [h('div', { class: 'chart' }, bestRow, plot, axis), readout];
  }

  function table(plan) {
    const details = h('details', { class: 'table-view', open: !!state.tableOpen[plan.date] },
      h('summary', {}, 'All hourly prices'),
      h('div', { class: 'table-wrap' },
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Hour'), h('th', { scope: 'col', class: 'num' }, '€ per kWh'), h('th', { scope: 'col' }, 'Price level'))),
          h('tbody', {}, plan.hours.map((hr) => h('tr', {},
            h('td', {}, hr.label + '–' + T.timeLabel(hr.endMs, hr.date)),
            h('td', { class: 'num' }, T.euro(hr.allIn)),
            h('td', {}, tierLabel(hr.tier))))))));
    details.addEventListener('toggle', () => { state.tableOpen[plan.date] = details.open; });
    return details;
  }

  // Same words as the calendar event title. Each " · " part stays on one line,
  // so a chip wraps between parts, never inside a time or price range.
  function chipParts(title) {
    return title.split(' · ').map((part, i) => [i ? ' · ' : '', h('span', { class: 'chip-part' }, part)]);
  }

  function emptyDayText(date, d) {
    const problem = state.problems[date];
    if (problem === 'offline') return 'Couldn’t load prices — check your connection. Trying again every 15 minutes.';
    if (!problem) return 'Loading prices…';
    if (date === d.tomorrow) {
      return C.localParts(Date.now()).hour < 13
        ? 'Tomorrow’s prices arrive around 14:00.'
        : 'Not published yet — checking again every 15 minutes.';
    }
    return state.loading ? 'Loading prices…' : 'No prices for today yet.';
  }

  function renderDay(id, date, plan, words, now, scale, d) {
    const box = byId(id);
    box.replaceChildren();
    const head = h('header', { class: 'day-head' },
      h('h2', {}, nl(words[0]), ' · ' + words[1] + ' ', h('span', { class: 'muted' }, T.dayLabel(date))));
    box.append(head);

    if (!plan) {
      box.append(h('p', { class: 'day-empty' }, emptyDayText(date, d)));
      return;
    }

    head.append(h('p', { class: 'day-stats' },
      'average ' + T.euro(plan.stats.average) + ' · range ' + T.euroRange(plan.stats.min, plan.stats.max)));

    const events = T.eventsForPlan(plan, CFG);
    // chart() returns two nodes; Element.append would print an array as text.
    box.append(
      ...chart(plan, now, scale),
      events.length
        ? h('ul', { class: 'chips', 'aria-label': 'Windows' }, events.map((e) => h('li', { class: 'chip' }, chipParts(e.title))))
        : h('p', { class: 'day-empty' }, 'No stand-out hours — prices are close all day.'),
      table(plan)
    );
  }

  // ---- Footer --------------------------------------------------------------

  function renderFooter(d) {
    const f = byId('footer');
    f.replaceChildren();
    const t = CFG.tariff;
    const source = state.sources[d.today] || state.sources[d.tomorrow];
    const offline = state.problems[d.today] === 'offline' || state.problems[d.tomorrow] === 'offline';
    // Element.append(null) inserts the text "null" — only pass real nodes.
    [
      offline && state.savedAt[d.today]
        ? h('p', { class: 'stale' }, 'Offline — showing prices saved at ' + clock(state.savedAt[d.today]) + '.')
        : null,
      h('p', {}, 'Price per kWh = market price × ' + t.vatMultiplier + ' VAT + €' + t.energyTaxInclVat +
        ' energy tax + €' + t.supplierMarkupInclVat + ' Eneco fee (Eneco Dynamisch).'),
      h('p', {}, 'Market prices: EPEX day-ahead' + (source ? ' via ' + source : '') +
        (state.checkedAt ? ' · checked ' + clock(state.checkedAt) : '') + '.'),
    ].forEach((node) => { if (node) f.append(node); });
  }

  // ---- Render loop ---------------------------------------------------------

  function render() {
    const now = Date.now();
    const d = dates(now);
    if (!dayFor(d.today) && !inflight && !state.problems[d.today]) refresh();

    const plans = [d.today, d.tomorrow].map(dayFor).filter(Boolean).map((day) => C.planDay(day, CFG));
    const o = plans.length ? C.outlook(plans, now, CFG) : null;
    const scale = scaleFor(plans);

    byId('today-label').textContent = T.dayLabel(d.today);
    renderNow(o, d);
    renderAppliances(o, d);
    renderDay('day-today', d.today, plans.find((p) => p.date === d.today), ['Vandaag', 'Today'], now, scale, d);
    renderDay('day-tomorrow', d.tomorrow, plans.find((p) => p.date === d.tomorrow), ['Morgen', 'Tomorrow'], now, scale, d);
    renderFooter(d);
  }

  function recheck() {
    const d = dates(Date.now());
    if (dayFor(d.today) && dayFor(d.tomorrow)) return;
    delete state.problems[d.today];
    delete state.problems[d.tomorrow];
    refresh();
  }

  loadSaved();
  render();
  refresh();
  setInterval(render, TICK_MS);
  setInterval(recheck, RECHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    render();
    recheck();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Offline support unavailable', e));
  }
})();
