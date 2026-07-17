import type { TransactionMode } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import type { ListingBooking } from "#shared/db/attendee-types.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { decryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { getAttendeesByTokens } from "#shared/db/attendees/tokens.ts";
import {
  checkoutStagesApi,
  findCheckoutStage,
} from "#shared/db/checkout-stages.ts";
import { getDb, queryAll, queryOne } from "#shared/db/client.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { createPaidCheckout } from "#shared/staged-checkout.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { checkoutIntent } from "#test-utils/checkout.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

const createdSession = {
  checkoutUrl: "https://pay.example/checkout",
  providerCheckoutId: "provider-checkout-1",
  sessionId: "session-1",
};

const stageRows = (): Promise<unknown[]> =>
  queryAll("SELECT payment_session_id FROM checkout_stages", []);

const attendeeToken = async (attendeeId: number): Promise<string> => {
  const row = await queryOne<{ pii_blob: OwnerKeyEncrypted }>(
    "SELECT pii_blob FROM attendees WHERE id = ?",
    [attendeeId],
  );
  return (await decryptPiiBlob(row!.pii_blob, await getTestPrivateKey(), true))
    .ticket_token;
};

const stagedCheckout = async (bookings: ListingBooking[]) => {
  const items = bookings.map((booking) => ({
    listingId: booking.listingId,
    name: `Listing ${booking.listingId}`,
    quantity: booking.quantity ?? 1,
    slug: `listing-${booking.listingId}`,
    unitPrice: 1000,
    ...(booking.packageGroupId
      ? { packageGroupId: booking.packageGroupId }
      : {}),
  }));
  return createPaidCheckout({
    baseUrl: "https://tickets.example",
    intent: checkoutIntent({
      allocations: bookings
        .filter((booking) => booking.parentListingId)
        .map((booking) => ({
          childId: booking.listingId,
          parentId: booking.parentListingId!,
          qty: booking.quantity ?? 1,
        })),
      date: bookings.find((booking) => booking.date)?.date ?? null,
      items,
    }),
    provider: stripePaymentProvider,
  });
};

const createdCheckout = async (
  closeCheckout: PaymentProvider["closeCheckout"],
) => {
  const listing = await createTestListing();
  const create = stub(stripePaymentProvider, "createCheckoutSession", () =>
    Promise.resolve(createdSession),
  );
  const close = stub(stripePaymentProvider, "closeCheckout", closeCheckout);
  return {
    close,
    restore: () => {
      create.restore();
      close.restore();
    },
    run: () => stagedCheckout([{ listingId: listing.id, quantity: 1 }]),
  };
};

const failedStageWrite = async (
  closeCheckout: PaymentProvider["closeCheckout"],
) => {
  const checkout = await createdCheckout(closeCheckout);
  await getDb().execute("DROP TABLE checkout_stages");
  return checkout;
};

describeWithEnv("staged checkout", { db: true }, () => {
  test("returns no stage when the exact session and attendee do not exist", async () => {
    expect(await findCheckoutStage("missing", 999, "token")).toBeNull();
  });

  test("fails before provider creation when a checkout listing is missing", async () => {
    const create = stub(stripePaymentProvider, "createCheckoutSession");
    try {
      await expect(
        stagedCheckout([{ listingId: 999, quantity: 1 }]),
      ).rejects.toThrow("Could not load every listing");
      expect(create.calls.length).toBe(0);
    } finally {
      create.restore();
    }
  });

  test("preflights one listing through the collection path and does not create a provider session when sold out", async () => {
    const listing = await createTestListing({ maxAttendees: 1 });
    const availability = stub(attendeesApi, "checkBatchAvailability", () =>
      Promise.resolve(false),
    );
    const create = stub(stripePaymentProvider, "createCheckoutSession");
    try {
      expect(
        await stagedCheckout([{ listingId: listing.id, quantity: 1 }]),
      ).toEqual({ type: "sold_out" });
      expect(availability.calls[0]!.args[0]).toEqual([
        { durationDays: 1, listingId: listing.id, quantity: 1 },
      ]);
      expect(create.calls.length).toBe(0);
      expect(await stageRows()).toEqual([]);
    } finally {
      availability.restore();
      create.restore();
    }
  });

  test("stores exact single, multi-path, package, and dated identities at zero quantity without holding capacity", async () => {
    const group = await createTestGroup({ isPackage: true });
    const first = await createTestListing({ groupId: group.id });
    const second = await createDailyTestListing();
    const bookings: ListingBooking[] = [
      { listingId: first.id, quantity: 2 },
      {
        date: "2026-08-20",
        durationDays: 3,
        listingId: first.id,
        packageGroupId: group.id,
        quantity: 1,
      },
      { listingId: second.id, parentListingId: first.id, quantity: 4 },
    ];
    const create = stub(stripePaymentProvider, "createCheckoutSession", () =>
      Promise.resolve(createdSession),
    );
    try {
      expect(await stagedCheckout(bookings)).toEqual({
        ...createdSession,
        type: "checkout",
      });
      const stage = await queryOne<{
        attendee_id: number;
        provider_checkout_id: string;
        state: string;
        ticket_tokens: string;
      }>(
        "SELECT attendee_id, provider_checkout_id, state, ticket_tokens FROM checkout_stages WHERE payment_session_id = ?",
        [createdSession.sessionId],
      );
      expect(stage!.provider_checkout_id).toBe(
        createdSession.providerCheckoutId,
      );
      expect(stage!.state).toBe("pending");
      const token = await attendeeToken(stage!.attendee_id);
      expect(stage!.ticket_tokens.includes(token)).toBe(false);
      expect(
        await findCheckoutStage(
          createdSession.sessionId,
          stage!.attendee_id,
          token,
        ),
      ).toMatchObject({ state: "pending" });
      expect(await getAttendeeRaw(stage!.attendee_id)).toBeNull();
      expect(await getAttendeesByTokens([token])).toEqual([null]);
      expect(
        await findCheckoutStage(
          createdSession.sessionId,
          stage!.attendee_id,
          `${token}x`,
        ),
      ).toBeNull();
      expect(
        await queryAll(
          `SELECT listing_id, start_at, end_at, quantity, parent_listing_id, package_group_id
             FROM listing_attendees WHERE attendee_id = ? ORDER BY rowid`,
          [stage!.attendee_id],
        ),
      ).toEqual([
        {
          end_at: null,
          listing_id: first.id,
          package_group_id: 0,
          parent_listing_id: 0,
          quantity: 0,
          start_at: null,
        },
        {
          end_at: null,
          listing_id: first.id,
          package_group_id: group.id,
          parent_listing_id: 0,
          quantity: 0,
          start_at: null,
        },
        {
          end_at: "2026-08-21T00:00:00.000Z",
          listing_id: second.id,
          package_group_id: 0,
          parent_listing_id: first.id,
          quantity: 0,
          start_at: "2026-08-20T00:00:00Z",
        },
      ]);
      const capacity = await queryOne<{ booked_quantity: number }>(
        "SELECT booked_quantity FROM listings WHERE id = ?",
        [first.id],
      );
      expect(capacity!.booked_quantity).toBe(0);
    } finally {
      create.restore();
    }
  });

  test("reads a freshly stored stage from the primary", async () => {
    const listing = await createTestListing();
    const create = stub(stripePaymentProvider, "createCheckoutSession", () =>
      Promise.resolve(createdSession),
    );
    try {
      expect(
        await stagedCheckout([{ listingId: listing.id, quantity: 1 }]),
      ).toMatchObject({ type: "checkout" });
      const stage = await queryOne<{ attendee_id: number }>(
        "SELECT attendee_id FROM checkout_stages WHERE payment_session_id = ?",
        [createdSession.sessionId],
      );
      const token = await attendeeToken(stage!.attendee_id);
      const client = getDb();
      const originalBatch = client.batch.bind(client);
      const modes: TransactionMode[] = [];
      const batch = stub(client, "batch", (statements, mode) => {
        modes.push(mode ?? "deferred");
        return originalBatch(statements, mode);
      });
      try {
        expect(
          await findCheckoutStage(
            createdSession.sessionId,
            stage!.attendee_id,
            token,
          ),
        ).toMatchObject({ paymentSessionId: createdSession.sessionId });
        expect(modes).toEqual(["write"]);
      } finally {
        batch.restore();
      }
    } finally {
      create.restore();
    }
  });

  test("closes the provider checkout and exposes no URL when the atomic stage write fails", async () => {
    const failure = await failedStageWrite(() =>
      Promise.resolve("closed" as const),
    );
    try {
      await expect(failure.run()).rejects.toThrow(
        "Could not store checkout stage",
      );
      expect(failure.close.calls[0]!.args[0]).toEqual({
        providerCheckoutId: createdSession.providerCheckoutId,
        sessionId: createdSession.sessionId,
      });
      expect(await queryAll("SELECT id FROM attendees", [])).toEqual([]);
    } finally {
      failure.restore();
    }
  });

  test("propagates a close failure after a stage write failure", async () => {
    const failure = await failedStageWrite(() =>
      Promise.reject(new Error("provider close failed")),
    );
    try {
      await expect(failure.run()).rejects.toThrow("provider close failed");
    } finally {
      failure.restore();
    }
  });

  test("fails loudly when payment wins the stage-write race", async () => {
    const failure = await failedStageWrite(() =>
      Promise.resolve("paid" as const),
    );
    try {
      await expect(failure.run()).rejects.toThrow("was already paid");
    } finally {
      failure.restore();
    }
  });

  test("closes checkout when stage attendee preparation reports failure", async () => {
    const checkout = await createdCheckout(() =>
      Promise.resolve("closed" as const),
    );
    const stage = stub(attendeesApi, "createStagedCheckoutAtomic", () =>
      Promise.resolve({ reason: "encryption_error" as const, success: false }),
    );
    try {
      await expect(checkout.run()).rejects.toThrow(
        "Could not store checkout stage",
      );
      expect(checkout.close.calls.length).toBe(1);
    } finally {
      checkout.restore();
      stage.restore();
    }
  });

  test("closes checkout when its stored stage cannot be read back exactly", async () => {
    const checkout = await createdCheckout(() =>
      Promise.resolve("closed" as const),
    );
    const find = stub(checkoutStagesApi, "find", () => Promise.resolve(null));
    try {
      await expect(checkout.run()).rejects.toThrow(
        "Could not store checkout stage",
      );
      expect(await stageRows()).toEqual([
        { payment_session_id: createdSession.sessionId },
      ]);
    } finally {
      checkout.restore();
      find.restore();
    }
  });
});
