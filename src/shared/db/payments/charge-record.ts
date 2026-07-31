import * as v from "valibot";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { paymentStoredJson } from "#shared/db/payments/codecs.ts";
import {
  type LegacyPaymentCharge,
  LegacyPaymentChargeSchema,
  type PaymentCharge,
  PaymentChargeSchema,
  type StoredPaymentCharge,
  StoredPaymentIntegerSchema,
} from "#shared/db/payments/types.ts";
import { PaymentRefundStateSchema } from "#shared/payment-state/lifecycle.ts";
import {
  type ProviderChargeResource,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import { PaymentProviderSchema } from "#shared/types.ts";

export const PAYMENT_CHARGE_COLUMNS = [
  "id",
  "payment_id",
  "origin",
  "provider",
  "resource_kind",
  "provider_reference",
  "captured_amount",
  "currency",
  "refunded_amount",
  "refund_state",
  "pending_refund_id",
  "pending_refund_idempotency_key",
  "provider_refunded_at",
  "legacy_source",
  "created_at",
  "updated_at",
  "observed_at",
] as const;

interface StoredChargeBase {
  created_at: number;
  id: number;
  legacy_source: string | null;
  observed_at: number;
  payment_id: string;
  pending_refund_id: EnvKeyEncrypted | null;
  pending_refund_idempotency_key: EnvKeyEncrypted | null;
  provider_refunded_at: string | null;
  updated_at: number;
}

export interface StoredCurrentChargeRow extends StoredChargeBase {
  captured_amount: number;
  currency: string;
  legacy_source: null;
  origin: "current";
  provider: v.InferOutput<typeof PaymentProviderSchema>;
  provider_reference: EnvKeyEncrypted;
  refund_state: v.InferOutput<typeof PaymentRefundStateSchema>;
  refunded_amount: number;
  resource_kind: ProviderChargeResource["kind"];
}

export interface StoredLegacyChargeRow extends StoredChargeBase {
  captured_amount: null;
  currency: null;
  legacy_source: string;
  origin: "legacy";
  provider: null;
  provider_reference: string;
  refund_state: "unknown";
  refunded_amount: null;
  resource_kind: null;
}

export type StoredChargeRow = StoredCurrentChargeRow | StoredLegacyChargeRow;

const StoredChargeRowSchema = v.strictObject({
  captured_amount: v.nullable(StoredPaymentIntegerSchema),
  created_at: StoredPaymentIntegerSchema,
  currency: v.nullable(v.string()),
  id: StoredPaymentIntegerSchema,
  legacy_source: v.nullable(v.string()),
  observed_at: StoredPaymentIntegerSchema,
  origin: v.picklist(["current", "legacy"]),
  payment_id: ResourceIdSchema,
  pending_refund_id: v.nullable(v.string()),
  pending_refund_idempotency_key: v.nullable(v.string()),
  provider: v.nullable(PaymentProviderSchema),
  provider_reference: v.string(),
  provider_refunded_at: v.nullable(v.string()),
  refund_state: v.union([PaymentRefundStateSchema, v.literal("unknown")]),
  refunded_amount: v.nullable(StoredPaymentIntegerSchema),
  resource_kind: v.nullable(
    v.picklist([
      "stripe_payment_intent",
      "square_payment",
      "sumup_transaction",
    ]),
  ),
  updated_at: StoredPaymentIntegerSchema,
});

const sharedChargeFields = (row: StoredChargeBase) => ({
  createdAt: row.created_at,
  id: row.id,
  observedAt: row.observed_at,
  paymentId: row.payment_id,
  updatedAt: row.updated_at,
});

const readCurrentCharge = async (
  row: StoredCurrentChargeRow,
): Promise<PaymentCharge> => {
  const [providerReference, pendingRefund, idempotencyKey] = await Promise.all([
    paymentStoredJson.chargeResource.open(
      row.provider_reference,
      `payment_charges.provider_reference for ${row.id}`,
    ),
    row.pending_refund_id === null
      ? null
      : paymentStoredJson.refundResource.open(
          row.pending_refund_id,
          `payment_charges.pending_refund_id for ${row.id}`,
        ),
    row.pending_refund_idempotency_key === null
      ? null
      : decrypt(row.pending_refund_idempotency_key),
  ]);
  if (providerReference.provider !== row.provider) {
    throw new Error(
      `Invalid stored charge resource for payment charge ${row.id}`,
    );
  }
  return v.parse(PaymentChargeSchema, {
    ...sharedChargeFields(row),
    captured: { amount: row.captured_amount, currency: row.currency },
    pendingRefund,
    pendingRefundIdempotencyKey: idempotencyKey,
    providerReference,
    refunded: { amount: row.refunded_amount, currency: row.currency },
    refundState: row.refund_state,
  });
};

export function readStoredPaymentCharge(
  row: StoredCurrentChargeRow,
): Promise<PaymentCharge>;
export function readStoredPaymentCharge(
  row: StoredLegacyChargeRow,
): Promise<LegacyPaymentCharge>;
export function readStoredPaymentCharge(
  row: StoredChargeRow,
): Promise<StoredPaymentCharge>;
export function readStoredPaymentCharge(
  row: StoredChargeRow,
): Promise<StoredPaymentCharge> {
  v.parse(StoredChargeRowSchema, row);
  return row.origin === "current"
    ? readCurrentCharge(row)
    : Promise.resolve(
        v.parse(LegacyPaymentChargeSchema, {
          ...sharedChargeFields(row),
          providerReference: row.provider_reference,
          providerRefundedAt: row.provider_refunded_at,
          refundState: row.refund_state,
          source: row.legacy_source,
        }),
      );
}
