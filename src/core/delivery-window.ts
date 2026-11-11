/**
 * Pure weekly delivery-window schedule.
 *
 * The router may start an automated agent dispatch only while a configured
 * window is open. An empty window list means "no window configured", which is
 * the safe default: existing installations keep running 24/7. Nothing in this
 * module reads the clock, the database or a provider; callers inject `now` and
 * the last dispatch start so the decision is deterministic and testable.
 *
 * Window boundaries are wall-clock times in an explicit IANA time zone:
 * the start is inclusive and the end is exclusive. A window whose end is at or
 * before its start crosses midnight; `days` names the weekday on which that
 * window opens. Overlapping windows are allowed (union semantics).
 */

export const DELIVERY_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DeliveryDay = (typeof DELIVERY_DAYS)[number];

export interface DeliveryWindow {
  /** Weekday on which the window opens, in the configured zone. */
  days: DeliveryDay[];
  /** Minutes since local midnight, inclusive. */
  startMinute: number;
  /** Minutes since local midnight, exclusive; earlier than start crosses midnight. */
  endMinute: number;
}

export interface DeliverySchedule {
  /** Explicit IANA zone (or `UTC`). Null only when no windows are configured. */
  timezone: string | null;
  /** Normalized weekly windows. Empty means 24/7 with no window restriction. */
  windows: DeliveryWindow[];
  /** Global start-to-start cooldown in milliseconds; 0 disables it. */
  cooldownMs: number;
}

export interface RawDeliveryWindow {
  days?: string[] | string;
  start?: string;
  end?: string;
}

export interface RawDeliverySettings {
  timezone?: string;
  windows?: RawDeliveryWindow[];
  cooldown_ms?: number;
}

export const DEFAULT_DELIVERY_SCHEDULE: DeliverySchedule = {
  timezone: null,
  windows: [],
  cooldownMs: 0,
};

/** A week is long enough to cover every weekly schedule while bounding validation. */
export const MAX_DELIVERY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DELIVERY_WINDOWS = 64;

const DAY_ORDER: Record<DeliveryDay, number> = {
  mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6,
};

const DAY_ALIASES = new Map<string, DeliveryDay>([
  ['mon', 'mon'], ['monday', 'mon'],
  ['tue', 'tue'], ['tues', 'tue'], ['tuesday', 'tue'],
  ['wed', 'wed'], ['wednesday', 'wed'],
  ['thu', 'thu'], ['thur', 'thu'], ['thurs', 'thu'], ['thursday', 'thu'],
  ['fri', 'fri'], ['friday', 'fri'],
  ['sat', 'sat'], ['saturday', 'sat'],
  ['sun', 'sun'], ['sunday', 'sun'],
]);

const DAY_GROUPS: Record<string, DeliveryDay[]> = {
  daily: [...DELIVERY_DAYS],
  weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  weekends: ['sat', 'sun'],
};

const ALLOWED_KEYS = new Set(['timezone', 'windows', 'cooldown_ms']);
const ALLOWED_WINDOW_KEYS = new Set(['days', 'start', 'end']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unsupported field "${key}"`);
  }
}

function canonicalDay(value: string, label: string): DeliveryDay {
  const day = DAY_ALIASES.get(value.trim().toLocaleLowerCase());
  if (!day) throw new Error(`${label} has unknown day "${value}" (use mon..sun, weekdays, weekends or daily)`);
  return day;
}

function normalizeDays(value: unknown, label: string): DeliveryDay[] {
  const entries = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${label} must be a non-empty array of weekdays or one of daily, weekdays, weekends`);
  }
  if (entries.length > 7) throw new Error(`${label} has more entries than weekdays`);
  const days: DeliveryDay[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error(`${label} must contain weekday names`);
    const group = DAY_GROUPS[entry.trim().toLocaleLowerCase()];
    if (group) {
      if (entries.length !== 1) throw new Error(`${label} must use a day group on its own`);
      days.push(...group);
      continue;
    }
    days.push(canonicalDay(entry, label));
  }
  if (new Set(days).size !== days.length) throw new Error(`${label} must not repeat a weekday`);
  return [...days].sort((a, b) => DAY_ORDER[a] - DAY_ORDER[b]);
}

function parseClock(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) {
    throw new Error(`${label} must be a 24-hour HH:MM time from 00:00 to 23:59`);
  }
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function normalizeWindow(value: unknown, label: string): DeliveryWindow {
  const window = requireRecord(value, label);
  rejectUnknownKeys(window, ALLOWED_WINDOW_KEYS, label);
  if (window.days === undefined) throw new Error(`${label}.days is required`);
  if (window.start === undefined) throw new Error(`${label}.start is required`);
  if (window.end === undefined) throw new Error(`${label}.end is required`);
  const days = normalizeDays(window.days, `${label}.days`);
  const startMinute = parseClock(window.start, `${label}.start`);
  const endMinute = parseClock(window.end, `${label}.end`);
  if (startMinute === endMinute) {
    throw new Error(`${label}.start and ${label}.end must differ (use 00:00 for midnight)`);
  }
  return { days, startMinute, endMinute };
}

function assertTimeZone(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be an explicit IANA time zone such as UTC or Europe/Berlin`);
  }
  const timezone = value.trim();
  // Offset strings are not IANA zones and would silently change behavior when
  // daylight saving applies; require a named zone.
  if (/^[+-][0-9]{2}:?[0-9]{2}$/.test(timezone) || /^[+-][0-9]{2}$/.test(timezone)) {
    throw new Error(`${label} must be an IANA time zone, not a UTC offset`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`${label} "${timezone}" is not a supported IANA time zone`);
  }
  return timezone;
}

function sameWindow(a: DeliveryWindow, b: DeliveryWindow): boolean {
  return a.startMinute === b.startMinute && a.endMinute === b.endMinute &&
    a.days.length === b.days.length && a.days.every((day, index) => day === b.days[index]);
}

/**
 * Validate untrusted config and return the normalized schedule used at runtime.
 * With no `windows` (or an empty array) the schedule is always active. A
 * non-empty window list requires an explicit time zone.
 */
export function normalizeDeliverySchedule(raw: unknown, label = 'delivery'): DeliverySchedule {
  if (raw === undefined || raw === null) return { ...DEFAULT_DELIVERY_SCHEDULE, windows: [] };
  const value = requireRecord(raw, label);
  rejectUnknownKeys(value, ALLOWED_KEYS, label);
  const timezone = value.timezone === undefined ? null : assertTimeZone(value.timezone, `${label}.timezone`);
  let windows: DeliveryWindow[] = [];
  if (value.windows !== undefined) {
    if (!Array.isArray(value.windows)) throw new Error(`${label}.windows must be an array`);
    if (value.windows.length > MAX_DELIVERY_WINDOWS) {
      throw new Error(`${label}.windows must contain at most ${MAX_DELIVERY_WINDOWS} entries`);
    }
    windows = value.windows.map((entry, index) => normalizeWindow(entry, `${label}.windows[${index}]`));
    if (windows.length > 0 && !timezone) {
      throw new Error(`${label}.timezone is required when ${label}.windows is configured`);
    }
    for (let index = 0; index < windows.length; index++) {
      if (windows.slice(0, index).some((other) => sameWindow(other, windows[index]))) {
        throw new Error(`${label}.windows[${index}] duplicates an earlier window`);
      }
    }
  }
  let cooldownMs = 0;
  if (value.cooldown_ms !== undefined) {
    if (!Number.isSafeInteger(value.cooldown_ms) || (value.cooldown_ms as number) < 0 ||
        (value.cooldown_ms as number) > MAX_DELIVERY_COOLDOWN_MS) {
      throw new Error(`${label}.cooldown_ms must be an integer from 0 to ${MAX_DELIVERY_COOLDOWN_MS}`);
    }
    cooldownMs = value.cooldown_ms as number;
  }
  windows.sort((a, b) => {
    const day = DAY_ORDER[a.days[0]] - DAY_ORDER[b.days[0]];
    return day || a.startMinute - b.startMinute || a.endMinute - b.endMinute;
  });
  return { timezone, windows, cooldownMs };
}

/**
 * Validate an already-normalized schedule assembled from flags/config overrides.
 * This keeps CLI overrides on the same validation path as file configuration.
 */
export function normalizeResolvedDeliverySchedule(input: {
  timezone: string | null;
  windows: DeliveryWindow[];
  cooldownMs: number;
}, label = 'delivery'): DeliverySchedule {
  const windows: RawDeliveryWindow[] = input.windows.map((window) => ({
    days: [...window.days],
    start: clockLabel(window.startMinute),
    end: clockLabel(window.endMinute),
  }));
  return normalizeDeliverySchedule({
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.windows.length > 0 ? { windows } : {}),
    cooldown_ms: input.cooldownMs,
  }, label);
}

/**
 * Parse one `--delivery-window` flag value. Entries are separated by `;` and
 * each has the form `days=HH:MM-HH:MM`, for example
 * `weekdays=01:00-04:00;weekdays=06:00-10:00`. Days accept a group name
 * (`daily`, `weekdays`, `weekends`) or a comma-separated list (`mon,tue`).
 */
export function parseDeliveryWindowSpec(value: unknown, label = '--delivery-window'): DeliveryWindow[] {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be days=HH:MM-HH:MM entries separated by ";"`);
  }
  const entries = value.split(';').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error(`${label} must contain at least one window`);
  if (entries.length > MAX_DELIVERY_WINDOWS) throw new Error(`${label} must contain at most ${MAX_DELIVERY_WINDOWS} windows`);
  return entries.map((entry, index) => {
    const match = /^([^=]+)=(.*)$/.exec(entry);
    if (!match) throw new Error(`${label}[${index}] must be days=HH:MM-HH:MM`);
    const dayText = match[1].trim();
    const range = /^([0-9]{2}:[0-9]{2})-([0-9]{2}:[0-9]{2})$/.exec(match[2].trim());
    if (!range) throw new Error(`${label}[${index}] must be days=HH:MM-HH:MM`);
    const days = dayText.includes(',')
      ? dayText.split(',').map((day) => day.trim()).filter(Boolean)
      : dayText;
    return normalizeWindow({ days, start: range[1], end: range[2] }, `${label}[${index}]`);
  });
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: DeliveryDay;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

function weekdayOfDate(year: number, month: number, day: number): DeliveryDay {
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const names: DeliveryDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return names[index];
}

function localParts(epochMs: number, timezone: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(epochMs))) {
    if (part.type === 'literal') continue;
    values[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute, second } = values;
  return {
    year, month, day, hour, minute, second,
    weekday: weekdayOfDate(year, month, day),
  };
}

function wallClockOf(instant: number, timezone: string): number {
  const parts = localParts(instant, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function wallClockToEpoch(year: number, month: number, day: number, minuteOfDay: number, timezone: string): number {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetAt = (instant: number) => wallClockOf(instant, timezone) - Math.floor(instant / 1000) * 1000;
  // Try both offsets around a DST transition. A wall time that exists twice
  // (fall-back) opens at its first occurrence; a wall time that does not exist
  // (spring-forward gap) shifts forward to the first valid instant. This keeps
  // window boundaries deterministic instead of silently shortening a window.
  const first = wall - offsetAt(wall);
  const candidates = [...new Set([first, wall - offsetAt(first)])];
  const matches = candidates.filter((instant) => wallClockOf(instant, timezone) === wall);
  if (matches.length > 0) return Math.min(...matches);
  // Spring-forward gap: no instant has this wall time. Resolve to the first
  // valid instant after the gap so the boundary shifts forward rather than
  // silently shortening the window.
  let low = Math.min(...candidates);
  let high = Math.max(...candidates);
  if (wallClockOf(low, timezone) >= wall) return low;
  if (wallClockOf(high, timezone) < wall) return high;
  while (high - low > 1000) {
    const mid = low + Math.floor((high - low) / 2000) * 1000;
    if (mid === low) break;
    if (wallClockOf(mid, timezone) >= wall) high = mid;
    else low = mid;
  }
  return high;
}

function addCalendarDays(date: { year: number; month: number; day: number }, offset: number) {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day) + offset * 86_400_000);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function windowInterval(window: DeliveryWindow, date: { year: number; month: number; day: number },
  timezone: string): { open: number; close: number } {
  const open = wallClockToEpoch(date.year, date.month, date.day, window.startMinute, timezone);
  const closeDate = window.endMinute > window.startMinute ? date : addCalendarDays(date, 1);
  const close = wallClockToEpoch(closeDate.year, closeDate.month, closeDate.day, window.endMinute, timezone);
  return { open, close };
}

/** True when a configured window is open at `epochMs`; always true without windows. */
export function deliveryWindowActive(schedule: DeliverySchedule, epochMs: number): boolean {
  if (schedule.windows.length === 0) return true;
  if (!schedule.timezone) throw new Error('delivery schedule with windows has no time zone');
  const timezone = schedule.timezone;
  const parts = localParts(epochMs, timezone);
  const today = { year: parts.year, month: parts.month, day: parts.day };
  // Checking yesterday covers overnight windows that opened on the prior date.
  for (const offset of [0, -1]) {
    const date = addCalendarDays(today, offset);
    const weekday = weekdayOfDate(date.year, date.month, date.day);
    for (const window of schedule.windows) {
      if (!window.days.includes(weekday)) continue;
      const { open, close } = windowInterval(window, date, timezone);
      // A spring-forward gap can collapse an interval; never treat it as open.
      if (close > open && epochMs >= open && epochMs < close) return true;
    }
  }
  return false;
}

function windowTransitions(schedule: DeliverySchedule, from: number): number[] {
  if (schedule.windows.length === 0 || !schedule.timezone) return [];
  const timezone = schedule.timezone;
  const parts = localParts(from, timezone);
  const base = Date.UTC(parts.year, parts.month - 1, parts.day);
  const transitions = new Set<number>();
  // One day of look-behind covers overnight windows; eight days of look-ahead
  // guarantee the next weekly opening regardless of the current weekday.
  for (let offset = -1; offset <= 8; offset += 1) {
    const date = new Date(base + offset * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = weekdayOfDate(year, month, day);
    for (const window of schedule.windows) {
      if (!window.days.includes(weekday)) continue;
      transitions.add(wallClockToEpoch(year, month, day, window.startMinute, timezone));
      if (window.endMinute > window.startMinute) {
        transitions.add(wallClockToEpoch(year, month, day, window.endMinute, timezone));
      } else {
        const next = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
        transitions.add(wallClockToEpoch(next.getUTCFullYear(), next.getUTCMonth() + 1,
          next.getUTCDate(), window.endMinute, timezone));
      }
    }
  }
  return [...transitions].sort((a, b) => a - b);
}

function cooldownBoundary(schedule: DeliverySchedule, lastDispatchStartAt: number | null | undefined): number | null {
  if (lastDispatchStartAt === null || lastDispatchStartAt === undefined || schedule.cooldownMs <= 0) return null;
  if (!Number.isFinite(lastDispatchStartAt)) throw new Error('last dispatch start must be a finite timestamp');
  return Math.trunc(lastDispatchStartAt) + schedule.cooldownMs;
}

export type DeliveryBlockReason = 'no-window' | 'in-window' | 'outside-window' | 'cooldown';

export interface DeliveryDecision {
  /** True only when an automated dispatch may start now. */
  dispatchAllowed: boolean;
  /** A configured window is open now (or no window is configured). */
  windowActive: boolean;
  reason: DeliveryBlockReason;
  timezone: string | null;
  /** Local wall clock in the configured zone, for diagnostics only. */
  localTime: string | null;
  weekday: DeliveryDay | null;
  /** Next instant at which the window opens or closes. */
  nextChangeAt: string | null;
  /** Earliest instant at which a dispatch may start, when currently blocked. */
  retryAt: string | null;
  cooldownUntil: string | null;
}

function isoOrNull(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function localLabel(parts: LocalParts): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

/**
 * Decide whether an automated dispatch may start. `lastDispatchStartAt` is the
 * durable start-to-start cooldown anchor (the last automated turn start), not
 * its completion. Running turns may finish at window close; this function
 * only gates new starts.
 */
export function evaluateDelivery(
  schedule: DeliverySchedule,
  now: number,
  lastDispatchStartAt: number | null | undefined = null,
): DeliveryDecision {
  if (!Number.isFinite(now)) throw new Error('delivery evaluation requires a finite timestamp');
  const windowActive = deliveryWindowActive(schedule, now);
  const cooldownUntil = cooldownBoundary(schedule, lastDispatchStartAt);
  const inCooldown = cooldownUntil !== null && now < cooldownUntil;
  const reason: DeliveryBlockReason = !windowActive ? 'outside-window'
    : inCooldown ? 'cooldown'
      : schedule.windows.length === 0 ? 'no-window' : 'in-window';
  const dispatchAllowed = reason === 'no-window' || reason === 'in-window';
  const parts = schedule.timezone && schedule.windows.length > 0 ? localParts(now, schedule.timezone) : null;
  const transitions = windowTransitions(schedule, now).filter((instant) => instant > now);
  const nextChange = transitions.find((instant) => deliveryWindowActive(schedule, instant) !== windowActive) ?? null;
  let retryAt: number | null = null;
  if (!dispatchAllowed) {
    const candidates = [...transitions];
    if (cooldownUntil !== null && cooldownUntil > now) candidates.push(cooldownUntil);
    candidates.sort((a, b) => a - b);
    retryAt = candidates.find((instant) => instant > now &&
      deliveryWindowActive(schedule, instant) && (cooldownUntil === null || instant >= cooldownUntil)) ?? null;
  }
  return {
    dispatchAllowed,
    windowActive,
    reason,
    timezone: schedule.timezone,
    localTime: parts ? localLabel(parts) : null,
    weekday: parts?.weekday ?? null,
    nextChangeAt: isoOrNull(nextChange),
    retryAt: isoOrNull(retryAt),
    cooldownUntil: isoOrNull(cooldownUntil !== null && cooldownUntil > now ? cooldownUntil : null),
  };
}

function clockLabel(minuteOfDay: number): string {
  const hour = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const minute = String(minuteOfDay % 60).padStart(2, '0');
  return `${hour}:${minute}`;
}

function daysLabel(days: DeliveryDay[]): string {
  if (days.length === 7) return 'daily';
  if (days.length === 5 && days.every((day, index) => day === DELIVERY_DAYS[index])) return 'weekdays';
  if (days.length === 2 && days[0] === 'sat' && days[1] === 'sun') return 'weekends';
  return days.join(',');
}

export function formatDeliveryDuration(ms: number): string {
  if (ms === 0) return 'disabled';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/** Human-readable one-line description for help/status output. */
export function describeDeliverySchedule(schedule: DeliverySchedule): string {
  const cooldown = schedule.cooldownMs > 0 ? `; cooldown ${formatDeliveryDuration(schedule.cooldownMs)}` : '';
  if (schedule.windows.length === 0) return `24/7 (no active window)${cooldown}`;
  const windows = schedule.windows
    .map((window) => `${daysLabel(window.days)} ${clockLabel(window.startMinute)}-${clockLabel(window.endMinute)}`)
    .join(', ');
  return `${schedule.timezone}: ${windows}${cooldown}`;
}
