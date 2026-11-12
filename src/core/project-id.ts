/**
 * GitHub repository ids are case-insensitive. Compare persisted/handoff
 * spellings through this helper instead of exact string equality.
 */
export function sameProjectId(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.length > 0 &&
    left.toLocaleLowerCase() === right.toLocaleLowerCase();
}
