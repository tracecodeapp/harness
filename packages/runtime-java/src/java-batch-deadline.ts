/** The guest timer excludes JVM process creation, retirement and kernel staging. */
export function javaBatchTransportDeadlineMs(
  perCaseWallClockMs: number,
  caseCount: number,
  lifecycleBudgetMs: number,
): number {
  // Keep the transport watchdog finite without overflowing setTimeout's range.
  return Math.min(2_147_483_647, lifecycleBudgetMs + perCaseWallClockMs * caseCount);
}
