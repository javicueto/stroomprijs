/*
 * Stroom — date words for the page: "2026-09-15" → "Tue 15 Sep".
 *
 * Single source of truth — edit here in shared/ only.
 */
var StroomText = (function () {
  'use strict';

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function dayLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return WEEKDAYS[wd] + ' ' + d + ' ' + MONTHS[m - 1];
  }

  const api = { dayLabel: dayLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
