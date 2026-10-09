// Kept free of server-only imports so the Booker UI can share the same limits.
export const BOOKING_ASSISTANT_LIMITS = {
  maxQueryLength: 200,
  maxSuggestions: 3,
  maxDaysAhead: 90,
  // Bounds slot-engine work per request to about one month, however broad the booker's request is.
  maxRangeDays: 31,
  requestTimeoutMs: 5000,
  // The expected JSON answer is well under 100 tokens; the headroom covers verbose models.
  maxOutputTokens: 300,
  // A normal provider response is about 1-2 KB, so anything far larger is not a usable answer.
  maxResponseBytes: 16_384,
} as const;
