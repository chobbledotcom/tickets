import { type ModifierRow, modifiersTable } from "#shared/db/modifiers.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

type TestListing = Awaited<ReturnType<typeof createTestListing>>;

interface ServiceChargeScenario {
  listing: TestListing;
  modifier: ModifierRow;
}

/**
 * A £10 listing plus a 10%-charge "Service charge" modifier — the base setup
 * shared by `modifiers.test.ts`'s "accepts a webhook whose total includes an
 * applied modifier" and `modifier-refunds.test.ts`'s "refunds a webhook whose
 * total omits an applied modifier". The two are intentional parallel
 * variants (total correctly includes the surcharge vs. omits it), so the
 * setup is colocated here rather than duplicated across both files.
 */
export const createServiceChargeScenario =
  async (): Promise<ServiceChargeScenario> => {
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "percent",
      calcValue: 10,
      direction: "charge",
      name: "Service charge",
    });
    return { listing, modifier };
  };
