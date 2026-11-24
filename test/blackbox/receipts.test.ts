import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import type { Api } from "#test/blackbox/api.ts";
import { addBooking, addListing, openApi } from "#test/blackbox/seed.ts";
import { loggedIn } from "#test/blackbox/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const DELIVERY = { amount: 250, description: "Delivery" };
const FEE = { amount: -100, description: "Fee" };

const Updated = v.object({
  attendee: v.looseObject({ remaining_balance: v.number() }),
});
const Refused = v.looseObject({ error: v.string() });

/** A booking of one 500 place, with a 250 delivery charge and 200 paid. The
 * attendee owes 550. */
const booked = async (): Promise<{ api: Api; path: string }> => {
  const api = await openApi(await loggedIn());
  const listing = await addListing(api, {
    max_attendees: 10,
    name: "Receipt Fair",
    unit_price: 500,
  });
  const id = await addBooking(api, listing, {
    adjustments: [DELIVERY],
    name: "Ada Lovelace",
    payments: [{ amount: 200 }],
  });
  return { api, path: `/api/admin/attendees/${id}` };
};

/** What the attendee owes after an update that the API accepts. */
const owedAfter = async (
  api: Api,
  path: string,
  body: Record<string, unknown>,
): Promise<number> => {
  const answer = await api.put(path, body);
  expect(answer.status).toBe(200);
  return v.parse(Updated, answer.body).attendee.remaining_balance;
};

/** The reason that the API gives when it refuses an update. */
const refusalOf = async (
  api: Api,
  path: string,
  body: Record<string, unknown>,
): Promise<string> => {
  const answer = await api.put(path, body);
  expect(answer.status).toBe(400);
  return v.parse(Refused, answer.body).error;
};

describeWithEnv(
  "the receipts of a booking, through the admin API",
  { db: true, triggers: true },
  () => {
    test("a new payment lowers what the attendee owes, and the same list again changes nothing", async () => {
      const { api, path } = await booked();
      const payments = [{ amount: 200 }, { amount: 100 }];
      expect(await owedAfter(api, path, { payments })).toBe(450);
      expect(await owedAfter(api, path, { payments })).toBe(450);
    });

    test("a new adjustment changes what the attendee owes", async () => {
      const { api, path } = await booked();
      expect(await owedAfter(api, path, { adjustments: [DELIVERY, FEE] })).toBe(
        450,
      );
    });

    test("a payment that is already recorded cannot change its amount", async () => {
      const { api, path } = await booked();
      expect(await refusalOf(api, path, { payments: [{ amount: 250 }] })).toBe(
        "payments[0] is already recorded with a different amount",
      );
      expect(await owedAfter(api, path, { name: "Ada King" })).toBe(550);
    });

    test("a refusal names the adjustment by its own place, after the payments", async () => {
      const { api, path } = await booked();
      await owedAfter(api, path, { adjustments: [DELIVERY, FEE] });
      const refusal = await refusalOf(api, path, {
        adjustments: [DELIVERY, { ...FEE, amount: -150 }],
        payments: [{ amount: 200 }],
      });
      expect(refusal).toBe(
        "adjustments[1] is already recorded with a different amount",
      );
    });

    test("a refusal names each fact that the receipt changed", async () => {
      const { api, path } = await booked();
      const refusal = await refusalOf(api, path, {
        adjustments: [{ ...DELIVERY, amount: -250 }],
      });
      expect(refusal).toBe(
        "adjustments[0] is already recorded with a different kind, source, destination",
      );
    });
  },
);
