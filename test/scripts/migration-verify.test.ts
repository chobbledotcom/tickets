import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MIGRATION_VERIFY_USAGE,
  type MigrationVerifyDeps,
  type MigrationVerifyOwnerKey,
  type MigrationVerifyReader,
  runMigrationVerifyCli,
} from "#scripts/migration-verify-lib.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  type AttendeePiiSource,
  type CheckoutStageRow,
  LEGACY_MERGE_SESSION_PREFIX,
  type ProcessedPaymentRow,
  type SumupCheckoutRow,
} from "#shared/migration-readiness/readiness.ts";

const enc = (s: string): OwnerKeyEncrypted => s as OwnerKeyEncrypted;

interface Clipio extends ScriptIo {
  errors: string[];
  output: string[];
  stderr: (line: string) => void;
  stdout: (line: string) => void;
}

const io = (args: string[]): Clipio => {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    args,
    errors,
    getEnv: () => undefined,
    output,
    stderr: (line) => errors.push(line),
    stdout: (line) => output.push(line),
  };
};

const fakeReader = (
  overrides: Partial<MigrationVerifyReader> = {},
): MigrationVerifyReader => ({
  readAttendeeIds: () => Promise.resolve(new Set([1])),
  readAttendeePii: () =>
    Promise.resolve<AttendeePiiSource[]>([{ id: 1, pii_blob: enc("hyb:1:x") }]),
  readCheckoutStages: () =>
    Promise.resolve<CheckoutStageRow[]>([
      {
        attendee_id: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        payment_session_id: "sess-1",
        provider: "stripe",
        state: "completed",
      },
    ]),
  readProcessedPayments: () =>
    Promise.resolve<ProcessedPaymentRow[]>([
      {
        attendee_id: 1,
        failure_data: "",
        payment_reference: "",
        payment_session_id: "sess-1",
        processed_at: "2026-01-01T00:00:00.000Z",
        provider_refunded_at: "",
      },
    ]),
  readSumupCheckouts: () =>
    Promise.resolve<SumupCheckoutRow[]>([
      {
        created_at: "2026-01-01T00:00:00.000Z",
        reference_index: "i",
        sumup_id: "su",
      },
    ]),
  ...overrides,
});

const alwaysVerifyingKey = (
  key: CryptoKey | null,
): MigrationVerifyOwnerKey => ({
  derive: () => Promise.resolve(key),
  verify: () =>
    Promise.resolve({
      undecryptableMergeReferences: new Set<string>(),
      undecryptablePii: new Set<number>(),
    }),
});

/** An owner key that derives from `derive` and records the verify call through
 *  `onVerify` (returning no failures). Shared by the tests that assert what the
 *  owner key was derived/verified with, so they differ only in that recording. */
const recordingOwnerKey = (
  derive: (username: string, password: string) => Promise<CryptoKey | null>,
  onVerify: (
    key: CryptoKey,
    inputs: {
      mergeReferences: readonly ProcessedPaymentRow[];
      attendees: readonly AttendeePiiSource[];
    },
  ) => void,
): MigrationVerifyOwnerKey => ({
  derive,
  verify: (key, inputs) => {
    onVerify(key, inputs);
    return Promise.resolve({
      undecryptableMergeReferences: new Set<string>(),
      undecryptablePii: new Set<number>(),
    });
  },
});

const deps = (
  clip: Clipio,
  over: Partial<MigrationVerifyDeps>,
): MigrationVerifyDeps => ({
  createReader: () => fakeReader(),
  ownerKey: alwaysVerifyingKey({} as CryptoKey),
  pageSize: 500,
  prompt: () => "owner-password",
  ...clip,
  ...over,
});

describe("runMigrationVerifyCli", () => {
  test("prints usage and exits 0 for --help", async () => {
    const result = await runMigrationVerifyCli(
      deps(io(["--help"]), { createReader: () => fakeReader() }),
    );
    expect(result).toBe(0);
  });

  test("blocks without the owner key when encrypted PII exists", async () => {
    const clip = io([]);
    const result = await runMigrationVerifyCli(
      deps(clip, { prompt: () => null }),
    );
    expect(result).toBe(1);
    expect(clip.output.join("\n")).toContain(
      "Payment migration readiness: BLOCKED",
    );
    expect(clip.output.join("\n")).toContain("owner key not supplied");
  });

  test("is ready without the owner key when there is no PII to check", async () => {
    const clip = io([]);
    const result = await runMigrationVerifyCli(
      deps(clip, {
        createReader: () =>
          fakeReader({ readAttendeePii: () => Promise.resolve([]) }),
        prompt: () => null,
      }),
    );
    expect(result).toBe(0);
    expect(clip.output.join("\n")).toContain(
      "Payment migration readiness: ready",
    );
  });

  test("verifies PII and reports ready when the owner key decrypts every blob", async () => {
    const clip = io(["--owner", "owner"]);
    const derived = {} as CryptoKey;
    let derivedWith: { username: string; password: string } | null = null;
    let verifiedWith: CryptoKey | null = null;
    const result = await runMigrationVerifyCli(
      deps(clip, {
        ownerKey: recordingOwnerKey(
          (username, password) => {
            derivedWith = { password, username };
            return Promise.resolve(derived);
          },
          (key) => {
            verifiedWith = key;
          },
        ),
      }),
    );
    expect(result).toBe(0);
    expect(derivedWith).toEqual({
      password: "owner-password",
      username: "owner",
    });
    expect(verifiedWith).toBe(derived);
    expect(clip.output.join("\n")).toContain(
      "verified 1 of 1 attendee PII blob",
    );
  });

  test("blocks when the owner key cannot be derived (wrong password)", async () => {
    const clip = io(["--owner", "owner"]);
    const result = await runMigrationVerifyCli(
      deps(clip, { ownerKey: alwaysVerifyingKey(null) }),
    );
    expect(result).toBe(1);
    expect(clip.output.join("\n")).toContain("owner key not supplied");
    expect(clip.errors.join("\n")).toContain("could not be derived");
  });

  test("blocks when a PII blob fails to decrypt under the owner key", async () => {
    const clip = io(["--owner", "owner"]);
    const result = await runMigrationVerifyCli(
      deps(clip, {
        ownerKey: {
          derive: () => Promise.resolve({} as CryptoKey),
          verify: () =>
            Promise.resolve({
              undecryptableMergeReferences: new Set<string>(),
              undecryptablePii: new Set([1]),
            }),
        },
      }),
    );
    expect(result).toBe(1);
    expect(clip.output.join("\n")).toContain(
      "attendee PII that did not decrypt",
    );
  });

  test("surfaces a payment table contradiction even without the owner key", async () => {
    const clip = io([]);
    const result = await runMigrationVerifyCli(
      deps(clip, {
        createReader: () =>
          fakeReader({
            readCheckoutStages: () =>
              Promise.resolve<CheckoutStageRow[]>([
                {
                  attendee_id: 1,
                  created_at: "2026-01-01T00:00:00.000Z",
                  payment_session_id: "orphan",
                  provider: "stripe",
                  state: "completed",
                },
              ]),
          }),
        prompt: () => null,
      }),
    );
    expect(result).toBe(1);
    expect(clip.output.join("\n")).toContain(
      "checkout stage without a processed payment",
    );
  });

  test("exits 2 when reading a source fails", async () => {
    const clip = io([]);
    const result = await runMigrationVerifyCli(
      deps(clip, {
        createReader: () =>
          fakeReader({
            readProcessedPayments: () => Promise.reject(new Error("DB down")),
          }),
        prompt: () => null,
      }),
    );
    expect(result).toBe(2);
    expect(clip.errors.join("\n")).toContain("DB down");
  });

  test("verifies a merge-reference charge that decrypts with the owner key", async () => {
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}1`;
    const clip = io(["--owner", "owner"]);
    let verifiedRefs: readonly ProcessedPaymentRow[] = [];
    const result = await runMigrationVerifyCli(
      deps(clip, {
        createReader: () =>
          fakeReader({
            readProcessedPayments: () =>
              Promise.resolve<ProcessedPaymentRow[]>([
                {
                  attendee_id: 1,
                  failure_data: "",
                  payment_reference: enc("hyb:1:charge"),
                  payment_session_id: ref,
                  processed_at: "2026-01-01T00:00:00.000Z",
                  provider_refunded_at: "",
                },
                {
                  attendee_id: 1,
                  failure_data: "",
                  payment_reference: "",
                  payment_session_id: "sess-1",
                  processed_at: "2026-01-01T00:00:00.000Z",
                  provider_refunded_at: "",
                },
              ]),
          }),
        ownerKey: recordingOwnerKey(
          () => Promise.resolve({} as CryptoKey),
          (_key, inputs) => {
            verifiedRefs = inputs.mergeReferences;
          },
        ),
      }),
    );
    expect(result).toBe(0);
    expect(verifiedRefs.map((r) => r.payment_session_id)).toEqual([ref]);
    expect(clip.output.join("\n")).toContain("merge references: 1");
  });

  test("exits 2 and prints usage for an unknown flag", async () => {
    const clip = io(["--bogus"]);
    const result = await runMigrationVerifyCli(
      deps(clip, { createReader: () => fakeReader() }),
    );
    expect(result).toBe(2);
    expect(clip.errors.join("\n")).toContain(MIGRATION_VERIFY_USAGE);
  });
});
