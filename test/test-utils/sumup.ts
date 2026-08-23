import { expect } from "@std/expect";
import { afterEach, beforeEach } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { execute, getDb } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { setSumupCheckoutId, storeSumupCheckout } from "#db/sumup-checkouts.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { sumupApi } from "#shared/sumup.ts";
import type { SumupCheckout } from "#shared/sumup-observation.ts";
import { tableRowCount } from "#test-utils/db/migration-test-helpers.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { debugMessages, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { withMocks } from "#test-utils/mocks.ts";

type SumupClient = NonNullable<ReturnType<typeof sumupApi.getSumupClient>>;

/** Methods a fake SumUp client may implement for a given test. */
export type FakeSumupParts = {
  create?: (body: unknown) => Promise<unknown>;
  get?: (id: string) => Promise<unknown>;
  refund?: (merchantCode: string, id: string) => Promise<void>;
  txnGet?: (merchantCode: string, query: unknown) => Promise<unknown>;
  merchantGet?: (merchantCode: string) => Promise<unknown>;
};

/** Build a minimal fake SumUp client exposing only the methods under test. */
export const makeSumupClient = (p: FakeSumupParts): SumupClient =>
  ({
    createCheckout: p.create,
    getMerchant: p.merchantGet,
    readCheckout: p.get,
    readTransaction: p.txnGet,
    refundTransaction: p.refund,
  }) as unknown as SumupClient;

/** Run `body` with the SumUp client replaced by `client` (or made absent). */
export const withSumupClient = (
  client: SumupClient | null,
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

/**
 * Stage a checkout the way production does: a real listing, a real priced
 * intent, and metadata signed by assembleCheckoutMetadata, stored encrypted
 * and mapped to `checkoutId`. Use this over {@link stageSumupCheckout}
 * whenever the test needs the price proof to actually verify.
 */
export const stageSignedSumupCheckout = async (
  checkoutId: string,
  unitPrice = 1000,
): Promise<{ listing: { id: number }; reference: string }> => {
  const staged = await stageSignedMultiItemSumupCheckout(checkoutId, 1, [
    unitPrice,
  ]);
  return { listing: staged.listings[0]!, reference: staged.reference };
};

/** Stage a signed checkout holding one item per listing, so a test can tell
 * the booking's first listing from its second. */
export const stageSignedMultiItemSumupCheckout = async (
  checkoutId: string,
  itemCount: number,
  unitPrices: number[] = [],
): Promise<{ listings: { id: number }[]; reference: string }> => {
  const listings: Awaited<ReturnType<typeof createTestListing>>[] = [];
  for (let index = 0; index < itemCount; index++) {
    listings.push(
      await createTestListing({ unitPrice: unitPrices[index] ?? 1000 }),
    );
  }
  await settings.update.paymentProvider("sumup");
  await settings.update.sumup.apiKey("sk_test_x");
  await settings.update.sumup.merchantCode("MC1");
  setEffectiveDomainForTest("localhost");
  const reference = crypto.randomUUID();
  const intent: CheckoutIntent = {
    address: "",
    date: null,
    email: "alice@example.com",
    items: listings.map((listing, index) => ({
      listingId: listing.id,
      name: listing.name,
      quantity: 1,
      slug: listing.slug,
      unitPrice: unitPrices[index] ?? 1000,
    })),
    name: "Alice",
    phone: "",
    special_instructions: "",
  };
  await storeSumupCheckout(
    reference,
    await assembleCheckoutMetadata(
      "sumup",
      intent,
      priceCheckout(intent).total,
    ),
  );
  await setSumupCheckoutId(reference, checkoutId);
  return { listings, reference };
};

/** Bring a staged checkout's next recovery check forward, so a test does not
 * have to wait the real hours out. Pass `when` to place it at a exact time,
 * e.g. older than every other due row. */
export const makeSumupCheckoutDue = (
  checkoutId: string,
  when = "2000-01-01T00:00:00.000Z",
): Promise<unknown> =>
  execute("UPDATE sumup_checkouts SET next_check_at = ? WHERE sumup_id = ?", [
    when,
    checkoutId,
  ]);

/** Store one recovery row exactly as SQL sees it. Machine scan tests use this
 * to plant combinations that no production writer can make. */
export const plantSumupRecoveryRow = (
  id: string,
  state: string,
  nextCheckAt: string | null,
): Promise<unknown> =>
  execute(
    `INSERT INTO sumup_checkouts
       (reference_index, wrapped_key, metadata, sumup_id, created_at,
        recovery_state, next_check_at)
     VALUES (?, '', '', ?, '2026-08-01T00:00:00.000Z', ?, ?)`,
    [`idx_${id}`, id, state, nextCheckAt],
  );

/** How a staged checkout's recovery row reads right now. Every caller has
 * just staged the row, so a missing one is a broken test rather than a case
 * to handle — it fails on the read. */
export const sumupRecoveryRow = async (
  checkoutId: string,
): Promise<{ nextCheckAt: string | null; state: string }> => {
  const result = await getDb().execute({
    args: [checkoutId],
    sql: "SELECT recovery_state, next_check_at FROM sumup_checkouts WHERE sumup_id = ?",
  });
  const row = result.rows[0]!;
  return {
    nextCheckAt: row.next_check_at === null ? null : String(row.next_check_at),
    state: String(row.recovery_state),
  };
};

/** The check every "did this happen exactly once?" test here makes: one
 * ticket and one reservation, however many times the work was run. The
 * reservation row is the one that catches a double-book, because it is the
 * key the payment engine reserves against. */
export const expectBookedExactlyOnce = async (): Promise<void> => {
  expect(await tableRowCount("attendees")).toBe(1);
  expect(await tableRowCount("processed_payments")).toBe(1);
};

/** Stub SumUp's checkout lookup for a staged reference. */
export const withSumupCheckoutStatus = (
  reference: string,
  status: SumupCheckout["status"],
  transactionId = "txn_test",
) =>
  stub(sumupApi, "readCheckoutById", () =>
    Promise.resolve({
      resource: sumupCheckout({ reference, status, transactionId }),
      status: "found" as const,
    }),
  );

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
