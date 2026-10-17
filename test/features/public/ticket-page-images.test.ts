import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ticketPageImageUrls } from "#routes/public/ticket-page-images.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("the ticket page's image-url lookup", { db: true }, () => {
  test("resolves ids named in the terms and a package description", async () => {
    const poster = await makeImage("Poster");
    const flyer = await makeImage("Flyer");
    const urls = await ticketPageImageUrls({
      listings: [],
      packages: [{ description: `![Flyer](img#${flyer.id})` }],
      terms: `![Poster](img#${poster.id})`,
    });
    expect(urls.get(poster.id)).toBe(`/image/${poster.filename}`);
    expect(urls.get(flyer.id)).toBe(`/image/${flyer.filename}`);
  });

  test("reads the other texts when the page names no packages", async () => {
    const poster = await makeImage("Poster");
    const urls = await ticketPageImageUrls({
      listings: [{ listing: { description: `![Poster](img#${poster.id})` } }],
      terms: null,
    });
    expect(urls.get(poster.id)).toBe(`/image/${poster.filename}`);
    expect(urls.size).toBe(1);
  });
});
