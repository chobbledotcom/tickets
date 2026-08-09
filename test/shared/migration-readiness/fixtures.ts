/**
 * Shared fixtures for the migration-readiness tests: the type-cast helper for
 * owner-key ciphertext, the row builders, and the canonical "good" diagnose
 * input. Split out so the diagnosis suite and the formatter suite both reuse
 * them without duplication.
 */

import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import type {
  CheckoutStageRow,
  DiagnoseInput,
  ProcessedPaymentRow,
} from "#shared/migration-readiness/readiness.ts";

/** Re-exported so test files can brand string literals as owner-key ciphertext
 *  without each importing the sealed type. */
export type { OwnerKeyEncrypted };

export const enc = (s: string): OwnerKeyEncrypted => s as OwnerKeyEncrypted;

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
  sumup: [
    {
      created_at: "2026-01-01T00:00:00.000Z",
      reference_index: "idx-1",
      sumup_id: "su-1",
    },
  ],
  undecryptablePaymentReferences: new Set(),
  undecryptablePii: new Set(),
  ...over,
});

/** A no-owner-key input with one `legacy-merge:*` row on attendee 1 (no PII),
 *  varying only in whether the charge reference is encrypted or empty. Shared by
 *  the "blocks on encrypted merge charge" and "does not block on empty charge"
 *  cases so they differ in exactly the one fact under test. */
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
