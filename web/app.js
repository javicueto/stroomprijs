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
    hour12: false,   // time format for the whole page; remembered per phone
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

  // Every time shown on the page goes through fmt(), so the 24h/12h switch
  // applies everywhere at once. "16:00" or "4 pm" / "4:30 pm".
  function fmt(hour, minute) {
    if (!state.hour12) return C.pad(hour) + ':' + C.pad(minute);
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return h12 + (minute ? ':' + C.pad(minute) : '') + ' ' + (hour < 12 ? 'am' : 'pm');
  }

  // The end of `date` reads "24:00" (or "12 am"), not the next day's "00:00".
  function timeOf(ms, date) {
    if (date && ms === C.dayRange(date).end) return state.hour12 ? '12 am' : '24:00';
    const lp = C.localParts(ms);
    return fmt(lp.hour, lp.minute);
  }

  function spanText(startMs, endMs, date) {
    return timeOf(startMs, date) + '–' + timeOf(endMs, date);
  }

  function clock(ms) {
    return timeOf(ms);
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
    const time = fmt(lp.hour, lp.minute);
    return lp.date === d.today ? time : time + ' ' + relDay(lp.date, d);
  }

  // End of the unbroken run of hours sharing the current hour's tier.
  function stretchEnd(hours, current) {
    let j = hours.indexOf(current);
    while (j + 1 < hours.length && hours[j + 1].tier === current.tier && hours[j + 1].startMs === hours[j].endMs) j++;
    return { endMs: hours[j].endMs, known: j + 1 < hours.length };
  }

  // ---- Haptics -------------------------------------------------------------
  // iPhone Safari has no vibration API. Since iOS 18, toggling a native
  // <input type="checkbox" switch> plays the system haptic tick, so clicking a
  // hidden one is the only way a web page can make an iPhone tick. Android uses
  // navigator.vibrate. Elsewhere this silently does nothing.
  let hapticLabel = null;

  function haptic() {
    if (typeof navigator.vibrate === 'function' && /Android/i.test(navigator.userAgent)) {
      navigator.vibrate(8);
      return;
    }
    if (!hapticLabel) {
      hapticLabel = h('label', { class: 'haptic-switch', 'aria-hidden': 'true' },
        h('input', { type: 'checkbox', switch: true, tabindex: '-1' }));
      document.body.append(hapticLabel);
    }
    hapticLabel.click();
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
      h('p', { class: 'hero-eyebrow' }, 'Now ' + clock(Date.now())),
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
    return keyTile(extraClass, label, capital(relDay(date, d)), spanText(w.startMs, w.endMs, date));
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
        plan.best ? h('p', { class: 'key-sub' }, 'Least expensive: ' + spanText(plan.best.startMs, plan.best.endMs, plan.date)) : null);
      return tile;
    }
    tile.append(h('ul', { class: 'tomorrow-list' }, groups.map((g) => h('li', {},
      h('span', { class: 'tomorrow-tier' }, NAMES[g[0]][0] + ' ' + NAMES[g[0]][2]),
      h('span', { class: 'tomorrow-times' }, g[1].map((w) => h('span', {}, spanText(w.startMs, w.endMs, plan.date))))))));
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

  // ---- Timeline strip: now → end of tomorrow --------------------------------
  // Every block with its word, the time at both ends of each block, and a
  // marker that can be dragged hour by hour to look ahead.

  const scrub = { holding: false, active: false, pendingRender: false, returnTimer: null };
  const SCRUB_RETURN_MS = 4000;

  function stripDay(date) {
    return T.dayLabel(date).split(' ').slice(0, 2).join(' ');
  }

  // Places time labels in two rows under the strip, centred on their block
  // edge. Day names win over times, then earlier labels; a label that fits in
  // neither row is hidden rather than drawn over another.
  function layoutLabels(container) {
    const width = container.clientWidth;
    const rows = [[], []];
    Array.prototype.slice.call(container.children)
      .sort((p, q) => (p.dataset.rank - q.dataset.rank) || (p.dataset.at - q.dataset.at))
      .forEach((el) => {
        el.hidden = false;
        const w = el.getBoundingClientRect().width;
        const left = Math.min(Math.max(el.dataset.at * width - w / 2, 0), width - w);
        const row = rows.findIndex((r) => r.every((iv) => left + w + 6 <= iv[0] || left >= iv[1] + 6));
        if (row < 0) {
          el.hidden = true;
          return;
        }
        rows[row].push([left, left + w]);
        el.style.left = left + 'px';
        el.style.top = row * 18 + 'px';
      });
  }

  function renderStrip(hoursAll, now, d) {
    const box = byId('strip');
    box.replaceChildren();
    const hours = hoursAll.filter((x) => x.endMs > now);
    if (!hours.length) {
      box.append(h('p', { class: 'muted' }, state.loading ? 'Loading…' : 'No prices yet.'));
      return;
    }
    const startMs = hours[0].startMs;
    const endMs = hours[hours.length - 1].endMs;
    const frac = (ms) => (ms - startMs) / (endMs - startMs);

    const runs = [];
    hours.forEach((x) => {
      const last = runs[runs.length - 1];
      if (last && last.tier === x.tier && last.endMs === x.startMs) last.endMs = x.endMs;
      else runs.push({ tier: x.tier, startMs: x.startMs, endMs: x.endMs });
    });

    const bar = h('div', {
      class: 'strip-bar',
      role: 'img',
      'aria-label': runs.map((r) => NAMES[r.tier][2] + ' until ' + at(r.endMs, d)).join(', '),
    }, runs.map((r) => h('span', { class: 'strip-run tier-' + r.tier, style: 'flex-grow:' + (r.endMs - r.startMs) / C.HOUR },
      h('span', { class: 'strip-run-label' }, NAMES[r.tier][2]))));

    // Time at both ends of every block (a shared edge is labelled once), and
    // the day name at midnight.
    const labels = h('div', { class: 'strip-labels', 'aria-hidden': 'true' });
    const label = (ms, text, rank, extra) =>
      h('span', { class: 'strip-label' + (extra || ''), 'data-at': frac(ms), 'data-rank': rank }, text);
    hours.forEach((x) => {
      if (x.hour === 0 && x.startMs > startMs) labels.append(label(x.startMs, stripDay(x.date), 0, ' is-day'));
    });
    labels.append(label(startMs, timeOf(startMs), 1));
    runs.forEach((r, i) => {
      const isLast = i === runs.length - 1;
      labels.append(label(r.endMs, isLast ? timeOf(r.endMs, hours[hours.length - 1].date) : timeOf(r.endMs), 1));
    });

    const tagSwatch = h('span', { class: 'swatch' });
    const tagText = h('span', {});
    const marker = h('div', {
      class: 'strip-now',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Look ahead on the timeline',
      'aria-valuemin': '0',
      'aria-valuemax': String(hours.length - 1),
    }, h('span', { class: 'strip-now-tag' }, tagSwatch, tagText));

    const strip = h('div', { class: 'strip' }, marker, bar, labels);
    const present = ['free', 'cheap', 'normal', 'expensive'].filter((t) => runs.some((r) => r.tier === t));
    box.append(strip, h('ul', { class: 'legend' }, present.map((t) =>
      h('li', {}, h('span', { class: 'swatch tier-' + t, 'aria-hidden': 'true' }), NAMES[t][2]))));

    let index = 0;
    const place = (i, animate) => {
      const hr = hours[i];
      const isNow = i === 0;
      const f = frac(isNow ? now : hr.startMs);
      marker.classList.toggle('is-animated', !!animate);
      marker.classList.toggle('is-scrubbed', !isNow);
      marker.classList.toggle('flip', f > 0.6);
      marker.style.left = f * 100 + '%';
      tagSwatch.className = 'swatch tier-' + hr.tier;
      const when = isNow
        ? 'Now ' + clock(now)
        : (hr.date === d.today ? '' : stripDay(hr.date).split(' ')[0] + ' ') + timeOf(hr.startMs);
      tagText.textContent = when + ' · ' + NAMES[hr.tier][2];
      marker.setAttribute('aria-valuenow', String(i));
      marker.setAttribute('aria-valuetext', tagText.textContent);
    };

    // One haptic tick per hour step — the "dented" feel.
    const go = (i) => {
      const next = Math.min(Math.max(i, 0), hours.length - 1);
      if (next === index) return;
      index = next;
      place(index, false);
      haptic();
    };

    const hold = () => {
      scrub.holding = true;
      clearTimeout(scrub.returnTimer);
    };

    // After letting go the marker stays a moment so the time can be read,
    // then glides back to now and any redraw that waited is done.
    const letGo = () => {
      clearTimeout(scrub.returnTimer);
      scrub.returnTimer = setTimeout(() => {
        index = 0;
        place(0, true);
        scrub.holding = false;
        if (scrub.pendingRender) {
          scrub.pendingRender = false;
          setTimeout(render, 300);
        }
      }, SCRUB_RETURN_MS);
    };

    const indexAt = (clientX) => {
      const rect = bar.getBoundingClientRect();
      const f = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 0.9999);
      return Math.floor(f * hours.length);
    };

    strip.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      hold();
      scrub.active = true;
      try { strip.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no capture */ }
      go(indexAt(e.clientX));
    });
    strip.addEventListener('pointermove', (e) => {
      if (scrub.active) go(indexAt(e.clientX));
    });
    const stop = () => {
      if (!scrub.active) return;
      scrub.active = false;
      letGo();
    };
    strip.addEventListener('pointerup', stop);
    strip.addEventListener('pointercancel', stop);
    strip.addEventListener('lostpointercapture', stop);

    marker.addEventListener('keydown', (e) => {
      const next = {
        ArrowRight: index + 1, ArrowUp: index + 1, ArrowLeft: index - 1, ArrowDown: index - 1, Home: 0, End: hours.length - 1,
      }[e.key];
      if (next == null) return;
      e.preventDefault();
      hold();
      go(next);
      letGo();
    });

    place(0, false);

    // Words inside blocks and times under them are placed right away: the strip
    // is already in the page, so reading a width forces layout. Waiting for an
    // animation frame left every time stacked at the left edge in background
    // tabs, where frames do not run.
    bar.querySelectorAll('.strip-run-label').forEach((el) => {
      el.hidden = el.getBoundingClientRect().width > el.parentElement.clientWidth - 6;
    });
    layoutLabels(labels);
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
    // Rebuilding the page mid-drag would yank the marker away; catch up after.
    if (scrub.holding) {
      scrub.pendingRender = true;
      return;
    }
    const now = Date.now();
    const d = dates(now);
    if (!dayFor(d.today) && !inflight && !state.problems[d.today]) refresh();

    const plans = [d.today, d.tomorrow].map(dayFor).filter(Boolean).map((day) => C.planDay(day, CFG));
    const o = plans.length ? C.outlook(plans, now, CFG) : null;
    const hours = plans.reduce((all, p) => all.concat(p.hours), []).sort((a, b) => a.startMs - b.startMs);

    byId('today-label').textContent = T.dayLabel(d.today);
    document.querySelectorAll('#clock-toggle button').forEach((b) => {
      b.setAttribute('aria-pressed', String((b.dataset.hour12 === 'true') === state.hour12));
    });
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
  state.hour12 = readStore('hour12') === true;
  document.querySelectorAll('#clock-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      state.hour12 = b.dataset.hour12 === 'true';
      writeStore('hour12', state.hour12);
      render();
    });
  });
  render();
  refresh();
  // Redraw on the minute, so the "Now 23:31" tag never lags behind the clock.
  setTimeout(() => {
    render();
    setInterval(render, TICK_MS);
  }, TICK_MS - (Date.now() % TICK_MS) + 50);
  // Block widths change with the screen, and so does which words fit inside them.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });
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
