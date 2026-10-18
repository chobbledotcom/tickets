import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addTicketPageImageUrls } from "#db/images.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describeWithEnv("the ticket page's image-url write", { db: true }, () => {
  test("writes the ids named in the terms and a package description", async () => {
    const poster = await makeImage("Poster");
    const flyer = await makeImage("Flyer");
    await withRequestContext(async () => {
      await addTicketPageImageUrls({
        listings: [],
        packages: [{ description: `![Flyer](img#${flyer.id})` }],
        questions: [],
        terms: `![Poster](img#${poster.id})`,
      });
      expect(renderMarkdown(`![Poster](img#${poster.id})`)).toContain(
        `src="/image/${poster.filename}"`,
      );
      expect(renderMarkdown(`![Flyer](img#${flyer.id})`)).toContain(
        `src="/image/${flyer.filename}"`,
      );
    });
  });

  test("writes the other texts when the page sells no packages", async () => {
    const poster = await makeImage("Poster");
    await withRequestContext(async () => {
      await addTicketPageImageUrls({
        listings: [{ listing: { description: `![Poster](img#${poster.id})` } }],
        packages: [],
        questions: [],
        terms: null,
      });
      expect(renderMarkdown(`![Poster](img#${poster.id})`)).toContain(
        `src="/image/${poster.filename}"`,
      );
    });
  });

  test("writes an id named only in a question's text", async () => {
    const poster = await makeImage("Poster");
    await withRequestContext(async () => {
      await addTicketPageImageUrls({
        listings: [],
        packages: [],
        questions: [{ text: `![Poster](img#${poster.id})` }],
        terms: null,
      });
      expect(renderMarkdown(`![Poster](img#${poster.id})`)).toContain(
        `src="/image/${poster.filename}"`,
      );
    });
  });

  test("writes nothing when no text names an image", async () => {
    await withRequestContext(async () => {
      await addTicketPageImageUrls({
        listings: [{ listing: { description: "plain words" } }],
        packages: [],
        questions: [],
        terms: "also plain",
      });
      expect(renderMarkdown("![Poster](img#7)")).toContain('src=""');
    });
  });
});
