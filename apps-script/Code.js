/**
 * ⚡ Stroom — writes tomorrow’s free / cheap / expensive electricity windows
 * into a shared Google Calendar, every afternoon.
 *
 * StroomCore, StroomText, StroomFeeds, STROOM_CONFIG and STROOM_PRIVATE are
 * generated copies — edit shared/ and config/, then run scripts/sync_shared.sh.
 *
 * Run by hand:  setup()           once — calendar, sharing, reminders, triggers
 *               rewriteTomorrow() force a fresh write for tomorrow
 *               rewriteToday()    same for today
 */

const TZ = 'Europe/Amsterdam';

function setup() {
  const calendarId = ensureCalendar_();
  shareCalendar_(calendarId);
  setOwnReminders_(calendarId);
  installTriggers_();
  const today = StroomCore.todayLocal(Date.now());
  console.log('today', writeDay_(today));
  console.log('tomorrow', writeDay_(StroomCore.addDays(today, 1)));
}

function rewriteTomorrow() {
  console.log(writeDay_(StroomCore.addDays(StroomCore.todayLocal(Date.now()), 1)));
}

function rewriteToday() {
  console.log(writeDay_(StroomCore.todayLocal(Date.now())));
}

// Trigger handler. Installed for each hour in config.calendar.runHours. The
// first run that finds tomorrow’s prices writes the events; later runs that
// day do nothing. Only the last run of the day raises an alert — earlier
// misses are normal when prices publish late.
function runDaily() {
  const now = Date.now();
  const tomorrow = StroomCore.addDays(StroomCore.todayLocal(now), 1);
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('written:' + tomorrow)) return;

  const isLastRun = StroomCore.localParts(now).hour >= Math.max.apply(null, STROOM_CONFIG.calendar.runHours);
  try {
    const result = writeDay_(tomorrow);
    if (!result.written && isLastRun) {
      alert_('no prices for ' + tomorrow, 'No complete price data was found.\n\n' + result.notes.join('\n'));
    }
  } catch (e) {
    console.error(e);
    if (isLastRun) alert_('failed for ' + tomorrow, String(e.stack || e));
  }
  forgetOldDays_(props, now);
}

// Private run link (web app). Lets a trusted caller rewrite today or tomorrow
// without opening the editor. The secret key is never stored in this project:
// only its SHA-256 hash (STROOM_PRIVATE.runTokenSha256). The response is a
// status line only — never event contents.
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (!STROOM_PRIVATE.runTokenSha256 || sha256Hex_(params.token || '') !== STROOM_PRIVATE.runTokenSha256) {
    return text_('forbidden');
  }
  const today = StroomCore.todayLocal(Date.now());
  const target = { rewriteToday: today, rewriteTomorrow: StroomCore.addDays(today, 1) }[params.fn];
  if (!target) return text_('unknown fn');
  try {
    const result = writeDay_(target);
    return text_(result.written ? 'ok ' + target + ' ' + result.events.length + ' events' : 'no prices for ' + target);
  } catch (err) {
    console.error(err);
    return text_('error: ' + err.message);
  }
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map((b) => ((b + 256) % 256).toString(16).padStart(2, '0'))
    .join('');
}

function text_(message) {
  return ContentService.createTextOutput(message);
}

function writeDay_(dateStr) {
  const loaded = StroomFeeds.loadDaySync(dateStr, fetchJson_, STROOM_CONFIG.tariff);
  if (!loaded.day) return { written: false, date: dateStr, notes: loaded.notes };

  const plan = StroomCore.planDay(loaded.day, STROOM_CONFIG);
  const events = StroomText.eventsForPlan(plan, STROOM_CONFIG);
  const calendarId = calendarId_();

  // Insert the new set first, then remove the old one. If an insert fails,
  // the day is not marked written, so the next run replaces everything tagged
  // for that date — never a half-written day left behind.
  const oldIds = taggedEventIds_(calendarId, dateStr);
  events.forEach((ev) => {
    Calendar.Events.insert({
      summary: ev.title,
      description: ev.description,
      start: { dateTime: new Date(ev.startMs).toISOString(), timeZone: TZ },
      end: { dateTime: new Date(ev.endMs).toISOString(), timeZone: TZ },
      transparency: 'transparent',
      colorId: STROOM_CONFIG.calendar.colors[ev.kind],
      reminders: { useDefault: true },
      extendedProperties: { private: { stroomDate: dateStr } },
    }, calendarId);
  });
  oldIds.forEach((id) => Calendar.Events.remove(calendarId, id));

  PropertiesService.getScriptProperties().setProperty('written:' + dateStr, new Date().toISOString());
  return { written: true, date: dateStr, source: loaded.source, events: events.map((e) => e.title) };
}

// Only events this script wrote (tagged with stroomDate) are ever touched.
function taggedEventIds_(calendarId, dateStr) {
  const ids = [];
  let pageToken;
  do {
    const page = Calendar.Events.list(calendarId, {
      privateExtendedProperty: 'stroomDate=' + dateStr,
      maxResults: 250,
      pageToken: pageToken,
    });
    (page.items || []).forEach((item) => ids.push(item.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

function fetchJson_(req) {
  const options = { method: req.method, muteHttpExceptions: true, headers: { Accept: 'application/json' } };
  if (req.body) {
    options.contentType = 'application/json';
    options.payload = req.body;
  }
  const res = UrlFetchApp.fetch(req.url, options);
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
  return JSON.parse(res.getContentText());
}

// ---- Setup -----------------------------------------------------------------

function calendarId_() {
  const id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  if (!id) throw new Error('No calendar yet — run setup() first.');
  return id;
}

function ensureCalendar_() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty('CALENDAR_ID');
  if (existing) {
    try {
      Calendar.Calendars.get(existing);
      return existing;
    } catch (e) {
      console.warn('Stored calendar is gone, creating a new one: ' + e.message);
    }
  }
  const created = Calendar.Calendars.insert({
    summary: STROOM_CONFIG.calendar.name,
    description: STROOM_CONFIG.calendar.description,
    timeZone: TZ,
  });
  props.setProperty('CALENDAR_ID', created.id);
  return created.id;
}

// Read-only access. Google emails each person once with an “Add calendar” link.
function shareCalendar_(calendarId) {
  STROOM_PRIVATE.shareWith.forEach((email) => {
    try {
      const rule = Calendar.Acl.get(calendarId, 'user:' + email);
      if (rule && rule.role) return;
    } catch (e) {
      // Not shared yet.
    }
    Calendar.Acl.insert({ role: 'reader', scope: { type: 'user', value: email } }, calendarId, { sendNotifications: true });
  });
}

// Reminders are personal in Google Calendar: this sets them for the owner
// only. Everyone the calendar is shared with sets their own default
// notification on the calendar once (see README).
function setOwnReminders_(calendarId) {
  Calendar.CalendarList.patch({
    defaultReminders: [{ method: 'popup', minutes: STROOM_CONFIG.calendar.reminderMinutes }],
  }, calendarId);
}

function installTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'runDaily')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  STROOM_CONFIG.calendar.runHours.forEach((hour) => {
    ScriptApp.newTrigger('runDaily').timeBased().everyDays(1).atHour(hour).inTimezone(TZ).create();
  });
}

function alert_(what, body) {
  MailApp.sendEmail(STROOM_PRIVATE.alertEmail, '⚡ Stroom calendar: ' + what,
    body + '\n\nThe calendar has no events for that day. Open the script: https://script.google.com/d/' +
    ScriptApp.getScriptId() + '/edit');
}

function forgetOldDays_(props, now) {
  const cutoff = StroomCore.addDays(StroomCore.todayLocal(now), -7);
  Object.keys(props.getProperties())
    .filter((k) => k.indexOf('written:') === 0 && k.slice(8) < cutoff)
    .forEach((k) => props.deleteProperty(k));
}
