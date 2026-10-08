import { afterEach, describe, expect, it, vi } from "vitest";
import { getBookingAssistantConfig, isBookingAssistantEnabled } from "./config";

const stubEnv = (env: Record<string, string>) => {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
};

describe("getBookingAssistantConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when the flag is not set", () => {
    stubEnv({ BOOKING_ASSISTANT_ENABLED: "", BOOKING_ASSISTANT_API_KEY: "sk-test" });

    expect(getBookingAssistantConfig()).toBeNull();
    expect(isBookingAssistantEnabled()).toBe(false);
  });

  it.each(["0", "false", "yes"])("returns null when the flag is %s", (flag) => {
    stubEnv({ BOOKING_ASSISTANT_ENABLED: flag, BOOKING_ASSISTANT_API_KEY: "sk-test" });

    expect(getBookingAssistantConfig()).toBeNull();
  });

  it.each(["", "   "])("returns null when the API key is %j", (apiKey) => {
    stubEnv({ BOOKING_ASSISTANT_ENABLED: "1", BOOKING_ASSISTANT_API_KEY: apiKey });

    expect(getBookingAssistantConfig()).toBeNull();
    expect(isBookingAssistantEnabled()).toBe(false);
  });

  it.each(["1", "true"])("uses the default model and API URL when the flag is %s", (flag) => {
    stubEnv({
      BOOKING_ASSISTANT_ENABLED: flag,
      BOOKING_ASSISTANT_API_KEY: " sk-test ",
      BOOKING_ASSISTANT_MODEL: "",
      BOOKING_ASSISTANT_API_URL: "",
    });

    expect(getBookingAssistantConfig()).toEqual({
      apiKey: "sk-test",
      model: "claude-haiku-5-5",
      apiUrl: "https://api.anthropic.com/v1/messages",
    });
    expect(isBookingAssistantEnabled()).toBe(true);
  });

  it("uses a custom model and API URL when provided", () => {
    stubEnv({
      BOOKING_ASSISTANT_ENABLED: "1",
      BOOKING_ASSISTANT_API_KEY: "sk-test",
      BOOKING_ASSISTANT_MODEL: "custom-model",
      BOOKING_ASSISTANT_API_URL: "https://llm-proxy.example.com/v1/messages",
    });

    expect(getBookingAssistantConfig()).toEqual({
      apiKey: "sk-test",
      model: "custom-model",
      apiUrl: "https://llm-proxy.example.com/v1/messages",
    });
  });

  it("allows plain http only for a local proxy", () => {
    stubEnv({
      BOOKING_ASSISTANT_ENABLED: "1",
      BOOKING_ASSISTANT_API_KEY: "sk-test",
      BOOKING_ASSISTANT_API_URL: "http://localhost:8080/v1/messages",
    });

    expect(getBookingAssistantConfig()?.apiUrl).toBe("http://localhost:8080/v1/messages");
  });

  it.each([
    "http://llm-proxy.example.com/v1/messages",
    "not a url",
    "ftp://localhost/v1/messages",
  ])("returns null for the disallowed API URL %s", (apiUrl) => {
    stubEnv({
      BOOKING_ASSISTANT_ENABLED: "1",
      BOOKING_ASSISTANT_API_KEY: "sk-test",
      BOOKING_ASSISTANT_API_URL: apiUrl,
    });

    expect(getBookingAssistantConfig()).toBeNull();
  });
});
