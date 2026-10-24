/**
 * Read-only migration readiness for the legacy payment tables.
 *
 * The pure rules here turn the legacy reader rows into one lossless migration
 * model and an operator-readable verdict. They never touch the aggregate
 * payment runtime or the live provider and refund paths. Callers fetch the
 * rows and report decryption failures. These rules group and diagnose over
 * what was read. The timestamp conversion lives in `timestamps.ts`.
 */

import { HYBRID_PREFIX } from "#crypto/hybrid.ts";
import type { EnvKeyEncrypted, OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { convertAllTimestamps } from "#shared/migration-readiness/timestamps.ts";

/** The session-id prefix marking a `processed_payments` row as an
 *  attendee-merge handoff of the source attendee's `payment_id`. */
export const LEGACY_MERGE_SESSION_PREFIX = "legacy-merge:";

/** One row of the legacy `processed_payments` table (migration input). The
 *  `payment_reference` is owner-key-encrypted ciphertext (or empty) and is
 *  never decoded here. */
export type ProcessedPaymentRow = {
  payment_session_id: string;
  attendee_id: number | null;
  processed_at: string;
  payment_reference: OwnerKeyEncrypted | "";
  provider_refunded_at: string;
  /** Encrypted "+"-joined ticket tokens, "" while none are stored. The
   *  redirect/webhook replay decrypts this field, so the verifier checks it. */
  ticket_tokens: EnvKeyEncrypted | "";
  /** Encrypted terminal-failure payload. Non-empty means a handled terminal
   *  outcome (refund, sold-out, price-change), distinct from an unresolved
   *  stuck reservation (attendee_id NULL + failure_data ''). These rules
   *  never decode it. The caller verifies it with the database key. */
  failure_data: EnvKeyEncrypted | "";
};

/** One row of the legacy `checkout_stages` table. */
export type CheckoutStageRow = {
  payment_session_id: string;
  attendee_id: number;
  provider: string;
  state: string;
  created_at: string;
};

/** One row of the legacy `sumup_checkouts` staging table. The booking
 *  `metadata` is reference-wrapped ciphertext. The checkout reader needs both
 *  encrypted columns to recover the staged booking metadata, so empty values
 *  block the verdict. */
export type SumupCheckoutRow = {
  reference_index: string;
  sumup_id: string;
  created_at: string;
  wrapped_key: string;
  metadata: string;
};

/** An attendee row carrying owner-key-encrypted PII (migration input). */
export type AttendeePiiSource = {
  id: number;
  pii_blob: OwnerKeyEncrypted | "";
};

/** A `processed_payments` row that hand-offs a merged attendee's `payment_id`.
 *  Its `payment_session_id` is `legacy-merge:<source attendee id>`. Its
 *  `attendee_id` is the merge target. Its `payment_reference` is the source
 *  attendee's owner-key-encrypted `payment_id`. */
export type MergeReferenceRow = ProcessedPaymentRow;

/** One provider payment after grouping. The legacy tables key each payment by
 *  `payment_session_id`. A group is the processed row (if any) plus the
 *  checkout-stage row (if any) that share it. */
export type PaymentGroup = {
  paymentSessionId: string;
  processed: ProcessedPaymentRow | null;
  stage: CheckoutStageRow | null;
};

export type ContradictionKind =
  | "checkout_stage_without_processed_payment"
  | "checkout_stage_attendee_mismatch"
  | "checkout_stage_without_attendee"
  | "processed_payment_without_attendee"
  | "undecryptable_attendee_pii"
  | "undecryptable_payment_reference"
  | "undecryptable_merge_reference"
  | "undecryptable_ticket_tokens"
  | "undecryptable_failure_data"
  | "owner_key_unavailable"
  | "unconvertible_timestamp"
  | "sumup_checkout_without_id"
  | "sumup_checkout_without_staging_ciphertext";

/** A single blocking finding. `detail` carries only non-secret identifying
 *  context (a payment session id, an attendee id, or a count) — never PII. */
export type Contradiction = {
  kind: ContradictionKind;
  detail: string;
};

export type ReadinessKind = "ready" | "blocked";

export type ReadinessCounts = {
  processedPayments: number;
  checkoutStages: number;
  sumupCheckouts: number;
  attendeePiiBlobs: number;
  mergeReferences: number;
  paymentGroups: number;
  timestampConversions: number;
};

export type ReadinessReport = {
  kind: ReadinessKind;
  counts: ReadinessCounts;
  contradictions: Contradiction[];
};

const isMergeReference = (sessionId: string): boolean =>
  sessionId.startsWith(LEGACY_MERGE_SESSION_PREFIX);
/** A `processed_payments` row that carries an owner-key-encrypted
 *  `payment_reference` — a captured charge (regular or merge-reference) that
 *  only the owner key can verify. Only hybrid ciphertext needs the key. A
 *  legacy plaintext `payment_reference` (development builds wrote the column
 *  in the clear) is not encrypted, so it does not block when the key is
 *  absent. */
const hasEncryptedPaymentReference = (
  processed: readonly ProcessedPaymentRow[],
): boolean =>
  processed.some((row) => row.payment_reference.startsWith(HYBRID_PREFIX));

/** Fold rows that share `payment_session_id` into one group. The group keeps
 *  the order in which a session first appears. `field` names the side the
 *  rows fill. The cast bridges a correlation TypeScript cannot express for a
 *  generic indexed assignment. */
const foldRowsIntoGroups = <Row extends { payment_session_id: string }>(
  bySession: Map<string, PaymentGroup>,
  order: string[],
  field: "processed" | "stage",
  rows: readonly Row[],
): void => {
  for (const row of rows) {
    const sessionId = row.payment_session_id;
    const existing = bySession.get(sessionId);
    if (existing) {
      existing[field] = row as never;
    } else {
      order.push(sessionId);
      const group: PaymentGroup = {
        paymentSessionId: sessionId,
        processed: null,
        stage: null,
      };
      group[field] = row as never;
      bySession.set(sessionId, group);
    }
  }
};

/** Build the lossless payment model by grouping each `payment_session_id` once,
 *  preserving the order a session is first seen. One group can carry a
 *  processed row, a checkout-stage row, or both. */
export const buildPaymentGroups = (
  processedRows: readonly ProcessedPaymentRow[],
  stageRows: readonly CheckoutStageRow[],
): PaymentGroup[] => {
  const order: string[] = [];
  const bySession = new Map<string, PaymentGroup>();
  foldRowsIntoGroups(bySession, order, "processed", processedRows);
  foldRowsIntoGroups(bySession, order, "stage", stageRows);
  return order.map((sessionId) => bySession.get(sessionId)!);
};

/** Inputs to the readiness verdict. The caller fetches every row and reports
 *  any decryption failures. These rules never perform IO. */
export type DiagnoseInput = {
  processed: readonly ProcessedPaymentRow[];
  stages: readonly CheckoutStageRow[];
  sumup: readonly SumupCheckoutRow[];
  attendees: readonly AttendeePiiSource[];
  /** Live attendee ids, used to prove processed-payment and checkout-stage rows
   *  still point at real attendees rather than deleted bookings. */
  attendeeIds: ReadonlySet<number>;
  /** Whether the caller supplied the owner private key and decrypted PII. When
   *  false and encrypted PII or payment references exist, the verdict blocks
   *  rather than skipping. */
  ownerKeyAvailable: boolean;
  /** Attendee ids whose `pii_blob` failed to decrypt (or parse) under the
   *  owner key. */
  undecryptablePii: ReadonlySet<number>;
  /** `payment_session_id`s of `processed_payments` rows whose
   *  `payment_reference` failed to decrypt under the owner key. Regular
   *  captured charges and merge-reference charges alike. */
  undecryptablePaymentReferences: ReadonlySet<string>;
  /** `payment_session_id`s whose non-empty `ticket_tokens` failed to decrypt
   *  with the database key. The replayed ticket state is unrecoverable. */
  undecryptableTicketTokens: ReadonlySet<string>;
  /** `payment_session_id`s whose non-empty `failure_data` failed to decrypt
   *  or parse with the database key. The stored terminal outcome is corrupt,
   *  so the row is not a proven handled failure. */
  undecryptableFailureData: ReadonlySet<string>;
};

/** A `processed_payments` row is a handled terminal failure when its attendee
 *  is null and `failure_data` is set. The payload records the handled outcome
 *  (refund, sold-out, or price-change) for idempotent replay. The caller must
 *  verify the payload under the database key first.
 *  An unresolved stuck reservation (attendee null + failure_data '') is not a
 *  terminal failure. A terminal failure is a normal stored outcome and must
 *  not block migration. A row whose `failure_data` failed the caller's
 *  verification is not a proven handled outcome, so it does not get the
 *  exemption. */
const isTerminalFailure = (
  row: ProcessedPaymentRow,
  undecryptableFailureData: ReadonlySet<string>,
): boolean =>
  row.attendee_id === null &&
  row.failure_data !== "" &&
  !undecryptableFailureData.has(row.payment_session_id);

/** When a session has both a stage and a processed payment, their live
 *  attendees must agree. A disagreement is corruption. Returns null when
 *  either side is absent, either attendee is missing or deleted, or they
 *  match. */
const stageProcessedMismatch = (
  group: PaymentGroup,
  attendeeIds: ReadonlySet<number>,
): Contradiction | null => {
  const { stage, processed } = group;
  if (!stage || !processed) return null;
  const processedAttendee = processed.attendee_id;
  if (
    processedAttendee === null ||
    !attendeeIds.has(processedAttendee) ||
    stage.attendee_id === processedAttendee
  ) {
    return null;
  }
  return {
    detail: `${stage.attendee_id} vs ${processedAttendee}`,
    kind: "checkout_stage_attendee_mismatch",
  };
};

/** Contradictions in one payment group. The findings: a checkout stage whose
 *  session has no processed payment. A stage whose attendee is deleted. A
 *  stage and processed payment that disagree on attendee. A non-terminal
 *  processed payment that points at a missing attendee. A merge-reference
 *  row's `attendee_id` is the merge target. The source is deleted by
 *  `applyAttendeeMerge` in the same batch, so no separate "source attendee"
 *  expectation exists. */
const groupContradictions = (
  group: PaymentGroup,
  attendeeIds: ReadonlySet<number>,
  undecryptableFailureData: ReadonlySet<string>,
): Contradiction[] => {
  const contradictions: Contradiction[] = [];
  if (group.stage) {
    if (!group.processed) {
      contradictions.push({
        detail: group.paymentSessionId,
        kind: "checkout_stage_without_processed_payment",
      });
    }
    if (!attendeeIds.has(group.stage.attendee_id)) {
      contradictions.push({
        detail: String(group.stage.attendee_id),
        kind: "checkout_stage_without_attendee",
      });
    }
  }
  if (
    group.processed &&
    !isTerminalFailure(group.processed, undecryptableFailureData)
  ) {
    const { attendee_id: attendeeId } = group.processed;
    if (attendeeId === null || !attendeeIds.has(attendeeId)) {
      contradictions.push({
        detail: String(attendeeId),
        kind: "processed_payment_without_attendee",
      });
    }
  }
  const mismatch = stageProcessedMismatch(group, attendeeIds);
  if (mismatch) contradictions.push(mismatch);
  return contradictions;
};

/** Fold each payment group's reference contradictions into one list. */
const referenceContradictions = (
  groups: readonly PaymentGroup[],
  attendeeIds: ReadonlySet<number>,
  undecryptableFailureData: ReadonlySet<string>,
): Contradiction[] =>
  groups.flatMap((group) =>
    groupContradictions(group, attendeeIds, undecryptableFailureData),
  );

/** One contradiction per env-key-encrypted field the caller did not decrypt.
 *  For a terminal failure payload, the field also did not parse. */
const envCiphertextContradictions = (input: DiagnoseInput): Contradiction[] => [
  ...[...input.undecryptableTicketTokens].map((sessionId) => ({
    detail: sessionId,
    kind: "undecryptable_ticket_tokens" as const,
  })),
  ...[...input.undecryptableFailureData].map((sessionId) => ({
    detail: sessionId,
    kind: "undecryptable_failure_data" as const,
  })),
];

const sumupContradictions = (
  sumup: readonly SumupCheckoutRow[],
): Contradiction[] =>
  sumup.flatMap(({ metadata, reference_index, sumup_id, wrapped_key }) => {
    const contradictions: Contradiction[] = [];
    if (sumup_id === "") {
      contradictions.push({
        detail: reference_index,
        kind: "sumup_checkout_without_id",
      });
    }
    // The checkout reader unwraps the staging key and decrypts the booking
    // metadata, so a row missing either encrypted column is not migratable.
    if (wrapped_key === "" || metadata === "") {
      contradictions.push({
        detail: reference_index,
        kind: "sumup_checkout_without_staging_ciphertext",
      });
    }
    return contradictions;
  });

/** Owner-key controls. When the key is supplied, every PII blob and every
 *  payment reference that fails to decrypt is a contradiction. The session id
 *  classifies it as a merge-reference charge or a regular captured charge.
 *  When the key is not supplied and encrypted PII or encrypted payment
 *  references exist, the migration blocks. It never skips charges it cannot
 *  verify. */
const ownerKeyContradictions = (input: DiagnoseInput): Contradiction[] => {
  if (input.ownerKeyAvailable) {
    const paymentRefFailures = [...input.undecryptablePaymentReferences].map(
      (sessionId) => ({
        detail: sessionId,
        kind: (isMergeReference(sessionId)
          ? "undecryptable_merge_reference"
          : "undecryptable_payment_reference") as ContradictionKind,
      }),
    );
    return [
      ...[...input.undecryptablePii].map((attendeeId) => ({
        detail: `attendee ${attendeeId}`,
        kind: "undecryptable_attendee_pii" as const,
      })),
      ...paymentRefFailures,
    ];
  }
  const piiCount = input.attendees.filter(
    (attendee) => attendee.pii_blob !== "",
  ).length;
  const hasCharges = hasEncryptedPaymentReference(input.processed);
  if (piiCount > 0 || hasCharges) {
    return [
      {
        detail:
          `${piiCount} encrypted attendee PII blob(s)` +
          ` and ${hasCharges ? "encrypted payment reference(s)" : "no payment references"}` +
          " cannot be verified without the owner key",
        kind: "owner_key_unavailable" as const,
      },
    ];
  }
  return [];
};

/** Turn one lossless read of the legacy payment sources into a readiness
 *  verdict. The data is `ready` only when every row is accounted for and
 *  every timestamp normalises. Every reference must point at a live attendee.
 *  The owner key must decrypt every PII blob and payment reference.
 *  Any single finding blocks the migration. The operator fixes it before a
 *  later release changes payment history. */
export const diagnoseReadiness = (input: DiagnoseInput): ReadinessReport => {
  const groups = buildPaymentGroups(input.processed, input.stages);
  const timestamp = convertAllTimestamps(
    input.processed,
    input.stages,
    input.sumup,
  );
  const contradictions: Contradiction[] = [
    ...referenceContradictions(
      groups,
      input.attendeeIds,
      input.undecryptableFailureData,
    ),
    ...sumupContradictions(input.sumup),
    ...timestamp.contradictions,
    ...ownerKeyContradictions(input),
    ...envCiphertextContradictions(input),
  ];
  const mergeReferenceCount = input.processed.filter((row) =>
    isMergeReference(row.payment_session_id),
  ).length;

  return {
    contradictions,
    counts: {
      attendeePiiBlobs: input.attendees.length,
      checkoutStages: input.stages.length,
      mergeReferences: mergeReferenceCount,
      paymentGroups: groups.length,
      processedPayments: input.processed.length,
      sumupCheckouts: input.sumup.length,
      timestampConversions: timestamp.converted,
    },
    kind: contradictions.length === 0 ? "ready" : "blocked",
  };
};
