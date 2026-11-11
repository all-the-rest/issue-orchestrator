import assert from 'node:assert/strict';
import {
  DEFAULT_DELIVERY_SCHEDULE,
  MAX_DELIVERY_COOLDOWN_MS,
  deliveryWindowActive,
  describeDeliverySchedule,
  evaluateDelivery,
  formatDeliveryDuration,
  normalizeDeliverySchedule,
  normalizeResolvedDeliverySchedule,
  parseDeliveryWindowSpec,
} from '../dist/core/delivery-window.js';

const at = (text) => Date.parse(text);
const iso = (text) => new Date(text).toISOString();

// No configured window is the default: existing installations stay 24/7.
assert.deepEqual(normalizeDeliverySchedule(undefined), DEFAULT_DELIVERY_SCHEDULE);
assert.deepEqual(normalizeDeliverySchedule({}), DEFAULT_DELIVERY_SCHEDULE);
assert.deepEqual(normalizeDeliverySchedule({ windows: [] }), DEFAULT_DELIVERY_SCHEDULE);
assert.equal(normalizeDeliverySchedule(null).windows.length, 0);
assert.equal(deliveryWindowActive(normalizeDeliverySchedule({ timezone: 'UTC', windows: [] }),
  at('2026-11-14T02:00:00Z')), true, 'an empty window list stays 24/7 even with a zone');
for (const moment of ['2026-11-09T00:00:00Z', '2026-11-09T03:17:42Z', '2026-11-15T23:59:59Z']) {
  const decision = evaluateDelivery(DEFAULT_DELIVERY_SCHEDULE, at(moment));
  assert.equal(decision.dispatchAllowed, true, `${moment} must be dispatchable without a window`);
  assert.equal(decision.reason, 'no-window');
  assert.equal(decision.nextChangeAt, null);
  assert.equal(decision.cooldownUntil, null);
}

// Operator example from issue #67: DeepSeek off-peak, weekdays UTC 01:00-04:00
// and 06:00-10:00; all other hours and weekends are outside the window.
const deepseekRaw = {
  timezone: 'UTC',
  windows: [
    { days: 'weekdays', start: '01:00', end: '04:00' },
    { days: 'weekdays', start: '06:00', end: '10:00' },
  ],
};
const deepseek = normalizeDeliverySchedule(deepseekRaw);
assert.deepEqual(deepseek.windows[0].days, ['mon', 'tue', 'wed', 'thu', 'fri']);
assert.equal(deepseek.windows[0].startMinute, 60);
assert.equal(deepseek.windows[0].endMinute, 240);

const boundaryCases = [
  ['2026-11-09T00:59:59Z', false, 'before the first weekday window'],
  ['2026-11-09T01:00:00Z', true, 'window start is inclusive'],
  ['2026-11-09T03:59:59Z', true, 'inside the first window'],
  ['2026-11-09T04:00:00Z', false, 'window end is exclusive'],
  ['2026-11-09T05:59:59Z', false, 'between weekday windows'],
  ['2026-11-09T06:00:00Z', true, 'second window start'],
  ['2026-11-09T09:59:59Z', true, 'near the second window end'],
  ['2026-11-09T10:00:00Z', false, 'second window end'],
  ['2026-11-13T09:00:00Z', true, 'Friday is a weekday'],
  ['2026-11-14T02:00:00Z', false, 'Saturday has no window'],
  ['2026-11-15T09:00:00Z', false, 'Sunday has no window'],
];
for (const [moment, expected, label] of boundaryCases) {
  assert.equal(deliveryWindowActive(deepseek, at(moment)), expected, label);
  assert.equal(evaluateDelivery(deepseek, at(moment)).dispatchAllowed, expected, label);
}

// A blocked decision reports the next opening, and an open decision reports the close.
let decision = evaluateDelivery(deepseek, at('2026-11-09T00:30:00Z'));
assert.equal(decision.reason, 'outside-window');
assert.equal(decision.nextChangeAt, iso('2026-11-09T01:00:00Z'));
assert.equal(decision.retryAt, iso('2026-11-09T01:00:00Z'));
assert.equal(decision.localTime, '2026-11-09T00:30:00');
assert.equal(decision.weekday, 'mon');
decision = evaluateDelivery(deepseek, at('2026-11-09T01:00:00Z'));
assert.equal(decision.reason, 'in-window');
assert.equal(decision.nextChangeAt, iso('2026-11-09T04:00:00Z'));
assert.equal(decision.retryAt, null);
decision = evaluateDelivery(deepseek, at('2026-11-09T10:00:00Z'));
assert.equal(decision.nextChangeAt, iso('2026-11-10T01:00:00Z'),
  'after the last weekday window the next change is the next weekday opening');

// Overnight windows open on the listed day and close on the following local day.
const overnight = normalizeDeliverySchedule({
  timezone: 'UTC',
  windows: [{ days: ['mon'], start: '22:00', end: '02:00' }],
});
for (const [moment, expected] of [
  ['2026-11-09T21:59:59Z', false],
  ['2026-11-09T22:00:00Z', true],
  ['2026-11-10T01:59:59Z', true],
  ['2026-11-10T02:00:00Z', false],
  ['2026-11-10T22:00:00Z', false],
  ['2026-11-16T22:00:00Z', true],
]) assert.equal(deliveryWindowActive(overnight, at(moment)), expected, moment);
assert.equal(evaluateDelivery(overnight, at('2026-11-09T23:00:00Z')).nextChangeAt,
  iso('2026-11-10T02:00:00Z'));
assert.equal(evaluateDelivery(overnight, at('2026-11-10T03:00:00Z')).retryAt,
  iso('2026-11-16T22:00:00Z'), 'the next opening can be a week away');

// Explicit IANA zones apply DST, unlike a fixed UTC offset.
const newYork = normalizeDeliverySchedule({
  timezone: 'America/New_York',
  windows: [{ days: 'weekdays', start: '09:00', end: '17:00' }],
});
for (const [moment, expected, label] of [
  ['2026-01-05T13:59:59Z', false, 'winter before 09:00 EST'],
  ['2026-01-05T14:00:00Z', true, 'winter 09:00 EST'],
  ['2026-01-05T21:59:59Z', true, 'winter 16:59:59 EST'],
  ['2026-01-05T22:00:00Z', false, 'winter 17:00 EST'],
  ['2026-07-06T12:59:59Z', false, 'summer before 09:00 EDT'],
  ['2026-07-06T13:00:00Z', true, 'summer 09:00 EDT'],
  ['2026-07-06T20:59:59Z', true, 'summer 16:59:59 EDT'],
  ['2026-07-06T21:00:00Z', false, 'summer 17:00 EDT'],
  ['2026-03-09T13:00:00Z', true, 'Monday after the US spring-forward is 09:00 EDT'],
]) assert.equal(deliveryWindowActive(newYork, at(moment)), expected, label);

// DST folds and gaps keep boundaries deterministic.
const fallBack = normalizeDeliverySchedule({
  timezone: 'America/New_York',
  windows: [{ days: ['sun'], start: '01:30', end: '03:30' }],
});
for (const [moment, expected, label] of [
  ['2026-11-01T05:29:59Z', false, 'before the first 01:30 EDT occurrence'],
  ['2026-11-01T05:30:00Z', true, 'window opens at the first 01:30 EDT occurrence'],
  ['2026-11-01T06:30:00Z', true, 'the repeated 01:30 EST hour stays inside the window'],
  ['2026-11-01T08:29:59Z', true, 'last second before 03:30 EST closes'],
  ['2026-11-01T08:30:00Z', false, 'window closes at 03:30 EST'],
]) assert.equal(deliveryWindowActive(fallBack, at(moment)), expected, label);
assert.equal(evaluateDelivery(fallBack, at('2026-11-01T05:30:00Z')).nextChangeAt,
  iso('2026-11-01T08:30:00Z'));
const springGap = normalizeDeliverySchedule({
  timezone: 'America/New_York',
  windows: [{ days: ['sun'], start: '02:30', end: '04:00' }],
});
for (const [moment, expected, label] of [
  ['2026-03-08T06:30:00Z', false, '01:30 EST is before the shifted start'],
  ['2026-03-08T06:59:59Z', false, 'the nonexistent 02:30 wall time has not been reached'],
  ['2026-03-08T07:00:00Z', true, 'a nonexistent 02:30 boundary shifts forward to 03:00 EDT'],
  ['2026-03-08T07:59:59Z', true, 'inside the shortened Sunday window'],
  ['2026-03-08T08:00:00Z', false, '04:00 EDT closes the window'],
]) assert.equal(deliveryWindowActive(springGap, at(moment)), expected, label);
assert.equal(evaluateDelivery(springGap, at('2026-03-08T06:30:00Z')).retryAt,
  iso('2026-03-08T07:00:00Z'), 'the gap retry matches the shifted opening');

// Cooldown blocks a new start even inside an open window.
const always = normalizeDeliverySchedule({ cooldown_ms: 60_000 });
const noon = at('2026-11-09T12:00:30Z');
decision = evaluateDelivery(always, noon, at('2026-11-09T12:00:00Z'));
assert.equal(decision.reason, 'cooldown');
assert.equal(decision.dispatchAllowed, false);
assert.equal(decision.cooldownUntil, iso('2026-11-09T12:01:00Z'));
assert.equal(decision.retryAt, iso('2026-11-09T12:01:00Z'));
assert.equal(evaluateDelivery(always, at('2026-11-09T12:00:59.999Z'), at('2026-11-09T12:00:00Z')).dispatchAllowed, false);
assert.equal(evaluateDelivery(always, at('2026-11-09T12:01:00Z'), at('2026-11-09T12:00:00Z')).dispatchAllowed, true,
  'cooldown ends exactly at last start plus cooldown');
assert.equal(evaluateDelivery(always, noon, null).dispatchAllowed, true, 'no recorded start means no cooldown');
assert.equal(evaluateDelivery(normalizeDeliverySchedule({ cooldown_ms: 0 }), noon, at('2026-11-09T12:00:29Z')).dispatchAllowed,
  true, 'cooldown 0 disables the limit');

// Outside a window takes precedence over cooldown, but retry never precedes the cooldown.
decision = evaluateDelivery(deepseek, at('2026-11-09T00:30:00Z'), at('2026-11-09T00:29:30Z'));
assert.equal(decision.reason, 'outside-window');
assert.equal(decision.retryAt, iso('2026-11-09T01:00:00Z'));
// A cooldown that outlives the window pushes the retry to the next window opening.
const deepseekCooldown = normalizeDeliverySchedule({ ...deepseekRaw, cooldown_ms: 60_000 });
decision = evaluateDelivery(deepseekCooldown, at('2026-11-09T03:59:30Z'), at('2026-11-09T03:59:00Z'));
assert.equal(decision.reason, 'cooldown');
assert.equal(decision.cooldownUntil, iso('2026-11-09T04:00:00Z'));
assert.equal(decision.retryAt, iso('2026-11-09T06:00:00Z'),
  'the 04:00 close ends the current window before the cooldown expires');
assert.equal(evaluateDelivery(normalizeDeliverySchedule({ cooldown_ms: 300_000 }), noon, at('2026-11-09T12:00:00Z'))
  .cooldownUntil, iso('2026-11-09T12:05:00Z'));

// Validation is strict and reports the offending path.
const rejects = [
  [{ windows: [{ days: ['mon'], start: '01:00', end: '02:00' }] }, /timezone is required/],
  [{ timezone: 'Mars/Olympus', windows: [{ days: ['mon'], start: '01:00', end: '02:00' }] }, /not a supported IANA/],
  [{ timezone: '+02:00', windows: [{ days: ['mon'], start: '01:00', end: '02:00' }] }, /IANA time zone, not a UTC offset/],
  [{ timezone: 'UTC', windows: 'daily' }, /windows must be an array/],
  [{ timezone: 'UTC', windows: [{ days: ['funday'], start: '01:00', end: '02:00' }] }, /unknown day/],
  [{ timezone: 'UTC', windows: [{ days: [], start: '01:00', end: '02:00' }] }, /non-empty array/],
  [{ timezone: 'UTC', windows: [{ days: ['mon', 'monday'], start: '01:00', end: '02:00' }] }, /must not repeat/],
  [{ timezone: 'UTC', windows: [{ days: ['mon'], start: '24:00', end: '02:00' }] }, /HH:MM/],
  [{ timezone: 'UTC', windows: [{ days: ['mon'], start: '9:00', end: '10:00' }] }, /HH:MM/],
  [{ timezone: 'UTC', windows: [{ days: ['mon'], start: '01:60', end: '02:00' }] }, /HH:MM/],
  [{ timezone: 'UTC', windows: [{ days: ['mon'], start: '01:00', end: '01:00' }] }, /must differ/],
  [{ timezone: 'UTC', windows: [{ days: ['mon'], start: '01:00', end: '02:00', body: 'x' }] }, /unsupported field/],
  [{ timezone: 'UTC', windows: [{ days: ['mon'], start: '01:00' }] }, /end is required/],
  [{ timezone: 'UTC', windows: [{ start: '01:00', end: '02:00' }] }, /days is required/],
  [{ timezone: 'UTC', windows: [{ days: ['mon'], start: '01:00', end: '02:00' }], extra: true }, /unsupported field/],
  [{ timezone: 'UTC', cooldown_ms: -1 }, /cooldown_ms must be an integer/],
  [{ timezone: 'UTC', cooldown_ms: 1.5 }, /cooldown_ms must be an integer/],
  [{ timezone: 'UTC', cooldown_ms: MAX_DELIVERY_COOLDOWN_MS + 1 }, /cooldown_ms must be an integer/],
  [{ timezone: 'UTC', windows: [
    { days: ['mon'], start: '01:00', end: '02:00' },
    { days: ['monday'], start: '01:00', end: '02:00' },
  ] }, /duplicates an earlier window/],
];
for (const [raw, pattern] of rejects) {
  assert.throws(() => normalizeDeliverySchedule(raw), pattern, JSON.stringify(raw));
}
assert.throws(() => normalizeDeliverySchedule([]), /must be an object/);
assert.throws(() => normalizeDeliverySchedule({ timezone: 'UTC', windows: new Array(65).fill(
  { days: ['mon'], start: '01:00', end: '02:00' }) }), /at most 64 entries/);

// Weekday aliases and groups normalize deterministically.
assert.deepEqual(normalizeDeliverySchedule({ timezone: 'UTC', windows: [
  { days: 'weekends', start: '10:00', end: '12:00' },
] }).windows[0].days, ['sat', 'sun']);
assert.deepEqual(normalizeDeliverySchedule({ timezone: 'UTC', windows: [
  { days: ['FRIDAY', 'Monday'], start: '10:00', end: '12:00' },
] }).windows[0].days, ['mon', 'fri']);
assert.deepEqual(normalizeDeliverySchedule({ timezone: 'UTC', windows: [
  { days: 'daily', start: '10:00', end: '12:00' },
] }).windows[0].days, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

// CLI flag parsing uses the same validator as config.
assert.deepEqual(parseDeliveryWindowSpec('weekdays=01:00-04:00;weekdays=06:00-10:00').map((window) => [
  window.days.join(','), window.startMinute, window.endMinute,
]), [
  ['mon,tue,wed,thu,fri', 60, 240],
  ['mon,tue,wed,thu,fri', 360, 600],
]);
assert.deepEqual(parseDeliveryWindowSpec('sat,sun=10:00-12:00')[0].days, ['sat', 'sun']);
assert.deepEqual(parseDeliveryWindowSpec(' mon = 22:00-02:00 ')[0], {
  days: ['mon'], startMinute: 1320, endMinute: 120,
});
assert.deepEqual(normalizeResolvedDeliverySchedule({
  timezone: 'UTC',
  windows: [{ days: ['mon'], startMinute: 60, endMinute: 240 }],
  cooldownMs: 60_000,
}), {
  timezone: 'UTC',
  windows: [{ days: ['mon'], startMinute: 60, endMinute: 240 }],
  cooldownMs: 60_000,
}, 'resolved CLI/config overrides use the same validation path');
assert.throws(() => normalizeResolvedDeliverySchedule({
  timezone: null, windows: [{ days: ['mon'], startMinute: 60, endMinute: 240 }], cooldownMs: 0,
}), /timezone is required/);
for (const [spec, pattern] of [
  ['', /must be days=HH:MM-HH:MM/],
  ['weekdays', /must be days=HH:MM-HH:MM/],
  ['weekdays=1:00-4:00', /must be days=HH:MM-HH:MM/],
  ['funday=01:00-02:00', /unknown day/],
  ['weekdays=01:00-01:00', /must differ/],
]) assert.throws(() => parseDeliveryWindowSpec(spec), pattern, spec);

// Help/status rendering is stable and shows safe defaults.
assert.equal(describeDeliverySchedule(DEFAULT_DELIVERY_SCHEDULE), '24/7 (no active window)');
assert.equal(describeDeliverySchedule(normalizeDeliverySchedule({ cooldown_ms: 600_000 })),
  '24/7 (no active window); cooldown 10m');
assert.equal(describeDeliverySchedule(deepseek), 'UTC: weekdays 01:00-04:00, weekdays 06:00-10:00');
assert.equal(describeDeliverySchedule(overnight), 'UTC: mon 22:00-02:00');
assert.equal(formatDeliveryDuration(0), 'disabled');
assert.equal(formatDeliveryDuration(1_500), '1500ms');
assert.equal(formatDeliveryDuration(90_000), '90s');
assert.equal(formatDeliveryDuration(600_000), '10m');
assert.equal(formatDeliveryDuration(3_600_000), '1h');

console.log('delivery windows validate, evaluate boundaries, time zones and cooldown');
