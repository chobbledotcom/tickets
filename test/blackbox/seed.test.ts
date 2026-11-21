import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { App, Page } from "#test/blackbox/driver.ts";
import { addListing } from "#test/blackbox/seed.ts";

const page = (
  status: number,
  html = "",
  location: string | null = null,
): Page => ({
  html,
  location,
  status,
});

/** A visitor whose answers come from a table of addresses. */
const visitor = (saved: Page, answers: Record<string, string>): App => ({
  cookieHeader: () => "",
  get: (path) => Promise.resolve(page(200, answers[path] ?? "")),
  logIn: () => Promise.resolve(page(302)),
  submit: () => Promise.resolve(saved),
});

const FIELDS = { maxAttendees: "5", name: "Quiz", unitPrice: "1.00" };

describe("addListing", () => {
  test("reads the number and the public address from the owner's pages", async () => {
    const app = visitor(page(302, "", "/admin"), {
      "/admin/listing/7": '<a href="/ticket/abc12">public</a>',
      "/admin/listings": '<a href="/admin/listing/7">Quiz</a>',
    });
    expect(await addListing(app, FIELDS)).toEqual({ id: 7, slug: "abc12" });
  });

  test("fails when the form is not answered with a redirect", async () => {
    await expect(addListing(visitor(page(422), {}), FIELDS)).rejects.toThrow(
      "Adding the listing answered 422, not a redirect.",
    );
  });

  test("fails when the listings page does not show the new name", async () => {
    await expect(
      addListing(
        visitor(page(302), { "/admin/listings": "<p>none</p>" }),
        FIELDS,
      ),
    ).rejects.toThrow('The listings page does not show "Quiz".');
  });

  test("fails when the listing page holds no public address", async () => {
    const app = visitor(page(302), {
      "/admin/listing/7": "<p>none</p>",
      "/admin/listings": '<a href="/admin/listing/7">Quiz</a>',
    });
    await expect(addListing(app, FIELDS)).rejects.toThrow(
      "The page of listing 7 holds no public address.",
    );
  });
});
