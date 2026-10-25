// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assert, assertStringIncludes } from "@std/assert";
import {
  pictureTag,
  uploadsAPicture,
} from "#test/specs/support/attendee-images.ts";
import { PREVIEWER, previewsText } from "#test/specs/support/preview.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "an uploaded picture called {string}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await uploadsAPicture(this, name);
  },
);

When(
  "the editor previews text with the picture in it",
  async function (this: TicketsWorld): Promise<void> {
    const image = this.noteImage!;
    await previewsText(this, `Have a look. ![${image.alt}](img#${image.id})`);
  },
);

When(
  "the editor previews text with a picture that was never uploaded",
  async function (this: TicketsWorld): Promise<void> {
    await previewsText(this, "Have a look. ![Ghost](img#424242)");
  },
);

Then(
  "the preview shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    assertStringIncludes(whatTheyWereTold(this, PREVIEWER), pictureTag(this));
  },
);

Then(
  "the preview never shows the picture reference",
  function (this: TicketsWorld): void {
    assert(!whatTheyWereTold(this, PREVIEWER).includes("img#"));
  },
);

Then(
  "the preview keeps the describing words",
  function (this: TicketsWorld): void {
    assertStringIncludes(
      whatTheyWereTold(this, PREVIEWER),
      '<img src="" alt="Ghost">',
    );
  },
);

Then(
  "the preview shows no picture at all",
  function (this: TicketsWorld): void {
    assert(!whatTheyWereTold(this, PREVIEWER).includes("/image/"));
  },
);
