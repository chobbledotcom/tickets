// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { questionsTable } from "#db/questions/tables.ts";
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { adminBrowser, scenarioBrowser } from "#test/specs/support/browser.ts";
import {
  listingIdNamed,
  rememberListing,
} from "#test/specs/support/listings.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { enableFeature } from "#test-utils/settings.ts";

// jscpd:ignore-end

const GROUP_NAME = "Oakfield Primary Summer Fair volunteers";
const SETUP_SHIFT = "Set-up shift | 08:00-10:00 | 8 places";
const GATE_SHIFT = "Gate duty | 11:30-14:00 | 8 places";
const CLEARUP_SHIFT = "Clear-up shift | 15:30-17:00 | 8 places";
const ACCESS_QUESTION = "Do you have any access needs?";
const ACCESS_ANSWER = "Step-free access, please.";
const VOLUNTEER_NAME = "Sam Taylor";
const VOLUNTEER_EMAIL = "sam.taylor@example.test";

Given(
  "Oakfield has three volunteer shifts with eight places each",
  async function (this: TicketsWorld): Promise<void> {
    await enableFeature("questions");
    const group = await createTestGroup({ name: GROUP_NAME });
    for (const name of [SETUP_SHIFT, GATE_SHIFT, CLEARUP_SHIFT]) {
      const listing = await createTestListing({
        fields: "email",
        groupIds: [group.id],
        maxAttendees: 8,
        maxQuantity: 1,
        name,
        thankYouUrl: "",
        unitPrice: 0,
      });
      rememberListing(this, name, listing);
    }
    const question = await questionsTable.insert({
      assignAll: true,
      displayType: "free_text",
      text: ACCESS_QUESTION,
    });
    this.groupSlug = group.slug;
    // The shifts are offered on the group's own page, which is where an
    // evidence capture of the sign-up form has to go.
    leaveEvidencePage(this, ["volunteer-shift-form"], `/ticket/${group.slug}`);
    this.questionId = question.id;
  },
);

When(
  "Sam signs up for the set-up shift and asks for step-free access",
  async function (this: TicketsWorld): Promise<void> {
    const browser = scenarioBrowser(this);
    await browser.visit(
      `/ticket/${requiredWorldValue(this.groupSlug, "volunteer group slug")}`,
    );
    expect(browser.pageText).toContain(GROUP_NAME);
    expect(browser.pageText).toContain(ACCESS_QUESTION);
    await browser.submitForm(
      {
        email: VOLUNTEER_EMAIL,
        name: VOLUNTEER_NAME,
        [`quantity_${listingIdNamed(this, SETUP_SHIFT)}`]: "1",
        [`question_${requiredWorldValue(this.questionId, "access question id")}`]:
          ACCESS_ANSWER,
      },
      "Continue",
    );
  },
);

Then(
  "Sam receives a free booking confirmation for the set-up shift",
  async function (this: TicketsWorld): Promise<void> {
    const browser = scenarioBrowser(this);
    expect(browser.pageText).toContain("Thank you for your order");
    await browser.clickLink("View your ticket");
    expect(browser.pageText).toContain(SETUP_SHIFT);
    expect(browser.pageText).not.toContain(GATE_SHIFT);
    expect(browser.pageText).not.toContain(CLEARUP_SHIFT);
  },
);

Then(
  "the organiser sees Sam and the access note on the set-up shift",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    const listingId = requiredWorldValue(
      listingIdNamed(this, SETUP_SHIFT),
      "set-up shift listing id",
    );
    await browser.visit(`/admin/listing/${listingId}/attendees`);
    expect(browser.pageText).toContain(VOLUNTEER_NAME);
    expect(browser.pageText).toContain(VOLUNTEER_EMAIL);
    expect(browser.pageText).toContain(ACCESS_ANSWER);
  },
);
