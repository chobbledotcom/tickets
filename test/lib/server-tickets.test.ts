import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { groupsTable } from "#shared/db/groups.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { clearTokenAttempts } from "#shared/db/token-attempts.ts";
import { MAX_TOKEN_404S } from "#shared/limits.ts";
import {
  awaitTestRequest,
  createDailyTestAttendee,
  createPaidTestAttendee,
  createTestAttendee,
  createTestAttendeeWithToken,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectHtml,
  expectHtmlResponse,
  fetchAliceTicketPageBody,
  getAttendeesRaw,
} from "#test-utils";

/** Fetch a ticket page and return the response body text */
const fetchTicketBody = async (tokenPath: string): Promise<string> => {
  const response = await awaitTestRequest(`/t/${tokenPath}`);
  return response.text();
};

/** Assert a daily-listing ticket page shows the booking date, returning the
 * body for any further assertions the caller needs. */
const expectDailyBookingDate = async (
  response: Response,
  date: string,
): Promise<string> => {
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain(formatDateLabel(date));
  expect(body).toContain("Booking Date");
  return body;
};

describeWithEnv("ticket view (/t/:tokens)", { db: true }, () => {
  test("displays ticket for a single valid token", async () => {
    const { listing, token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(listing.name);
    expect(body).toContain("Your Tickets");
  });

  test("displays tickets for multiple valid tokens", async () => {
    const { listing: listingA, token: tokenA } =
      await createTestAttendeeWithToken("Bob", "bob@test.com");
    const { listing: listingB, token: tokenB } =
      await createTestAttendeeWithToken("Bob", "bob@test.com", {}, 2);

    const body = await fetchTicketBody(`${tokenA}+${tokenB}`);
    expect(body).toContain(listingA.name);
    expect(body).toContain(listingB.name);
  });

  test("returns 404 for invalid token", async () => {
    const response = await awaitTestRequest("/t/nonexistent-token");
    expect(response.status).toBe(404);
  });

  test("returns 404 for empty tokens path", async () => {
    const response = await awaitTestRequest("/t/");
    expect(response.status).toBe(404);
  });

  test("shows quantity when greater than 1", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Carol",
      "carol@test.com",
      { maxQuantity: 5 },
      3,
    );

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("Quantity: 3");
  });

  test("shows quantity when equal to 1", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Carol",
      "carol@test.com",
    );

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("Quantity: 1");
  });

  test("deduplicates repeated tokens in URL", async () => {
    const { listing, token } = await createTestAttendeeWithToken(
      "Eve",
      "eve@test.com",
    );

    const body = await fetchTicketBody(`${token}+${token}`);
    expect(body).toContain(listing.name);
    expect(body).toContain("1 Ticket");
  });

  test("skips invalid tokens among valid ones", async () => {
    const { listing, token } = await createTestAttendeeWithToken(
      "Dave",
      "dave@test.com",
    );

    const response = await awaitTestRequest(`/t/${token}+bad-token`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(listing.name);
  });

  test("returns null for non-GET methods", async () => {
    const { routeTicketView } = await import("#routes/tickets/index.ts");
    const request = new Request("http://localhost/t/some-token", {
      method: "POST",
    });
    const result = await routeTicketView(request, "/t/some-token", "POST");
    expect(result).toBeNull();
  });

  test("attendee has a unique ticket_token_index after creation", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Frank",
      "frank@test.com",
    );
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Grace",
      "grace@test.com",
    );
    const attendees = await getAttendeesRaw(listing.id);

    expect(attendees[0]!.ticket_token_index).not.toBe("");
    expect(attendees[1]!.ticket_token_index).not.toBe("");
    expect(attendees[0]!.ticket_token_index).not.toBe(
      attendees[1]!.ticket_token_index,
    );
  });

  test("references SVG endpoint for QR code instead of inline SVG", async () => {
    const { token } = await createTestAttendeeWithToken("Eve", "eve@test.com");

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain(`/t/${token}/svg`);
    expect(body).toContain("<img");
  });

  test("serves QR code SVG at /t/:token/svg with cache headers", async () => {
    const { token } = await createTestAttendeeWithToken("Eve", "eve@test.com");

    const response = await awaitTestRequest(`/t/${token}/svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("cache-control")).toContain("public");

    const body = await response.text();
    expect(body).toContain("<svg");
    expect(body).toContain("</svg>");
  });

  test("returns 404 for /t/:token/svg with invalid token", async () => {
    const response = await awaitTestRequest("/t/nonexistent-token/svg");
    expect(response.status).toBe(404);
  });

  test("displays booked date for daily listing tickets", async () => {
    const date = "2026-02-15";
    const { token } = await createDailyTestAttendee(
      "Zara",
      "zara@test.com",
      date,
    );

    const response = await awaitTestRequest(`/t/${token}`);
    await expectDailyBookingDate(response, date);
  });

  test("shows date for daily listing and shows standard listing without date on same ticket page", async () => {
    const date = "2026-02-15";
    const { listing: dailyListing, token: tokenA } =
      await createDailyTestAttendee("Mixed", "mixed@test.com", date);
    const { listing: standardListing, token: tokenB } =
      await createTestAttendeeWithToken("Mixed", "mixed@test.com");

    const response = await awaitTestRequest(`/t/${tokenA}+${tokenB}`);
    const body = await expectDailyBookingDate(response, date);
    expect(body).toContain(dailyListing.name);
    expect(body).toContain(standardListing.name);
    expect(body).toContain("2 Tickets");
  });

  test("does not show booking date for standard listing tickets", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const body = await fetchTicketBody(token);
    expect(body).not.toContain("Booking Date");
  });

  test("shows listing date and location when listing has them", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
      {
        date: "2026-06-15T14:00",
        location: "Village Hall",
      },
    );

    const response = await awaitTestRequest(`/t/${token}`);
    await expectHtmlResponse(
      response,
      200,
      "ticket-card-date",
      "ticket-card-location",
      "Village Hall",
    );
  });

  test("does not show listing date or location when both are empty", async () => {
    const { token } = await createTestAttendeeWithToken("Bob", "bob@test.com");

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("ticket-card-date");
    expect(body).not.toContain("ticket-card-location");
  });

  test("shows listing description when present", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
      {
        description: "A wonderful listing",
      },
    );

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("ticket-card-description");
    expect(body).toContain("A wonderful listing");
  });

  test("does not show description when empty", async () => {
    const { token } = await createTestAttendeeWithToken("Bob", "bob@test.com");

    const body = await fetchTicketBody(token);
    expect(body).not.toContain("ticket-card-description");
  });

  test("shows price for paid tickets", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      unitPrice: 1500,
    });
    const attendee = await createPaidTestAttendee(
      listing.id,
      "Alice",
      "alice@test.com",
      "pi_test",
      1500,
    );

    const response = await awaitTestRequest(`/t/${attendee.ticket_token}`);
    const body = await response.text();
    expect(body).toContain("ticket-card-price");
    expect(body).toContain(formatCurrency(1500));
  });

  test("does not show price for free tickets", async () => {
    const { token } = await createTestAttendeeWithToken("Bob", "bob@test.com");

    const body = await fetchTicketBody(token);
    expect(body).not.toContain("ticket-card-price");
  });

  test("displays ticket token on ticket page", async () => {
    const { body, token } = await fetchAliceTicketPageBody();
    expect(body).toContain("ticket-card-token");
    expect(body).toContain(token);
  });

  test("shows non-transferable notice for non-transferable listing", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice Smith",
      "alice@test.com",
      { nonTransferable: true },
    );

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("ticket-card-notice");
    expect(body).toContain("Non-transferable");
    expect(body).toContain("ID required at entry");
  });

  test("does not show non-transferable notice for transferable listing", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Bob Jones",
      "bob@test.com",
    );

    await expectHtml(await awaitTestRequest(`/t/${token}`), {
      notContains: ["ticket-card-notice", "Non-transferable"],
      status: 200,
    });
  });

  test("shows attachment download link when listing has attachment", async () => {
    const { listing, token } = await createTestAttendeeWithToken(
      "Alice Smith",
      "alice@test.com",
    );
    await listingsTable.update(listing.id, {
      attachmentName: "Listing Guide.pdf",
      attachmentUrl: "abc-guide.pdf",
    });

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("attachment-link");
    expect(body).toContain("Download: Listing Guide.pdf");
    expect(body).toContain("/attachment/");
  });

  test("does not show attachment link when listing has no attachment", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Bob Jones",
      "bob@test.com",
    );

    await expectHtml(await awaitTestRequest(`/t/${token}`), {
      notContains: ["attachment-link", "Download:"],
      status: 200,
    });
  });

  test("returns 429 after hitting MAX_TOKEN_404S distinct invalid tokens", async () => {
    // Tests use "direct" as the fallback IP — clear any prior state.
    await clearTokenAttempts("direct");

    for (let i = 0; i < MAX_TOKEN_404S; i++) {
      const res = await awaitTestRequest(`/t/bad-token-${i}`);
      expect(res.status).toBe(404);
    }

    const locked = await awaitTestRequest("/t/any-token");
    expect(locked.status).toBe(429);
  });

  test("successful lookups do not count toward rate limit", async () => {
    await clearTokenAttempts("direct");
    const { token } = await createTestAttendeeWithToken("Hal", "hal@test.com");

    for (let i = 0; i < MAX_TOKEN_404S * 2; i++) {
      const res = await awaitTestRequest(`/t/${token}`);
      expect(res.status).toBe(200);
    }

    const stillOk = await awaitTestRequest(`/t/${token}`);
    expect(stillOk.status).toBe(200);
  });

  test("repeated hits on the same invalid token don't lock out", async () => {
    await clearTokenAttempts("direct");

    for (let i = 0; i < MAX_TOKEN_404S * 3; i++) {
      const res = await awaitTestRequest("/t/same-invalid-token");
      expect(res.status).toBe(404);
    }

    const stillAllowed = await awaitTestRequest("/t/other-invalid");
    expect(stillAllowed.status).toBe(404);
  });

  test("rate limit applies to SVG endpoint too", async () => {
    await clearTokenAttempts("direct");

    for (let i = 0; i < MAX_TOKEN_404S; i++) {
      const res = await awaitTestRequest(`/t/bad-svg-${i}/svg`);
      expect(res.status).toBe(404);
    }

    const locked = await awaitTestRequest("/t/some-token/svg");
    expect(locked.status).toBe(429);
  });

  test("successful lookup clears prior fat-finger failures", async () => {
    await clearTokenAttempts("direct");
    const { token } = await createTestAttendeeWithToken("Ivy", "ivy@test.com");

    for (let i = 0; i < MAX_TOKEN_404S - 1; i++) {
      const bad = await awaitTestRequest(`/t/fatfinger-${i}`);
      expect(bad.status).toBe(404);
    }

    const good = await awaitTestRequest(`/t/${token}`);
    expect(good.status).toBe(200);

    for (let i = 0; i < MAX_TOKEN_404S - 1; i++) {
      const res = await awaitTestRequest(`/t/after-reset-${i}`);
      expect(res.status).toBe(404);
    }
    const notLocked = await awaitTestRequest("/t/probe");
    expect(notLocked.status).toBe(404);
  });
});

describeWithEnv(
  "ticket view package grouping (/t/:tokens)",
  { db: true },
  () => {
    /** A HIDDEN one-member package group and its sole listing. */
    const hiddenOneMemberPackage = async () => {
      const group = await createTestGroup({ isPackage: true, name: "Kit Bag" });
      await groupsTable.update(group.id, { hidePackageListings: true });
      const widget = await createTestListing({
        groupId: group.id,
        name: "Widget",
      });
      return { group, widget };
    };

    test("a standalone booking of a hidden package's listing is NOT collapsed/hidden", async () => {
      // Regression for the membership-equality bug: the listing booked NOT via the
      // package (package_group_id 0 on its rows) must render normally, never
      // collapsed/renamed to the hidden package.
      const { widget } = await hiddenOneMemberPackage();
      const result = await createAttendeeAtomic({
        bookings: [{ listingId: widget.id, quantity: 1 }],
        email: "standalone@test.com",
        name: "Standalone",
      });
      if (!result.success) throw new Error("standalone booking failed");
      const token = result.attendees[0]!.ticket_token;

      const body = await fetchTicketBody(token);
      expect(body).toContain("Widget");
      expect(body).not.toContain("Kit Bag");
    });

    test("the same listing booked as the package IS collapsed under the package name", async () => {
      const { group, widget } = await hiddenOneMemberPackage();
      const result = await createAttendeeAtomic({
        bookings: [{ listingId: widget.id, quantity: 1 }],
        email: "pkg@test.com",
        name: "Packaged",
        packageGroupId: group.id,
      });
      if (!result.success) throw new Error("package booking failed");
      const token = result.attendees[0]!.ticket_token;

      const body = await fetchTicketBody(token);
      expect(body).toContain("Kit Bag");
      // Hidden package: the member listing name is suppressed.
      expect(body).not.toContain("Widget");
    });

    test("two separate package orders are NOT collapsed into one card", async () => {
      // /t/a+b resolves two distinct attendees who happen to share a package
      // group; collapsing them would render a single package card and drop the
      // second ticket. Only a single-token order collapses, so two tokens render
      // normally (each booking as its own card) rather than one hidden package.
      const { group, widget } = await hiddenOneMemberPackage();
      const book = async (email: string) => {
        const result = await createAttendeeAtomic({
          bookings: [{ listingId: widget.id, quantity: 1 }],
          email,
          name: email,
          packageGroupId: group.id,
        });
        if (!result.success) throw new Error("package booking failed");
        return result.attendees[0]!.ticket_token;
      };
      const tokenA = await book("a@test.com");
      const tokenB = await book("b@test.com");

      const body = await fetchTicketBody(`${tokenA}+${tokenB}`);
      // Two cards, rendered normally — not collapsed into one hidden package.
      expect(body).toContain("2 Tickets");
      expect(body).toContain("Widget");
      expect(body).not.toContain("Kit Bag");
    });

    test("a FREE public package checkout stamps package_group_id and collapses the ticket", async () => {
      // Drives the public free-checkout path so handleFreePath threads
      // ctx.packageGroupId into createFreeReservation — the standalone-vs-package
      // distinction comes from the persisted id, set here end-to-end.
      const { handleRequest } = await import("#routes");
      const { mockRequest, mockTicketFormRequest } = await import(
        "#test-utils/mocks.ts"
      );
      const { extractCsrfToken } = await import("#test-utils/csrf.ts");
      const { getDb } = await import("#shared/db/client.ts");

      const group = await createTestGroup({
        isPackage: true,
        name: "Free Kit",
        slug: "free-kit",
      });
      await groupsTable.update(group.id, { hidePackageListings: true });
      // A free member (unit price 0) so the order completes via the free path.
      const freebie = await createTestListing({
        groupId: group.id,
        name: "Freebie",
        unitPrice: 0,
      });

      const pageHtml = await (
        await handleRequest(mockRequest(`/ticket/${group.slug}`))
      ).text();
      const csrf = extractCsrfToken(pageHtml)!;
      const submit = await handleRequest(
        mockTicketFormRequest(
          group.slug,
          {
            email: "freepkg@test.com",
            name: "Free Buyer",
            package_quantity: "1",
          },
          csrf,
        ),
      );
      expect([302, 303]).toContain(submit.status);

      // The free public package checkout stamped the group id onto the booking
      // row (the standalone-vs-package distinction is persisted, not inferred).
      const row = (
        await getDb().execute({
          args: [freebie.id],
          sql: "SELECT package_group_id FROM listing_attendees WHERE listing_id = ? ORDER BY id DESC LIMIT 1",
        })
      ).rows[0]!;
      expect(Number(row.package_group_id)).toBe(group.id);
    });
  },
);
