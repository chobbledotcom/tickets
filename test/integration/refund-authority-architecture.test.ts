import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllFilesWithExt } from "#test/scripts/code-quality/detectors.ts";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundObservationDue,
  readyRefund,
} from "#shared/payment/refund-authority.ts";
import { markRefundOwnerChoiceNeeded } from "#shared/payment/refund-authority-choice.ts";
import { refundLifecycleFor } from "#shared/payment/refund-authority-lifecycle.ts";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src");

const sourceFiles = async (): Promise<
  readonly { readonly code: string; readonly path: string }[]
> => {
  const files = (
    await Promise.all(
      [".ts", ".tsx"].map((extension) =>
        getAllFilesWithExt(sourceRoot, extension)
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
  files.filter(({ code }) => pattern.test(code)).map(({ path }) => path).sort();

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

  test("deleted refund paths cannot return", async () => {
    expect(
      pathsContaining(
        await sourceFiles(),
        /payment-refund-dispatch|sendRefundIfAdmitted|tryRefund/,
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
        pathsContaining(
          files,
          new RegExp(`"GET ${lifecycle.operatorRoute}"`),
        ),
      ).toEqual(["features/admin/privacy.ts"]);
    }
  });
});
