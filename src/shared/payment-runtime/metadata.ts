import * as v from "valibot";
import {
  assembleCheckoutMetadata,
  enforceMetadataLimits,
  extractSessionMetadata,
  type ProviderMetadata,
  ProviderMetadataSchema,
} from "#shared/payment-helpers.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import { signPrice, verifyPrice } from "#shared/payment-signature.ts";
import { ResourceIdSchema } from "#shared/payment-state/resources.ts";
import {
  type BookingIntent,
  BookingIntentSchema,
  type SessionMetadata,
} from "#shared/payments.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/** Rebuild provider metadata from the canonical intent held by our aggregate. */
export const metadataForStoredPayment = async (
  provider: PaymentProviderType,
  value: unknown,
  total: number,
  localPaymentId: string,
): Promise<ProviderMetadata> => {
  const intent = v.parse(BookingIntentSchema, value);
  const paymentId = v.parse(ResourceIdSchema, localPaymentId);
  const caps = PAYMENT_PROVIDERS[provider].metadata;
  const maxEntries = "maxEntries" in caps ? caps.maxEntries : undefined;
  const metadata = v.parse(
    ProviderMetadataSchema,
    await assembleCheckoutMetadata(provider, total, {
      payment_id: paymentId,
    })(intent),
  );
  const logical = extractSessionMetadata(metadata);
  const signature = signPrice(
    { ...logical, local_payment_id: paymentId },
    total,
  );
  return v.parse(
    ProviderMetadataSchema,
    enforceMetadataLimits(
      {
        ...metadata,
        price_proof: `${total}.${paymentId}.${signature}`,
      },
      caps.maxValueLength,
      maxEntries,
    ),
  );
};

const parseJson = (value: string): unknown => JSON.parse(value);

const optionalJson = (value: string): unknown | undefined =>
  value === "" ? undefined : parseJson(value);

const optionalPositiveInt = (value: string): number | undefined =>
  value === "" ? undefined : Number(value);

/** Parse one provider metadata payload through the canonical booking schema. */
export const bookingIntentFromMetadata = (
  value: ProviderMetadata | SessionMetadata,
): BookingIntent | null => {
  try {
    const metadata = extractSessionMetadata(value);
    const parsed = v.safeParse(BookingIntentSchema, {
      address: metadata.address,
      allocations: optionalJson(metadata.allocations),
      balanceAttendeeId: optionalPositiveInt(metadata.balance_attendee_id),
      date: metadata.date === "" ? null : metadata.date,
      dayCount: optionalPositiveInt(metadata.day_count),
      email: metadata.email,
      items: parseJson(metadata.items),
      listingAnswerIds: optionalJson(metadata.answer_ids),
      listingTextAnswerIds: optionalJson(metadata.text_answer_ids),
      modifiers: metadata.modifiers === "" ? [] : parseJson(metadata.modifiers),
      name: metadata.name,
      phone: metadata.phone,
      reservationAmount:
        metadata.reservation_amount === ""
          ? undefined
          : metadata.reservation_amount,
      siteTokenIndex:
        metadata.site_token_index === ""
          ? undefined
          : metadata.site_token_index,
      special_instructions: metadata.special_instructions,
      thankYouUrl:
        metadata.thank_you_url === "" ? undefined : metadata.thank_you_url,
    });
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
};

export type SignedBookingIntent = {
  intent: BookingIntent;
  localPaymentId: string | null;
  signature: string;
  total: number;
};

type PriceProof = {
  localPaymentId: string | null;
  signature: string;
  total: number;
};

const parsePriceProof = (value: string): PriceProof | null => {
  const current = /^(\d+)\.([^.]+)\.(\S+)$/u.exec(value);
  if (current !== null) {
    const localPaymentId = v.safeParse(ResourceIdSchema, current[2]);
    return localPaymentId.success
      ? {
          localPaymentId: localPaymentId.output,
          signature: current[3]!,
          total: Number(current[1]),
        }
      : null;
  }
  const legacy = /^(\d+)\.(\S+)$/u.exec(value);
  return legacy === null
    ? null
    : {
        localPaymentId: null,
        signature: legacy[2]!,
        total: Number(legacy[1]),
      };
};

/** Verify signed checkout metadata, including pre-aggregate legacy checkouts. */
export const signedBookingIntentFromMetadata = async (
  value: ProviderMetadata | SessionMetadata,
): Promise<SignedBookingIntent | null> => {
  const metadata = extractSessionMetadata(value);
  const proof = parsePriceProof(metadata.price_proof);
  if (proof === null) return null;
  const { localPaymentId, signature, total } = proof;
  const signedMetadata =
    localPaymentId === null
      ? metadata
      : { ...metadata, local_payment_id: localPaymentId };
  if (
    !Number.isSafeInteger(total) ||
    !(await verifyPrice(signedMetadata, total, signature))
  ) {
    return null;
  }
  const intent = bookingIntentFromMetadata(metadata);
  return intent === null ? null : { intent, localPaymentId, signature, total };
};
