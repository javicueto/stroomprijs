// Run: node --test tests/
// Loads the real apps-script/ files (the generated copies included) into a
// sandbox with fake Google services, the way Apps Script loads them, and runs
// the calendar job end to end. Nothing here touches a real Google account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', 'apps-script');
const FIX = path.join(__dirname, 'fixtures');
const HOUR = 3600000;

function sandbox({ nowIso, prices = 'fixtures', fail = false }) {
  const state = { props: {}, events: [], acl: [], reminders: null, triggers: [], mail: [], fetches: 0, calendars: {} };
  let nextId = 1;

  const fetch = (url, opts) => {
    state.fetches++;
    if (fail) throw new Error('boom');
    let body = null;
    if (prices === 'fixtures') {
      const date = opts.method === 'post'
        ? JSON.parse(opts.payload).variables.d
        : new Date(Date.parse(url.match(/fromDate=([^&]+)/)[1]) + 3 * HOUR).toISOString().slice(0, 10);
      const file = path.join(FIX, `${date}_${opts.method === 'post' ? 'frank' : 'energyzero'}.json`);
      if (fs.existsSync(file)) body = fs.readFileSync(file, 'utf8');
    } else {
      body = JSON.stringify(opts.method === 'post' ? { data: { marketPrices: { electricityPrices: [] } } } : { Prices: [] });
    }
    return { getResponseCode: () => (body ? 200 : 500), getContentText: () => body };
  };

  const props = {
    getProperty: (k) => (k in state.props ? state.props[k] : null),
    setProperty: (k, v) => { state.props[k] = v; },
    deleteProperty: (k) => { delete state.props[k]; },
    getProperties: () => Object.assign({}, state.props),
  };

  const triggerBuilder = (handler) => {
    const t = { handler };
    const chain = {
      timeBased: () => chain, everyDays: (n) => ((t.everyDays = n), chain),
      atHour: (h) => ((t.hour = h), chain), inTimezone: (tz) => ((t.tz = tz), chain),
      create: () => { state.triggers.push(t); return { getHandlerFunction: () => handler }; },
    };
    return chain;
  };

  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    STROOM_PRIVATE: { shareWith: ['partner@example.com'], alertEmail: 'owner@example.com' },
    PropertiesService: { getScriptProperties: () => props },
    UrlFetchApp: { fetch },
    MailApp: { sendEmail: (to, subject, body) => state.mail.push({ to, subject, body }) },
    ScriptApp: {
      getProjectTriggers: () => state.triggers.map((t) => ({ getHandlerFunction: () => t.handler, _t: t })),
      deleteTrigger: (t) => { state.triggers = state.triggers.filter((x) => x !== t._t); },
      newTrigger: triggerBuilder,
      getScriptId: () => 'SCRIPT_ID',
    },
    Calendar: {
      Calendars: {
        get: (id) => { if (!state.calendars[id]) throw new Error('Not Found'); return state.calendars[id]; },
        insert: (res) => { const id = 'cal' + nextId++; state.calendars[id] = res; return { id }; },
      },
      Acl: {
        get: (cal, ruleId) => { const r = state.acl.find((a) => a.ruleId === ruleId); if (!r) throw new Error('Not Found'); return r; },
        insert: (res, cal, opts) => state.acl.push({ ruleId: 'user:' + res.scope.value, role: res.role, opts }),
      },
      CalendarList: { patch: (res) => { state.reminders = res.defaultReminders; } },
      Events: {
        insert: (res, cal) => state.events.push(Object.assign({ id: 'ev' + nextId++, cal }, res)),
        list: (cal, opts) => {
          const [k, v] = opts.privateExtendedProperty.split('=');
          return { items: state.events.filter((e) => e.extendedProperties.private[k] === v) };
        },
        remove: (cal, id) => { state.events = state.events.filter((e) => e.id !== id); },
      },
    },
  });
  vm.runInContext(`Date.now = () => ${Date.parse(nowIso)};`, ctx);
  // Same load order as .clasp.json filePushOrder. private-config.js is replaced by the fake above.
  for (const f of ['config.js', 'classify.js', 'describe.js', 'fetch-prices.js', 'Code.js']) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, state };
}

const eventsFor = (state, date) => state.events.filter((e) => e.extendedProperties.private.stroomDate === date);
// Objects made inside the sandbox have the sandbox's prototypes, which strict
// deep-equal treats as different. Compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('setup: creates, shares, sets reminders, installs triggers, writes today and tomorrow', () => {
  const { ctx, state } = sandbox({ nowIso: '2026-09-14T13:10:00Z' }); // 15:10 in Amsterdam
  ctx.setup();

  assert.equal(Object.keys(state.calendars).length, 1);
  assert.equal(Object.values(state.calendars)[0].summary, '⚡ Stroom');
  assert.deepEqual(state.acl.map((a) => [a.ruleId, a.role, a.opts.sendNotifications]), [['user:partner@example.com', 'reader', true]]);
  assert.deepEqual(plain(state.reminders), [{ method: 'popup', minutes: 30 }]);
  assert.deepEqual(state.triggers.map((t) => [t.handler, t.hour, t.tz]), [
    ['runDaily', 14, 'Europe/Amsterdam'], ['runDaily', 15, 'Europe/Amsterdam'], ['runDaily', 16, 'Europe/Amsterdam'],
  ]);

  const tomorrow = eventsFor(state, '2026-09-15');
  assert.ok(tomorrow.length >= 2);
  tomorrow.forEach((e) => {
    assert.equal(e.transparency, 'transparent');
    assert.deepEqual(plain(e.reminders), { useDefault: true });
    assert.equal(e.start.timeZone, 'Europe/Amsterdam');
    assert.ok(e.colorId);
  });
  assert.ok(eventsFor(state, '2026-09-14').length >= 1, 'today written from the Frank fallback');
});

test('running setup twice changes nothing: one calendar, one share, three triggers, one set of events', () => {
  const { ctx, state } = sandbox({ nowIso: '2026-09-14T13:10:00Z' });
  ctx.setup();
  const before = eventsFor(state, '2026-09-15').map((e) => e.summary);
  ctx.setup();
  ctx.rewriteTomorrow();
  assert.equal(Object.keys(state.calendars).length, 1);
  assert.equal(state.acl.length, 1);
  assert.equal(state.triggers.length, 3);
  assert.deepEqual(eventsFor(state, '2026-09-15').map((e) => e.summary), before);
});

test('runDaily: writes once, later runs that day do not refetch', () => {
  const { ctx, state } = sandbox({ nowIso: '2026-09-14T12:05:00Z' }); // 14:05
  ctx.setup();
  state.props = { CALENDAR_ID: state.props.CALENDAR_ID };
  state.events = [];
  ctx.runDaily();
  assert.ok(eventsFor(state, '2026-09-15').length >= 2);
  const fetches = state.fetches;
  ctx.runDaily();
  assert.equal(state.fetches, fetches);
  assert.equal(state.mail.length, 0);
});

test('prices late: quiet at 14:00 and 15:00, one alert email at the 16:00 run', () => {
  for (const [iso, mails] of [['2026-09-14T12:05:00Z', 0], ['2026-09-14T13:05:00Z', 0], ['2026-09-14T14:05:00Z', 1]]) {
    const { ctx, state } = sandbox({ nowIso: iso, prices: 'empty' });
    state.props.CALENDAR_ID = 'cal1';
    ctx.runDaily();
    assert.equal(state.mail.length, mails, iso);
    assert.equal(state.events.length, 0);
    if (mails) {
      assert.equal(state.mail[0].to, 'owner@example.com');
      assert.match(state.mail[0].subject, /no prices for 2026-09-15/);
      assert.match(state.mail[0].body, /EnergyZero: 0 of 24 hours/);
    }
  }
});

test('a failure on the last run emails the error instead of failing silently', () => {
  const { ctx, state } = sandbox({ nowIso: '2026-09-14T14:30:00Z', fail: true });
  state.props.CALENDAR_ID = 'cal1';
  ctx.runDaily();
  assert.equal(state.mail.length, 1);
  assert.match(state.mail[0].subject, /2026-09-15/);
});
