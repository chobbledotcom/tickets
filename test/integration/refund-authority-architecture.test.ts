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
import { markRefundOwnerChoiceNeeded } from "#shared/payment/refund-authority-choice.ts";
import { refundLifecycleFor } from "#shared/payment/refund-authority-lifecycle.ts";
import { getAllFilesWithExt } from "#test/scripts/code-quality/detectors.ts";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src");

const sourceFiles = async (): Promise<
  readonly { readonly code: string; readonly path: string }[]
> => {
  const files = (
    await Promise.all(
      [".ts", ".tsx"].map((extension) =>
        getAllFilesWithExt(sourceRoot, extension),
      ),
    )
  ).flat();
  return await Promise.all(
    files.map(async (path) => ({
      code: await Deno.readTextFile(path),
      path: path.replace(`${sourceRoot}/`, ""),
    })),
  );
};

const pathsContaining = (
  files: readonly { readonly code: string; readonly path: string }[],
  pattern: RegExp,
): string[] =>
  files
    .filter(({ code }) => pattern.test(code))
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

  test("only the authority store writes durable refund rows", async () => {
    expect(
      pathsContaining(
        await sourceFiles(),
        /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+payment_charges/,
      ),
    ).toEqual(["shared/db/provider-refund-authority.ts"]);
  });

  test("only a provider-validated payment can mint an attendee payment anchor", async () => {
    expect(
      pathsContaining(await sourceFiles(), /prepareAttendeePaymentAnchor\s*\(/),
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
