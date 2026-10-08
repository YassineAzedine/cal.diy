import process from "node:process";

const DEFAULT_MODEL = "claude-haiku-5-5";
const DEFAULT_API_URL = "https://api.anthropic.com/v1/messages";
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

export type BookingAssistantConfig = {
  apiKey: string;
  model: string;
  apiUrl: string;
};

const isTruthyFlag = (value: string | undefined) => value === "1" || value === "true";

// The API key is sent to this URL, so plain http is only allowed for a local proxy.
const isAllowedApiUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && LOCAL_HOSTNAMES.includes(url.hostname);
  } catch {
    return false;
  }
};

/**
 * Server-only. Returns null whenever the assistant must stay off, so a half-configured
 * self-hosted instance degrades to the normal Booker instead of erroring.
 */
export function getBookingAssistantConfig(): BookingAssistantConfig | null {
  if (!isTruthyFlag(process.env.BOOKING_ASSISTANT_ENABLED)) return null;

  const apiKey = process.env.BOOKING_ASSISTANT_API_KEY?.trim();
  if (!apiKey) return null;

  const apiUrl = process.env.BOOKING_ASSISTANT_API_URL?.trim() || DEFAULT_API_URL;
  if (!isAllowedApiUrl(apiUrl)) return null;

  return {
    apiKey,
    model: process.env.BOOKING_ASSISTANT_MODEL?.trim() || DEFAULT_MODEL,
    apiUrl,
  };
}

export function isBookingAssistantEnabled(): boolean {
  return getBookingAssistantConfig() !== null;
}
