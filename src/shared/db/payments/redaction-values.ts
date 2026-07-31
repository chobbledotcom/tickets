import * as v from "valibot";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type {
  PaymentCaseEvidence,
  PaymentCompletion,
} from "#shared/db/payments/types.ts";
import type { PaymentCompletion as StoredPaymentCompletion } from "#shared/payment-completion.ts";
import {
  type PaymentResolution,
  PaymentResolutionSchema,
} from "#shared/payment-state/lifecycle.ts";
import type {
  PaymentObservation,
  ProviderRead,
} from "#shared/payment-state/observation.ts";

export const redactBookingIntent = (intent: BookingIntent): BookingIntent => ({
  address: "",
  date: null,
  email: "",
  items: intent.items,
  modifiers: [],
  name: "",
  phone: "",
  special_instructions: "",
});

const redactObservation = (
  observation: PaymentObservation,
): PaymentObservation => ({
  ...observation,
  bookingIntent: redactBookingIntent(observation.bookingIntent),
});

const redactProviderRead = (read: ProviderRead): ProviderRead =>
  read.status === "found"
    ? { ...read, observation: redactObservation(read.observation) }
    : read;

export const redactPaymentResolution = (
  resolution: PaymentResolution,
): PaymentResolution =>
  v.parse(
    PaymentResolutionSchema,
    "observation" in resolution && resolution.observation !== undefined
      ? {
          ...resolution,
          observation: redactObservation(resolution.observation),
        }
      : resolution,
  );

export const redactPaymentCompletion = (
  completion: StoredPaymentCompletion,
): PaymentCompletion =>
  completion.kind === "booking"
    ? {
        ...completion,
        facts: {
          ...completion.facts,
          promos: completion.facts.promos.map((promo) => ({
            ...promo,
            name: "",
          })),
        },
        input: redactBookingIntent(completion.input),
      }
    : {
        ...completion,
        facts: {
          ...completion.facts,
          spec: { ...completion.facts.spec, detail: "", reason: "" },
        },
        input: redactBookingIntent(completion.input),
      };

export const redactPaymentCaseEvidence = (
  evidence: PaymentCaseEvidence,
): PaymentCaseEvidence => {
  if ("items" in evidence) return redactBookingIntent(evidence);
  if ("kind" in evidence && evidence.kind === "provider_read") {
    return { ...evidence, read: redactProviderRead(evidence.read) };
  }
  return evidence;
};
