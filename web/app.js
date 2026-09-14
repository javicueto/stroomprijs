/*
 * ⚡ Stroom — the web page. Answers three questions at a glance:
 * is electricity cheap now, when is it cheap (or expensive) next, and tomorrow?
 *
 * Fetches, keeps a local copy, draws. Every price rule lives in shared/
 * (StroomCore, StroomText, StroomFeeds), the same code the calendar uses —
 * never add price logic here.
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

  const VERDICT = {
    free: { word: 'FREE', advice: 'Run everything you can' },
    cheap: { word: 'CHEAP', advice: 'Good time to run things' },
    normal: { word: 'NORMAL', advice: 'Not cheap, not expensive' },
    expensive: { word: 'EXPENSIVE', advice: 'Wait if you can' },
  };

  const state = {
    rows: {},        // date → [{startMs, spotExVat}] — raw prices, so a tariff change applies to saved days too
    sources: {},
    savedAt: {},
    problems: {},    // date → 'unpublished' | 'offline'
    checkedAt: null,
    loading: true,
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
          const rows = result.day.hours.map((x) => ({ startMs: x.startMs, spotExVat: x.spot }));
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
  const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function clock(ms) {
    const lp = C.localParts(ms);
    return C.pad(lp.hour) + ':' + C.pad(lp.minute);
  }

  function relDay(date, d) {
    if (date === d.today) return 'today';
    if (date === d.tomorrow) return 'tomorrow';
    return T.dayLabel(date);
  }

  // "16:00", "16:00 tomorrow", "midnight"
  function at(ms, d) {
    const lp = C.localParts(ms);
    if (lp.hour === 0 && lp.minute === 0) return lp.date === d.tomorrow ? 'midnight' : 'midnight tomorrow';
    const time = C.pad(lp.hour) + ':' + C.pad(lp.minute);
    return lp.date === d.today ? time : time + ' ' + relDay(lp.date, d);
  }

  // End of the unbroken run of hours sharing the current hour's tier.
  function stretchEnd(hours, current) {
    let j = hours.indexOf(current);
    while (j + 1 < hours.length && hours[j + 1].tier === current.tier && hours[j + 1].startMs === hours[j].endMs) j++;
    return { endMs: hours[j].endMs, known: j + 1 < hours.length };
  }

  // ---- Verdict -------------------------------------------------------------

  function renderHero(o, hours, d) {
    const box = byId('hero');
    box.replaceChildren();
    if (!o || !o.current) {
      box.className = 'hero hero-loading';
      box.append(h('p', { class: 'hero-eyebrow' }, 'Now'),
        h('p', { class: 'hero-word hero-word-quiet' },
          state.loading ? 'Loading…' : 'No prices — check your connection'));
      return;
    }
    const cur = o.current;
    const v = VERDICT[cur.tier];
    const end = stretchEnd(hours, cur);
    box.className = 'hero hero-' + cur.tier;
    box.append(
      h('p', { class: 'hero-eyebrow' }, 'Now · ', nl('Nu · ' + NAMES[cur.tier][1])),
      h('p', { class: 'hero-word' + (v.word.length > 6 ? ' is-long' : '') }, v.word),
      end.known ? h('p', { class: 'hero-until' }, 'until ' + at(end.endMs, d)) : null,
      h('p', { class: 'hero-advice' }, v.advice)
    );
  }

  // ---- Next cheap / next expensive / tomorrow ------------------------------

  function keyTile(extraClass, label, day, value, sub) {
    return h('div', { class: 'key ' + extraClass },
      h('p', { class: 'key-label' }, label),
      day ? h('p', { class: 'key-day' }, day) : null,
      h('p', { class: 'key-value' }, value),
      sub ? h('p', { class: 'key-sub' }, sub) : null);
  }

  function windowTile(extraClass, label, w, d, fallback) {
    if (!w) return keyTile(extraClass, label, null, fallback[0], fallback[1]);
    const date = w.hours[0].date;
    return keyTile(extraClass, label, capital(relDay(date, d)), T.span(w.startMs, w.endMs, date));
  }

  function tomorrowTile(plan, d) {
    const tile = h('div', { class: 'key key-tomorrow' },
      h('p', { class: 'key-label' }, 'Tomorrow · ', nl('Morgen'), ' · ' + T.dayLabel(d.tomorrow)));
    if (!plan) {
      tile.append(h('p', { class: 'key-value' },
        state.problems[d.tomorrow] === 'offline' ? 'Couldn’t load' : 'Known around 14:00'));
      return tile;
    }
    const groups = ['free', 'cheap', 'expensive']
      .map((tier) => [tier, plan.windows.filter((w) => w.tier === tier)])
      .filter((g) => g[1].length);
    if (!groups.length) {
      tile.append(h('p', { class: 'key-value' }, '⚪ Normal all day'),
        plan.best ? h('p', { class: 'key-sub' }, 'Least expensive: ' + T.span(plan.best.startMs, plan.best.endMs, plan.date)) : null);
      return tile;
    }
    tile.append(h('ul', { class: 'tomorrow-list' }, groups.map((g) => h('li', {},
      h('span', { class: 'tomorrow-tier' }, NAMES[g[0]][0] + ' ' + NAMES[g[0]][2]),
      h('span', { class: 'tomorrow-times' }, g[1].map((w) => h('span', {}, T.span(w.startMs, w.endMs, plan.date))))))));
    return tile;
  }

  function renderKeys(o, plans, d) {
    const box = byId('keys');
    box.replaceChildren();
    if (!o) return;
    const tomorrowPlan = plans.find((p) => p.date === d.tomorrow);
    const waiting = ['Not today', 'Tomorrow is known around 14:00'];
    const cheapNow = o.current && (o.current.tier === 'cheap' || o.current.tier === 'free');
    box.append(
      windowTile('key-cheap', o.nextGood && o.nextGood.tier === 'free' ? '🆓 Next free' : '🟢 Next cheap', o.nextGood, d,
        tomorrowPlan ? (cheapNow ? ['Now', 'Nothing cheaper later'] : ['None', 'Not before the end of tomorrow']) : waiting),
      windowTile('key-expensive', '🔴 Next expensive', o.nextExpensive, d,
        tomorrowPlan ? ['None', 'Not before the end of tomorrow'] : waiting),
      tomorrowTile(tomorrowPlan, d)
    );
  }

  // ---- Strip: now → end of tomorrow ----------------------------------------

  function renderStrip(hoursAll, now, d) {
    const box = byId('strip');
    box.replaceChildren();
    const hours = hoursAll.filter((x) => x.endMs > now);
    if (!hours.length) {
      box.append(h('p', { class: 'muted' }, state.loading ? 'Loading…' : 'No prices yet.'));
      return;
    }
    const start = hours[0].startMs;
    const span = hours[hours.length - 1].endMs - start;
    const frac = (ms) => ((ms - start) / span) * 100;

    const runs = [];
    hours.forEach((x) => {
      const last = runs[runs.length - 1];
      if (last && last.tier === x.tier && last.endMs === x.startMs) last.endMs = x.endMs;
      else runs.push({ tier: x.tier, startMs: x.startMs, endMs: x.endMs });
    });

    const labels = h('div', { class: 'strip-labels', 'aria-hidden': 'true' });
    hours.forEach((x) => {
      const left = frac(x.startMs);
      if (x.hour % 6 !== 0 || left < 8 || left > 92) return;
      labels.append(h('span', { class: 'strip-label' + (x.hour === 0 ? ' is-day' : ''), style: 'left:' + left + '%' },
        x.hour === 0 ? T.dayLabel(x.date).split(' ')[0] : C.pad(x.hour)));
    });

    const present = ['free', 'cheap', 'normal', 'expensive'].filter((t) => runs.some((r) => r.tier === t));
    box.append(
      h('div', { class: 'strip' },
        h('span', { class: 'strip-now', style: 'left:' + frac(now) + '%', 'aria-hidden': 'true' }, h('span', {}, 'now')),
        h('div', {
          class: 'strip-bar',
          role: 'img',
          'aria-label': runs.map((r) => NAMES[r.tier][2] + ' until ' + at(r.endMs, d)).join(', '),
        }, runs.map((r) => h('span', { class: 'strip-run tier-' + r.tier, style: 'flex-grow:' + (r.endMs - r.startMs) / C.HOUR }))),
        labels),
      h('ul', { class: 'legend' }, present.map((t) =>
        h('li', {}, h('span', { class: 'swatch tier-' + t, 'aria-hidden': 'true' }), NAMES[t][2])))
    );
  }

  // ---- Footer --------------------------------------------------------------

  function renderFooter(d) {
    const f = byId('footer');
    f.replaceChildren();
    const offline = state.problems[d.today] === 'offline' || state.problems[d.tomorrow] === 'offline';
    const source = state.sources[d.today] || state.sources[d.tomorrow];
    // Element.append(null) inserts the text "null" — only pass real nodes.
    [
      offline && state.savedAt[d.today]
        ? h('p', { class: 'stale' }, 'Offline — showing what was loaded at ' + clock(state.savedAt[d.today]) + '.')
        : null,
      h('p', {}, 'Eneco Dynamisch · market prices' + (source ? ' via ' + source : '') +
        (state.checkedAt ? ' · checked ' + clock(state.checkedAt) : '')),
    ].forEach((node) => { if (node) f.append(node); });
  }

  // ---- Render loop ---------------------------------------------------------

  function render() {
    const now = Date.now();
    const d = dates(now);
    if (!dayFor(d.today) && !inflight && !state.problems[d.today]) refresh();

    const plans = [d.today, d.tomorrow].map(dayFor).filter(Boolean).map((day) => C.planDay(day, CFG));
    const o = plans.length ? C.outlook(plans, now, CFG) : null;
    const hours = plans.reduce((all, p) => all.concat(p.hours), []).sort((a, b) => a.startMs - b.startMs);

    byId('today-label').textContent = T.dayLabel(d.today);
    renderHero(o, hours, d);
    renderKeys(o, plans, d);
    renderStrip(hours, now, d);
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
