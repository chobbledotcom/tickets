// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { expectBothReservedAtTwoAndOne } from "#test/lib/server-public/_shared-multi.ts";
import {
  expectAttendeeCounts,
  expectFlash,
  expectHtmlResponse,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import { getTicketCsrfToken } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket multi-slug POST",
  { db: true, triggers: true },
  () => {
    describe("POST /ticket/:slug1+:slug2", () => {
      /** Helper to submit ticket form with CSRF */
      const submitMultiTicketForm = async (
        slugs: string[],
        data: Record<string, string>,
      ): Promise<Response> => {
        const path = `/ticket/${slugs.join("+")}`;
        const getResponse = await handleRequest(mockRequest(path));
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        return handleRequest(
          mockFormRequest(path, { ...data, csrf_token: csrfToken }),
        );
      };

      test("returns 404 when no valid listings", async () => {
        const response = await handleRequest(
          mockFormRequest("/ticket/nonexistent1+nonexistent2", {
            email: "john@example.com",
            name: "John",
          }),
        );
        expect(response.status).toBe(404);
      });

      test("validates name is required", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Post Multi 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Post Multi 2",
        });
        const response = await submitMultiTicketForm(
          [listing1.slug, listing2.slug],
          {
            email: "john@example.com",
            name: "",
            [`quantity_${listing1.id}`]: "1",
          },
        );
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("required"), false);
      });

      test("requires at least one ticket selected", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Post Multi Empty 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Post Multi Empty 2",
        });
        const response = await submitMultiTicketForm(
          [listing1.slug, listing2.slug],
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "0",
            [`quantity_${listing2.id}`]: "0",
          },
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Please select at least one ticket"),
          false,
        );
      });

      test("renders flashed 'select at least one ticket' error after redirect", async () => {
        const { FLASH_TEST_ID, flashCookieHeader } = await import(
          "#test-utils/assertions.ts"
        );
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Flash Render 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Flash Render 2",
        });
        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await handleRequest(
          mockRequest(`/ticket/${slug}?flash=${FLASH_TEST_ID}`, {
            headers: {
              cookie: flashCookieHeader(
                "Please select at least one ticket",
                false,
              ),
            },
          }),
        );
        await expectHtmlResponse(
          response,
          200,
          "Please select at least one ticket",
        );
      });

      test("creates attendees for selected free listings", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Post Multi Free 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Post Multi Free 2",
        });
        const response = await submitMultiTicketForm(
          [listing1.slug, listing2.slug],
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "2",
            [`quantity_${listing2.id}`]: "1",
          },
        );
        // Verify attendees were created
        await expectBothReservedAtTwoAndOne(response, listing1, listing2);
      });

      test("only registers for listings with quantity > 0", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Post Multi Partial 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Post Multi Partial 2",
        });
        const response = await submitMultiTicketForm(
          [listing1.slug, listing2.slug],
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "0",
          },
        );
        expectReservedRedirectWithTokens(response);

        // Verify only listing1 has an attendee
        await expectAttendeeCounts([
          { count: 1, listingId: listing1.id },
          { count: 0, listingId: listing2.id },
        ]);
      });

      test("caps quantity at max purchasable", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 3,
          maxQuantity: 2,
          name: "Post Multi Cap 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Post Multi Cap 2",
        });
        const response = await submitMultiTicketForm(
          [listing1.slug, listing2.slug],
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "10", // Request more than max
            [`quantity_${listing2.id}`]: "0",
          },
        );
        expectReservedRedirectWithTokens(response);

        // Verify quantity was capped
        await expectAttendeeCounts([
          { count: 1, listingId: listing1.id, quantity: 2 }, // Capped at maxQuantity
        ]);
      });
    });
  },
);
