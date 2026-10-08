// Kept free of server-only imports so the Booker UI can share the same limits.
export const BOOKING_ASSISTANT_LIMITS = {
  maxQueryLength: 200,
  maxSuggestions: 3,
  maxDaysAhead: 90,
  // Bounds slot-engine work per request to about one month, however broad the booker's request is.
  maxRangeDays: 31,
  requestTimeoutMs: 5000,
} as const;
