import type { ValidatedSession } from "#routes/api/webhook-types.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { queryAll } from "#shared/db/client.ts";
import type {
  BookingIntent,
  PaymentProviderType,
  SessionMetadata,
} from "#shared/payments.ts";

export const intentFor = (
  listingId: number,
  quantity = 1,
  price = 1000,
): BookingIntent => ({
  address: "",
  date: null,
  email: "staged-runtime@example.com",
  items: [{ e: listingId, p: price * quantity, q: quantity }],
  modifiers: [],
  name: "Staged Runtime",
  phone: "",
  special_instructions: "",
});

export const paidSession = (
  sessionId: string,
  intent: BookingIntent,
): ValidatedSession => {
  const amount = intent.items.reduce((total, item) => total + item.p, 0);
  return {
    intent,
    session: {
      amountTotal: amount,
      id: sessionId,
      metadata: {} as SessionMetadata,
      paymentReference: `payment-${sessionId}`,
      paymentStatus: "paid",
    },
    verdict: { agreed: amount, verdict: "trusted" },
  };
};

export const stageSession = async (
  sessionId: string,
  intent: BookingIntent,
  provider: PaymentProviderType = "stripe",
): Promise<number> => {
  const result = await attendeesApi.createStagedCheckoutAtomic(
    {
      address: intent.address,
      bookings: intent.items.map((item) => ({
        date: null,
        durationDays: 1,
        listingId: item.e,
        quantity: 0,
      })),
      email: intent.email,
      name: intent.name,
      phone: intent.phone,
      special_instructions: intent.special_instructions,
    },
    {
      paymentSessionId: sessionId,
      provider,
      providerCheckoutId: `checkout-${sessionId}`,
    },
  );
  assert(result.success, "Could not stage test checkout");
  return result.attendees[0]!.id;
};

export const attendeeIds = (): Promise<{ id: number }[]> =>
  queryAll<{ id: number }>("SELECT id FROM attendees ORDER BY id", []);

import { assert } from "@std/assert";
