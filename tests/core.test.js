// Run: node --test tests/
// Tests the generated web/ copies' source (shared/) against real Eneco and
// market data. Fixtures are real API responses saved on 14 Sep 2026.
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
  const { day, source } = feeds.loadDaySync('2026-09-15', fixtureFetch('2026-09-15'), config.tariff);
  const plan = core.planDay(day, config);
  const events = text.eventsForPlan(plan, config, source);

  // Checked by hand against the hourly prices: 06–08h are €0.41–0.43 (above
  // the €0.40 rail), 11–15h are the five hours ≥ €0.04 below the €0.35
  // average, 18–21h are €0.40–0.46.
  assert.deepEqual(events.map((e) => e.title), [
    '🔴 Duur · Avoid 06:00–09:00 · €0.41–0.43',
    '🟢 Goedkoop · Cheap 11:00–16:00 · €0.18–0.26',
    '🔴 Duur · Avoid 18:00–22:00 · €0.40–0.46',
  ]);
  assert.match(events[0].description, /^• Dishwasher \(eco, 3h\): €0\.42 · €0\.19 at 12:00$/m);
  assert.match(events[0].description, /^Start before 06:00, or wait until 09:00\.$/m);
  // The cheapest 3 hours sit inside a cheap window, so no separate ⭐ event.
  assert.equal(plan.showBest, false);
  assert.ok(events.every((e) => !e.title.startsWith('⭐')));
  // Every hour of the day is listed once in each description.
  events.forEach((e) => assert.equal((e.description.match(/^\d\d:00 {2}/gm) || []).length, 24));
});

test('14 Sep 2026: the lone cheap hour at 04:00 is dropped, and the hour list agrees', () => {
  const { day, source } = feeds.loadDaySync('2026-09-14', (req) => {
    if (req.method !== 'post') throw new Error('offline');
    return fixture('2026-09-14_frank.json');
  }, config.tariff);
  const plan = core.planDay(day, config);
  const events = text.eventsForPlan(plan, config, source);
  assert.deepEqual(events.map((e) => e.title), [
    '🔴 Duur · Avoid 06:00–10:00 · €0.42–0.50',
    '🟢 Goedkoop · Cheap 12:00–17:00 · €0.33–0.35',
    '🔴 Duur · Avoid 18:00–23:00 · €0.43–0.62',
  ]);
  assert.equal(plan.hours.find((h) => h.label === '04:00').tier, 'normal');
  assert.match(events[0].description, /^04:00 {2}€0\.36$/m);
});

test('a single free hour is still shown', () => {
  const start = core.dayRange('2026-05-10').start;
  const rows = Array.from({ length: 24 }, (_, i) => ({ startMs: start + i * HOUR, spotExVat: i === 13 ? -0.01 : 0.12 }));
  const plan = core.planDay(core.buildDay('2026-05-10', rows, config.tariff), config);
  assert.deepEqual(plan.windows.map((w) => [w.tier, w.hours.length]), [['free', 1]]);
});

test('event text: format, 24:00 at day end, curly apostrophes only', () => {
  const start = core.dayRange('2026-09-15').start;
  // €0.25 all day, then a €0.74 spike for the last three hours. Every normal
  // hour ties for cheapest and sits well below the day's average, so all of
  // them are cheap.
  const rows = Array.from({ length: 24 }, (_, i) => ({ startMs: start + i * HOUR, spotExVat: i >= 21 ? 0.5 : 0.1 }));
  const plan = core.planDay(core.buildDay('2026-09-15', rows, config.tariff), config);
  const events = text.eventsForPlan(plan, config, 'EnergyZero');
  assert.deepEqual(events.map((e) => e.title), [
    '🟢 Goedkoop · Cheap 00:00–21:00 · €0.25',
    '🔴 Duur · Avoid 21:00–24:00 · €0.74',
  ]);
  assert.match(events[1].description, /^Avoid starting: dishwasher, washing machine and dryer\.\nStart before 21:00\.$/m);
  events.forEach((e) => assert.ok(!/'/.test(e.title + e.description), 'straight apostrophe in ' + e.title));
});

test('flat day: no cheap or expensive events, only the best 3 hours', () => {
  const start = core.dayRange('2026-12-02').start;
  const rows = Array.from({ length: 24 }, (_, i) => ({ startMs: start + i * HOUR, spotExVat: i >= 3 && i < 6 ? 0.08 : 0.1 }));
  const plan = core.planDay(core.buildDay('2026-12-02', rows, config.tariff), config);
  assert.equal(plan.stats.flat, true);
  const events = text.eventsForPlan(plan, config, 'EnergyZero');
  assert.deepEqual(events.map((e) => e.title), ['⭐ Beste tijd · Best 3h 03:00–06:00 · €0.23']);
  assert.match(events[0].description, /^Flat day — prices barely change, so timing matters little\.$/m);
});

test('free hours: negative market price, title shows what you still pay', () => {
  const start = core.dayRange('2026-05-10').start;
  const rows = Array.from({ length: 24 }, (_, i) => ({ startMs: start + i * HOUR, spotExVat: i >= 12 && i < 15 ? -0.06 : 0.12 }));
  const plan = core.planDay(core.buildDay('2026-05-10', rows, config.tariff), config);
  const free = text.eventsForPlan(plan, config).find((e) => e.kind === 'free');
  assert.equal(free.title, '🆓 Gratis · Free power 12:00–15:00 · €0.06');
  assert.match(free.description, /charge laptops and phones and power banks/);
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
  assert.equal(text.span(o.nextGood.startMs, o.nextGood.endMs, o.nextGood.hours[0].date), '11:00–16:00');
  assert.equal(o.nextGood.hours[0].date, '2026-09-15');
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
