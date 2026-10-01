// Pooled tokens belong to volunteers, so we never lend one out once it is
// running low, no matter who spent the requests (us, them, or another app).
// A token with this many requests left or fewer is left alone until GitHub
// resets its hourly window.
export const MIN_REMAINING = 4_000;

export function hasBudget(remaining: number): boolean {
  return remaining > MIN_REMAINING;
}

// Emergency only: when no token in the pool is above MIN_REMAINING, the token
// endpoint may lend one with more than this many requests left, and alerts the
// maintainer. Never go below it.
export const EMERGENCY_MIN_REMAINING = 1_000;

export function hasEmergencyBudget(remaining: number): boolean {
  return remaining > EMERGENCY_MIN_REMAINING;
}
