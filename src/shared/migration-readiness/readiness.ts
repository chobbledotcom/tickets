/**
 * Read-only migration readiness for the legacy payment tables.
 *
 * The pure rules here turn the legacy reader rows (`processed_payments`,
 * `checkout_stages`, `sumup_checkouts`, attendee PII blobs, and attendee-merge
 * references) into one lossless migration model and an operator-readable
 * readiness verdict — without writing anything. They never touch the aggregate
 * payment runtime or the live provider/refund paths; they only describe whether
 * the historical data is safe to migrate in a later fleet-wide release.
 *
 * This module is pure: callers fetch the rows and report any decryption
 * failures, and these rules group, normalise, and diagnose over what was read.
 */

import { Temporal } from "temporal-polyfill";
import { HYBRID_PREFIX } from "#shared/crypto/keys.ts";
import type {
  EnvKeyEncrypted,
  OwnerKeyEncrypted,
} from "#shared/crypto/sealed.ts";
import { epochMsToIso } from "#shared/validation/timestamp.ts";

/** The session-id prefix marking a `processed_payments` row as an
 *  attendee-merge handoff of the source attendee's `payment_id`. */
export const LEGACY_MERGE_SESSION_PREFIX = "legacy-merge:";

/** One row of the legacy `processed_payments` table (migration input). The
 *  `payment_reference` is owner-key-encrypted ciphertext (or empty); it is
 *  never decoded here. */
export type ProcessedPaymentRow = {
  payment_session_id: string;
  attendee_id: number | null;
  processed_at: string;
  payment_reference: OwnerKeyEncrypted | "";
  provider_refunded_at: string;
  /** Encrypted terminal-failure payload. Non-empty means a handled terminal
   *  outcome (refund/sold-out/price-change), distinct from an unresolved
   *  stuck reservation (attendee_id NULL + failure_data ''). Never decoded. */
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
 *  `metadata` is reference-wrapped ciphertext that a DB dump alone cannot
 *  decrypt, so the readiness verdict works from the non-secret columns. */
export type SumupCheckoutRow = {
  reference_index: string;
  sumup_id: string;
  created_at: string;
};

/** An attendee row carrying owner-key-encrypted PII (migration input). */
export type AttendeePiiSource = {
  id: number;
  pii_blob: OwnerKeyEncrypted | "";
};

/** A `processed_payments` row that hand-offs a merged attendee's `payment_id`.
 *  Its `payment_session_id` is `legacy-merge:<source attendee id>`,
 *  `attendee_id` is the merge target, and `payment_reference` is the source
 *  attendee's owner-key-encrypted `payment_id`. */
export type MergeReferenceRow = ProcessedPaymentRow;

/** One provider payment after grouping: the legacy tables key each payment by
 *  `payment_session_id`, so a group is the processed row (if any) plus the
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
  | "owner_key_unavailable"
  | "unconvertible_timestamp"
  | "sumup_checkout_without_id";

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

/** Normalise a legacy stored timestamp to the canonical `…sssZ` ISO instant.
 *  Accepts ISO-8601 instants (any offset or sub-second precision) and the
 *  whole-epoch-millis strings older rows stored. Returns `""` for an empty
 *  column (a genuinely absent time is handled by the caller, which knows
 *  whether the column is required) and `null` when a value is neither a real
 *  instant nor a representable epoch-millis, so the caller can surface it
 *  instead of inventing a moment. */
export const convertLegacyTimestamp = (value: string): string | null => {
  if (value === "") return "";
  if (/^\d+$/.test(value)) {
    const epoch = Number(value);
    if (!Number.isInteger(epoch) || epoch <= 0) return null;
    try {
      return epochMsToIso(epoch);
    } catch {
      // Values outside Date's representable range (e.g. an overflowed epoch)
      // are not real instants — surface them rather than throwing.
      return null;
    }
  }
  try {
    // Temporal rejects impossible dates (month 13, Feb 30) where Date would
    // silently fix them, so it is the honest boundary for "is this a real
    // instant". Round-tripping through epoch-millis yields the canonical form.
    return epochMsToIso(Temporal.Instant.from(value).epochMilliseconds);
  } catch {
    return null;
  }
};

const isMergeReference = (sessionId: string): boolean =>
  sessionId.startsWith(LEGACY_MERGE_SESSION_PREFIX);
/** A `processed_payments` row that carries an owner-key-encrypted
 *  `payment_reference` — a captured charge (regular or merge-reference) only
 *  the owner key can verify. Only hybrid ciphertext needs the key: a legacy
 *  plaintext `payment_reference` (development builds wrote the column in the
 *  clear) is not encrypted, so it does not block when the key is absent. */
const hasEncryptedPaymentReference = (
  processed: readonly ProcessedPaymentRow[],
): boolean =>
  processed.some((row) => row.payment_reference.startsWith(HYBRID_PREFIX));

/** Convert every legacy timestamp column to a canonical instant, returning one
 *  contradiction per value that is neither a real instant nor a representable
 *  epoch-millis. `processed_at`, `checkout_stages.created_at`, and
 *  `sumup_checkouts.created_at` are NOT NULL in the schema, so an empty value
 *  is corruption; `provider_refunded_at` is optional (empty means "no refund
 *  yet") so an empty value is not a contradiction. */
const convertAllTimestamps = (
  processed: readonly ProcessedPaymentRow[],
  stages: readonly CheckoutStageRow[],
  sumup: readonly SumupCheckoutRow[],
): { contradictions: Contradiction[]; converted: number } => {
  const contradictions: Contradiction[] = [];
  let converted = 0;
  const check = (value: string, label: string, required: boolean): void => {
    if (value === "") {
      if (required) {
        contradictions.push({ detail: label, kind: "unconvertible_timestamp" });
      }
      return;
    }
    // value is non-empty here, so convertLegacyTimestamp returns either a
    // canonical ISO instant or null — never "" — so a non-null result is a
    // successful conversion (no "" literal to distinguish against).
    const result = convertLegacyTimestamp(value);
    if (result === null) {
      contradictions.push({ detail: label, kind: "unconvertible_timestamp" });
    } else {
      converted += 1;
    }
  };
  for (const row of processed) {
    check(
      row.processed_at,
      `processed_payments.processed_at = ${row.processed_at}`,
      true,
    );
    check(
      row.provider_refunded_at,
      `processed_payments.provider_refunded_at = ${row.provider_refunded_at}`,
      false,
    );
  }
  for (const row of stages) {
    check(
      row.created_at,
      `checkout_stages.created_at = ${row.created_at}`,
      true,
    );
  }
  for (const row of sumup) {
    check(
      row.created_at,
      `sumup_checkouts.created_at = ${row.created_at}`,
      true,
    );
  }
  return { contradictions, converted };
};

/** Fold rows that share `payment_session_id` into one group, keeping the order a
 *  session is first seen and filling the named side (processed/stage). `field`
 *  tracks the row type at each call site; the cast bridges a correlation
 *  TypeScript cannot express for a generic indexed assignment. */
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
 *  any owner-key decryption failures; these rules never perform IO. */
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
   *  `payment_reference` failed to decrypt under the owner key (regular
   *  captured charges and merge-reference charges alike). */
  undecryptablePaymentReferences: ReadonlySet<string>;
};

/** A `processed_payments` row is a handled terminal failure when its attendee
 *  is null but `failure_data` is set (refund/sold-out/price-change recorded for
 *  idempotent replay). Unlike an unresolved stuck reservation
 *  (attendee null + failure_data ''), a terminal failure is a normal stored
 *  outcome and must not block migration. */
const isTerminalFailure = (row: ProcessedPaymentRow): boolean =>
  row.attendee_id === null && row.failure_data !== "";

/** When a session has both a stage and a processed payment whose attendees are
 *  both live, they must agree; a disagreement is corruption. Returns null when
 *  either side is absent, either attendee is missing/deleted, or they match. */
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

/** Contradictions in one payment group: a checkout stage whose session has no
 *  processed payment, a stage whose own attendee has been deleted, a stage and
 *  processed payment that disagree on attendee, or a non-terminal processed
 *  payment pointing at a missing attendee. A merge-reference row's
 *  `attendee_id` is the merge target (the source is deleted by
 *  `applyAttendeeMerge` in the same batch), so its existence is covered here —
 *  there is no separate "source attendee" expectation. */
const groupContradictions = (
  group: PaymentGroup,
  attendeeIds: ReadonlySet<number>,
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
  if (group.processed && !isTerminalFailure(group.processed)) {
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
): Contradiction[] =>
  groups.flatMap((group) => groupContradictions(group, attendeeIds));

const sumupContradictions = (
  sumup: readonly SumupCheckoutRow[],
): Contradiction[] =>
  sumup
    .filter(({ sumup_id: sumupId }) => sumupId === "")
    .map(({ reference_index: referenceIndex }) => ({
      detail: referenceIndex,
      kind: "sumup_checkout_without_id" as const,
    }));

/** Owner-key controls. When the key is supplied, every PII blob and every
 *  payment reference that fails to decrypt is a contradiction (classified as a
 *  merge-reference charge or a regular captured charge by the session id). When
 *  the key is not supplied and encrypted PII or encrypted payment references
 *  exist, the migration blocks instead of skipping the charges it cannot yet
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
 *  verdict. The data is `ready` only when every row is accounted for, every
 *  timestamp normalises, every reference points at a live attendee, and the
 *  owner key could decrypt every PII blob and payment reference. Any single
 *  finding blocks the migration so the operator fixes it before a later release
 *  changes payment history. */
export const diagnoseReadiness = (input: DiagnoseInput): ReadinessReport => {
  const groups = buildPaymentGroups(input.processed, input.stages);
  const timestamp = convertAllTimestamps(
    input.processed,
    input.stages,
    input.sumup,
  );
  const contradictions: Contradiction[] = [
    ...referenceContradictions(groups, input.attendeeIds),
    ...sumupContradictions(input.sumup),
    ...timestamp.contradictions,
    ...ownerKeyContradictions(input),
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
