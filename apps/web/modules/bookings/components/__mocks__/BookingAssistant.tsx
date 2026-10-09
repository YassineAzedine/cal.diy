import { vi } from "vitest";

vi.mock("../BookingAssistant", () => ({
  BookingAssistant: () => <div data-testid="booking-assistant">Mock Booking Assistant</div>,
}));
