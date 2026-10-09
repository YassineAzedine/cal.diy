import { getBookingAssistantConfig } from "@calcom/features/booking-assistant/lib/config";
import type { BookingAssistantService } from "@calcom/features/booking-assistant/services/BookingAssistantService";
import { createContainer } from "../di";
import { moduleLoader as bookingAssistantServiceModuleLoader } from "../modules/BookingAssistantService";

const bookingAssistantServiceContainer = createContainer();
bookingAssistantServiceModuleLoader.loadModule(bookingAssistantServiceContainer);

/**
 * Returns null while the feature is off, checked on every call so a disabled or misconfigured
 * instance never builds a client holding the API key.
 */
export function getBookingAssistantService(): BookingAssistantService | null {
  if (!getBookingAssistantConfig()) return null;
  return bookingAssistantServiceContainer.get<BookingAssistantService>(
    bookingAssistantServiceModuleLoader.token
  );
}
