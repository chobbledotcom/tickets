// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  assertPublicHtml,
  expectFlash,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { getTicketCsrfToken } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  futureCloseTime,
  pastCloseTime,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

/** POSTs `formData` to `path` after closing `listingIdToClose` mid-submission
 * (having already fetched a valid CSRF token while it was still open) and
 * asserts the "closed while you were submitting" flash — the shared shape
 * behind both the single-ticket and ticket race-condition tests below. */
const expectClosesDuringSubmission = async (
  path: string,
  formData: Record<string, string>,
  listingIdToClose: number,
): Promise<void> => {
  const getResponse = await handleRequest(mockRequest(path));
  const csrfToken = getTicketCsrfToken(await getResponse.text());
  if (!csrfToken) throw new Error("No CSRF token");

  await updateTestListing(listingIdToClose, { closesAt: pastCloseTime() });

  const response = await handleRequest(
    mockFormRequest(
      path,
      { ...formData, csrf_token: csrfToken },
      `csrf_token=${csrfToken}`,
    ),
  );
  expect(response.status).toBe(302);
  expectFlash(
    response,
    expect.stringContaining(
      "Sorry, registration closed while you were submitting.",
    ),
    false,
  );
};

describeWithEnv(
  "server public > closes_at",
  { db: true, triggers: true },
  () => {
    describe("closes_at (single ticket)", () => {
      test("shows 'Registration closed.' when closes_at is in the past", async () => {
        const listing = await createTestListing({
          closesAt: pastCloseTime(),
        });

        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        const html = await expectHtmlResponse(
          response,
          200,
          "Registration closed.",
        );
        expect(html).not.toContain("Continue");
      });

      test("shows form when closes_at is in the future", async () => {
        const listing = await createTestListing({
          closesAt: futureCloseTime(),
        });

        const html = await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "Continue",
        );
        expect(html).not.toContain("Registration closed.");
      });

      test("shows form when closes_at is null", async () => {
        const listing = await createTestListing();

        const html = await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "Continue",
        );
        expect(html).not.toContain("Registration closed.");
      });

      test("shows 'registration closed while you were submitting' on POST when closes_at is past", async () => {
        // Create listing with future closes_at so we can get CSRF token
        const listing = await createTestListing({
          closesAt: futureCloseTime(),
        });

        await expectClosesDuringSubmission(
          `/ticket/${listing.slug}`,
          {
            email: "test@example.com",
            name: "Test User",
            [`quantity_${listing.id}`]: "1",
          },
          listing.id,
        );
      });
    });

    describe("closes_at (ticket)", () => {
      test("shows 'Registration closed.' when all listings are closed", async () => {
        const pastDate = pastCloseTime();
        const listing1 = await createTestListing({ closesAt: pastDate });
        const listing2 = await createTestListing({ closesAt: pastDate });

        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Registration closed.",
        );
      });

      test("shows 'Registration Closed' label for individual closed listing in ticket", async () => {
        const listing1 = await createTestListing({
          closesAt: pastCloseTime(),
        });
        const listing2 = await createTestListing();

        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Registration Closed",
          listing2.name, // open listing shows form
        );
      });

      test("shows error on POST when listing closes during submission", async () => {
        // Create two listings, one will close during submission
        const listing1 = await createTestListing({
          closesAt: futureCloseTime(),
        });
        const listing2 = await createTestListing();

        await expectClosesDuringSubmission(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          {
            email: "test@example.com",
            name: "Test User",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
          },
          listing1.id,
        );
      });
    });
  },
);
