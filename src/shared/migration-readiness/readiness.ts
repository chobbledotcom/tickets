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
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
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
  | "processed_payment_without_attendee"
  | "merge_reference_without_source_attendee"
  | "merge_reference_without_target_attendee"
  | "payment_split_across_page"
  | "undecryptable_attendee_pii"
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
 *  column (a genuinely absent time is not a contradiction) and `null` when a
 *  value is neither a real instant nor epoch-millis, so the caller can surface
 *  it instead of inventing a moment. */
export const convertLegacyTimestamp = (value: string): string | null => {
  if (value === "") return "";
  if (/^\d+$/.test(value)) {
    const epoch = Number(value);
    if (Number.isInteger(epoch) && epoch > 0) return epochMsToIso(epoch);
    return null;
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

const sourceAttendeeIdOf = (sessionId: string): number =>
  Number(sessionId.slice(LEGACY_MERGE_SESSION_PREFIX.length));

/** Convert every legacy timestamp column to a canonical instant, returning one
 *  contradiction per value that is neither a real instant nor epoch-millis.
 *  Empty columns are left as empty (an absent time is not a contradiction). */
const convertAllTimestamps = (
  processed: readonly ProcessedPaymentRow[],
  stages: readonly CheckoutStageRow[],
  sumup: readonly SumupCheckoutRow[],
): { contradictions: Contradiction[]; converted: number } => {
  const contradictions: Contradiction[] = [];
  let converted = 0;
  const check = (value: string, label: string): void => {
    const result = convertLegacyTimestamp(value);
    if (result === null) {
      contradictions.push({
        detail: label,
        kind: "unconvertible_timestamp",
      });
    } else if (result !== "") {
      converted += 1;
    }
  };
  for (const row of processed) {
    check(
      row.processed_at,
      `processed_payments.processed_at = ${row.processed_at}`,
    );
    check(
      row.provider_refunded_at,
      `processed_payments.provider_refunded_at = ${row.provider_refunded_at}`,
    );
  }
  for (const row of stages) {
    check(row.created_at, `checkout_stages.created_at = ${row.created_at}`);
  }
  for (const row of sumup) {
    check(row.created_at, `sumup_checkouts.created_at = ${row.created_at}`);
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

/** Provider payments whose rows would not fit on one keyset page, so a cursor
 *  that pages by row count would split one payment across a boundary. Each
 *  session id is returned once. With the legacy tables each payment is one row
 *  per table, so this only fires once a single payment grows past the page. */
export const paymentsExceedingPage = (
  orderedSessionIds: readonly string[],
  pageSize: number,
): readonly string[] => {
  const counts = new Map<string, number>();
  for (const id of orderedSessionIds) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > pageSize)
    .map(([id]) => id);
};

/** Inputs to the readiness verdict. The caller fetches every row and reports
 *  any owner-key decryption failures; these rules never perform IO. */
export type DiagnoseInput = {
  processed: readonly ProcessedPaymentRow[];
  stages: readonly CheckoutStageRow[];
  sumup: readonly SumupCheckoutRow[];
  attendees: readonly AttendeePiiSource[];
  /** Live attendee ids, used to prove processed-payment and merge-reference rows
   *  still point at real attendees rather than deleted bookings. */
  attendeeIds: ReadonlySet<number>;
  /** `payment_session_id` rows of `processed_payments` in read order, used to
   *  prove a cursor never splits one provider payment across a keyset page. */
  orderedProcessedSessionIds: readonly string[];
  pageSize: number;
  /** Whether the caller supplied the owner private key and decrypted PII. When
   *  false and encrypted PII exists, the verdict blocks rather than skipping. */
  ownerKeyAvailable: boolean;
  /** Attendee ids whose `pii_blob` failed to decrypt under the owner key. */
  undecryptablePii: ReadonlySet<number>;
  /** `payment_session_id`s of merge-reference rows whose `payment_reference`
   *  failed to decrypt under the owner key. */
  undecryptableMergeReferences: ReadonlySet<string>;
};

/** Contradictions where a checkout stage, processed payment, or merge
 *  reference points at a row that should also exist. */
const referenceContradictions = (
  groups: readonly PaymentGroup[],
  attendeeIds: ReadonlySet<number>,
): Contradiction[] => {
  const contradictions: Contradiction[] = [];
  for (const group of groups) {
    if (group.stage && !group.processed) {
      contradictions.push({
        detail: group.paymentSessionId,
        kind: "checkout_stage_without_processed_payment",
      });
    }
    if (group.processed) {
      contradictions.push(
        ...processedPaymentContradictions(group, attendeeIds),
      );
    }
  }
  return contradictions;
};

const processedPaymentContradictions = (
  group: PaymentGroup,
  attendeeIds: ReadonlySet<number>,
): Contradiction[] => {
  if (!group.processed) return [];
  const { attendee_id: attendeeId, payment_session_id: sessionId } =
    group.processed;
  const contradictions: Contradiction[] = [];
  if (attendeeId === null || !attendeeIds.has(attendeeId)) {
    contradictions.push({
      detail: String(attendeeId),
      kind: "processed_payment_without_attendee",
    });
  }
  if (!isMergeReference(sessionId)) return contradictions;
  const sourceId = sourceAttendeeIdOf(sessionId);
  if (!attendeeIds.has(sourceId)) {
    contradictions.push({
      detail: sessionId,
      kind: "merge_reference_without_source_attendee",
    });
  }
  if (attendeeId !== null && !attendeeIds.has(attendeeId)) {
    contradictions.push({
      detail: sessionId,
      kind: "merge_reference_without_target_attendee",
    });
  }
  return contradictions;
};

const sumupContradictions = (
  sumup: readonly SumupCheckoutRow[],
): Contradiction[] =>
  sumup
    .filter(({ sumup_id: sumupId }) => sumupId === "")
    .map(({ reference_index: referenceIndex }) => ({
      detail: referenceIndex,
      kind: "sumup_checkout_without_id" as const,
    }));

const splitContradictions = (
  orderedSessionIds: readonly string[],
  pageSize: number,
): Contradiction[] =>
  paymentsExceedingPage(orderedSessionIds, pageSize).map((id) => ({
    detail: id,
    kind: "payment_split_across_page" as const,
  }));

/** Owner-key controls. When the key is supplied, every PII blob and
 *  merge-reference charge that fails to decrypt is a contradiction. When it is
 *  not supplied and encrypted PII exists, the migration blocks instead of
 *  skipping the charges it cannot yet verify. */
const ownerKeyContradictions = (input: DiagnoseInput): Contradiction[] => {
  if (input.ownerKeyAvailable) {
    return [
      ...[...input.undecryptablePii].map((attendeeId) => ({
        detail: `attendee ${attendeeId}`,
        kind: "undecryptable_attendee_pii" as const,
      })),
      ...[...input.undecryptableMergeReferences].map((sessionId) => ({
        detail: sessionId,
        kind: "undecryptable_merge_reference" as const,
      })),
    ];
  }
  if (input.attendees.some((attendee) => attendee.pii_blob !== "")) {
    return [
      {
        detail: `${input.attendees.length} encrypted attendee PII blob(s) cannot be verified without the owner key`,
        kind: "owner_key_unavailable" as const,
      },
    ];
  }
  return [];
};

/** Turn one lossless read of the legacy payment sources into a readiness
 *  verdict. The data is `ready` only when every row is accounted for, every
 *  timestamp normalises, every payment stays inside one page, every reference
 *  points at a live attendee, and the owner key could decrypt every PII blob
 *  and merge-reference charge. Any single finding blocks the migration so the
 *  operator fixes it before a later release changes payment history. */
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
    ...splitContradictions(input.orderedProcessedSessionIds, input.pageSize),
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

const CONTRADICTION_PHRASES: Record<ContradictionKind, string> = {
  checkout_stage_without_processed_payment:
    "checkout stage without a processed payment",
  merge_reference_without_source_attendee:
    "merge reference without its source attendee",
  merge_reference_without_target_attendee:
    "merge reference without its target attendee",
  owner_key_unavailable: "owner key not supplied",
  payment_split_across_page: "provider payment split across a page",
  processed_payment_without_attendee:
    "processed payment without a live attendee",
  sumup_checkout_without_id: "sumup checkout without a recorded id",
  unconvertible_timestamp: "timestamp that cannot be converted",
  undecryptable_attendee_pii: "attendee PII that did not decrypt",
  undecryptable_merge_reference: "merge-reference charge that did not decrypt",
};

/** Render a readiness verdict as plain operator lines. The owner-key line says
 *  how many PII blobs were verified (or that the key was not supplied), and the
 *  contradiction lines use plain phrases over non-secret detail only. */
export const formatReadinessReport = (report: ReadinessReport): string[] => {
  const lines: string[] = [];
  const heading =
    report.kind === "ready"
      ? "Payment migration readiness: ready"
      : `Payment migration readiness: BLOCKED — ${report.contradictions.length} contradiction(s)`;
  lines.push(heading, "");
  lines.push(
    "Source counts",
    `  processed_payments rows: ${report.counts.processedPayments}`,
    `  checkout_stages rows: ${report.counts.checkoutStages}`,
    `  sumup_checkouts rows: ${report.counts.sumupCheckouts}`,
    `  attendee PII blobs: ${report.counts.attendeePiiBlobs}`,
    `  merge references: ${report.counts.mergeReferences}`,
    `  payment groups: ${report.counts.paymentGroups}`,
    `  timestamps converted: ${report.counts.timestampConversions}`,
    "",
  );
  const ownerKeyMissing = report.contradictions.some(
    (c) => c.kind === "owner_key_unavailable",
  );
  if (ownerKeyMissing) {
    lines.push(
      "Owner key",
      `  not supplied — ${report.counts.attendeePiiBlobs} attendee PII blob(s) cannot be verified`,
      "",
    );
  } else if (report.counts.attendeePiiBlobs > 0) {
    const verified =
      report.counts.attendeePiiBlobs -
      report.contradictions.filter(
        (c) => c.kind === "undecryptable_attendee_pii",
      ).length;
    lines.push(
      "Owner key",
      `  verified ${verified} of ${report.counts.attendeePiiBlobs} attendee PII blob(s)`,
      "",
    );
  }
  if (report.contradictions.length > 0) {
    lines.push("Contradictions");
    for (const { detail, kind } of report.contradictions) {
      lines.push(`  - ${CONTRADICTION_PHRASES[kind]}: ${detail}`);
    }
  }
  return lines;
};
