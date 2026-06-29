import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { formatCountdown } from "#routes/format.ts";
import { withCookie } from "#routes/response.ts";
import { addDays } from "#shared/dates.ts";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { getDb, insert } from "#shared/db/client.ts";
import {
  assignListingsToGroup,
  getGroupIdsByListingId,
} from "#shared/db/groups.ts";
import {
  getAllListings,
  getListing,
  getListingWithCount,
  invalidateListingsCache,
  listingsTable,
  updateListingAggregateValues,
} from "#shared/db/listings.ts";
import {
  answersTable,
  questionsTable,
  saveAttendeeAnswers,
  setListingQuestions,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import { nowMs } from "#shared/now.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  adminFormPost,
  adminGet,
  adminMultipartPost,
  assertAdminHtml,
  assertAdminHtmlWithCookie,
  awaitTestRequest,
  bookAttendee,
  createTestAttendee,
  createTestGroup,
  createTestListing,
  createTestManagerSession,
  deactivateTestListing,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  followRedirectWithFlash,
  getAllActivityLog,
  getListingActivityLog,
  logActivity,
  mockFormRequest,
  mockMultipartRequest,
  setTestEnv,
  setupListingAndLogin,
  submitTicketForm,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
  updateTestListing,
} from "#test-utils";
import { postAttendeeRefund, postListingSale } from "#test-utils/ledger.ts";

describeWithEnv("server (admin listings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("GET /admin/listings", () => {
    testRequiresAuth("/admin/listings");

    test("renders active listings before deactivated listings", async () => {
      const active = await createTestListing({ name: "Active Show" });
      const deactivated = await createTestListing({ name: "Old Show" });
      await deactivateTestListing(deactivated.id);

      const response = await adminGet("/admin/listings");
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('class="active" href="/admin/listings"');
      expect(html).toContain(active.name);
      expect(html).toContain(deactivated.name);
      expect(html.indexOf(active.name)).toBeLessThan(
        html.indexOf(deactivated.name),
      );
    });
  });

  describe("GET /admin/listing/new", () => {
    testRequiresAuth("/admin/listing/new");

    test("renders type picker when authenticated (no template param)", async () => {
      const response = await adminGet("/admin/listing/new");
      await expectHtmlResponse(
        response,
        200,
        "Add Listing",
        "Choose a listing type",
      );
    });

    test("renders create listing form with template=custom", async () => {
      const response = await adminGet("/admin/listing/new?template=custom");
      await expectHtmlResponse(
        response,
        200,
        "Add Listing",
        'action="/admin/listing"',
      );
    });

    test("renders create listing form with a named template param", async () => {
      const response = await adminGet(
        "/admin/listing/new?template=one-off-event",
      );
      await expectHtmlResponse(
        response,
        200,
        "Add Listing",
        'action="/admin/listing"',
      );
    });

    test("redirects to picker when a logistics template is requested but logistics is disabled", async () => {
      settings.setForTest({ has_logistics: false });
      const response = await adminGet(
        "/admin/listing/new?template=hireable-item",
      );
      await expectHtmlResponse(
        response,
        200,
        "Add Listing",
        "Choose a listing type",
      );
    });
  });

  describe("POST /admin/listing", () => {
    testRequiresAuth("/admin/listing", {
      body: {
        max_attendees: "100",
        max_quantity: "1",
        name: "Test Listing",
        thank_you_url: "https://example.com",
      },
      multipart: true,
    });

    test("redirects to picker when posting a logistics template with logistics disabled", async () => {
      settings.setForTest({ has_logistics: false });
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "100",
        max_quantity: "1",
        name: "Hireable",
        template_id: "hireable-item",
        thank_you_url: "https://example.com",
      });
      await expectHtmlResponse(
        response,
        200,
        "Add Listing",
        "Choose a listing type",
      );
    });

    test("returns date required error for one-off-event template with no date", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        listing_type: "standard",
        max_attendees: "100",
        max_quantity: "1",
        name: "My Event",
        purchase_only: "",
        template_id: "one-off-event",
        thank_you_url: "https://example.com",
        uses_logistics: "",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("date is required");
    });

    test("re-renders with carried template_id when create validation fails", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "100",
        max_quantity: "1",
        template_id: "online-digital",
        thank_you_url: "https://example.com",
        // name omitted → validation error
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('value="online-digital"');
    });

    test("creates listing when authenticated", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "New Listing",
        thank_you_url: "https://example.com/thanks",
      });
      await expectFlashRedirect("/admin", "Listing created")(response);

      // Verify listing was actually created
      const listing = await getListing(1);
      expect(listing).not.toBeNull();
      expect(listing?.name).toBe("New Listing");
    });

    test("clears webhook URL when creating listing in demo mode", async () => {
      setDemoModeForTest(true);

      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Demo Listing",
        webhook_url: "https://example.com/webhook",
      });
      await expectFlashRedirect("/admin", "Listing created")(response);

      // Verify webhook_url was cleared
      const listing = await getListing(1);
      expect(listing).not.toBeNull();
      expect(listing?.webhook_url).toBe("");
    });

    test("creates listing with group_id when provided", async () => {
      const group = await createTestGroup({
        name: "Listing Group",
        slug: "listing-group",
      });
      const { response } = await adminMultipartPost("/admin/listing", {
        group_ids: String(group.id),
        max_attendees: "50",
        max_quantity: "1",
        name: "Grouped Listing",
        thank_you_url: "https://example.com/thanks",
      });
      await expectFlashRedirect("/admin", "Listing created")(response);

      const listing = await getListing(1);
      expect(await getGroupIdsByListingId(listing!.id)).toContain(group.id);
    });

    test("rejects non-existent group_id on create", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        group_ids: "999",
        max_attendees: "50",
        max_quantity: "1",
        name: "Bad Group Listing",
        thank_you_url: "https://example.com/thanks",
      });
      expectStatus(400)(response);

      const listings = await getAllListings();
      const match = listings.find((e) => e.name === "Bad Group Listing");
      expect(match).toBeUndefined();
    });

    test("rejects listing type mismatch with group on create", async () => {
      const group = await createTestGroup({
        name: "Standard Group",
        slug: "standard-group",
      });
      await createTestListing({
        groupId: group.id,
        listingType: "standard",
        maxAttendees: 50,
        name: "Standard Listing",
      });

      const { response } = await adminMultipartPost("/admin/listing", {
        group_ids: String(group.id),
        listing_type: "daily",
        max_attendees: "50",
        max_quantity: "1",
        name: "Daily Mismatch",
        thank_you_url: "https://example.com/thanks",
      });
      expectStatus(400)(response);
      const body = await response.clone().text();
      expect(body).toContain("already contains standard listings");
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/listing",
          {
            csrf_token: "invalid-csrf-token",
            max_attendees: "50",
            max_quantity: "1",
            name: "New Listing",
            thank_you_url: "https://example.com/thanks",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects missing CSRF token", async () => {
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/listing",
          {
            max_attendees: "50",
            max_quantity: "1",
            name: "New Listing",
            thank_you_url: "https://example.com/thanks",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("stays on form with error on validation failure", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "",
        name: "",
        thank_you_url: "",
      });
      await expectHtmlResponse(response, 400, "Add Listing");
    });

    test("rejects duplicate slug", async () => {
      // First, create an listing with a specific name
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Duplicate Listing",
        thankYouUrl: "https://example.com",
      });

      // Try to create another listing with the same name (generates same slug)
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Duplicate Listing",
        thank_you_url: "https://example.com",
      });
      // Slug auto-generated so creation succeeds
      await expectFlashRedirect("/admin", "Listing created")(response);
    });
  });

  describe("GET /admin/listing/:id", () => {
    testRequiresAuth("/admin/listing/1");

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999");
      expect(response.status).toBe(404);
    });

    test("shows listing details when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      await assertAdminHtml("/admin/listing/1", listing.name);
    });

    test("renders the income & ledger breakdown reconciling income with the balance", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Ledger Listing",
        thankYouUrl: "https://example.com",
      });
      const buyer = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada",
        "ada@example.com",
      );
      // A £50 sale, then a refunded £20 booking (postAttendeeRefund posts a
      // self-contained net-zero order — a sale plus its full reversal). So gross
      // credits total £70 and recognised income is £70 (refund-agnostic), while
      // the net ledger balance is £50 once the £20 refund_sale debit is netted —
      // a legitimate divergence the page must show reconciled.
      await postListingSale({
        attendeeId: buyer.id,
        gross: 5000,
        listingId: listing.id,
      });
      await postAttendeeRefund({
        attendeeId: buyer.id,
        gross: 2000,
        listingId: listing.id,
      });

      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).toContain("Income &amp; ledger");
      expect(html).toContain("Gross ticket sales");
      expect(html).toContain("Recognised income");
      expect(html).toContain("Net balance in ledger");
      // Recognised income £70 differs from the net ledger balance £50 by the £20
      // refund — both rendered, reconciled.
      expect(html).toContain("£70");
      expect(html).toContain("£50");
      expect(html).toContain("−£20");
      expect(html).toContain(`href="/admin/ledger?listing=${listing.id}"`);
    });

    test("does not eagerly render the full revenue statement on listing detail pages", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Busy Listing",
        thankYouUrl: "https://example.com",
      });
      const buyer = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada",
        "ada@example.com",
      );
      await postListingSale({
        attendeeId: buyer.id,
        gross: 5000,
        listingId: listing.id,
      });

      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).toContain("Income &amp; ledger");
      expect(html).toContain(`href="/admin/ledger?listing=${listing.id}"`);
      expect(html).not.toContain('<section id="ledger">');
      expect(html).not.toContain("Account statement");
      expect(html).not.toContain("<th>Counterparty</th>");
    });

    test("shows stored-total mismatches on listing detail and edit pages", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Mismatch Listing",
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Actual User",
        "actual@example.com",
        2,
      );
      await updateListingAggregateValues(listing.id, {
        booked_quantity: 9,
        tickets_count: 1,
      });

      const detail = await adminGet(`/admin/listing/${listing.id}`);
      await expectHtmlResponse(
        detail,
        200,
        "Running total check",
        "expected <strong>1</strong>, got",
        "Review and recalculate totals",
      );

      const edit = await adminGet(`/admin/listing/${listing.id}/edit`);
      await expectHtmlResponse(
        edit,
        200,
        "Running totals",
        "expected <strong>1</strong>, got",
        "Review and recalculate totals",
      );
    });

    test("shows Edit link on listing page", async () => {
      const { cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/listing/1", {
        cookie: cookie,
      });
      const html = await response.text();
      expect(html).toContain("/admin/listing/1/edit");
      expect(html).toContain(">Edit<");
    });

    test("only renders check-in messages with a name and in/out status", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const valid = await adminGet(
        `/admin/listing/${listing.id}?checkin_name=Ada%20Lovelace&checkin_status=in`,
      );
      const validHtml = await valid.text();
      expect(validHtml).toContain('id="message"');
      expect(validHtml).toContain("Checked Ada Lovelace in");

      for (const query of [
        "checkin_name=Ada%20Lovelace",
        "checkin_status=in",
        "checkin_name=Ada%20Lovelace&checkin_status=sideways",
      ]) {
        const response = await adminGet(
          `/admin/listing/${listing.id}?${query}`,
        );
        const html = await response.text();
        expect(html).not.toContain('id="message"');
        expect(html).not.toContain("Checked Ada Lovelace");
      }
    });

    test("keeps the email action enabled when the date filter hides emailable attendees", async () => {
      const visibleDate = addDays(todayInTz("UTC"), 1);
      const hiddenDate = addDays(todayInTz("UTC"), 2);
      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      await submitTicketForm(listing.slug, {
        date: visibleDate,
        email: "ada@example.com",
        name: "Ada Lovelace",
      });

      const response = await adminGet(
        `/admin/listing/${listing.id}?date=${hiddenDate}`,
      );
      const html = await response.text();
      expect(html).not.toContain("Ada Lovelace");
      expect(html).toContain(
        `href="/admin/emails?listing=${listing.id}">Email</a>`,
      );
      expect(html).not.toContain("btn--disabled");
    });

    test("shows Group Attendees row when listing is in a capped group", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
      });
      const group = await createTestGroup({
        maxAttendees: 20,
        name: "Capped Group",
        slug: "capped-grp",
      });
      await assignListingsToGroup([listing.id], group.id);
      // Sibling listing in the same group with bookings: proves the row's
      // count is the group-wide total, not just the current listing's.
      const sibling = await createTestListing({
        groupId: group.id,
        maxAttendees: 100,
        name: "Sibling",
      });
      await bookAttendee(sibling, {
        email: "a@test.com",
        name: "A",
        quantity: 4,
      });

      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).toContain("Group Attendees");
      expect(html).toContain("4 / 20");
      expect(html).toContain("16 remain");
      expect(html).toContain(`href="/admin/groups/${group.id}"`);
    });

    test("shows the tightest capped group when a listing is in several", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
      });
      const loose = await createTestGroup({
        maxAttendees: 50,
        name: "Loose",
        slug: "loose-grp",
      });
      const tight = await createTestGroup({
        maxAttendees: 6,
        name: "Tight",
        slug: "tight-grp",
      });
      const looser = await createTestGroup({
        maxAttendees: 100,
        name: "Looser",
        slug: "looser-grp",
      });
      await assignListingsToGroup([listing.id], loose.id);
      await assignListingsToGroup([listing.id], tight.id);
      await assignListingsToGroup([listing.id], looser.id);
      // A sibling booked into the tight group makes it the binding constraint.
      const sibling = await createTestListing({
        groupId: tight.id,
        maxAttendees: 100,
        name: "Tight Sibling",
      });
      await bookAttendee(sibling, {
        email: "t@test.com",
        name: "T",
        quantity: 4,
      });

      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      // The tight group (6 cap, 4 booked → 2 remain) is the binding one shown,
      // not the roomier groups it also belongs to.
      expect(html).toContain("4 / 6");
      expect(html).toContain("2 remain");
      expect(html).toContain(`href="/admin/groups/${tight.id}"`);
      expect(html).not.toContain(`href="/admin/groups/${loose.id}"`);
      expect(html).not.toContain(`href="/admin/groups/${looser.id}"`);
    });

    test("omits Group Attendees row when group is uncapped", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
      });
      const group = await createTestGroup({
        name: "Uncapped",
        slug: "uncapped-grp",
      });
      await assignListingsToGroup([listing.id], group.id);

      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).not.toContain("Group Attendees");
    });

    test("shows question answer summary when questions assigned", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Q Listing",
      });
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      await setListingQuestions(listing.id, [q.id]);

      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).toContain("<th>Size</th>");
      expect(html).toContain("Small (0)");
    });
  });

  describe("GET /admin/listing/:id/duplicate", () => {
    testRequiresAuth("/admin/listing/1/duplicate", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/duplicate");
      expect(response.status).toBe(404);
    });

    test("shows duplicate form pre-filled with listing settings but no name", async () => {
      await setupListingAndLogin({
        maxAttendees: 75,
        name: "Original Listing",
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 2000,
        webhookUrl: "https://example.com/webhook",
      });

      const html = await assertAdminHtml(
        "/admin/listing/1/duplicate",
        "Duplicate Listing",
        "Original Listing",
        'value="75"',
        'value="20.00"',
        'value="https://example.com/thanks"',
        'value="https://example.com/webhook"',
      );
      // Name field should be empty (not pre-filled)
      expect(html).not.toContain('value="Original Listing"');
      // Form posts to create endpoint
      expect(html).toContain('action="/admin/listing"');
      // Name field has autofocus
      expect(html).toContain("autofocus");
    });

    test("shows Duplicate link on listing detail page", async () => {
      const { cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/listing/1", {
        cookie: cookie,
      });
      const html = await response.text();
      expect(html).toContain("/admin/listing/1/duplicate");
      expect(html).toContain(">Duplicate<");
    });
  });

  describe("GET /admin/listing/:id/in", () => {
    testRequiresAuth("/admin/listing/1/in", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/in");
      expect(response.status).toBe(404);
    });

    test("shows only checked-in attendees", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const checkedInAttendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Checked In User",
        "in@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Not Checked User",
        "out@example.com",
      );

      // Check in the first attendee
      await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${checkedInAttendee.id}/checkin`,
        {},
      );

      const html = await assertAdminHtml(
        `/admin/listing/${listing.id}/in`,
        "Checked In User",
        "<strong>Checked In</strong>",
      );
      expect(html).not.toContain("Not Checked User");
    });
  });

  describe("GET /admin/listing/:id/out", () => {
    testRequiresAuth("/admin/listing/1/out", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/out");
      expect(response.status).toBe(404);
    });

    test("shows only checked-out attendees", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const checkedInAttendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Checked In User",
        "in@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Not Checked User",
        "out@example.com",
      );

      // Check in the first attendee
      await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${checkedInAttendee.id}/checkin`,
        {},
      );

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/out`,
        {
          cookie: cookie,
        },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Checked In User");
      expect(html).toContain("Not Checked User");
      expect(html).toContain("<strong>Checked Out</strong>");
    });
  });

  describe("GET /admin/listing/:id/export", () => {
    testRequiresAuth("/admin/listing/1/export", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/export");
      expect(response.status).toBe(404);
    });

    test("returns CSV with correct headers when authenticated", async () => {
      const { cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/listing/1/export", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/csv; charset=utf-8",
      );
      expect(response.headers.get("content-disposition")).toContain(
        "attachment",
      );
      expect(response.headers.get("content-disposition")).toContain(".csv");
    });

    test("returns CSV with attendee data", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Jane Smith",
        "jane@example.com",
      );

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        {
          cookie: cookie,
        },
      );
      const csv = await response.text();
      expect(csv).toContain(
        "Name,Email,Phone,Address,Special Instructions,Quantity,Registered",
      );
      expect(csv).toContain("John Doe");
      expect(csv).toContain("john@example.com");
      expect(csv).toContain("Jane Smith");
      expect(csv).toContain("jane@example.com");
    });

    test("returns CSV with Checked In column", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );

      // Check in the attendee
      await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
        {},
      );

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        {
          cookie: cookie,
        },
      );
      const csv = await response.text();
      expect(csv).toContain(",Checked In");
      // John Doe is checked in
      expect(csv).toContain("John Doe");
      expect(csv).toContain(",Yes");
    });

    test("sanitizes slug for filename", async () => {
      const { cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing Special",
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/listing/1/export", {
        cookie: cookie,
      });
      const disposition = response.headers.get("content-disposition");
      // Non-alphanumeric characters are replaced with underscores in filename sanitization
      expect(disposition).toContain("Test_Listing_Special");
    });

    test("CSV export includes question columns when listing has questions", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Create attendee BEFORE assigning questions (avoids form validation)
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "CSV Q User",
        "csvq@test.com",
      );

      // Create question, answers, and assign to listing
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Shirt Size",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });
      await setListingQuestions(listing.id, [q.id]);
      await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        { cookie },
      );
      const csv = await response.text();
      expect(csv).toContain("Shirt Size");
      expect(csv).toContain("Small");
    });
  });

  describe("GET /admin/listing/:id/edit", () => {
    testRequiresAuth("/admin/listing/1/edit", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/edit");
      expect(response.status).toBe(404);
    });

    test("shows edit form when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1500,
      });

      await assertAdminHtml(
        "/admin/listing/1/edit",
        "Edit:",
        'value="Test Listing"',
        'value="100"',
        'value="15.00"',
        'value="https://example.com/thanks"',
        `value="${listing.slug}"`,
        "Slug",
      );
    });

    test("shows the income-correction form with its ledger warning", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await adminGet("/admin/listing/1/edit");
      const html = await response.text();
      // The dedicated money-correction section, separate from the counts override.
      expect(html).toContain("Adjust income");
      expect(html).toContain('action="/admin/listing/1/income"');
      expect(html).toContain('name="income"');
      // The prominent warning that this edits the source-of-truth money ledger.
      expect(html).toContain("correcting entry to the money ledger");
    });
  });

  describe("POST /admin/listing/:id/income", () => {
    test("posts a writeoff correction that raises the projected income", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Seed £15 of gross income, then correct it up to £25 (major units).
      await postListingSale({
        attendeeId: 1,
        gross: 1500,
        listingId: listing.id,
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/income`,
        { income: "25.00" },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/edit`,
        "Listing income adjusted",
      )(response);

      invalidateListingsCache();
      const updated = await getListingWithCount(listing.id);
      expect(updated?.income).toBe(2500);
    });

    test("posts a writeoff correction that lowers the projected income", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await postListingSale({
        attendeeId: 1,
        gross: 4000,
        listingId: listing.id,
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/income`,
        { income: "10.00" },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/edit`,
        "Listing income adjusted",
      )(response);

      invalidateListingsCache();
      const updated = await getListingWithCount(listing.id);
      expect(updated?.income).toBe(1000);
    });

    test("logs a neutral activity message without the raw figure", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Gala",
        thankYouUrl: "https://example.com",
      });
      await adminFormPost(`/admin/listing/${listing.id}/income`, {
        income: "12.34",
      });
      const log = await getAllActivityLog(10);
      const entry = log.find((e) => e.message.includes("income adjusted"));
      expect(entry?.message).toBe("Listing 'Gala' income adjusted");
      // The raw corrected figure is not logged verbatim.
      expect(entry?.message).not.toContain("12.34");
    });

    test("rejects a blank amount with an error flash", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/income`,
        { income: "" },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/edit`,
        "Enter a valid amount",
        false,
      )(response);
    });

    test("rejects a non-numeric amount with an error flash", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/income`,
        { income: "abc" },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/edit`,
        "Enter a valid amount",
        false,
      )(response);
    });

    test("returns 404 for a non-existent listing", async () => {
      const { response } = await adminFormPost("/admin/listing/9999/income", {
        income: "10",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("listing aggregate recalculation routes", () => {
    testRequiresAuth("/admin/listings/recalculate/1", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("shows current and attendee-derived listing totals", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Counted User",
        "counted@example.com",
        2,
      );
      await updateListingAggregateValues(listing.id, {
        booked_quantity: 9,
        tickets_count: 5,
      });

      const response = await adminGet(
        `/admin/listings/recalculate/${listing.id}`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Recalculate:",
        "Current",
        "From attendee data",
        'value="booked_quantity"',
        ">9<",
        ">1<",
      );
    });

    test("resets selected listing totals", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Reset User",
        "reset@example.com",
        2,
      );
      // Income is projected from the ledger, so seed it with a real sale leg on
      // revenue:<listingId> rather than the (count-only) aggregate override.
      await postListingSale({
        attendeeId: attendee.id,
        eventId: "reset-totals",
        gross: 9000,
        listingId: listing.id,
      });
      await updateListingAggregateValues(listing.id, {
        booked_quantity: 9,
        tickets_count: 5,
      });

      const { response } = await adminFormPost(
        `/admin/listings/recalculate/${listing.id}`,
        { recalculate_fields: "booked_quantity" },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/edit`,
        "Listing totals recalculated",
        true,
      )(response);

      const updated = await getListingWithCount(listing.id);
      expect(updated?.attendee_count).toBe(1);
      // Resetting only booked_quantity leaves the ledger-projected income alone.
      expect(updated?.income).toBe(9000);
      expect(updated?.tickets_count).toBe(5);
    });

    test("shows recalculation success on the redirected edit page", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { cookie, response } = await adminFormPost(
        `/admin/listings/recalculate/${listing.id}`,
        { recalculate_fields: "booked_quantity" },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/edit`,
        "Listing totals recalculated",
        true,
      )(response);

      const editResponse = await followRedirectWithFlash(
        response,
        (request) => handleRequest(request),
        cookie,
      );
      await expectHtmlResponse(
        editResponse,
        200,
        "Listing totals recalculated",
      );
    });

    test("rejects listing recalculation with no selected totals", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost(
        `/admin/listings/recalculate/${listing.id}`,
        {},
      );
      await expectHtmlResponse(
        response,
        400,
        "Choose at least one total to recalculate",
      );
    });
  });

  describe("POST /admin/listing/:id/edit", () => {
    testRequiresAuth("/admin/listing/1/edit", {
      body: {
        max_attendees: "50",
        max_quantity: "1",
        name: "Updated Listing",
        slug: "updated-listing",
        thank_you_url: "https://example.com/updated",
      },
      multipart: true,
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost("/admin/listing/999/edit", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Updated Listing",
        slug: "updated-listing",
        thank_you_url: "https://example.com/updated",
      });
      expect(response.status).toBe(404);
    });

    test("rejects request with invalid CSRF token", async () => {
      const { cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/listing/1/edit",
          {
            csrf_token: "invalid-token",
            max_attendees: "50",
            max_quantity: "1",
            name: "Updated Listing",
            slug: "updated-listing",
            thank_you_url: "https://example.com/updated",
          },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("validates required fields", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/edit", {
        max_attendees: "50",
        max_quantity: "1",
        name: "",
        slug: "test-slug",
        thank_you_url: "https://example.com",
      });
      await expectHtmlResponse(response, 400, "Listing Name is required");
    });

    test("updates listing when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/edit", {
        max_attendees: "200",
        max_quantity: "5",
        name: listing.name,
        slug: listing.slug,
        thank_you_url: "https://example.com/updated",
        unit_price: "20.00",
      });
      await expectFlashRedirect(
        "/admin/listing/1",
        "Listing updated",
      )(response);

      // Verify the listing was updated
      const updated = await getListingWithCount(1);
      expect(updated?.max_attendees).toBe(200);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(2000);
    });

    test("updates listing running totals from the edit form", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          booked_quantity: "12",
          max_attendees: "100",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
          thank_you_url: "https://example.com",
          tickets_count: "4",
        },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      // income is no longer a column override — it's projected from the ledger,
      // so the form only edits the count aggregates now.
      const updated = await getListingWithCount(listing.id);
      expect(updated?.attendee_count).toBe(12);
      expect(updated?.tickets_count).toBe(4);
    });

    test("rejects invalid listing running totals", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          booked_quantity: "-1",
          max_attendees: "100",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
          thank_you_url: "https://example.com",
          tickets_count: "4",
        },
      );

      await expectHtmlResponse(
        response,
        400,
        "Total Attendees Ever must be 0 or greater",
      );
    });

    test("clears webhook URL when updating listing in demo mode", async () => {
      setDemoModeForTest(true);

      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        webhookUrl: "https://example.com/original-webhook",
      });

      const { response } = await adminFormPost("/admin/listing/1/edit", {
        max_attendees: "200",
        max_quantity: "5",
        name: listing.name,
        slug: listing.slug,
        webhook_url: "https://example.com/new-webhook",
      });
      await expectFlashRedirect(
        "/admin/listing/1",
        "Listing updated",
      )(response);

      // Verify webhook_url was cleared
      const updated = await getListingWithCount(1);
      expect(updated?.webhook_url).toBe("");
    });

    test("updates listing group_id", async () => {
      const group1 = await createTestGroup({
        name: "Group One",
        slug: "group-one",
      });
      const group2 = await createTestGroup({
        name: "Group Two",
        slug: "group-two",
      });
      const { listing } = await setupListingAndLogin({
        groupId: group1.id,
        maxAttendees: 50,
        name: "Group Switch Listing",
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          group_ids: String(group2.id),
          max_attendees: "50",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
        },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      // The group checkboxes replace membership: group1 → group2.
      expect(await getGroupIdsByListingId(listing.id)).toEqual([group2.id]);
    });

    test("rejects non-existent group_id on edit", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Edit Bad Group",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          group_ids: "999",
          max_attendees: "50",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
        },
      );
      await expectHtmlResponse(response, 400, "Selected group does not exist");
    });

    test("rejects listing type mismatch with group on edit", async () => {
      const group = await createTestGroup({
        name: "Daily Group",
        slug: "daily-group",
      });
      await createTestListing({
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 50,
        name: "Daily Listing",
      });
      const { listing } = await setupListingAndLogin({
        listingType: "standard",
        maxAttendees: 50,
        name: "Standard Listing",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          group_ids: String(group.id),
          max_attendees: "50",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
        },
      );
      const html = await expectHtmlResponse(
        response,
        400,
        "already contains daily listings",
      );
      // The rejected edit re-renders the group the operator ticked as checked,
      // so their selection isn't silently dropped on the next submit.
      expect(html).toContain(
        `checked name="group_ids" type="checkbox" value="${group.id}"`,
      );
    });

    test("allows same listing type in group on edit", async () => {
      const group = await createTestGroup({
        name: "Same Type Group",
        slug: "same-type-group",
      });
      await createTestListing({
        groupId: group.id,
        listingType: "standard",
        maxAttendees: 50,
        name: "Standard A",
      });
      const { listing } = await setupListingAndLogin({
        listingType: "standard",
        maxAttendees: 50,
        name: "Standard B",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          group_ids: String(group.id),
          max_attendees: "50",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
        },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);
    });

    test("updates listing slug", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Slug Update Test",
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          max_attendees: "100",
          max_quantity: "1",
          name: "Slug Update Test",
          slug: "new-custom-slug",
          thank_you_url: "https://example.com",
        },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      const updated = await getListingWithCount(listing.id);
      expect(updated?.slug).toBe("new-custom-slug");
    });

    test("normalizes slug on update (spaces, uppercase)", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Normalize Test",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          max_attendees: "50",
          max_quantity: "1",
          name: "Normalize Test",
          slug: "  My Custom Slug  ",
        },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      const updated = await getListingWithCount(listing.id);
      expect(updated?.slug).toBe("my-custom-slug");
    });

    test("rejects invalid slug characters", async () => {
      await setupListingAndLogin({
        maxAttendees: 50,
        name: "Invalid Slug Test",
      });

      const { response } = await adminFormPost("/admin/listing/1/edit", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Invalid Slug Test",
        slug: "invalid_slug!@#",
      });
      await expectHtmlResponse(
        response,
        400,
        "Slug must be lowercase letters and numbers separated by single hyphens or underscores",
      );
    });

    test("rejects duplicate slug used by another listing", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Listing One",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Listing Two",
      });

      // Try to change listing2's slug to listing1's slug
      const { response } = await adminFormPost(
        `/admin/listing/${listing2.id}/edit`,
        {
          max_attendees: "50",
          max_quantity: "1",
          name: "Listing Two",
          slug: listing1.slug,
        },
      );
      await expectHtmlResponse(
        response,
        400,
        "Slug is already in use by another listing",
      );
    });

    test("rejects slug used by a group", async () => {
      const group = await createTestGroup({
        name: "Slug Group",
        slug: "slug-group",
      });
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Listing Slug Collision",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          max_attendees: "50",
          max_quantity: "1",
          name: listing.name,
          slug: group.slug,
        },
      );
      await expectHtmlResponse(
        response,
        400,
        "Slug is already in use by another listing",
      );
    });

    test("allows keeping the same slug on update", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Same Slug Test",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          max_attendees: "100",
          max_quantity: "1",
          name: "Same Slug Test",
          slug: listing.slug,
        },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      const updated = await getListingWithCount(listing.id);
      expect(updated?.slug).toBe(listing.slug);
      expect(updated?.max_attendees).toBe(100);
    });
  });

  describe("GET /admin/listing/:id/deactivate", () => {
    testRequiresAuth("/admin/listing/1/deactivate", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/deactivate");
      expect(response.status).toBe(404);
    });

    test("shows deactivate confirmation page when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      await assertAdminHtml(
        "/admin/listing/1/deactivate",
        "Deactivate Listing",
        "Return a 404",
        'name="confirm_identifier"',
        "type its name",
        listing.name,
      );
    });
  });

  describe("POST /admin/listing/:id/deactivate", () => {
    testRequiresAuth("/admin/listing/1/deactivate", {
      body: {},
      method: "POST",
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("deactivates listing and redirects", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/deactivate", {
        confirm_identifier: listing.name,
      });
      await expectFlashRedirect(
        "/admin/listing/1",
        "Listing deactivated",
      )(response);

      // Verify listing is now inactive
      const deactivatedListing = await getListingWithCount(1);
      expect(deactivatedListing?.active).toBe(false);
    });

    test("returns error when identifier does not match", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/deactivate", {
        confirm_identifier: "wrong-identifier",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Listing name does not match"),
        false,
      );
    });

    test("displays error on confirmation page after failed attempt", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const { cookie, response: postResponse } = await adminFormPost(
        "/admin/listing/1/deactivate",
        { confirm_identifier: "wrong" },
      );
      const page = await followRedirectWithFlash(
        postResponse,
        handleRequest,
        cookie,
      );
      const html = await page.text();
      expect(html).toContain("does not match");
    });
  });

  describe("GET /admin/listing/:id/reactivate", () => {
    testRequiresAuth("/admin/listing/1/reactivate", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("shows reactivate confirmation page when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the listing first
      await deactivateTestListing(listing.id);

      await assertAdminHtml(
        "/admin/listing/1/reactivate",
        "Reactivate Listing",
        "available for registrations",
        'name="confirm_identifier"',
        "type its name",
      );
    });
  });

  describe("POST /admin/listing/:id/reactivate", () => {
    test("reactivates listing and redirects", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the listing first
      await deactivateTestListing(listing.id);

      const { response } = await adminFormPost("/admin/listing/1/reactivate", {
        confirm_identifier: listing.name,
      });
      await expectFlashRedirect(
        "/admin/listing/1",
        "Listing reactivated",
      )(response);

      // Verify listing is now active
      const activeListing = await getListingWithCount(1);
      expect(activeListing?.active).toBe(true);
    });

    test("returns error when name does not match", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });
      // Deactivate the listing first
      await deactivateTestListing(listing.id);

      const { response } = await adminFormPost("/admin/listing/1/reactivate", {
        confirm_identifier: "wrong-identifier",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Listing name does not match"),
        false,
      );
    });

    test("displays error on confirmation page after failed attempt", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });
      await deactivateTestListing(listing.id);

      const { cookie, response: postResponse } = await adminFormPost(
        "/admin/listing/1/reactivate",
        { confirm_identifier: "wrong" },
      );
      const page = await followRedirectWithFlash(
        postResponse,
        handleRequest,
        cookie,
      );
      const html = await page.text();
      expect(html).toContain("does not match");
    });
  });

  describe("GET /admin/listing/:id/delete", () => {
    testRequiresAuth("/admin/listing/1/delete", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/delete");
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      await assertAdminHtml(
        "/admin/listing/1/delete",
        "Delete Listing",
        listing.name,
        "type its name",
      );
    });
  });

  describe("POST /admin/listing/:id/delete", () => {
    testRequiresAuth("/admin/listing/1/delete", {
      body: {
        confirm_identifier: "Test Listing",
      },
      method: "POST",
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          name: "Test Listing",
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost("/admin/listing/999/delete", {
        confirm_identifier: "Test Listing",
      });
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/listing/1/delete",
          {
            confirm_identifier: listing.name,
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects mismatched listing identifier", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/delete", {
        confirm_identifier: "wrong-identifier",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
    });

    test("displays error on confirmation page after failed attempt", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const { cookie, response: postResponse } = await adminFormPost(
        "/admin/listing/1/delete",
        { confirm_identifier: "wrong" },
      );
      const page = await followRedirectWithFlash(
        postResponse,
        handleRequest,
        cookie,
      );
      const html = await page.text();
      expect(html).toContain("does not match");
    });

    test("deletes listing with matching identifier (case insensitive)", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/delete", {
        confirm_identifier: "TEST LISTING", // uppercase (case insensitive)
      });
      await expectFlashRedirect("/admin", "Listing deleted")(response);

      // Verify listing was deleted
      const deletedListing = await getListing(1);
      expect(deletedListing).toBeNull();
    });

    test("deletes listing with matching identifier (trimmed)", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/delete", {
        confirm_identifier: "  Test Listing  ", // with spaces
      });
      await expectFlashRedirect("/admin", "Listing deleted")(response);
    });

    test("deletes the listing and unlinks its attendees", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Jane Doe",
        "jane@example.com",
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/delete`,
        { confirm_identifier: listing.name },
      );
      expect(response.status).toBe(302);

      // The listing is gone and no attendees remain linked to it (the attendee
      // rows themselves are orphaned, not purged).
      const deleted = await getListing(listing.id);
      expect(deleted).toBeNull();

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees).toEqual([]);
    });

    test("skips identifier verification when verify_identifier=false (for API users)", async () => {
      await createTestListing({
        maxAttendees: 50,
        name: "API Listing",
        thankYouUrl: "https://example.com",
      });

      // Delete with verify_identifier=false - no need for confirm_identifier
      const { response } = await adminFormPost(
        "/admin/listing/1/delete?verify_identifier=false",
      );
      expect(response.status).toBe(302);

      // Verify listing was deleted
      const listing = await getListing(1);
      expect(listing).toBeNull();
    });

    test("returns 404 when listing not found with verify_identifier=false", async () => {
      const { response } = await adminFormPost(
        "/admin/listing/9999/delete?verify_identifier=false",
      );
      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /admin/listing/:id/delete", () => {
    test("deletes listing using DELETE method", async () => {
      await createTestListing({
        maxAttendees: 50,
        name: "Delete Method Test",
        thankYouUrl: "https://example.com",
      });

      // Use DELETE method with verify_identifier=false
      const response = await handleRequest(
        new Request(
          "http://localhost/admin/listing/1/delete?verify_identifier=false",
          {
            body: new URLSearchParams({
              csrf_token: await testCsrfToken(),
            }).toString(),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie: await testCookie(),
              host: "localhost",
            },
            method: "DELETE",
          },
        ),
      );
      expect(response.status).toBe(302);

      // Verify listing was deleted
      const listing = await getListing(1);
      expect(listing).toBeNull();
    });
  });

  describe("POST /admin/listing with unit_price", () => {
    test("creates listing with unit_price when authenticated", async () => {
      const { response } = await adminFormPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Paid Listing",
        thank_you_url: "https://example.com/thanks",
        unit_price: "10.00",
      });
      expect(response.status).toBe(302);
    });
  });

  describe("POST /admin/listing with can_pay_more", () => {
    test("creates listing with can_pay_more enabled", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        can_pay_more: "1",
        max_attendees: "50",
        max_quantity: "1",
        name: "Pay More Listing",
        unit_price: "10.00",
      });
      expect(response.status).toBe(302);

      const listing = await getListingWithCount(1);
      expect(listing?.can_pay_more).toBe(true);
      expect(listing?.unit_price).toBe(1000);
    });

    test("creates listing with can_pay_more disabled by default", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Normal Listing",
        unit_price: "5.00",
      });
      expect(response.status).toBe(302);

      const listing = await getListingWithCount(1);
      expect(listing?.can_pay_more).toBe(false);
    });

    test("updates listing can_pay_more via edit", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });

      const { response } = await adminMultipartPost(
        `/admin/listing/${listing.id}/edit`,
        {
          can_pay_more: "1",
          max_attendees: String(listing.max_attendees),
          max_quantity: String(listing.max_quantity),
          name: listing.name,
          slug: listing.slug,
          unit_price: "10.00",
        },
      );
      expect(response.status).toBe(302);

      const updated = await getListingWithCount(listing.id);
      expect(updated?.can_pay_more).toBe(true);
    });
  });

  describe("POST /admin/listing with max_price", () => {
    test("creates listing with max_price", async () => {
      const listing = await createTestListing({
        canPayMore: true,
        maxPrice: 50000,
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.max_price).toBe(50000);
      expect(saved?.can_pay_more).toBe(true);
    });

    test("max_price defaults to 10000 when not set", async () => {
      const listing = await createTestListing({ canPayMore: true });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.max_price).toBe(10000);
    });

    test("rejects max_price less than unit_price + 100 when can_pay_more", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        can_pay_more: "1",
        max_attendees: "50",
        max_price: "10.50",
        max_quantity: "1",
        name: "Bad Max Price",
        unit_price: "10.00",
      });
      await expectHtmlResponse(
        response,
        400,
        "Maximum price must be at least £1 more than the ticket price",
      );
    });

    test("allows max_price less than unit_price + 100 when can_pay_more is off", async () => {
      const listing = await createTestListing({
        maxPrice: 1050,
        unitPrice: 1000,
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.max_price).toBe(1050);
    });

    test("accepts max_price equal to unit_price + 100", async () => {
      const listing = await createTestListing({
        maxPrice: 1100,
        unitPrice: 1000,
      });
      expect(listing.max_price).toBe(1100);
    });

    test("updates max_price via edit", async () => {
      const listing = await createTestListing({
        canPayMore: true,
        unitPrice: 1000,
      });
      await updateTestListing(listing.id, { maxPrice: 25000 });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.max_price).toBe(25000);
    });
  });

  describe("GET /admin/log", () => {
    testRequiresAuth("/admin/log");

    test("shows log page when authenticated", async () => {
      // Create an listing to generate activity
      await createTestListing({
        maxAttendees: 50,
        name: "Log Test",
      });

      const response = await adminGet("/admin/log");
      await expectHtmlResponse(response, 200, "Log");
    });

    test("shows log page for manager", async () => {
      const managerCookie = await createTestManagerSession();
      await assertAdminHtmlWithCookie("/admin/log", managerCookie, "Log");
    });

    test("shows truncation message when more than 200 entries", async () => {
      // Create 201 log entries to trigger truncation
      for (let i = 0; i < 201; i++) {
        await logActivity(`Action ${i}`);
      }

      const response = await adminGet("/admin/log");
      const html = await response.text();
      expect(html).toContain("Showing the most recent 200 entries");
    });

    test("links each entry to its attendee and listing by name", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Gala Dinner",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada Lovelace",
        "ada@example.com",
      );
      await logActivity("Balance updated", listing.id, attendee.id);

      const response = await awaitTestRequest("/admin/log", { cookie });
      const html = await response.text();
      expect(html).toContain(
        `<a href="/admin/attendees/${attendee.id}">Ada Lovelace</a>`,
      );
      expect(html).toContain(
        `<a href="/admin/listing/${listing.id}">Gala Dinner</a>`,
      );
    });
  });

  describe("GET /admin/listing/:id/log", () => {
    testRequiresAuth("/admin/listing/1/log");

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/log");
      expect(response.status).toBe(404);
    });

    test("shows log for existing listing", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Listing Log",
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}/log`,
        "Log",
        listing.name,
      );
    });
  });

  describe("POST /admin/listing/:id/deactivate (listing not found)", () => {
    test("returns 404 when listing does not exist", async () => {
      const { response } = await adminFormPost(
        "/admin/listing/999/deactivate",
        {
          confirm_identifier: "something",
        },
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/listing/:id/reactivate (listing not found)", () => {
    test("returns 404 when listing does not exist", async () => {
      const { response } = await adminFormPost(
        "/admin/listing/999/reactivate",
        {
          confirm_identifier: "something",
        },
      );
      expect(response.status).toBe(404);
    });
  });

  describe("admin/listings.ts (listing delete handler via onDelete)", () => {
    test("delete listing handler cleans up associated data", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "On Delete Test",
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Test User",
        "test@example.com",
      );

      // Delete listing via API (skip verify)
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/delete?verify_identifier=false`,
        {},
      );
      expect(response.status).toBe(302);

      // Verify both listing and attendees deleted
      expect(await getListing(listing.id)).toBeNull();
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });
  });

  describe("admin/listings.ts (listingErrorPage with deleted listing)", () => {
    test("edit validation returns 400 with error when listing exists", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "First Edit Err",
        thankYouUrl: "https://example.com",
      });

      // Submit with empty name to trigger validation error
      const { response } = await adminFormPost("/admin/listing/1/edit", {
        max_attendees: "50",
        max_quantity: "1",
        name: "",
        thank_you_url: "https://example.com",
      });
      // Should return 400 with error page (listing exists -> listingErrorPage returns htmlResponse)
      await expectHtmlResponse(response, 400, "Listing Name is required");
    });
  });

  describe("admin/listings.ts (form.get fallbacks)", () => {
    test("deactivate listing without confirm_identifier uses empty fallback", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Deactivate Fallback",
        thankYouUrl: "https://example.com",
      });

      // Submit without confirm_identifier field
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/deactivate`,
        {},
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Listing name does not match"),
        false,
      );
    });

    test("reactivate listing without confirm_identifier uses empty fallback", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Reactivate Fallback",
        thankYouUrl: "https://example.com",
      });
      await deactivateTestListing(listing.id);

      // Submit without confirm_identifier field
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/reactivate`,
        {},
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Listing name does not match"),
        false,
      );
    });

    test("delete listing without confirm_identifier uses empty fallback", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Delete Fallback",
        thankYouUrl: "https://example.com",
      });

      // Submit without confirm_identifier field
      const { response } = await adminFormPost("/admin/listing/1/delete", {});
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
    });
  });

  describe("POST /admin/listing/:id/edit validation error", () => {
    test("shows error when editing non-existent listing", async () => {
      const { response } = await adminFormPost("/admin/listing/99999/edit", {
        max_attendees: "50",
        name: "Updated Name",
      });
      expect(response.status).toBe(404);
    });

    test("shows edit page with error when name is empty", async () => {
      const { listing: listing1 } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Edit Orig",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing1.id}/edit`,
        {
          max_attendees: "50",
          max_quantity: "1",
          name: "",
        },
      );
      await expectHtmlResponse(response, 400, "Listing Name is required");
    });
  });

  describe("POST /admin/listing/:id/delete with custom onDelete", () => {
    test("deletes the listing when identifier verification is skipped", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Skip Verify Delete",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Test User",
        "test@example.com",
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/delete?verify_identifier=false`,
        {},
      );
      await expectFlashRedirect("/admin", "Listing deleted")(response);

      const deleted = await getListing(listing.id);
      expect(deleted).toBeNull();
    });
  });

  describe("routes/admin/listings.ts (listing error page)", () => {
    test("shows edit error page for existing listing with validation error", async () => {
      const { listing: listing1 } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Listing Err 1",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing1.id}/edit`,
        {
          max_attendees: "50",
          max_quantity: "1",
          name: "",
        },
      );
      await expectHtmlResponse(response, 400, "Listing Name is required");
    });

    test("unlinks the listing's attendees when deleted with verification skipped", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Skip Verify Del Test",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Del User",
        "del@example.com",
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/delete?verify_identifier=false`,
        {},
      );
      await expectFlashRedirect("/admin", "Listing deleted")(response);

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(0);
    });
  });

  describe("routes/admin/listings.ts (listingErrorPage notFound)", () => {
    test("listing edit validation error returns 404 when listing was deleted", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Listing For Delete Err",
      });

      // Spy on listingsTable.findById: return the row on first call (so requireExists passes),
      // but also delete the listing from DB so getListingWithCount (raw SQL) returns null.
      const originalFindById = listingsTable.findById.bind(listingsTable);
      const findByIdStub = stub(
        listingsTable,
        "findById",
        async (id: unknown) => {
          const row = await originalFindById(id as number);
          if (row) {
            // Delete the listing from DB so getListingWithCount returns null
            await getDb().execute({
              args: [id as number],
              sql: "DELETE FROM listings WHERE id = ?",
            });
            invalidateListingsCache();
          }
          return row;
        },
      );

      try {
        // Send an update with empty name to trigger validation error
        const { response } = await adminFormPost(
          `/admin/listing/${listing1.id}/edit`,
          {
            max_attendees: "50",
            max_quantity: "1",
            name: "",
          },
        );
        // requireExists sees the row (first findById). Validation fails (empty name).
        // listingErrorPage calls getListingWithCount, but listing was deleted, so returns 404.
        expect(response.status).toBe(404);
      } finally {
        findByIdStub.restore();
      }
    });
  });

  describe("admin listing onDelete handler", () => {
    test("deleting an listing triggers the onDelete handler which calls deleteListing", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 10,
        name: "Delete OnDelete Test",
      });
      // Add an attendee so delete covers more paths
      await createTestAttendee(
        listing.id,
        listing.slug,
        "User A",
        "a@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/delete`,
        { confirm_identifier: listing.name },
      );
      expect(response.status).toBe(302);
    });
  });

  describe("edit listing notFound race condition", () => {
    test("returns 404 when listing is deleted during edit update", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Race Condition Listing",
        thankYouUrl: "https://example.com",
      });

      // handleAdminListingEditPost calls getListingWithCount (raw SQL), then
      // updateResource.update which calls requireExists -> table.findById.
      // We spy on findById to return null, simulating the listing being deleted
      // between the initial check and the update.
      const findByIdStub2 = stub(listingsTable, "findById", () =>
        Promise.resolve(null),
      );

      try {
        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/edit`,
          {
            max_attendees: "50",
            max_quantity: "1",
            name: "Updated Name",
            slug: "updated-slug",
          },
        );
        expect(response.status).toBe(404);
      } finally {
        findByIdStub2.restore();
      }
    });
  });

  describe("closes_at field", () => {
    test("creates listing with closes_at timestamp", async () => {
      const closesAt = "2099-06-15T14:30";
      const listing = await createTestListing({ closesAt });

      const saved = await getListingWithCount(listing.id);
      expect(saved?.closes_at).toBe("2099-06-15T14:30:00.000Z");
    });

    test("creates listing without closes_at (defaults to null)", async () => {
      const listing = await createTestListing();

      const saved = await getListingWithCount(listing.id);
      expect(saved?.closes_at).toBeNull();
    });

    test("updates listing closes_at", async () => {
      const listing = await createTestListing();
      const closesAt = "2099-12-31T23:59";
      await updateTestListing(listing.id, { closesAt });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.closes_at).toBe("2099-12-31T23:59:00.000Z");
    });

    test("clears closes_at by setting to empty string", async () => {
      const listing = await createTestListing({ closesAt: "2099-06-15T14:30" });
      await updateTestListing(listing.id, { closesAt: "" });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.closes_at).toBeNull();
    });

    test("admin listing detail page shows closes_at with countdown when set", async () => {
      const { listing } = await setupListingAndLogin({
        closesAt: "2099-06-15T14:30",
      });

      const html = await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Registration Closes",
        "from now",
      );
      expect(html).not.toContain("No deadline");
    });

    test("admin listing detail page shows 'No deadline' when closes_at is null", async () => {
      const { listing } = await setupListingAndLogin();

      await assertAdminHtml(`/admin/listing/${listing.id}`, "No deadline");
    });

    test("admin listing edit page shows closes_at in form", async () => {
      const { listing } = await setupListingAndLogin({
        closesAt: "2099-06-15T14:30",
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        'value="2099-06-15"',
        'value="14:30"',
        "Registration Closes At",
      );
    });

    test("admin listing detail page shows 'closed' countdown for past closes_at", async () => {
      const { listing } = await setupListingAndLogin({
        closesAt: "2024-01-01T00:00",
      });

      await assertAdminHtml(`/admin/listing/${listing.id}`, "(closed)");
    });

    test("admin listing detail page shows days-only countdown", async () => {
      const future = new Date(
        Date.now() + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000,
      );
      const closesAt = future.toISOString().slice(0, 16);
      const listing = await createTestListing({ closesAt });

      const response = await adminGet(`/admin/listing/${listing.id}`);
      await expectHtmlResponse(response, 200, "days from now");
    });

    test("admin listing detail page shows hours-only countdown", async () => {
      const future = new Date(Date.now() + 5 * 60 * 60 * 1000 + 10 * 60 * 1000);
      const closesAt = future.toISOString().slice(0, 16);
      const listing = await createTestListing({ closesAt });

      const response = await adminGet(`/admin/listing/${listing.id}`);
      await expectHtmlResponse(response, 200, "hours from now");
    });

    test("admin listing detail page shows minutes-only countdown", async () => {
      const future = new Date(Date.now() + 30 * 60 * 1000);
      const closesAt = future.toISOString().slice(0, 16);
      const listing = await createTestListing({ closesAt });

      const response = await adminGet(`/admin/listing/${listing.id}`);
      await expectHtmlResponse(response, 200, "minute");
    });

    test("formatCountdown shows days and hours", () => {
      const future = new Date(
        nowMs() + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000 + 30 * 60 * 1000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("3 days and 5 hours from now");
    });

    test("formatCountdown shows only days when no remaining hours", () => {
      const future = new Date(
        nowMs() + 2 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("2 days from now");
    });

    test("formatCountdown shows only hours", () => {
      const future = new Date(
        nowMs() + 5 * 60 * 60 * 1000 + 10 * 60 * 1000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("5 hours from now");
    });

    test("formatCountdown shows minutes when less than an hour", () => {
      const result = formatCountdown(
        new Date(nowMs() + 30 * 60 * 1000).toISOString(),
      );
      expect(result).toContain("minute");
      expect(result).toContain("from now");
    });

    test("formatCountdown shows closed for past dates", () => {
      expect(formatCountdown("2024-01-01T00:00:00.000Z")).toBe("closed");
    });

    test("formatCountdown singular forms", () => {
      // Add 30s buffer so elapsed time between nowMs() calls doesn't push hours below boundary
      const future = new Date(
        nowMs() + 1 * 24 * 60 * 60 * 1000 + 1 * 60 * 60 * 1000 + 30_000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("1 day and 1 hour from now");
    });

    test("rejects invalid closes_at format", async () => {
      const { listing } = await setupListingAndLogin();

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          closes_at_date: "not-a-date",
          closes_at_time: "99:99",
          max_attendees: "100",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
        },
      );
      await expectHtmlResponse(
        response,
        400,
        "Please enter a valid date and time",
      );
    });
  });

  describe("listing date and location", () => {
    test("creates listing with date and location", async () => {
      const listing = await createTestListing({
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.date).toBe("2026-06-15T14:00:00.000Z");
      expect(saved?.location).toBe("Village Hall");
    });

    test("updates listing date and location", async () => {
      const listing = await createTestListing();
      await updateTestListing(listing.id, {
        date: "2026-12-25T18:00",
        location: "Town Centre",
      });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.date).toBe("2026-12-25T18:00:00.000Z");
      expect(updated?.location).toBe("Town Centre");
    });

    test("clears listing date by setting to empty string", async () => {
      const listing = await createTestListing({ date: "2026-06-15T14:00" });
      await updateTestListing(listing.id, { date: "" });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.date).toBe("");
    });

    test("admin detail page shows Listing Date and Location when set", async () => {
      const { listing } = await setupListingAndLogin({
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Listing Date",
        "Monday 15 June 2026 at 14:00 UTC",
        "<th>Location</th>",
        "Village Hall",
      );
    });

    test("admin detail page hides Listing Date and Location when empty", async () => {
      const { listing } = await setupListingAndLogin();
      const html = await assertAdminHtml(`/admin/listing/${listing.id}`);
      expect(html).not.toContain("Listing Date");
      expect(html).not.toContain("<th>Location</th>");
    });

    test("admin edit page pre-fills date as split inputs", async () => {
      const { listing } = await setupListingAndLogin({
        date: "2026-06-15T14:00",
      });
      await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        'value="2026-06-15"',
        'value="14:00"',
      );
    });

    test("admin edit page pre-fills location", async () => {
      const { listing } = await setupListingAndLogin({
        location: "Village Hall",
      });
      await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        'value="Village Hall"',
      );
    });

    test("CSV export includes Listing Date and Listing Location columns", async () => {
      const { listing } = await setupListingAndLogin({
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "alice@test.com",
      );
      await assertAdminHtml(
        `/admin/listing/${listing.id}/export`,
        "Listing Date",
        "Listing Location",
        "Village Hall",
      );
    });

    test("CSV export omits Listing Date and Listing Location when empty", async () => {
      const { listing, cookie } = await setupListingAndLogin();
      await createTestAttendee(listing.id, listing.slug, "Bob", "bob@test.com");
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const csv = await response.text();
      expect(csv).not.toContain("Listing Date");
      expect(csv).not.toContain("Listing Location");
    });

    test("rejects invalid listing date on edit", async () => {
      const { listing } = await setupListingAndLogin();
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          date_date: "not-a-date",
          date_time: "99:99",
          max_attendees: "100",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
        },
      );
      await expectHtmlResponse(
        response,
        400,
        "Please enter a valid date and time",
      );
    });
  });

  describe("withCookie", () => {
    test("adds a cookie to a response without existing cookies", async () => {
      const response = new Response("body", { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });

    test("preserves existing set-cookie headers when adding another", async () => {
      const headers = new Headers();
      headers.append("set-cookie", "first=one; Path=/");
      const response = new Response("body", { headers, status: 200 });
      const result = await withCookie(response, "second=two; Path=/");
      const cookies = result.headers.getSetCookie();
      expect(cookies.length).toBe(2);
      expect(cookies).toContain("first=one; Path=/");
      expect(cookies).toContain("second=two; Path=/");
    });

    test("preserves response status", async () => {
      const response = new Response("body", { status: 201 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.status).toBe(201);
    });

    test("preserves text response body", async () => {
      const response = new Response("hello world", { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(await result.text()).toBe("hello world");
    });

    test("preserves binary response body", async () => {
      const bytes = new Uint8Array([0, 1, 2, 128, 255]);
      const response = new Response(bytes, { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      const body = new Uint8Array(await result.arrayBuffer());
      expect(body.length).toBe(5);
      expect(body[0]).toBe(0);
      expect(body[3]).toBe(128);
      expect(body[4]).toBe(255);
    });

    test("handles null body response", async () => {
      const response = new Response(null, { status: 204 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.status).toBe(204);
      expect(result.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });
  });

  describe("daily listing type", () => {
    test("creates a daily listing with custom config", async () => {
      const listing = await createTestListing({
        bookableDays: ["Monday", "Wednesday", "Friday"],
        listingType: "daily",
        maximumDaysAfter: 30,
        minimumDaysBefore: 2,
      });

      const saved = await getListingWithCount(listing.id);
      expect(saved?.listing_type).toBe("daily");
      expect(saved?.bookable_days).toEqual(["Monday", "Wednesday", "Friday"]);
      expect(saved?.minimum_days_before).toBe(2);
      expect(saved?.maximum_days_after).toBe(30);
    });

    test("creates standard listing with default daily config", async () => {
      const listing = await createTestListing();

      const saved = await getListingWithCount(listing.id);
      expect(saved?.listing_type).toBe("standard");
      expect(saved?.bookable_days).toEqual([
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ]);
      expect(saved?.minimum_days_before).toBe(1);
      expect(saved?.maximum_days_after).toBe(90);
    });

    test("admin listing detail page shows Daily type for daily listings", async () => {
      const { listing } = await setupListingAndLogin({
        bookableDays: ["Monday", "Tuesday"],
        listingType: "daily",
        maximumDaysAfter: 60,
        minimumDaysBefore: 3,
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Listing Type",
        "Daily",
        "Bookable Days",
        "Monday, Tuesday",
        "Booking Window",
        "3 to 60 days",
        "Capacity of",
        "applies per date",
      );
    });

    test("admin listing detail page shows Standard type without daily config", async () => {
      const { listing } = await setupListingAndLogin();

      const html = await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Listing Type",
        "Standard",
      );
      expect(html).not.toContain("Bookable Days");
      expect(html).not.toContain("Booking Window");
    });

    test("admin listing edit page pre-fills daily config", async () => {
      const { listing } = await setupListingAndLogin({
        bookableDays: ["Wednesday", "Friday"],
        listingType: "daily",
        maximumDaysAfter: 120,
        minimumDaysBefore: 5,
      });

      const html = await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        'value="Wednesday" checked',
        'value="Friday" checked',
        'value="5"',
        'value="120"',
      );
      expect(html).not.toContain('value="Monday" checked');
    });

    test("updates listing from standard to daily", async () => {
      const listing = await createTestListing();
      await updateTestListing(listing.id, {
        bookableDays: ["Saturday", "Sunday"],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.listing_type).toBe("daily");
      expect(updated?.bookable_days).toEqual(["Saturday", "Sunday"]);
      expect(updated?.minimum_days_before).toBe(0);
      expect(updated?.maximum_days_after).toBe(14);
    });

    test("updates listing from daily to standard", async () => {
      const listing = await createTestListing({
        bookableDays: ["Monday"],
        listingType: "daily",
        maximumDaysAfter: 365,
        minimumDaysBefore: 7,
      });
      await updateTestListing(listing.id, { listingType: "standard" });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.listing_type).toBe("standard");
    });

    test("duplicate page pre-fills daily listing config", async () => {
      await setupListingAndLogin({
        bookableDays: ["Tuesday", "Thursday"],
        listingType: "daily",
        maximumDaysAfter: 45,
        minimumDaysBefore: 2,
      });

      const html = await assertAdminHtml(
        "/admin/listing/1/duplicate",
        'value="Tuesday" checked',
        'value="Thursday" checked',
        'value="2"',
        'value="45"',
      );
      expect(html).not.toContain('value="Monday" checked');
    });

    test("rejects invalid listing_type value", async () => {
      const { response } = await adminFormPost("/admin/listing", {
        listing_type: "invalid",
        max_attendees: "50",
        max_quantity: "1",
        name: "Bad Type Listing",
        thank_you_url: "https://example.com",
      });
      expectStatus(400)(response);
    });

    test("creates listing with non_transferable flag", async () => {
      const listing = await createTestListing({ nonTransferable: true });

      const saved = await getListingWithCount(listing.id);
      expect(saved?.non_transferable).toBe(true);
    });

    test("creates listing without non_transferable by default", async () => {
      const listing = await createTestListing();

      const saved = await getListingWithCount(listing.id);
      expect(saved?.non_transferable).toBe(false);
    });

    test("admin listing detail page shows non-transferable row when enabled", async () => {
      const { listing } = await setupListingAndLogin({
        nonTransferable: true,
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Non-Transferable",
        "ID verification required at entry",
      );
    });

    test("admin listing detail page does not show non-transferable row when disabled", async () => {
      const { listing } = await setupListingAndLogin();

      const html = await assertAdminHtml(`/admin/listing/${listing.id}`);
      expect(html).not.toContain("Non-Transferable");
    });

    test("admin listing edit page pre-fills non-transferable select", async () => {
      const { listing } = await setupListingAndLogin({
        nonTransferable: true,
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        "Non-Transferable Tickets",
        'value="1" selected',
      );
    });

    test("updates listing to enable non_transferable", async () => {
      const listing = await createTestListing();
      await updateTestListing(listing.id, { nonTransferable: true });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.non_transferable).toBe(true);
    });

    test("rejects invalid bookable_days value", async () => {
      await setupListingAndLogin({
        name: "Edit Target",
      });

      const listing = (await getListingWithCount(1))!;

      const { response } = await adminFormPost("/admin/listing/1/edit", {
        bookable_days: "Funday,Bunday",
        listing_type: "daily",
        max_attendees: "50",
        max_quantity: "1",
        maximum_days_after: "90",
        minimum_days_before: "1",
        name: "Edit Target",
        slug: listing.slug,
      });
      await expectHtmlResponse(response, 400, "Invalid day");
    });

    test("saves an empty bookable-days selection for a daily listing", async () => {
      const listing = await createTestListing({
        bookableDays: ["Monday"],
        listingType: "daily",
        name: "Daily Edit Target",
      });

      await updateTestListing(listing.id, { bookableDays: [] });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.bookable_days).toEqual([]);
    });
  });

  describe("audit logging (listing edit)", () => {
    test("logs activity when listing is updated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      await adminFormPost(`/admin/listing/${listing.id}/edit`, {
        max_attendees: "200",
        max_quantity: "1",
        name: listing.name,
        slug: listing.slug,
        thank_you_url: "https://example.com/updated",
      });

      const logs = await getListingActivityLog(listing.id);
      const updateLog = logs.find((l: { message: string }) =>
        l.message.includes("updated"),
      );
      expect(updateLog).toBeDefined();
      expect(updateLog?.message).toContain(listing.name);
    });
  });

  describe("daily listing admin view (Phase 4)", () => {
    const validDate1 = addDays(todayInTz("UTC"), 1);
    const validDate2 = addDays(todayInTz("UTC"), 2);

    const createDailyListingWithAttendees = async () => {
      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      // Create attendees on two different dates via the public form
      await submitTicketForm(listing.slug, {
        date: validDate1,
        email: "a@test.com",
        name: "User A",
      });
      await submitTicketForm(listing.slug, {
        date: validDate1,
        email: "b@test.com",
        name: "User B",
      });
      await submitTicketForm(listing.slug, {
        date: validDate2,
        email: "c@test.com",
        name: "User C",
      });
      return listing;
    };

    test("shows date selector dropdown for daily listings", async () => {
      const listing = await createDailyListingWithAttendees();

      const response = await adminGet(`/admin/listing/${listing.id}`);
      await expectHtmlResponse(
        response,
        200,
        "<select",
        "All dates",
        validDate1,
        validDate2,
      );
    });

    test("shows Date column header for daily listings", async () => {
      const listing = await createDailyListingWithAttendees();

      const response = await adminGet(`/admin/listing/${listing.id}`);
      const html = await response.text();
      expect(html).toContain("<th>Date</th>");
    });

    test("does not show Date column for standard listings", async () => {
      const { listing, cookie } = await setupListingAndLogin();

      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).not.toContain("<th>Date</th>");
    });

    test("filters attendees by ?date= parameter", async () => {
      const listing = await createDailyListingWithAttendees();

      // Filter to date1 — should show 2 attendees (User A and User B)
      const response = await adminGet(
        `/admin/listing/${listing.id}?date=${validDate1}`,
      );
      const html = await response.text();
      expect(html).toContain("User A");
      expect(html).toContain("User B");
      expect(html).not.toContain("User C");
    });

    test("filters attendees by ?date= showing other date", async () => {
      const listing = await createDailyListingWithAttendees();

      // Filter to date2 — should show 1 attendee (User C)
      const response = await adminGet(
        `/admin/listing/${listing.id}?date=${validDate2}`,
      );
      const html = await response.text();
      expect(html).toContain("User C");
      expect(html).not.toContain("User A");
    });

    test("shows per-date capacity when date filter is active", async () => {
      const listing = await createDailyListingWithAttendees();

      const response = await adminGet(
        `/admin/listing/${listing.id}?date=${validDate1}`,
      );
      const html = await response.text();
      // Should show "2 / 100" for the 2 attendees on date1
      expect(html).toContain("2 / 100");
      expect(html).toContain("98 remain");
    });

    test("shows total count without date filter", async () => {
      const listing = await createDailyListingWithAttendees();

      const response = await adminGet(`/admin/listing/${listing.id}`);
      const html = await response.text();
      expect(html).toContain("(total)");
      expect(html).toContain("Capacity of");
    });

    test("date filter composes with check-in filter", async () => {
      const listing = await createDailyListingWithAttendees();

      // Filter to date1 + checked out — should show both since none are checked in
      const response = await adminGet(
        `/admin/listing/${listing.id}/out?date=${validDate1}`,
      );
      const html = await response.text();
      expect(html).toContain("User A");
      expect(html).toContain("User B");
      expect(html).not.toContain("User C");
    });

    test("ignores ?date= for standard listings", async () => {
      const { listing, cookie } = await setupListingAndLogin();
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Standard User",
        "std@test.com",
      );

      // Even with ?date= param, standard listings show all attendees
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}?date=2026-03-15`,
        { cookie },
      );
      const html = await response.text();
      expect(html).toContain("Standard User");
      expect(html).not.toContain("<th>Date</th>");
    });

    test("CSV export includes Date column for daily listings", async () => {
      const listing = await createDailyListingWithAttendees();

      const response = await adminGet(`/admin/listing/${listing.id}/export`);
      await expectHtmlResponse(response, 200, "Date,Name,Email");
    });

    test("CSV export excludes Date column for standard listings", async () => {
      const { listing, cookie } = await setupListingAndLogin();
      await createTestAttendee(
        listing.id,
        listing.slug,
        "CSV User",
        "csv@test.com",
      );

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        { cookie },
      );
      const csv = await response.text();
      expect(csv.startsWith("Name,Email")).toBe(true);
    });

    test("CSV export filters by ?date= for daily listings", async () => {
      const listing = await createDailyListingWithAttendees();

      const response = await adminGet(
        `/admin/listing/${listing.id}/export?date=${validDate2}`,
      );
      const csv = await response.text();
      expect(csv).toContain("User C");
      expect(csv).not.toContain("User A");
    });

    test("CSV export filename includes date when filtered", async () => {
      const listing = await createDailyListingWithAttendees();

      const response = await adminGet(
        `/admin/listing/${listing.id}/export?date=${validDate1}`,
      );
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition).toContain(validDate1);
      expect(disposition).toContain("_attendees.csv");
    });

    test("Export CSV link includes ?date= when filter is active", async () => {
      const listing = await createDailyListingWithAttendees();

      const response = await adminGet(
        `/admin/listing/${listing.id}?date=${validDate1}`,
      );
      const html = await response.text();
      expect(html).toContain(
        `/admin/listing/${listing.id}/export?date=${validDate1}`,
      );
    });

    test("filter links preserve ?date= query parameter", async () => {
      const listing = await createDailyListingWithAttendees();

      const response = await adminGet(
        `/admin/listing/${listing.id}?date=${validDate1}`,
      );
      const html = await response.text();
      expect(html).toContain(
        `/admin/listing/${listing.id}/in?date=${validDate1}#attendees`,
      );
      expect(html).toContain(
        `/admin/listing/${listing.id}/out?date=${validDate1}#attendees`,
      );
    });
  });

  describe("stale reservation cleanup on admin listing view", () => {
    test("cleans up stale reservations when viewing an listing", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Cleanup Test Listing",
        thankYouUrl: "https://example.com",
      });

      // Insert a stale reservation (older than 5 minutes)
      const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      await getDb().execute(
        insert("processed_payments", {
          attendee_id: null,
          payment_session_id: "cs_stale_admin_test",
          processed_at: staleTime,
        }),
      );

      // Verify it exists
      const before = await getDb().execute({
        args: ["cs_stale_admin_test"],
        sql: `SELECT *
              FROM processed_payments
              WHERE payment_session_id = ?`,
      });
      expect(before.rows.length).toBe(1);

      // View the admin listing page
      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);

      // Stale reservation should be cleaned up
      const after = await getDb().execute({
        args: ["cs_stale_admin_test"],
        sql: `SELECT *
              FROM processed_payments
              WHERE payment_session_id = ?`,
      });
      expect(after.rows.length).toBe(0);
    });

    test("does not clean up fresh reservations when viewing an listing", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Fresh Reservation Test",
        thankYouUrl: "https://example.com",
      });

      // Insert a fresh reservation (just now)
      await getDb().execute(
        insert("processed_payments", {
          attendee_id: null,
          payment_session_id: "cs_fresh_admin_test",
          processed_at: new Date().toISOString(),
        }),
      );

      // View the admin listing page
      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);

      // Fresh reservation should still exist
      const after = await getDb().execute({
        args: ["cs_fresh_admin_test"],
        sql: `SELECT *
              FROM processed_payments
              WHERE payment_session_id = ?`,
      });
      expect(after.rows.length).toBe(1);
    });
  });

  describe("hidden listings", () => {
    test("creates listing with hidden enabled", async () => {
      const listing = await createTestListing({ hidden: true });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.hidden).toBe(true);
    });

    test("creates listing with hidden disabled by default", async () => {
      const listing = await createTestListing();
      const saved = await getListingWithCount(listing.id);
      expect(saved?.hidden).toBe(false);
    });

    test("updates listing to enable hidden", async () => {
      const listing = await createTestListing();
      await updateTestListing(listing.id, { hidden: true });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.hidden).toBe(true);
    });

    test("updates listing to enable can_pay_more via updateTestListing", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      await updateTestListing(listing.id, { canPayMore: true });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.can_pay_more).toBe(true);
    });

    test("updates listing to disable hidden", async () => {
      const listing = await createTestListing({ hidden: true });
      await updateTestListing(listing.id, { hidden: false });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.hidden).toBe(false);
    });

    test("admin listing detail page shows Hidden row when enabled", async () => {
      const { listing } = await setupListingAndLogin({
        hidden: true,
      });
      await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Hidden",
        "not shown in public listings list",
      );
    });

    test("admin listing detail page does not show Hidden row when disabled", async () => {
      const { listing } = await setupListingAndLogin();
      const html = await assertAdminHtml(`/admin/listing/${listing.id}`);
      expect(html).not.toContain("not shown in public listings list");
    });

    test("admin listing edit page pre-fills hidden checkbox", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        hidden: true,
      });
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/edit`,
        {
          cookie,
        },
      );
      const html = await response.text();
      expect(html).toContain("hidden");
    });

    test("admin listing edit page shows attachment info when listing has attachment", async () => {
      const { listing, cookie } = await setupListingAndLogin();
      await listingsTable.update(listing.id, {
        attachmentName: "Listing Guide.pdf",
        attachmentUrl: "uuid-guide.pdf",
      });

      await runWithStorageConfig(
        { zoneKey: "testkey", zoneName: "testzone" },
        async () => {
          const response = await awaitTestRequest(
            `/admin/listing/${listing.id}/edit`,
            { cookie },
          );
          const html = await response.text();
          expect(html).toContain("attachment-info");
          expect(html).toContain("Listing Guide.pdf");
          expect(html).toContain("Remove Attachment");
        },
      );
    });

    test("admin listing edit page does not show attachment info when empty", async () => {
      const { listing, cookie } = await setupListingAndLogin();

      await runWithStorageConfig(
        { zoneKey: "testkey", zoneName: "testzone" },
        async () => {
          const response = await awaitTestRequest(
            `/admin/listing/${listing.id}/edit`,
            { cookie },
          );
          const html = await response.text();
          expect(html).not.toContain("attachment-info");
          expect(html).not.toContain("Remove Attachment");
        },
      );
    });
  });

  describe("assign_built_site", () => {
    test("saves assign_built_site when CAN_BUILD_SITES is true", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
      try {
        const listing = await createTestListing({ assignBuiltSite: true });
        const saved = await getListingWithCount(listing.id);
        expect(saved?.assign_built_site).toBe(true);
      } finally {
        restore();
      }
    });

    test("ignores assign_built_site when CAN_BUILD_SITES is not set", async () => {
      const listing = await createTestListing({ assignBuiltSite: true });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.assign_built_site).toBe(false);
    });

    test("defaults to false even when CAN_BUILD_SITES is true", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
      try {
        const listing = await createTestListing();
        const saved = await getListingWithCount(listing.id);
        expect(saved?.assign_built_site).toBe(false);
      } finally {
        restore();
      }
    });

    test("updates listing to enable assign_built_site", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
      try {
        const listing = await createTestListing();
        await updateTestListing(listing.id, { assignBuiltSite: true });
        const updated = await getListingWithCount(listing.id);
        expect(updated?.assign_built_site).toBe(true);
      } finally {
        restore();
      }
    });
  });
});
