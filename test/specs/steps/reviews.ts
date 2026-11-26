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
    expect(editor.currentHtml).toContain(t("site.reviews.text_label"));
  },
);

When(
  "the owner replaces the reviews file with a review from {string}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const editor = await openAdminPage(this, "/admin/site/reviews");
    const source = `---
reviews:
  - name: ${JSON.stringify(name)}
    rating: 5
    date: "2026-11-24"
    text: "A new review."
---
`;
    await fillInAndSend(editor, { reviewsMarkdown: source }, t("common.save"));
  },
);
