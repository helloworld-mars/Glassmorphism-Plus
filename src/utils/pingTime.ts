import { CACHE_CONFIG } from '@/constants/cache'

export interface PingTimeWindow {
  start: number
  end: number
  bucketCount: number
  bucketWidth: number
}

const NUMERIC_TIMESTAMP_PATTERN = /^[-+]?\d+(?:\.\d+)?$/
const RFC3339_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i
const EPOCH_SECONDS_THRESHOLD = 100_000_000_000
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000
export const PING_TIME_WINDOW_ALIGNMENT_MS = CACHE_CONFIG.nodePingSummary.historyBucketAlignment

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function normalizeNumericTimestamp(value: number): number | null {
  if (!Number.isFinite(value))
    return null

  const milliseconds = Math.abs(value) < EPOCH_SECONDS_THRESHOLD
    ? value * 1000
    : value
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > MAX_DATE_TIMESTAMP_MS)
    return null

  return Math.trunc(milliseconds)
}

function parseRfc3339Timestamp(value: string): number | null {
  const match = RFC3339_TIMESTAMP_PATTERN.exec(value)
  if (!match)
    return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, matchedOffset] = match
  const offset = matchedOffset ?? ''
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
    return null
  if (hour > 23 || minute > 59 || second > 59)
    return null
  if (offset !== 'Z' && offset !== 'z') {
    const offsetHours = Number(offset.slice(1, 3))
    const offsetMinutes = Number(offset.slice(4, 6))
    if (offsetHours > 23 || offsetMinutes > 59)
      return null
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

/**
 * Converts Komari's RFC3339 timestamps, Unix seconds, or Unix milliseconds
 * into epoch milliseconds. Invalid or ambiguous non-date values are rejected.
 */
export function parsePingTimestampMs(value: unknown): number | null {
  if (typeof value === 'number')
    return normalizeNumericTimestamp(value)

  if (typeof value !== 'string')
    return null

  const raw = value.trim()
  if (!raw)
    return null
  if (NUMERIC_TIMESTAMP_PATTERN.test(raw))
    return normalizeNumericTimestamp(Number(raw))

  return parseRfc3339Timestamp(raw)
}

export function createPingTimeWindow(start: number, end: number, bucketCount: number): PingTimeWindow | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isSafeInteger(bucketCount) || bucketCount <= 0)
    return null
  if (end <= start)
    return null

  const bucketWidth = (end - start) / bucketCount
  if (!Number.isFinite(bucketWidth) || bucketWidth <= 0)
    return null

  return { start, end, bucketCount, bucketWidth }
}

/**
 * Creates a trailing window whose exclusive end is the next bucket boundary.
 * A sample at the current aligned boundary is therefore included in the window.
 */
export function createNextAlignedPingTimeWindow(
  now: number,
  hours: number,
  bucketCount: number,
): PingTimeWindow | null {
  if (!Number.isFinite(now) || !Number.isFinite(hours) || hours <= 0)
    return null

  const duration = hours * 60 * 60 * 1000
  const bucketWidth = duration / bucketCount
  if (!Number.isFinite(bucketWidth) || bucketWidth <= 0)
    return null

  const end = (Math.floor(now / PING_TIME_WINDOW_ALIGNMENT_MS) + 1) * PING_TIME_WINDOW_ALIGNMENT_MS
  return createPingTimeWindow(end - duration, end, bucketCount)
}

/** Returns the bucket index for a timestamp in the strict half-open [start, end) interval. */
export function getPingTimeBucketIndex(timestamp: number, window: PingTimeWindow): number | null {
  if (!Number.isFinite(timestamp) || timestamp < window.start || timestamp >= window.end)
    return null

  const index = Math.floor((timestamp - window.start) / window.bucketWidth)
  return index >= 0 && index < window.bucketCount ? index : null
}

export function isPingTimestampInWindow(timestamp: number, window: PingTimeWindow): boolean {
  return getPingTimeBucketIndex(timestamp, window) !== null
}
