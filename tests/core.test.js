// Run: node --test tests/
// Tests the shared price logic (the source of web/shared/) against real Eneco
// and market data. Fixtures are real API responses saved on 14 Sep 2026.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../shared/classify.js');
const text = require('../shared/describe.js');
const feeds = require('../shared/fetch-prices.js');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/tariff.json'), 'utf8'));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const HOUR = 3600000;

// Pretend fetch: serves the saved responses for the matching source.
function fixtureFetch(date) {
  return (req) => (req.method === 'post' ? fixture(date + '_frank.json') : fixture(date + '_energyzero.json'));
}

// "06:00", and "24:00" for the very end of the day.
function hhmm(ms, date) {
  if (ms === core.dayRange(date).end) return '24:00';
  const lp = core.localParts(ms);
  return core.pad(lp.hour) + ':' + core.pad(lp.minute);
}

// Windows as "expensive 06:00–09:00" — easy to read and compare.
function windowList(plan) {
  return plan.windows.map((w) => w.tier + ' ' + hhmm(w.startMs, plan.date) + '–' + hhmm(w.endMs, plan.date));
}

test('reproduces the two prices Mijn Eneco showed on 14 Sep 2026', () => {
  const { day, source } = feeds.loadDaySync('2026-09-14', (req) => {
    if (req.method !== 'post') throw new Error('offline');
    return fixture('2026-09-14_frank.json');
  }, config.tariff);
  assert.equal(source, 'Frank Energie');
  const at = (iso) => day.hours.find((h) => h.startMs === Date.parse(iso)).allIn;
  // "Je stroomprijs tot 23:00 is € 0,42834" (22:00 local) and "vanaf 23:00 € 0,39031".
  assert.ok(Math.abs(at('2026-09-14T20:00:00Z') - 0.42834) < 0.00001, at('2026-09-14T20:00:00Z'));
  assert.ok(Math.abs(at('2026-09-14T21:00:00Z') - 0.39031) < 0.00001, at('2026-09-14T21:00:00Z'));
});

test('Amsterdam local time matches the Intl time zone database, every hour 2025–2028', () => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  for (let ms = Date.UTC(2025, 0, 1); ms < Date.UTC(2029, 0, 1); ms += HOUR) {
    const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
    const lp = core.localParts(ms);
    assert.equal(lp.date, `${p.year}-${p.month}-${p.day}`, new Date(ms).toISOString());
    assert.equal(lp.hour, Number(p.hour), new Date(ms).toISOString());
  }
});

test('daylight-saving days have 23 and 25 hours', () => {
  const len = (d) => (core.dayRange(d).end - core.dayRange(d).start) / HOUR;
  assert.equal(len('2026-03-29'), 23);
  assert.equal(len('2026-10-25'), 25);
  assert.equal(len('2026-09-15'), 24);
  assert.equal(new Date(core.dayRange('2026-09-15').start).toISOString(), '2026-09-14T22:00:00.000Z');
  assert.equal(core.addDays('2026-12-31', 1), '2027-01-01');
});

test('day labels read like "Tue 15 Sep"', () => {
  assert.equal(text.dayLabel('2026-09-15'), 'Tue 15 Sep');
  assert.equal(text.dayLabel('2027-01-01'), 'Fri 1 Jan');
});

test('both feeds give the same day, to a hundredth of a cent', () => {
  const ez = feeds.loadDaySync('2026-09-15', (req) => {
    if (req.method === 'post') throw new Error('not this one');
    return fixture('2026-09-15_energyzero.json');
  }, config.tariff);
  const fr = feeds.loadDaySync('2026-09-15', (req) => {
    if (req.method !== 'post') throw new Error('offline');
    return fixture('2026-09-15_frank.json');
  }, config.tariff);
  assert.equal(ez.source, 'EnergyZero');
  assert.equal(fr.source, 'Frank Energie');
  assert.equal(ez.day.hours.length, 24);
  ez.day.hours.forEach((h, i) => assert.ok(Math.abs(h.allIn - fr.day.hours[i].allIn) < 0.0001, h.label));
});

test('a feed with no data yet falls through to the next, then reports why', () => {
  const r = feeds.loadDaySync('2026-09-16', () => ({ Prices: [], data: { marketPrices: null } }), config.tariff);
  assert.equal(r.day, null);
  assert.deepEqual(r.notes, ['EnergyZero: 0 of 24 hours', 'Frank Energie: unexpected response']);
});

test('15-minute prices are averaged into hours', () => {
  const start = core.dayRange('2026-09-15').start;
  const rows = [];
  for (let q = 0; q < 96; q++) rows.push({ startMs: start + q * 900000, spotExVat: (q % 4) / 10 }); // 0, .1, .2, .3
  const day = core.buildDay('2026-09-15', rows, config.tariff);
  assert.equal(day.complete, true);
  assert.ok(Math.abs(day.hours[5].spot - 0.15) < 1e-12);
});

test('tiers agree with the independent Python implementation on every day of the year', () => {
  const expected = fixture('python_tiers_12m.json');
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/spot_2025-09_2026-09_energyzero.json'), 'utf8'));
  const fixed = config.tariff.energyTaxInclVat + config.tariff.supplierMarkupInclVat;
  const days = {};
  Object.keys(raw).map((t) => Date.parse(t)).sort((a, b) => a - b).forEach((ms) => {
    const spot = raw[new Date(ms).toISOString().replace('.000Z', 'Z')];
    const d = core.localParts(ms).date;
    (days[d] = days[d] || []).push({ startMs: ms, spot: spot, allIn: spot + fixed });
  });
  let checked = 0;
  for (const [date, tiers] of Object.entries(expected)) {
    const got = core.classify(days[date], config.tiers).hours.map((h) => h.tier);
    assert.deepEqual(got, tiers, date);
    checked++;
  }
  assert.ok(checked >= 360, `only ${checked} days`);
});

test('15 Sep 2026: morning peak, cheap midday, expensive evening', () => {
  const { day } = feeds.loadDaySync('2026-09-15', fixtureFetch('2026-09-15'), config.tariff);
  const plan = core.planDay(day, config);

  // Checked by hand against the hourly prices: 06–08h are €0.41–0.43 (above
  // the €0.40 rail), 11–15h are the five hours ≥ €0.04 below the €0.35
  // average, 18–21h are €0.40–0.46.
  assert.deepEqual(windowList(plan), ['expensive 06:00–09:00', 'cheap 11:00–16:00', 'expensive 18:00–22:00']);
  assert.equal(hhmm(plan.best.startMs, plan.date) + '–' + hhmm(plan.best.endMs, plan.date), '12:00–15:00');
  // The cheapest 3 hours sit inside a cheap window, so no separate best window.
  assert.equal(plan.showBest, false);
});

test('14 Sep 2026: the lone cheap hour at 04:00 is dropped, and the hour list agrees', () => {
  const { day } = feeds.loadDaySync('2026-09-14', (req) => {
    if (req.method !== 'post') throw new Error('offline');
    return fixture('2026-09-14_frank.json');
  }, config.tariff);
  const plan = core.planDay(day, config);
  assert.deepEqual(windowList(plan), ['expensive 06:00–10:00', 'cheap 12:00–17:00', 'expensive 18:00–23:00']);
  assert.equal(plan.hours.find((h) => h.label === '04:00').tier, 'normal');
});

test('a single free hour is still shown', () => {
  const start = core.dayRange('2026-05-10').start;
  const rows = Array.from({ length: 24 }, (_, i) => ({ startMs: start + i * HOUR, spotExVat: i === 13 ? -0.01 : 0.12 }));
  const plan = core.planDay(core.buildDay('2026-05-10', rows, config.tariff), config);
  assert.deepEqual(plan.windows.map((w) => [w.tier, w.hours.length]), [['free', 1]]);
});

test('a long cheap stretch and an evening spike ending at midnight', () => {
  const start = core.dayRange('2026-09-15').start;
  // €0.25 all day, then a €0.74 spike for the last three hours. Every normal
  // hour ties for cheapest and sits well below the day's average, so all of
  // them are cheap.
  const rows = Array.from({ length: 24 }, (_, i) => ({ startMs: start + i * HOUR, spotExVat: i >= 21 ? 0.5 : 0.1 }));
  const plan = core.planDay(core.buildDay('2026-09-15', rows, config.tariff), config);
  assert.deepEqual(windowList(plan), ['cheap 00:00–21:00', 'expensive 21:00–24:00']);
});

test('flat day: no cheap or expensive windows, only the best 3 hours', () => {
  const start = core.dayRange('2026-12-02').start;
  const rows = Array.from({ length: 24 }, (_, i) => ({ startMs: start + i * HOUR, spotExVat: i >= 3 && i < 6 ? 0.08 : 0.1 }));
  const plan = core.planDay(core.buildDay('2026-12-02', rows, config.tariff), config);
  assert.equal(plan.stats.flat, true);
  assert.deepEqual(windowList(plan), []);
  assert.equal(plan.showBest, true);
  assert.equal(hhmm(plan.best.startMs, plan.date) + '–' + hhmm(plan.best.endMs, plan.date), '03:00–06:00');
});

test('free hours: a negative market price becomes a free window', () => {
  const start = core.dayRange('2026-05-10').start;
  const rows = Array.from({ length: 24 }, (_, i) => ({ startMs: start + i * HOUR, spotExVat: i >= 12 && i < 15 ? -0.06 : 0.12 }));
  const plan = core.planDay(core.buildDay('2026-05-10', rows, config.tariff), config);
  assert.ok(windowList(plan).includes('free 12:00–15:00'), windowList(plan).join(', '));
});

test('outlook at 22:30 on 14 Sep: now expensive, next cheap is tomorrow 11:00, dryer best at 12:00', () => {
  const load = (date) => feeds.loadDaySync(date, (req) => {
    if (req.method !== 'post') throw new Error('offline');
    return fixture(date + '_frank.json');
  }, config.tariff).day;
  const plans = ['2026-09-14', '2026-09-15'].map((d) => core.planDay(load(d), config));
  const o = core.outlook(plans, Date.parse('2026-09-14T20:30:00Z'), config);

  assert.equal(o.current.label, '22:00');
  assert.equal(o.current.date, '2026-09-14');
  assert.equal(o.currentWindow.tier, 'expensive');
  assert.equal(hhmm(o.nextGood.startMs, '2026-09-15') + '–' + hhmm(o.nextGood.endMs, '2026-09-15'), '11:00–16:00');
  assert.equal(o.nextGood.hours[0].date, '2026-09-15');
  // Now is inside today's 18–23 expensive window, so "next" is tomorrow morning's peak.
  assert.equal(hhmm(o.nextExpensive.startMs, '2026-09-15') + '–' + hhmm(o.nextExpensive.endMs, '2026-09-15'), '06:00–09:00');
  const dryer = o.appliances.find((a) => a.appliance.id === 'dryer');
  // 12–14h averages €0.1869, 13–15h €0.1874: a near tie, the earlier start wins.
  assert.equal(core.localParts(dryer.best.startMs).hour, 12);
  assert.ok(dryer.now.cost > dryer.best.cost * 2);
  assert.equal(new Date(o.knownUntilMs).toISOString(), '2026-09-15T22:00:00.000Z');

  // With only today known, nothing cheap is left and the best block starts now or later.
  const late = core.outlook(plans.slice(0, 1), Date.parse('2026-09-14T20:30:00Z'), config);
  assert.equal(late.nextGood, null);
  assert.ok(late.bestAhead === null || late.bestAhead.startMs >= Date.parse('2026-09-14T20:00:00Z'));
});

test('best start per appliance uses its own duration', () => {
  const start = core.dayRange('2026-09-15').start;
  const prices = [5, 5, 5, 1, 1, 9, 1, 1, 1, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
  const rows = prices.map((p, i) => ({ startMs: start + i * HOUR, spotExVat: p / 10 }));
  const plan = core.planDay(core.buildDay('2026-09-15', rows, config.tariff), config);
  const byId = Object.fromEntries(plan.appliances.map((a) => [a.appliance.id, a]));
  assert.equal(core.localParts(byId.washer.best.startMs).hour, 3); // 2h: 03–05 ties 06–08, earliest wins
  assert.equal(core.localParts(byId.dishwasher.best.startMs).hour, 6); // 3h: 06–09
});
