import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { PRICE_TYPE_GROUP_DAY } from "#shared/db/listing-prices.ts";
import {
  loadRegistrationPackageFacts,
  RegistrationDeliveryError,
  registrationDeliveryResult,
  waitForRegistrationDeliveries,
} from "#shared/registration-package-facts.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  type DbCallHooks,
  statementSql,
  wrapDbClient,
} from "#test-utils/record-queries.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const row = (packageGroupId: number) => ({
  attendee: { package_group_id: packageGroupId },
});

const registrationDeliveryError = async (
  outcome: Promise<unknown>,
): Promise<RegistrationDeliveryError> => {
  const error = await outcome.catch((reason) => reason);
  expect(error).toBeInstanceOf(RegistrationDeliveryError);
  if (!(error instanceof RegistrationDeliveryError)) throw error;
  expect(error.message).toBe("Unexpected registration delivery failure");
  return error;
};

test("marks a registration failed exactly when any delivery failed", () => {
  expect(registrationDeliveryResult([])).toEqual({ failed: false });
  expect(
    registrationDeliveryResult([{ delivered: true }, { delivered: true }]),
  ).toEqual({ failed: false });
  expect(
    registrationDeliveryResult([{ delivered: true }, { delivered: false }]),
  ).toEqual({ failed: true });
});

test("combines completed registration deliveries", async () => {
  expect(
    await waitForRegistrationDeliveries<{ delivered: boolean }>([
      Promise.resolve({ delivered: true }),
      Promise.resolve({ delivered: false }),
    ]),
  ).toEqual({ failed: true });
});

test("waits for every registration delivery before rejecting", async () => {
  const pending = Promise.withResolvers<{ delivered: true }>();
  const failure = new Error("unexpected delivery failure");
  const outcome = waitForRegistrationDeliveries([
    Promise.reject(failure),
    pending.promise,
  ]);
  let rejected = false;
  outcome.catch(() => {
    rejected = true;
  });

  await Promise.resolve();
  expect(rejected).toBe(false);
  pending.resolve({ delivered: true });
  const error = await registrationDeliveryError(outcome);
  expect(error.failed).toBe(false);
  expect(error.reasons).toEqual([failure]);
});

test("keeps every registration delivery rejection", async () => {
  const failure = new Error("unexpected delivery failure");
  const secondFailure = new Error("another delivery failure");
  const error = await registrationDeliveryError(
    waitForRegistrationDeliveries([
      Promise.resolve({ delivered: false }),
      Promise.reject(failure),
      Promise.reject(secondFailure),
    ]),
  );

  expect(error.failed).toBe(true);
  expect(error.reasons).toEqual([failure, secondFailure]);
});

describeWithEnv("loadRegistrationPackageFacts", { db: true }, () => {
  test("does not read the database for rows outside a package", async () => {
    const calls = await countDatabaseCalls(0, async () => {
      expect(await loadRegistrationPackageFacts([row(0), row(-1)])).toEqual({
        displays: new Map(),
        pricingByGroup: new Map(),
      });
    });
    expect(calls).toBe(0);
  });

  test("loads each package once with its display and complete member pricing", async () => {
    const group = await createHiddenPackageGroup("Weekend bundle");
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 900, 2: 1600 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      name: "Cabin",
      unitPrice: 900,
    });
    await setGroupPackageMembers(group.id, [
      { dayPrices: { 2: 1400 }, listingId: member.id, price: 750, quantity: 3 },
    ]);
    const packageQueries: Parameters<DbCallHooks["execute"]>[0][] = [];
    const restoreDb = wrapDbClient({
      batch: () => {},
      execute: (statement) => {
        if (statementSql(statement).includes("groupListing.group_id IN")) {
          packageQueries.push(statement);
        }
        return null;
      },
    });
    let facts: Awaited<ReturnType<typeof loadRegistrationPackageFacts>>;
    try {
      facts = await loadRegistrationPackageFacts([
        row(group.id),
        row(group.id),
        row(0),
      ]);
    } finally {
      restoreDb();
    }
    expect(
      packageQueries.map((statement) =>
        typeof statement === "string" ? undefined : statement.args,
      ),
    ).toEqual([[group.id], [PRICE_TYPE_GROUP_DAY, group.id]]);
    expect(facts.displays).toEqual(
      new Map([[group.id, { hideListings: true, name: "Weekend bundle" }]]),
    );
    expect(facts.pricingByGroup).toEqual(
      new Map([
        [
          group.id,
          {
            dayPriceMap: new Map([[member.id, new Map([[2, 1400]])]]),
            memberIds: new Set([member.id]),
            priceMap: new Map([[member.id, 750]]),
            quantityMap: new Map([[member.id, 3]]),
          },
        ],
      ]),
    );
  });
});
