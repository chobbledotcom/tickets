import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeeBalanceState } from "#db/attendees/balance.ts";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { setGroupPackageMembers } from "#db/groups.ts";
import { settings } from "#db/settings.ts";
import { handlePaymentSuccess } from "#routes/api/payment-success.ts";
import { apiBookPackage } from "#test/features/api/packages/helpers.ts";
import { getPayPage } from "#test/integration/balance-helpers.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookedAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { stubPaidCheckout } from "#test-utils/payment-session.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";

describeWithEnv("the paid success balance page", { db: true }, () => {
  test("shows a concealed package's balance payment without its member URL", async () => {
    await settings.update.showPublicApi(true);
    const group = await createHiddenPackageGroup("Balance Box");
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 5,
      maxQuantity: 10,
      name: "Secret Member",
      thankYouUrl: "https://example.com/secret-member",
      unitPrice: 1000,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 1000 },
    ]);
    const booked = await apiBookPackage(group.slug);
    expect(booked.response.status).toBe(200);
    expect(booked.body.booking?.amountOwed).toBe(1000);
    const attendee = (
      await getAttendeesByTokens([booked.body.booking!.ticketToken])
    )[0];
    if (!attendee) throw new Error("Missing booked attendee");
    await setupStripe();
    using refund = stubRefundPayment("re_balance_private", 1000);
    using _provider = await stubPaidCheckout(
      "cs_balance_hidden",
      [{ e: member.id, p: 1000, q: 1 }],
      { balance_attendee_id: String(attendee.id) },
    );

    const response = await handlePaymentSuccess(
      new Request(
        "http://localhost/payment/success?session_id=cs_balance_secret",
      ),
    );

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('data-payment-result="success"');
    expect(page).not.toContain("secret-member");
    expect(page).not.toContain('http-equiv="refresh"');
    expect((await getAttendeeBalanceState(attendee.id))?.remainingBalance).toBe(
      0,
    );
    expect(refund.calls).toHaveLength(0);
  });

  test("shows a named booking's balance payment without its thank-you URL", async () => {
    await setupStripe();
    const { attendeeId, listingId } = await createReservedAttendee(500);
    using refund = stubRefundPayment("re_balance_named", 500);
    using _provider = await stubPaidCheckout(
      "cs_balance_named",
      [{ e: listingId, p: 500, q: 1 }],
      { balance_attendee_id: String(attendeeId) },
    );

    const response = await handlePaymentSuccess(
      new Request(
        "http://localhost/payment/success?session_id=cs_balance_named",
      ),
    );

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('data-payment-result="success"');
    expect(page).not.toContain("example.com");
    expect(page).not.toContain('http-equiv="refresh"');
    expect((await getAttendeeBalanceState(attendeeId))?.remainingBalance).toBe(
      0,
    );
    expect(refund.calls).toHaveLength(0);
  });

  test("collapses a concealing package row behind the package name", async () => {
    const group = await createHiddenPackageGroup("Mystery Box");
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Secret Contents",
      unitPrice: 1000,
    });
    const plain = await createTestListing({
      maxAttendees: 10,
      name: "Workshop Ticket",
      unitPrice: 1000,
    });
    const result = await attendeesApi.createAttendeeAtomic({
      bookings: [
        { listingId: member.id, packageGroupId: group.id, quantity: 1 },
        { listingId: plain.id, quantity: 2 },
      ],
      email: "balance@example.com",
      name: "Balance Buyer",
      remainingBalance: 3000,
    });
    const attendee = bookedAttendee(result);
    await postListingSale({
      amountPaid: 0,
      attendeeId: attendee.id,
      gross: 1000,
      listingId: member.id,
    });
    await postListingSale({
      amountPaid: 0,
      attendeeId: attendee.id,
      gross: 2000,
      listingId: plain.id,
    });
    expect((await getAttendeeBalanceState(attendee.id))?.remainingBalance).toBe(
      3000,
    );
    const html = await getPayPage(attendee.id);

    expect(html).not.toContain("Secret Contents");
    expect(html).toContain("Mystery Box");
    expect(html).toContain("Workshop Ticket");
  });
});
