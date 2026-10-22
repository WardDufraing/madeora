/** Where a Home's points pages live (S23). */
export function pointsPath(homeId: string): string {
  return `/homes/${homeId}/points`;
}

export function rewardsPath(homeId: string): string {
  return `/homes/${homeId}/rewards`;
}

export function leaderboardPath(homeId: string): string {
  return `/homes/${homeId}/leaderboard`;
}

/** A signed amount for a ledger line: +5, -3, 0. */
export function signedPoints(amount: number): string {
  return amount > 0 ? `+${String(amount)}` : String(amount);
}
