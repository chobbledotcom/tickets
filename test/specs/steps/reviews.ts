/** The visitor's side of the reviews page. */

import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  newcomerReading,
  openAdminPage,
  openAsNewcomer,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

When(
  "a visitor opens the reviews page",
  async function (this: TicketsWorld): Promise<void> {
    const read = await newcomerReading("/reviews");
    this.reviewsAnswer = { answered: read.answered, said: read.said };
  },
);

Then(
  "the visitor is told the page is not found",
  function (this: TicketsWorld): void {
    expect(this.reviewsAnswer?.answered).toBe(404);
  },
);

Then(
  "the visitor reads {string}",
  function (this: TicketsWorld, words: string): void {
    expect(this.reviewsAnswer?.said).toContain(words);
  },
);

Then(
  "the visitor is offered a reviews link",
  async function (this: TicketsWorld): Promise<void> {
    const page = await openAsNewcomer("/");
    expect(page.currentHtml).toContain('href="/reviews"');
  },
);

Then(
  "the visitor is offered no reviews link",
  async function (this: TicketsWorld): Promise<void> {
    const page = await openAsNewcomer("/");
    expect(page.currentHtml).not.toContain('href="/reviews"');
  },
);

When(
  "the owner opens the reviews editor",
  async function (this: TicketsWorld): Promise<void> {
    const editor = await openAdminPage(this, "/admin/site/reviews");
    expect(editor.currentHtml).toContain(t("reviews.add.submit"));
  },
);

When(
  "the owner turns on the reviews page",
  async function (this: TicketsWorld): Promise<void> {
    const editor = await openAdminPage(this, "/admin/site/reviews");
    await fillInAndSend(editor, {}, t("common.save"), {
      reviewsEnabled: ["true"],
    });
  },
);

When(
  "the owner turns off the reviews page",
  async function (this: TicketsWorld): Promise<void> {
    const editor = await openAdminPage(this, "/admin/site/reviews");
    await fillInAndSend(editor, {}, t("common.save"), {
      reviewsEnabled: [],
    });
  },
);

When(
  "the owner adds a review from {string} with the URL {string}",
  async function (
    this: TicketsWorld,
    name: string,
    url: string,
  ): Promise<void> {
    const editor = await openAdminPage(this, "/admin/site/reviews/new");
    await fillInAndSend(
      editor,
      {
        date: "2026-11-24",
        name,
        rating: "5",
        text: "A new review.",
        url,
      },
      t("reviews.add.submit"),
    );
  },
);
