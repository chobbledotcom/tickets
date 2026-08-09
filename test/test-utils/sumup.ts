import { afterEach, beforeEach } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { SumUp } from "@sumup/sdk";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import {
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import { sumupApi } from "#shared/sumup.ts";
import type { SumupCheckout } from "#shared/sumup-observation.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { debugMessages, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { withMocks } from "#test-utils/mocks.ts";

/** Methods a fake SumUp client may implement for a given test. */
export type FakeSumupParts = {
  create?: (body: unknown) => Promise<unknown>;
  get?: (id: string) => Promise<unknown>;
  refund?: (merchantCode: string, id: string) => Promise<void>;
  txnGet?: (merchantCode: string, query: unknown) => Promise<unknown>;
  merchantGet?: (merchantCode: string) => Promise<unknown>;
};

/** Build a minimal fake SumUp client exposing only the methods under test. */
export const makeSumupClient = (p: FakeSumupParts): SumUp =>
  ({
    checkouts: { create: p.create, get: p.get },
    merchants: { get: p.merchantGet },
    transactions: { get: p.txnGet, refund: p.refund },
  }) as unknown as SumUp;

/** Run `body` with the SumUp client replaced by `client` (or made absent). */
export const withSumupClient = (
  client: SumUp | null,
  body: () => Promise<void>,
): Promise<void> =>
  withMocks(() => stub(sumupApi, "getSumupClient", () => client), body);

/** Booking metadata as buildItemsMetadata would write it. */
export const SUMUP_META = {
  _origin: "example.com",
  email: "alice@example.com",
  items: '[{"e":1,"q":1,"p":0}]',
  name: "Alice",
};

/** A SumUp checkout with overridable fields (defaults: paid, reference "ref"). */
export const sumupCheckout = (
  over: Partial<SumupCheckout> = {},
): SumupCheckout => ({
  amountMinor: 1000,
  currency: "GBP",
  reference: "ref",
  status: "PAID",
  transactionId: "txn",
  ...over,
});

/** Stage {@link SUMUP_META} for reference "ref" mapped to SumUp id "co_1". */
export const stageSumupCheckout = async (): Promise<void> => {
  await storeSumupCheckout("ref", SUMUP_META);
  await setSumupCheckoutId("ref", "co_1");
};

/** Run `body` with readCheckoutById stubbed to resolve `read`, handing it
 *  a reader for the arguments the adapter was called with. */
export const withSumupCheckoutRead = (
  read: ProviderRead<SumupCheckout>,
  body: (calls: () => unknown[][]) => Promise<void>,
): Promise<void> =>
  withMocks(
    () => stub(sumupApi, "readCheckoutById", () => Promise.resolve(read)),
    (mock) => body(() => mock.calls.map((c) => c.args)),
  );

/** {@link withSumupCheckoutRead} for the common case: the fetch found `value`. */
export const withFetchedSumupCheckout = (
  value: SumupCheckout,
  body: (calls: () => unknown[][]) => Promise<void>,
): Promise<void> =>
  withSumupCheckoutRead({ resource: value, status: "found" }, body);

/**
 * Give a SumUp suite a database, a site domain, and a configured SumUp account,
 * plus the debug and error spies its assertions read. Call it inside a describe
 * block — it registers that block's hooks.
 */
export const setupSumupSuite = (): {
  loggedDebug: (needle: string) => boolean;
  errorSpy: ReturnType<typeof setupErrorSpy>;
} => {
  beforeEach(async () => {
    await createTestDb();
    setEffectiveDomainForTest("example.com");
    settings.setForTest({
      sumup_api_key: "sk_test_abc",
      sumup_merchant_code: "MC123",
    });
  });

  afterEach(() => {
    settings.clearTestOverrides();
    resetDb();
  });

  // Declared after the database hook: building the test database re-reads the
  // debug-log suppression flag, so the log spy must be installed after it.
  const debugSpy = useDebugLogSpy();
  return {
    errorSpy: setupErrorSpy(),
    loggedDebug: (needle: string) =>
      debugMessages(debugSpy()).some((line: unknown) =>
        String(line).includes(needle),
      ),
  };
};
