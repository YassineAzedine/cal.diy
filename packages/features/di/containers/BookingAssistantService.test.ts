import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetAvailableSlotsService } = vi.hoisted(() => ({
  mockGetAvailableSlotsService: vi.fn(() => ({ getAvailableSlots: vi.fn() })),
}));

// Keeps the test away from the real slot engine container, which needs Prisma and Redis.
vi.mock("@calcom/features/di/containers/AvailableSlots", () => ({
  getAvailableSlotsService: mockGetAvailableSlotsService,
}));

const enabledEnv = {
  BOOKING_ASSISTANT_ENABLED: "1",
  BOOKING_ASSISTANT_PROVIDER: "openrouter",
  BOOKING_ASSISTANT_API_KEY: "sk-or-test",
  BOOKING_ASSISTANT_MODEL: "example-org/example-model",
};

const importContainer = async () => {
  vi.resetModules();
  return import("./BookingAssistantService");
};

describe("getBookingAssistantService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockGetAvailableSlotsService.mockClear();
  });

  it("returns null and builds nothing while the feature is disabled", async () => {
    vi.stubEnv("BOOKING_ASSISTANT_ENABLED", "0");
    const { getBookingAssistantService } = await importContainer();

    expect(getBookingAssistantService()).toBeNull();
    expect(mockGetAvailableSlotsService).not.toHaveBeenCalled();
  });

  it("returns null when the feature is enabled but misconfigured", async () => {
    for (const [key, value] of Object.entries({ ...enabledEnv, BOOKING_ASSISTANT_MODEL: "" })) {
      vi.stubEnv(key, value);
    }
    const { getBookingAssistantService } = await importContainer();

    expect(getBookingAssistantService()).toBeNull();
  });

  it("builds the service once with the existing slot engine when enabled", async () => {
    for (const [key, value] of Object.entries(enabledEnv)) {
      vi.stubEnv(key, value);
    }
    const { getBookingAssistantService } = await importContainer();
    const { BookingAssistantService } = await import(
      "@calcom/features/booking-assistant/services/BookingAssistantService"
    );

    const service = getBookingAssistantService();

    expect(service).toBeInstanceOf(BookingAssistantService);
    expect(getBookingAssistantService()).toBe(service);
    expect(mockGetAvailableSlotsService).toHaveBeenCalledTimes(1);
  });
});
