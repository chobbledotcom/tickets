/**
 * Operator-facing read-only migration readiness verifier.
 *
 * Reads the legacy payment tables (`processed_payments`, `checkout_stages`,
 * `sumup_checkouts`), attendee PII blobs, and attendee-merge references from the
 * configured database — a live one, or one freshly restored from an old backup
 * into the current application — and reports whether they are safe to migrate in
 * a later fleet-wide release, without writing anything.
 *
 * The pure grouping, timestamp, and contradiction rules live in
 * `src/shared/migration-readiness/readiness.ts`; this module is the read shell
 * that fetches rows, enforces the owner-key control for encrypted attendee PII,
 * and prints the verdict. It is dependency-injected so the orchestration is
 * tested without a database.
 */

import { parseArgs } from "@std/cli/parse-args";
import type { ScriptIo } from "#scripts/script-runner.ts";
import {
  type AttendeePiiSource,
  type CheckoutStageRow,
  diagnoseReadiness,
  formatReadinessReport,
  type ProcessedPaymentRow,
  type SumupCheckoutRow,
} from "#shared/migration-readiness/readiness.ts";

export const MIGRATION_VERIFY_USAGE =
  "Usage: deno task migration-verify [--owner <username>] [--page-size <n>]";

export const EXIT_READY = 0;
export const EXIT_BLOCKED = 1;
export const EXIT_USAGE = 2;

export interface MigrationVerifyReader {
  readAttendeeIds(): Promise<Set<number>>;
  readAttendeePii(): Promise<AttendeePiiSource[]>;
  readCheckoutStages(): Promise<CheckoutStageRow[]>;
  readProcessedPayments(): Promise<ProcessedPaymentRow[]>;
  readSumupCheckouts(): Promise<SumupCheckoutRow[]>;
}

/** The encrypted sources the owner key verifies: every attendee PII blob and
 *  every `processed_payments` row carrying a `payment_reference` (a captured
 *  charge — regular or merge-reference). Bundled so the verify contract and the
 *  assessor that forwards to it share one parameter shape. */
export interface MigrationVerifyOwnerKeyInputs {
  attendees: readonly AttendeePiiSource[];
  paymentReferences: readonly ProcessedPaymentRow[];
}

export interface MigrationVerifyOwnerKey {
  /** Derive the owner private key from an owner-authenticated password, or null
   *  when the password is wrong, the account is not an owner, or the key cannot
   *  be unwrapped. */
  derive(username: string, password: string): Promise<CryptoKey | null>;
  /** Decrypt (and for PII, parse) every attendee PII blob and every payment
   *  reference under the owner key, returning the ids/keys that failed (never
   *  plaintext). */
  verify(
    key: CryptoKey,
    inputs: MigrationVerifyOwnerKeyInputs,
  ): Promise<{
    undecryptablePii: Set<number>;
    undecryptablePaymentReferences: Set<string>;
  }>;
}

export interface MigrationVerifyDeps extends ScriptIo {
  /** Builds the database reader for the parsed `--page-size`, so the keyset
   *  page size that bounds each read and the page size the diagnostics use are
   *  the same value the operator asked for. */
  createReader: (pageSize: number) => MigrationVerifyReader;
  ownerKey: MigrationVerifyOwnerKey;
  pageSize: number;
  prompt: (message: string) => string | null;
}

interface ParsedArgs {
  help: boolean;
  owner: string | undefined;
  pageSize: number;
}

const parseIntOrDefault = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : Number.NaN;
};

const parseVerifyArgs = (
  args: string[],
  fallbackPageSize: number,
): { kind: "ok"; value: ParsedArgs } | { kind: "usage" } => {
  const unknowns: string[] = [];
  const parsed = parseArgs(args, {
    boolean: ["help"],
    default: {},
    string: ["owner", "page-size"],
    unknown: (name) => {
      unknowns.push(name);
      return false;
    },
  });
  if (unknowns.length > 0 || parsed._.length > 0) return { kind: "usage" };
  const pageSize = parseIntOrDefault(parsed["page-size"], fallbackPageSize);
  if (Number.isNaN(pageSize)) return { kind: "usage" };
  return {
    kind: "ok",
    value: {
      help: parsed.help,
      owner: parsed.owner?.trim() || undefined,
      pageSize,
    },
  };
};

const readAllSources = async (
  reader: MigrationVerifyReader,
): Promise<{
  attendees: AttendeePiiSource[];
  attendeeIds: Set<number>;
  checkoutStages: CheckoutStageRow[];
  paymentReferences: ProcessedPaymentRow[];
  processed: ProcessedPaymentRow[];
  sumup: SumupCheckoutRow[];
}> => {
  const [processed, checkoutStages, sumup, attendees, attendeeIds] =
    await Promise.all([
      reader.readProcessedPayments(),
      reader.readCheckoutStages(),
      reader.readSumupCheckouts(),
      reader.readAttendeePii(),
      reader.readAttendeeIds(),
    ]);
  // Every row carrying a payment_reference (a captured charge) is verified by
  // the owner key — not only merge-reference handoffs. A corrupt regular
  // charge reference would break the refund-target migration, so it must fail
  // readiness now.
  const paymentReferences = processed.filter(
    (row) => row.payment_reference !== "",
  );
  return {
    attendeeIds,
    attendees,
    checkoutStages,
    paymentReferences,
    processed,
    sumup,
  };
};

const assessOwnerKey = async (
  deps: MigrationVerifyDeps,
  owner: string | undefined,
  inputs: MigrationVerifyOwnerKeyInputs,
): Promise<{
  ownerKeyAvailable: boolean;
  undecryptablePii: Set<number>;
  undecryptablePaymentReferences: Set<string>;
}> => {
  const empty = {
    ownerKeyAvailable: false,
    undecryptablePaymentReferences: new Set<string>(),
    undecryptablePii: new Set<number>(),
  };
  if (!owner) return empty;
  const password = deps.prompt(`Password for owner "${owner}":`) ?? "";
  if (password === "") return empty;
  const key = await deps.ownerKey.derive(owner, password);
  if (key === null) {
    deps.stderr(
      "The owner private key could not be derived from that password (wrong password, or not an owner account). Attendee PII cannot be verified.",
    );
    return empty;
  }
  return {
    ownerKeyAvailable: true,
    ...(await deps.ownerKey.verify(key, inputs)),
  };
};

/** Run the readiness verifier. Reads the legacy sources, enforces the
 *  owner-key control for attendee PII, and prints a bounded verdict. Returns
 *  0 when the database is ready to migrate, 1 when it is blocked, and 2 when
 *  the arguments or a source read failed before the verdict could run. */
export const runMigrationVerifyCli = async (
  deps: MigrationVerifyDeps,
): Promise<number> => {
  const parsed = parseVerifyArgs(deps.args, deps.pageSize);
  if (parsed.kind === "usage") {
    deps.stderr(MIGRATION_VERIFY_USAGE);
    return EXIT_USAGE;
  }
  if (parsed.value.help) {
    deps.stdout(MIGRATION_VERIFY_USAGE);
    return EXIT_READY;
  }

  let sources: Awaited<ReturnType<typeof readAllSources>>;
  try {
    sources = await readAllSources(deps.createReader(parsed.value.pageSize));
  } catch (error) {
    deps.stderr(`Could not read the legacy payment sources: ${String(error)}`);
    return EXIT_USAGE;
  }

  const ownerKey = await assessOwnerKey(deps, parsed.value.owner, {
    attendees: sources.attendees,
    paymentReferences: sources.paymentReferences,
  });

  const report = diagnoseReadiness({
    attendeeIds: sources.attendeeIds,
    attendees: sources.attendees,
    ownerKeyAvailable: ownerKey.ownerKeyAvailable,
    processed: sources.processed,
    stages: sources.checkoutStages,
    sumup: sources.sumup,
    undecryptablePaymentReferences: ownerKey.undecryptablePaymentReferences,
    undecryptablePii: ownerKey.undecryptablePii,
  });

  for (const line of formatReadinessReport(report)) deps.stdout(line);
  return report.kind === "ready" ? EXIT_READY : EXIT_BLOCKED;
};
