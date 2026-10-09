import { BOOKING_ASSISTANT_DI_TOKENS } from "@calcom/features/booking-assistant/di/tokens";
import { getBookingAssistantConfig } from "@calcom/features/booking-assistant/lib/config";
import { BookingAssistantService } from "@calcom/features/booking-assistant/services/BookingAssistantService";
import { LlmSlotRequestParser } from "@calcom/features/booking-assistant/services/LlmSlotRequestParser";
import { createCompletionClient } from "@calcom/features/booking-assistant/services/providers/createCompletionClient";
import { getAvailableSlotsService } from "@calcom/features/di/containers/AvailableSlots";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { Container } from "@evyweb/ioctopus";
import { createModule, type ModuleLoader } from "../di";

const token: symbol = BOOKING_ASSISTANT_DI_TOKENS.BOOKING_ASSISTANT_SERVICE;
const moduleToken: symbol = BOOKING_ASSISTANT_DI_TOKENS.BOOKING_ASSISTANT_SERVICE_MODULE;

const loadModule = (container: Container) => {
  const thisModule = createModule();
  thisModule.bind(token).toFactory(() => {
    const config = getBookingAssistantConfig();
    if (!config) {
      throw new ErrorWithCode(
        ErrorCode.InternalServerError,
        "Unable to create the booking assistant service: the feature is disabled or misconfigured"
      );
    }
    return new BookingAssistantService({
      slotRequestParser: new LlmSlotRequestParser({ client: createCompletionClient(config) }),
      // Reuses the existing slot engine container instead of re-wiring its dependencies.
      availableSlots: getAvailableSlotsService(),
    });
  });

  container.load(moduleToken, thisModule);
};

export const moduleLoader: ModuleLoader = {
  token,
  loadModule,
};
