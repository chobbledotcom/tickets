/**
 * Servicing §5 — hidden from the public site.
 *
 * A servicing token is a capacity hold, not a ticket. Every customer-facing
 * token surface must refuse it — the real token ticket route `/t/:token` AND
 * its QR SVG `/t/:token/svg` (asserting against `/t/...` — a 404 on
 * `/ticket/...` would be a false pass, since no slug matches a token), the
 * wallet pass routes, the check-in page, and the single-attendee bulk-email
 * lookup. A control with a normal attendee proves the routes still serve 200.
 *
 * Implementation contract (test-first):
 *   - `lookupAttendees` / `getAttendeesByTokens` / `lookupSingleTokenPassData`
 *     / `getAttendeePiiBlobForToken` skip `kind='servicing'` rows (a kind
 *     predicate on the existing token readers, not a parallel set).
 *   - `#test-utils/servicing.ts` exposes the servicing event's `ticketToken`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeePiiBlobForToken } from "#shared/db/attendees/queries.ts";
import {
  awaitTestRequest,
  createServicingHold,
  createTestAttendeeWithToken,
  describeWithEnv,
} from "#test-utils";

// jscpd:ignore-end

/** Assert both `/t/:token` and `/t/:token/svg` return the given status. */
const assertTokenRoutes = async (
  token: string,
  expected: number,
): Promise<void> => {
  expect((await awaitTestRequest(`/t/${token}`)).status).toBe(expected);
  expect((await awaitTestRequest(`/t/${token}/svg`)).status).toBe(expected);
};

describeWithEnv(
  "servicing §5 — token ticket view 404s for a servicing token",
  { db: true },
  () => {
    test("GET /t/:token and /t/:token/svg return 404 for a servicing token", async () => {
      const { ticketToken } = await createServicingHold();
      await assertTokenRoutes(ticketToken, 404);
    });

    test("control: a normal attendee's token returns 200 on /t/ and /t/svg", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Real Customer",
        "real@example.com",
      );
      await assertTokenRoutes(token, 200);
    });

    test("a normal attendee booked alongside a servicing hold still gets 200", async () => {
      // Defence-in-depth: the kind predicate excludes only servicing rows; a real
      // customer on the same listing is unaffected by the hold existing.
      await createServicingHold({ name: "Hold" });
      const { token } = await createTestAttendeeWithToken(
        "Customer",
        "c@example.com",
        {},
      );
      expect((await awaitTestRequest(`/t/${token}`)).status).toBe(200);
    });
  },
);

describeWithEnv(
  "servicing §5 — wallet and check-in routes 404 for a servicing token",
  { db: true },
  () => {
    test("Apple Wallet pass build returns not-found for a servicing token", async () => {
      const { ticketToken } = await createServicingHold();
      // Call the shared builder directly with a stub config so the kind gate
      // (not the config gate) is what's under test.
      const { buildPkpassForToken } = await import("#routes/wallet/index.ts");
      expect((await buildPkpassForToken(ticketToken, {} as never)).status).toBe(
        404,
      );
    });

    test("the check-in page returns not-found for a servicing token", async () => {
      const { ticketToken } = await createServicingHold();
      expect((await awaitTestRequest(`/checkin/${ticketToken}`)).status).toBe(
        404,
      );
    });
  },
);

describeWithEnv(
  "servicing §5 — token bulk-email lookup skips servicing",
  { db: true },
  () => {
    test("getAttendeePiiBlobForToken returns null for a servicing token", async () => {
      const { ticketToken } = await createServicingHold();
      expect(await getAttendeePiiBlobForToken(ticketToken)).toBeNull();
    });

    test("control: a normal attendee's token resolves to its PII blob", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Real Customer",
        "real@example.com",
      );
      expect(await getAttendeePiiBlobForToken(token)).not.toBeNull();
    });
  },
);
