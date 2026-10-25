// jscpd:ignore-start

import { Given, Then } from "@cucumber/cucumber";
import { assertStringIncludes } from "@std/assert";
import { settings } from "#db/settings.ts";
import { thingsGroupedTogether } from "#test/specs/support/bundles.ts";
import {
  ownerAsksWrittenQuestion,
  visitorOpensBooking,
} from "#test/specs/support/buyer-questions.ts";
import { imageNamed } from "#test/specs/support/images.ts";
import {
  listingIdNamed,
  rememberListing,
} from "#test/specs/support/listings.ts";
import {
  expectShownImage,
  expectShownImageInPackageSection,
  referenceNoImageAnswers,
  referenceToLibraryImage,
  sellsReadableThing,
  visitorReadsSharedPage,
  visitorReadsTwoThingsFromOnePage,
} from "#test/specs/support/ticket-page-images.ts";
import { openTicket } from "#test/specs/support/tickets.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { updateTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { createFreePackage } from "#test-utils/packages.ts";

// jscpd:ignore-end

Given(
  "the owner sells a {word} whose description carries the image {word}",
  async function (
    this: TicketsWorld,
    name: string,
    image: string,
  ): Promise<void> {
    await sellsReadableThing(this, name, await referenceToLibraryImage(image));
  },
);

Given(
  "the owner sells a {word} whose description carries a reference to an image called {word}",
  async function (
    this: TicketsWorld,
    name: string,
    image: string,
  ): Promise<void> {
    await sellsReadableThing(this, name, referenceNoImageAnswers(image));
  },
);

Given(
  "the owner has a shared page called {word} with the image {word} in its words",
  async function (
    this: TicketsWorld,
    name: string,
    image: string,
  ): Promise<void> {
    await thingsGroupedTogether(this, name, []);
    const group = this.things.require("bundle", name);
    await updateTestGroup(group.id, {
      description: await referenceToLibraryImage(image),
    });
  },
);

Given(
  "the {word} page sells a {word} and a {word}",
  async function (
    this: TicketsWorld,
    page: string,
    first: string,
    second: string,
  ): Promise<void> {
    const group = this.things.require("bundle", page);
    for (const name of [first, second]) {
      rememberListing(
        this,
        name,
        await createTestListing({
          groupId: group.id,
          maxAttendees: 10,
          maxQuantity: 10,
          name,
          thankYouUrl: "",
        }),
      );
    }
  },
);

Given(
  "the owner sells a {word} package holding a {word}",
  async function (
    this: TicketsWorld,
    name: string,
    part: string,
  ): Promise<void> {
    const { group, member } = await createFreePackage(name, part);
    this.things.remember("bundle", name, group);
    rememberListing(this, part, member);
  },
);

Given(
  "the {word} package's description carries the image {word}",
  async function (
    this: TicketsWorld,
    name: string,
    image: string,
  ): Promise<void> {
    const group = this.things.require("bundle", name);
    await updateTestGroup(group.id, {
      description: await referenceToLibraryImage(image),
    });
  },
);

Given(
  "the {word}'s description carries the image {word}",
  async function (
    this: TicketsWorld,
    name: string,
    image: string,
  ): Promise<void> {
    await updateTestListing(listingIdNamed(this, name), {
      description: await referenceToLibraryImage(image),
    });
  },
);

Given(
  "the {word} package and a {word} sell from one page",
  async function (
    this: TicketsWorld,
    _packageName: string,
    extraName: string,
  ): Promise<void> {
    rememberListing(
      this,
      extraName,
      await createTestListing({
        maxAttendees: 10,
        maxQuantity: 10,
        name: extraName,
        thankYouUrl: "",
      }),
    );
  },
);

Given(
  "the site's terms carry the image {word}",
  async function (this: TicketsWorld, image: string): Promise<void> {
    await settings.update.terms(await referenceToLibraryImage(image));
  },
);

Given(
  "the site's footer carries the image {word}",
  async function (this: TicketsWorld, image: string): Promise<void> {
    await settings.update.siteFooter(await referenceToLibraryImage(image));
  },
);

Given(
  "the owner asks the {word}'s buyers a question with the image {word} in it",
  async function (
    this: TicketsWorld,
    listingName: string,
    image: string,
  ): Promise<void> {
    await ownerAsksWrittenQuestion(
      this,
      await referenceToLibraryImage(image),
      listingName,
    );
  },
);

Then(
  "a visitor reading the {word}'s ticket page is shown the image {word}",
  async function (
    this: TicketsWorld,
    name: string,
    image: string,
  ): Promise<void> {
    expectShownImage(
      (await visitorOpensBooking(this, name)).currentHtml,
      await imageNamed(image),
    );
  },
);

Then(
  "a visitor reading the {word} page is shown the image {word}",
  async function (
    this: TicketsWorld,
    name: string,
    image: string,
  ): Promise<void> {
    expectShownImage(
      (await visitorReadsSharedPage(this, name)).currentHtml,
      await imageNamed(image),
    );
  },
);

Then(
  "a visitor reading the page that offers the {word} and the {word} is shown the image {word} in the package's description",
  async function (
    this: TicketsWorld,
    packageName: string,
    extraName: string,
    image: string,
  ): Promise<void> {
    await expectShownImageInPackageSection(this, packageName, extraName, image);
  },
);

Then(
  "a visitor reading the page that offers the {word} and the {word} is shown the image {word} in the {word}'s row",
  async function (
    this: TicketsWorld,
    packageName: string,
    extraName: string,
    image: string,
    memberName: string,
  ): Promise<void> {
    await expectShownImageInPackageSection(
      this,
      packageName,
      extraName,
      image,
      memberName,
    );
  },
);

Then(
  "a visitor reading the page that sells the {word} and the {word} is shown the image {word} and the image {word}",
  async function (
    this: TicketsWorld,
    firstThing: string,
    secondThing: string,
    firstImage: string,
    secondImage: string,
  ): Promise<void> {
    const html = (
      await visitorReadsTwoThingsFromOnePage(this, firstThing, secondThing)
    ).currentHtml;
    expectShownImage(html, await imageNamed(firstImage));
    expectShownImage(html, await imageNamed(secondImage));
  },
);

Then(
  "their ticket shows the image {word}",
  async function (this: TicketsWorld, image: string): Promise<void> {
    expectShownImage(
      (await openTicket(this)).currentHtml,
      await imageNamed(image),
    );
  },
);

Then(
  "a visitor reading the {word}'s ticket page is shown {word}'s name and no picture",
  async function (
    this: TicketsWorld,
    name: string,
    image: string,
  ): Promise<void> {
    assertStringIncludes(
      (await visitorOpensBooking(this, name)).currentHtml,
      `<img src="" alt="${image}">`,
    );
  },
);
