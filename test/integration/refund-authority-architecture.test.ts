import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PAYMENT_ROW_LIFECYCLE } from "#shared/payment/admit-move.ts";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundObservationDue,
  readyRefund,
} from "#shared/payment/refund-authority.ts";
import {
  markRefundOwnerChoiceNeeded,
  markRefundProviderConflict,
} from "#shared/payment/refund-authority-choice.ts";
import { refundLifecycleFor } from "#shared/payment/refund-authority-lifecycle.ts";
import { getAllFilesWithExt } from "#test/scripts/code-quality/detectors.ts";
import {
  couldBuildRefundAuthority,
  LOWER_SEND_SOURCE_PATHS,
  LOWER_SEND_TEST_PATHS,
  PARALLEL_AUTHORITY_FORMS,
  REFUND_AUTHORITY_ARCHITECTURE_FILES,
  REFUND_AUTHORITY_SOURCE_PATHS,
  REFUND_AUTHORITY_TEST_PATHS,
  TEST_AUTHORITY_BUILDING_PATHS,
} from "./refund-authority-architecture-fixtures.ts";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const testRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const codeFilesUnder = async (
  root: string,
): Promise<readonly { readonly code: string; readonly path: string }[]> => {
  const files = (
    await Promise.all(
      [".ts", ".tsx"].map((extension) => getAllFilesWithExt(root, extension)),
    )
  ).flat();
  return await Promise.all(
    files.map(async (path) => ({
      code: await Deno.readTextFile(path),
      path: path.replace(`${root}/`, ""),
    })),
  );
};

const sourceFiles = (): ReturnType<typeof codeFilesUnder> =>
  codeFilesUnder(sourceRoot);

const pathsContaining = (
  files: readonly { readonly code: string; readonly path: string }[],
  pattern: RegExp,
): string[] =>
  files
    .filter(({ code }) => pattern.test(code))
    .map(({ path }) => path)
    .sort();

const pathsMatching = (
  files: readonly { readonly code: string; readonly path: string }[],
  matches: (code: string) => boolean,
): string[] =>
  files
    .filter(({ code }) => matches(code))
    .map(({ path }) => path)
    .sort();

const refundLifecycles = () => {
  const ready = readyRefund({
    evidenceRevision: 1,
    nextActionAt: 20,
    now: 10,
    request: {
      capability: "keyless",
      generation: 1,
      identityIndex: "architecture-refund-request",
    },
  });
  const armed = armRefundSend(ready, 11, 20);
  return [
    ready,
    armed,
    markRefundObservationDue(armed, 12, 20),
    markRefundOwnerChoiceNeeded(armed, 12, "possibly_sent"),
    markRefundProviderConflict(ready, 12, {
      captured: { amount: 2_500, currency: "GBP" },
      kind: "returned",
      refunded: { amount: 400, currency: "GBP" },
    }),
    markRefundCompleted(ready, 12, "provider"),
  ].map(refundLifecycleFor);
};

describe("provider-refund architecture", () => {
  test("only the durable engine can import the money-send permit mint", async () => {
    expect(
      pathsContaining(await sourceFiles(), /authorizeDurableRefundSend/),
    ).toEqual([
      "shared/payment/refund-provider-authorization.ts",
      "shared/provider-refunds/send.ts",
    ]);
  });

  test("only the engine and provider adapters call a refund boundary", async () => {
    expect(pathsContaining(await sourceFiles(), /\.refundCharge\s*\(/)).toEqual(
      [
        "shared/provider-refunds/send.ts",
        "shared/square-provider.ts",
        "shared/stripe-provider.ts",
      ],
    );
  });

  test("only provider adapters call their refund APIs", async () => {
    expect(
      pathsContaining(
        await sourceFiles(),
        /(?:stripeApi|squareApi)\.refundCharge|sumupApi\.refundTransaction/,
      ),
    ).toEqual([
      "shared/square-provider.ts",
      "shared/stripe-provider.ts",
      "shared/sumup-provider.ts",
    ]);
  });

  test("only readiness, durable authority, and adapters read charges", async () => {
    expect(pathsContaining(await sourceFiles(), /\.readCharge\s*\(/)).toEqual([
      "features/admin/refunds/readiness.ts",
      "shared/provider-refunds/state.ts",
      "shared/square-provider.ts",
      "shared/stripe-provider.ts",
      "shared/sumup-provider.ts",
    ]);
  });

  test("existing-provider lookup stays confined to session retrieval", async () => {
    expect(
      pathsContaining(
        await sourceFiles(),
        /\bgetPaymentProviderForExistingPayments\b/,
      ),
    ).toEqual([
      "features/api/payment-processing/classify.ts",
      "features/api/webhooks.ts",
      "shared/payments.ts",
    ]);
  });

  test("single and listing-wide refunds share one batch command", async () => {
    expect(
      pathsContaining(await sourceFiles(), /processRefundBatch\s*\(/),
    ).toEqual([
      "features/admin/attendee-refunds/bulk.ts",
      "features/admin/attendee-refunds/single.ts",
    ]);
  });

  test("refund and refresh share one readiness command", async () => {
    const files = await sourceFiles();
    expect(pathsContaining(files, /\bprepareRefundReadiness\b/)).toEqual([
      "features/admin/refunds/provider.ts",
      "features/admin/refunds/readiness.ts",
      "features/admin/refunds/refresh.ts",
    ]);
    expect(pathsContaining(files, /\brunRefundReadiness\b/)).toEqual([
      "features/admin/refunds/provider.ts",
      "features/admin/refunds/readiness-run.ts",
      "features/admin/refunds/refresh.ts",
    ]);
  });

  test("recognizes a parallel authority regardless of declaration form", () => {
    for (const form of PARALLEL_AUTHORITY_FORMS) {
      expect(couldBuildRefundAuthority(form)).toBe(true);
    }
  });

  test("test authority building blocks stay at reviewed boundaries", async () => {
    const files = (await codeFilesUnder(testRoot)).filter(({ path }) =>
      !REFUND_AUTHORITY_ARCHITECTURE_FILES.has(path)
    );
    expect(
      pathsMatching(files, couldBuildRefundAuthority),
    ).toEqual(TEST_AUTHORITY_BUILDING_PATHS);
  });

  test("the durable authority's production and test entry points stay explicit", async () => {
    const authorityName = /\brequestProviderRefunds?\b/;
    expect(pathsContaining(await sourceFiles(), authorityName)).toEqual(
      REFUND_AUTHORITY_SOURCE_PATHS,
    );
    const tests = (await codeFilesUnder(testRoot)).filter(({ path }) =>
      !REFUND_AUTHORITY_ARCHITECTURE_FILES.has(path)
    );
    expect(pathsContaining(tests, authorityName)).toEqual(
      REFUND_AUTHORITY_TEST_PATHS,
    );
  });

  test("lower send mechanisms have one production call chain", async () => {
    const source = await sourceFiles();
    const tests = (await codeFilesUnder(testRoot)).filter(({ path }) =>
      !REFUND_AUTHORITY_ARCHITECTURE_FILES.has(path)
    );
    for (const [mechanism, paths] of Object.entries(LOWER_SEND_SOURCE_PATHS)) {
      expect(
        pathsContaining(source, new RegExp(`\\b${mechanism}\\b`)),
      ).toEqual(paths);
    }
    for (const [mechanism, paths] of Object.entries(LOWER_SEND_TEST_PATHS)) {
      expect(
        pathsContaining(tests, new RegExp(`\\b${mechanism}\\b`)),
      ).toEqual(paths);
    }
  });

  test("only provider API modules call their refund clients", async () => {
    expect(
      pathsContaining(
        await sourceFiles(),
        /client\.refunds\.(?:create|refundPayment)|client\.refundTransaction/,
      ),
    ).toEqual([
      "shared/square/payment-outcomes.ts",
      "shared/stripe.ts",
      "shared/sumup.ts",
    ]);
  });

  test("only the authority identity and transition stores write refund rows", async () => {
    expect(
      pathsContaining(
        await sourceFiles(),
        /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+payment_charges/,
      ),
    ).toEqual([
      "shared/db/provider-refund-authority-change.ts",
      "shared/db/provider-refund-authority.ts",
    ]);
  });

  test("only a provider-validated payment can mint an attendee payment anchor", async () => {
    expect(
      pathsContaining(
        await sourceFiles(),
        /prepareClaimedAttendeePaymentAnchor\s*\(/,
      ),
    ).toEqual(["features/api/payment-processing/store-refund.ts"]);
  });

  test("only old-row reads and collision checks recognize untagged references", async () => {
    expect(
      pathsContaining(await sourceFiles(), /kind:\s*["']untagged["']/),
    ).toEqual([
      "shared/db/payment-reference-store.ts",
      "shared/payment/provider-reference.ts",
    ]);
  });

  test("only immutable schema history names the legacy returned-payment column", async () => {
    expect(
      pathsContaining(await sourceFiles(), /provider_refunded_at/),
    ).toEqual([
      "shared/db/migrations/2026-07-07_processed_payments_payment_reference.ts",
      "shared/db/migrations/schema/tables-attendees.ts",
    ]);
  });

  test("no legacy refund-warning authority can return", async () => {
    expect(
      pathsContaining(await sourceFiles(), /["']refund_warning["']/),
    ).toEqual([]);
  });

  test("deleted refund paths cannot return", async () => {
    expect(
      pathsContaining(
        await sourceFiles(),
        /payment-reference-provider|provider-discovery|payment-refund-dispatch|returned_marker|sendRefundIfAdmitted|tryRefund/,
      ),
    ).toEqual([]);
  });

  test("every blocking state names a real clearer and reachable owner route", async () => {
    const files = await sourceFiles();
    for (const lifecycle of refundLifecycles()) {
      expect(
        pathsContaining(
          files,
          new RegExp(`export const ${lifecycle.clearedBy}\\b`),
        ),
      ).not.toEqual([]);
      expect(
        pathsContaining(files, new RegExp(`"GET ${lifecycle.operatorRoute}"`)),
      ).toEqual(["features/admin/privacy.ts"]);
    }
  });

  test("every attendee-row hold names its clearer and registered route", async () => {
    const files = await sourceFiles();
    for (const lifecycle of Object.values(PAYMENT_ROW_LIFECYCLE)) {
      expect(
        pathsContaining(
          files,
          new RegExp(`export const ${lifecycle.clearedBy}\\b`),
        ),
      ).not.toEqual([]);
      expect(
        pathsContaining(
          files,
          new RegExp(`"(?:GET|POST) ${lifecycle.operatorRoute}"`),
        ),
      ).not.toEqual([]);
    }
  });
});
