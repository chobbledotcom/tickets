// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { openAdminPage, scenarioBrowser } from "#test/specs/support/browser.ts";
import { ownerAsksChoiceQuestion } from "#test/specs/support/buyer-questions.ts";
import { organiserAddsBooking } from "#test/specs/support/by-hand.ts";
import { whyValueCannotBeSent } from "#test/specs/support/form-controls/rules.ts";
import { dayFromToday, newestStayOn } from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

import {
  regionShowsPicture,
  uploadsAPicture,
} from "#test/specs/support/attendee-images.ts";
import { emailFor } from "#test/specs/support/emails.ts";

/** The words the picture question asks, with the reference the picture is
 * named by. The story's subject is the picture, so the prose around it stays
 * fixed here rather than in the Feature. */
const questionTextWithPicture = (name: string, imageId: number): string =>
  `Choose a size. ![${name}](img#${imageId})`;

/** The prose block the question's own text renders in, named by the question
 * the site really filed. */
const questionProseMarker = (world: TicketsWorld): string =>
  `id="question-${world.buyerQuestion!.id}-prose"`;

/** Hold the question's own prose block to its copy of the picture, so a
 * picture rendered anywhere else on the form never stands in for it. */
function questionShowsPicture(this: TicketsWorld, _name: string): void {
  regionShowsPicture(
    scenarioBrowser(this).currentHtml,
    questionProseMarker(this),
    "div",
    this,
  );
}

/** Book someone onto a listing through the roster's own form, on the day the
 * story names, and remember the booking they made. */
const booksOnto = async (
  world: TicketsWorld,
  who: string,
  listingName: string,
  startsIn: number,
): Promise<void> => {
  await organiserAddsBooking(world, listingName, {
    day: dayFromToday(world, startsIn),
    email: emailFor(who),
    who,
  });
  world.things.remember(
    "record",
    `${who} booking`,
    await newestStayOn(world, listingName),
  );
};

Given(
  "the owner asks {word} buyers a question with a picture called {string} in it",
  async function (
    this: TicketsWorld,
    listingName: string,
    name: string,
  ): Promise<void> {
    const picture = await uploadsAPicture(this, name);
    await ownerAsksChoiceQuestion(
      this,
      listingName,
      questionTextWithPicture(name, picture.id),
      ["Small", "Large"],
    );
  },
);

When(
  "the organiser booked {word} onto the {word}",
  async function (
    this: TicketsWorld,
    who: string,
    listingName: string,
  ): Promise<void> {
    await organiserAddsBooking(this, listingName, {
      email: emailFor(who),
      who,
    });
    this.things.remember(
      "record",
      `${who} booking`,
      await newestStayOn(this, listingName),
    );
  },
);

When(
  "the organiser booked {word} onto the {word} starting today",
  async function (
    this: TicketsWorld,
    who: string,
    listingName: string,
  ): Promise<void> {
    await booksOnto(this, who, listingName, 0);
  },
);

When(
  "the organiser opens the edit page for {word}'s booking",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const attendeeId = this.things.require("record", `${who} booking`);
    await openAdminPage(this, `/admin/attendees/${attendeeId}/edit`);
  },
);

When(
  "the organiser sends the form without a name",
  async function (this: TicketsWorld): Promise<void> {
    await scenarioBrowser(this).submitForm({ name: "" }, "Save Attendee");
  },
);

Then("the question shows the {string} picture", questionShowsPicture);

Then("the question still shows the {string} picture", questionShowsPicture);

Then(
  "the answer control can still be used",
  function (this: TicketsWorld): void {
    const html = scenarioBrowser(this).currentHtml;
    const field = `question_${this.buyerQuestion!.id}`;
    // The radio's sendable value is the answer's own number, read from the
    // served form the way a browser would send it.
    const offered = html.match(
      new RegExp(`name="${field}"[^>]*value="([^"]+)"`),
    )?.[1];
    expect(offered).toBeDefined();
    expect(whyValueCannotBeSent(html, field, offered!)).toBeNull();
  },
);

Then(
  "the organiser is told to enter a name",
  function (this: TicketsWorld): void {
    assertStringIncludes(
      scenarioBrowser(this).pageText,
      t("error.name_required"),
    );
  },
);
