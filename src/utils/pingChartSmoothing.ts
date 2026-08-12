/**
 * Returns a display-only EWMA view of Ping samples.
 *
 * It intentionally never fills a missing sample, changes a timestamp, or
 * mutates the source rows. A gap resets the smoothing state, so values on the
 * other side of a real missing/PENDING bucket cannot influence one another.
 */
export function smoothPingChartDisplayRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  taskIds: ReadonlyArray<number>,
  alpha = 0.35,
): Array<Record<string, unknown>> {
  const normalizedAlpha = Math.min(1, Math.max(0, alpha))
  const displayRows = rows.map(row => ({ ...row }))

  for (const taskId of taskIds) {
    let previous: number | null = null

    for (const row of displayRows) {
      const rawValue = row[taskId]
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
        previous = null
        continue
      }

      const smoothed: number = previous === null
        ? rawValue
        : normalizedAlpha * rawValue + (1 - normalizedAlpha) * previous
      row[taskId] = smoothed
      previous = smoothed
    }
  }

  return displayRows
}
