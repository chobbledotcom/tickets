/**
 * Shared fixtures for the migration-readiness tests: the ciphertext brand
 * helpers, the row builders, and the canonical "good" diagnose input.
 */

import type { EnvKeyEncrypted, OwnerKeyEncrypted } from "#crypto/sealed.ts";
import type {
  CheckoutStageRow,
  DiagnoseInput,
  ProcessedPaymentRow,
  SumupCheckoutRow,
} from "#shared/migration-readiness/readiness.ts";

/** Re-exported so test files can brand string literals as owner-key ciphertext
 *  without each importing the sealed type. */
export type { OwnerKeyEncrypted };

export const enc = (s: string): OwnerKeyEncrypted => s as OwnerKeyEncrypted;

/** Brands a string literal as env-key ciphertext so tests can hand a corrupt
 *  value to a field the row types as encrypted. */
export const envEnc = (s: string): EnvKeyEncrypted => s as EnvKeyEncrypted;

export const stage = (over: Partial<CheckoutStageRow>): CheckoutStageRow => ({
  attendee_id: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  payment_session_id: "sess-1",
  provider: "stripe",
  state: "completed",
  ...over,
});

export const processed = (
  over: Partial<ProcessedPaymentRow>,
): ProcessedPaymentRow => ({
  attendee_id: 1,
  failure_data: "",
  payment_reference: "",
  payment_session_id: "sess-1",
  processed_at: "2026-01-01T00:00:00.000Z",
  provider_refunded_at: "",
  ticket_tokens: "",
  ...over,
});

export const sumupCheckout = (
  over: Partial<SumupCheckoutRow>,
): SumupCheckoutRow => ({
  created_at: "2026-01-01T00:00:00.000Z",
  metadata: "encrypted-metadata",
  reference_index: "idx-1",
  sumup_id: "su-1",
  wrapped_key: "wrapped-key",
  ...over,
});

export const goodInput = (
  over: Partial<DiagnoseInput> = {},
): DiagnoseInput => ({
  attendeeIds: new Set([1]),
  attendees: [{ id: 1, pii_blob: enc("hyb:1:x") }],
  ownerKeyAvailable: true,
  processed: [processed({ provider_refunded_at: "2026-01-02T00:00:00.000Z" })],
  stages: [stage({})],
  sumup: [sumupCheckout({})],
  undecryptableFailureData: new Set(),
  undecryptablePaymentReferences: new Set(),
  undecryptablePii: new Set(),
  undecryptableTicketTokens: new Set(),
  ...over,
});

/** A no-owner-key input with one `legacy-merge:*` row on attendee 1 (no PII).
 *  The charge reference is encrypted or empty, which is the fact under test. */
export const mergeRefNoOwnerInput = (
  ref: string,
  charge: OwnerKeyEncrypted | "",
): DiagnoseInput =>
  goodInput({
    attendeeIds: new Set([1]),
    attendees: [{ id: 1, pii_blob: "" }],
    ownerKeyAvailable: false,
    processed: [
      processed({
        attendee_id: 1,
        payment_reference: charge,
        payment_session_id: ref,
      }),
    ],
    stages: [],
  });
