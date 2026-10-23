import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { questionListings } from "#db/questions/queries.ts";
import { questionsTable } from "#db/questions/tables.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import {
  createTestGroup,
  updateTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { createFreePackage } from "#test-utils/packages.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import type { Image } from "#types";

describeWithEnv("the ticket page's image references", { db: true }, () => {
  /** GET one ticket page's HTML through the public route. */
  const ticketPageHtml = async (slug: string): Promise<string> => {
    await enablePublicSite();
    const response = await handleRequest(mockRequest(`/ticket/${slug}`));
    expect(response.status).toBe(200);
    return response.text();
  };

  /** Assert the page rendered `alt`'s reference as the image's uid URL. The
   * head's og:description echoes the raw description, so only the resolved
   * body image proves the lookup ran; an unresolved page renders src="". */
  const expectResolved = (html: string, image: Image, alt: string): void => {
    assertStringIncludes(
      html,
      `<img src="/image/${image.filename}" alt="${alt}">`,
    );
  };

  test("resolves a listing description's image reference on its own page", async () => {
    const poster = await makeImage("Poster");
    const listing = await createTestListing({
      description: `![Poster](img#${poster.id})`,
      name: "Kayak Tour",
    });
    const html = await ticketPageHtml(listing.slug);
    expectResolved(html, poster, "Poster");
  });

  test("resolves a group description's image reference on the group page", async () => {
    const poster = await makeImage("Poster");
    const group = await createTestGroup({
      description: `![Poster](img#${poster.id})`,
      name: "Stargazing",
    });
    await createTestListing({ groupId: group.id, name: "Barn" });
    expectResolved(await ticketPageHtml(group.slug), poster, "Poster");
  });

  test("resolves a package description's image reference on a cart page", async () => {
    const kit = await makeImage("Kit");
    const { group } = await createFreePackage("Camp Kit", "Tent");
    await updateTestGroup(group.id, { description: `![Kit](img#${kit.id})` });
    const extra = await createTestListing({ name: "Binoculars" });
    expectResolved(
      await ticketPageHtml(`${group.slug}+${extra.slug}`),
      kit,
      "Kit",
    );
  });

  test("resolves a question text's image reference", async () => {
    const poster = await makeImage("Poster");
    const listing = await createTestListing({ name: "Kayak Tour" });
    const question = await questionsTable.insert({
      displayType: "free_text",
      text: `![Poster](img#${poster.id})`,
    });
    await questionListings.setIds(question.id, [listing.id]);
    expectResolved(await ticketPageHtml(listing.slug), poster, "Poster");
  });

  test("resolves a global terms image reference on the booking page", async () => {
    const poster = await makeImage("Poster");
    await settings.update.terms(`![Poster](img#${poster.id})`);
    const listing = await createTestListing({ name: "Kayak Tour" });
    expectResolved(await ticketPageHtml(listing.slug), poster, "Poster");
  });

  test("resolves the site footer's image reference on the booking page", async () => {
    const poster = await makeImage("Poster");
    await settings.update.siteFooter(`![Poster](img#${poster.id})`);
    const listing = await createTestListing({ name: "Kayak Tour" });
    expectResolved(await ticketPageHtml(listing.slug), poster, "Poster");
  });

  test("resolves the site footer's image reference on the ticket the customer takes home", async () => {
    const poster = await makeImage("Poster");
    await settings.update.siteFooter(`![Poster](img#${poster.id})`);
    const { token } = await createTestAttendeeWithToken("Ada", "ada@test.com");
    const response = await handleRequest(mockRequest(`/t/${token}`));
    expect(response.status).toBe(200);
    expectResolved(await response.text(), poster, "Poster");
  });

  test("renders an image reference no image answers with an empty source", async () => {
    const listing = await createTestListing({
      description: "![Poster](img#999999)",
      name: "Kayak Tour",
    });
    const html = await ticketPageHtml(listing.slug);
    assertStringIncludes(html, '<img src="" alt="Poster">');
  });
});
