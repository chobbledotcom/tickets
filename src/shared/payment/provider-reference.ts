import * as v from "valibot";
import { type ResourceId, ResourceIdSchema } from "#payment/resource-id.ts";
import { parseOrThrow } from "#shared/validation/parse.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";
import { PaymentProviderSchema, type PaymentProviderType } from "#types";

const PAYMENT_REFERENCE_PREFIX = "payment-reference:1:";

interface PaymentReferenceBase {
  readonly reference: string;
}

/** A reference whose provider is part of its durable identity. */
export interface TaggedPaymentReference extends PaymentReferenceBase {
  readonly kind: "tagged";
  readonly provider: PaymentProviderType;
  readonly reference: ResourceId;
}

/** Name a charge by the provider that holds it and its id there. */
export const taggedPaymentReference = (
  provider: PaymentProviderType,
  reference: ResourceId,
): TaggedPaymentReference => ({ kind: "tagged", provider, reference });

/** A reference written before provider tags existed. */
export interface UntaggedPaymentReference extends PaymentReferenceBase {
  readonly kind: "untagged";
}

/** What an owner-key-encrypted payment-reference value can contain. */
export type PaymentReference =
  | TaggedPaymentReference
  | UntaggedPaymentReference;

const TaggedPaymentReferenceSchema = v.strictObject({
  kind: v.literal("tagged"),
  provider: PaymentProviderSchema,
  reference: ResourceIdSchema,
});

const storedReferenceJson = defineStoredJson(
  v.strictObject({
    provider: PaymentProviderSchema,
    reference: ResourceIdSchema,
  }),
);

const validTaggedReference = (
  reference: TaggedPaymentReference,
): TaggedPaymentReference =>
  parseOrThrow(
    TaggedPaymentReferenceSchema,
    {
      kind: reference.kind,
      provider: reference.provider,
      reference: reference.reference,
    },
    () => new Error("Invalid payment reference"),
  );

/** Store a tagged reference in the only versioned plaintext format. */
export const writePaymentReference = (
  reference: TaggedPaymentReference,
): string => {
  const valid = validTaggedReference(reference);
  return (
    PAYMENT_REFERENCE_PREFIX +
    storedReferenceJson.write({
      provider: valid.provider,
      reference: valid.reference,
    })
  );
};

/** Read the tagged format, or name an older raw value as untagged. */
export const readPaymentReference = (
  stored: string,
  context: string,
): PaymentReference => {
  if (!stored.startsWith(PAYMENT_REFERENCE_PREFIX)) {
    return { kind: "untagged", reference: stored };
  }
  const parsed = storedReferenceJson.read(
    stored.slice(PAYMENT_REFERENCE_PREFIX.length),
    context,
  );
  return { kind: "tagged", ...parsed };
};

/** Canonical plaintext to feed to the one-way reference index. */
export const paymentReferenceIndexInput = (
  reference: PaymentReference,
): string =>
  reference.kind === "tagged"
    ? writePaymentReference(reference)
    : reference.reference;
