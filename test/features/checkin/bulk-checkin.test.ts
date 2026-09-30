import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTwoListingBooking } from "#test-utils/db-helpers/bookings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import { testCsrfToken } from "#test-utils/session.ts";
import {
  checkOneLegAsStaff,
  postCheckin,
  setupCheckinTest,
} from "./helpers.ts";

describeWithEnv(
  "what the door's bulk check-in writes and offers",
  { db: true },
  () => {
    describe("POST /checkin/:tokens", () => {
      test("records each changed row in the activity log", async () => {
        const { listing, session, token } = await setupCheckinTest(
          "Logged",
          "logged@test.com",
        );

        await postCheckin(token, session, "true");
        await postCheckin(token, session, "false");

        const { getAttendeesByTokens } = await import(
          "#db/attendees/tokens.ts"
        );
        const { getAttendeeActivityLog } = await import("#db/activity-log.ts");
        const [awb] = await getAttendeesByTokens([token]);
        const { withTestSession } = await import("#test-utils/session.ts");
        // Reading the log decrypts its messages, which needs a session's
        // private key: run the read inside the test session's context.
        const log = await withTestSession(() =>
          getAttendeeActivityLog(awb!.id),
        );

        // Newest first: the checkout the door made last, then the check-in.
        // Older rows (the attendee's own creation) sit below them.
        expect(log.map((entry) => entry.message).slice(0, 2)).toEqual([
          `Attendee checked out 1 ticket for '${listing.name}'`,
          `Attendee checked in 1 ticket for '${listing.name}'`,
        ]);
      });

      test("a partly checked token logs only the rows the action moves", async () => {
        const { attendee, first, second } = await createTwoListingBooking(
          "Logged Partly",
          "logged-partly@test.com",
        );
        // Staff check one leg in through its own row's form; the bulk door
        // action then admits only the leg that still waits.
        await checkOneLegAsStaff(first.id, attendee.id);
        const { cookie } = await createTestScannerSession();
        const session = { cookie, csrfToken: await testCsrfToken() };

        await postCheckin(attendee.ticket_token, session, "true");

        const { getAttendeesByTokens } = await import(
          "#db/attendees/tokens.ts"
        );
        const { getAttendeeActivityLog } = await import("#db/activity-log.ts");
        const [awb] = await getAttendeesByTokens([attendee.ticket_token]);
        const { withTestSession } = await import("#test-utils/session.ts");
        const doorEntries = async () =>
          (await withTestSession(() => getAttendeeActivityLog(awb!.id)))
            .filter((entry) => entry.message.startsWith("Attendee checked "))
            .map((entry) => entry.message);

        // The leg the row-toggle checked in keeps its one record; the bulk
        // action adds none for it and records only the waiting leg.
        expect(await doorEntries()).toEqual([
          `Attendee checked in 1 ticket for '${second.name}'`,
          `Attendee checked in 1 ticket for '${first.name}'`,
        ]);

        await postCheckin(attendee.ticket_token, session, "false");
        // Both legs were in, so the checkout moves both — and records both.
        const afterCheckout = await doorEntries();
        expect(afterCheckout).toEqual([
          `Attendee checked out 1 ticket for '${second.name}'`,
          `Attendee checked out 1 ticket for '${first.name}'`,
          `Attendee checked in 1 ticket for '${second.name}'`,
          `Attendee checked in 1 ticket for '${first.name}'`,
        ]);

        await postCheckin(attendee.ticket_token, session, "false");
        // Checking out again moves nothing, so it records nothing new.
        expect(await doorEntries()).toEqual(afterCheckout);
      });

      test("a refunded checked row never turns the bulk action to checkout", async () => {
        const { attendee, first } = await createTwoListingBooking(
          "Route Mixed",
          "route-mixed@test.com",
        );
        // Staff check one leg in through its own row's form; the refund
        // takes that leg back. The other leg still waits at the door.
        await checkOneLegAsStaff(first.id, attendee.id);
        const { refundThroughLedger } = await import("#test-utils/ledger.ts");
        await refundThroughLedger(attendee.id, first.id);

        const response = await awaitTestRequest(
          `/checkin/${attendee.ticket_token}`,
          { cookie: (await createTestScannerSession()).cookie },
        );
        const body = await response.text();
        // The live row's admission stays on offer; a refunded checked row
        // is out of the eligibility set, so it cannot flip the action.
        expect(body).toContain("Check In All");
        expect(body).not.toContain("Check Out All");
      });
    });
  },
);
