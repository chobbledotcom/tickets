// jscpd:ignore-start
import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { renderChildBlock } from "#templates/public/reservations/child-block.ts";
import { ticketListing } from "#test/ui/templates/helpers.ts";
import { followRedirectWithFlash } from "#test-utils/assertions.ts";
import { submitMultiTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { deactivateTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  bookingPageHtml,
  childField,
  makeParent,
  makeTwoDefaultChildren,
  parentField,
} from "#test-utils/parents.ts";
import {
  selectOptionsFromHtml,
  selectOptionsHtml,
} from "#test-utils/parents-gate/helpers.ts";
import type { Listing } from "#types";

// jscpd:ignore-end

const makeHiddenSoleChild = () =>
  makeParent({
    children: [
      {
        canPayMore: true,
        hidden: true,
        maxPrice: 5000,
        name: "Hidden add-on",
        unitPrice: 1500,
      },
    ],
  });

const giveAdultsAudience = async (childId: number): Promise<void> => {
  const audience = await createTestAttributeWithOptions("Audience", ["Adults"]);
  await assignTestAttributeOptions(childId, audience.options);
};

const renderHidingChildName = async (
  parent: Listing,
  child: Listing,
): Promise<string> => {
  const html = await bookingPageHtml(parent.slug);
  assertStringIncludes(html, `data-sole-child="${child.id}"`);
  assertStringIncludes(html, `name="child_price_${parent.id}_${child.id}"`);
  assert(!html.includes("Hidden add-on"));
  return html;
};

describeWithEnv(
  "public reservations > child block",
  { db: true, triggers: true },
  () => {
    test("a listing without children renders an empty child block", () => {
      const parent = ticketListing({ id: 101, name: "Standalone" });

      expect(
        renderChildBlock(parent, {
          attributesByListing: new Map(),
          childDatesById: new Map(),
          children: new Map(),
          foldReserveByChildId: new Map(),
          groupIdsByListingId: new Map(),
          groupRemainingByGroupId: new Map(),
          questionListingMap: new Map(),
          questions: [],
          rendered: new Set(),
        }),
      ).toBe("");
    });

    test("a rejected multi-child submission re-fills the chosen child", async () => {
      await settings.update.terms("You must accept the rules.");
      const { parent, childA, childB } = await makeTwoDefaultChildren({
        maxQuantity: 5,
      });

      const posted = await submitMultiTicketForm(parent.slug, {
        email: "ada@example.com",
        name: "Ada",
        ...childField(parent, childA, "xyz"),
        ...childField(parent, childB, "1"),
        ...parentField(parent, "1"),
      });
      expect(posted.status).toBe(302);
      const refilled = await followRedirectWithFlash(posted, (req) =>
        handleRequest(req),
      );
      const html = await refilled.text();
      const optionsB = selectOptionsFromHtml(
        html,
        `child_qty_${parent.id}_${childB.id}`,
      );
      assertStringIncludes(optionsB, 'value="1" selected');
      const optionsA = selectOptionsFromHtml(
        html,
        `child_qty_${parent.id}_${childA.id}`,
      );
      assertStringIncludes(optionsA, 'value="0" selected');
    });

    test("pay-more children render non-required price inputs", async () => {
      const { parent, children } = await makeParent({
        children: [
          { canPayMore: true, maxPrice: 5000, unitPrice: 1000 },
          { canPayMore: true, maxPrice: 5000, unitPrice: 1000 },
          { unitPrice: 1000 },
        ],
      });
      const [childA, childB, fixedChild] = [
        children[0]!,
        children[1]!,
        children[2]!,
      ];

      const html = await bookingPageHtml(parent.slug);
      assertStringIncludes(
        html,
        `<fieldset class="child-selector" data-parent-id="${parent.id}">`,
      );
      assertStringIncludes(
        html,
        `name="child_price_${parent.id}_${childA.id}"`,
      );
      assertStringIncludes(
        html,
        `name="child_price_${parent.id}_${childB.id}"`,
      );
      assertStringIncludes(
        html,
        `name="child_qty_${parent.id}_${fixedChild.id}"`,
      );
      assert(
        !html.includes(`name="child_price_${parent.id}_${fixedChild.id}"`),
      );
      assertStringIncludes(
        html,
        `data-child-qty="${fixedChild.id}"><option value="0" selected>0</option><option value="1">1</option></select> Child 3 (£10)</label></fieldset>`,
      );
      expect(html).not.toMatch(
        new RegExp(
          `name="child_price_${parent.id}_${childA.id}"[^>]*\\srequired`,
        ),
      );
      expect(html).not.toMatch(
        new RegExp(
          `name="child_price_${parent.id}_${childB.id}"[^>]*\\srequired`,
        ),
      );
    });

    test("only the active child is selectable", async () => {
      const { parent, children } = await makeParent({
        children: [{}, { canPayMore: true, maxPrice: 5000 }],
      });
      const [liveChild, deadChild] = [children[0]!, children[1]!];
      await deactivateTestListing(deadChild.id);

      const html = await bookingPageHtml(parent.slug);
      assert(!html.includes(`name="child_qty_${parent.id}_${liveChild.id}"`));
      assertStringIncludes(html, `data-sole-child="${liveChild.id}"`);
      expect(html).toMatch(
        new RegExp(
          `<select name="child_qty_${parent.id}_${deadChild.id}"[^>]*\\sdisabled`,
        ),
      );
      assert(!html.includes(`name="child_price_${parent.id}_${deadChild.id}"`));
      assertStringIncludes(
        html,
        `<select name="child_qty_${parent.id}_${deadChild.id}" disabled><option value="0" selected>0</option></select> Child 2 (unavailable)</label></fieldset>`,
      );
    });

    test("a multi-child selector uses the effective maximum and generic guidance", async () => {
      const { parent, children } = await makeParent({
        children: [{ maxQuantity: 2 }, { maxQuantity: 2 }],
        parent: { maxQuantity: 2 },
      });
      const [childA, childB] = [children[0]!, children[1]!];

      const html = await bookingPageHtml(parent.slug);
      assertStringIncludes(
        html,
        `<select name="child_qty_${parent.id}_${childA.id}"`,
      );
      assertStringIncludes(
        html,
        `<select name="child_qty_${parent.id}_${childB.id}"`,
      );
      const optionsA = await selectOptionsHtml(
        parent.slug,
        `child_qty_${parent.id}_${childA.id}`,
      );
      assertStringIncludes(optionsA, 'value="2"');
      assert(!optionsA.includes('value="3"'));
      assertStringIncludes(
        html,
        "Choose add-ons to match your ticket quantity",
      );
      assert(!html.includes("Choose 2 add-ons in total"));
      assertStringIncludes(
        html,
        `<p class="child-total-note" data-child-total="${parent.id}">Choose add-ons to match your ticket quantity. <span class="child-total-hint" data-child-hint="${parent.id}"></span></p>`,
      );
      assertStringIncludes(
        html,
        "<legend>Choose an option for Parent</legend>",
      );
    });

    test("a sole pay-more child renders its price input", async () => {
      const { parent, child } = await makeParent({
        children: [{ canPayMore: true, maxPrice: 5000, unitPrice: 1000 }],
      });

      const html = await bookingPageHtml(parent.slug);
      assert(!html.includes(`name="child_qty_${parent.id}_${child.id}"`));
      assertStringIncludes(html, `name="child_price_${parent.id}_${child.id}"`);
    });

    test("a sole free child is informational", async () => {
      const { parent, child } = await makeParent({
        children: [{ maxQuantity: 5, name: "Add-on" }],
        parent: { maxQuantity: 5 },
      });

      const html = await bookingPageHtml(parent.slug);
      assert(!html.includes(`name="child_qty_${parent.id}_${child.id}"`));
      assertStringIncludes(html, `data-sole-child="${child.id}"`);
      // An ordinary sole child shows its name alone — no plan term.
      assertStringIncludes(
        html,
        `<p class="child-option child-sole" data-sole-parent="${parent.id}" data-sole-child="${child.id}">Add-on</p>`,
      );
      assertStringIncludes(
        html,
        `<fieldset class="child-selector" data-parent-id="${parent.id}"><p class="child-option child-sole"`,
      );
      assertStringIncludes(html, "Add-on");
      assert(!html.includes("Includes"));
      assert(!html.includes("one per booking"));
      assert(!html.includes("Choose an option for"));
      assert(!html.includes("Choose add-ons to match your ticket quantity"));
      assert(!html.includes("(£0"));
    });

    test("a sole paid child shows its name and price", async () => {
      const { parent, child } = await makeParent({
        children: [{ name: "Paid add-on", unitPrice: 1000 }],
      });

      const html = await bookingPageHtml(parent.slug);
      assertStringIncludes(html, `data-sole-child="${child.id}"`);
      assertStringIncludes(html, "Paid add-on");
      assertStringIncludes(html, "(£10");
      assert(!html.includes("Includes"));
      assert(!html.includes("one per booking"));
      assert(!html.includes("Choose an option for"));
    });

    test("a sole hidden child keeps its markers without showing its name", async () => {
      const { parent, child } = await makeHiddenSoleChild();

      const html = await renderHidingChildName(parent, child);
      assertStringIncludes(
        html,
        `<p class="child-option child-sole" data-sole-parent="${parent.id}" data-sole-child="${child.id}"></p><label>Price per ticket`,
      );
      assertStringIncludes(html, "</label></fieldset>");
      assert(!html.includes("Includes"));
      assert(!html.includes("Choose an option for"));
    });

    test("a visible sole child shows its selected attributes", async () => {
      const { parent, child } = await makeParent({
        children: [{ name: "Visible add-on", unitPrice: 1000 }],
      });
      await giveAdultsAudience(child.id);

      const html = await bookingPageHtml(parent.slug);
      assertStringIncludes(html, `data-sole-child="${child.id}"`);
      assertStringIncludes(html, "listing-attributes");
      assertStringIncludes(html, "Audience");
      assertStringIncludes(html, "Adults");
    });

    test("a hidden sole child does not show its attributes", async () => {
      const { parent, child } = await makeHiddenSoleChild();
      await giveAdultsAudience(child.id);

      const html = await renderHidingChildName(parent, child);
      assert(!html.includes("Audience"));
      assert(!html.includes("Adults"));
    });

    test("an all-free multi-child selector hides every price", async () => {
      const { parent, children } = await makeParent({
        children: [
          { name: "Free A", unitPrice: 0 },
          { name: "Free B", unitPrice: 0 },
        ],
      });
      const [childA, childB] = [children[0]!, children[1]!];

      const html = await bookingPageHtml(parent.slug);
      assertStringIncludes(html, "Choose an option for Parent");
      assertStringIncludes(html, "Free A");
      assertStringIncludes(html, "Free B");
      assertStringIncludes(html, `name="child_qty_${parent.id}_${childA.id}"`);
      assertStringIncludes(html, `name="child_qty_${parent.id}_${childB.id}"`);
      assertStringIncludes(
        html,
        `Free A</label><label class="child-option"><select name="child_qty_${parent.id}_${childB.id}"`,
      );
      assert(!html.includes("(£0"));
    });

    test("a mixed-price selector shows every price", async () => {
      const { parent } = await makeParent({
        children: [
          { name: "Free A", unitPrice: 0 },
          { name: "Paid B", unitPrice: 1000 },
        ],
      });

      const html = await bookingPageHtml(parent.slug);
      assertStringIncludes(html, "Choose an option for Parent");
      assertStringIncludes(html, "Free A");
      assertStringIncludes(html, "Paid B");
      assertStringIncludes(html, "(£0");
      assertStringIncludes(html, "(£10");
    });
  },
);
