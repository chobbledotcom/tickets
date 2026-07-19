// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import type { Listing } from "#shared/types.ts";
import { renderChildBlock } from "#templates/public/reservations/child-block.ts";
import { ticketListing } from "#test/templates/public/helpers.ts";
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
} from "../../../../lib/server-parents-gate/helpers.ts";

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
  expect(html).toContain(`data-sole-child="${child.id}"`);
  expect(html).toContain(`name="child_price_${parent.id}_${child.id}"`);
  expect(html).not.toContain("Hidden add-on");
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
      expect(optionsB).toContain('value="1" selected');
      const optionsA = selectOptionsFromHtml(
        html,
        `child_qty_${parent.id}_${childA.id}`,
      );
      expect(optionsA).toContain('value="0" selected');
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
      expect(html).toContain(
        `<fieldset class="child-selector" data-parent-id="${parent.id}">`,
      );
      expect(html).toContain(`name="child_price_${parent.id}_${childA.id}"`);
      expect(html).toContain(`name="child_price_${parent.id}_${childB.id}"`);
      expect(html).toContain(`name="child_qty_${parent.id}_${fixedChild.id}"`);
      expect(html).not.toContain(
        `name="child_price_${parent.id}_${fixedChild.id}"`,
      );
      expect(html).toContain(
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
      expect(html).not.toContain(
        `name="child_qty_${parent.id}_${liveChild.id}"`,
      );
      expect(html).toContain(`data-sole-child="${liveChild.id}"`);
      expect(html).toMatch(
        new RegExp(
          `<select name="child_qty_${parent.id}_${deadChild.id}"[^>]*\\sdisabled`,
        ),
      );
      expect(html).not.toContain(
        `name="child_price_${parent.id}_${deadChild.id}"`,
      );
      expect(html).toContain(
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
      expect(html).toContain(
        `<select name="child_qty_${parent.id}_${childA.id}"`,
      );
      expect(html).toContain(
        `<select name="child_qty_${parent.id}_${childB.id}"`,
      );
      const optionsA = await selectOptionsHtml(
        parent.slug,
        `child_qty_${parent.id}_${childA.id}`,
      );
      expect(optionsA).toContain('value="2"');
      expect(optionsA).not.toContain('value="3"');
      expect(html).toContain("Choose add-ons to match your ticket quantity");
      expect(html).not.toContain("Choose 2 add-ons in total");
      expect(html).toContain(
        `<p class="child-total-note" data-child-total="${parent.id}">Choose add-ons to match your ticket quantity. <span class="child-total-hint" data-child-hint="${parent.id}"></span></p>`,
      );
      expect(html).toContain("<legend>Choose an option for Parent</legend>");
    });

    test("a sole pay-more child renders its price input", async () => {
      const { parent, child } = await makeParent({
        children: [{ canPayMore: true, maxPrice: 5000, unitPrice: 1000 }],
      });

      const html = await bookingPageHtml(parent.slug);
      expect(html).not.toContain(`name="child_qty_${parent.id}_${child.id}"`);
      expect(html).toContain(`name="child_price_${parent.id}_${child.id}"`);
    });

    test("a sole free child is informational", async () => {
      const { parent, child } = await makeParent({
        children: [{ maxQuantity: 5, name: "Add-on" }],
        parent: { maxQuantity: 5 },
      });

      const html = await bookingPageHtml(parent.slug);
      expect(html).not.toContain(`name="child_qty_${parent.id}_${child.id}"`);
      expect(html).toContain(`data-sole-child="${child.id}"`);
      expect(html).toContain(
        `<p class="child-option child-sole" data-sole-parent="${parent.id}" data-sole-child="${child.id}">Add-on</p>`,
      );
      expect(html).toContain(
        `<fieldset class="child-selector" data-parent-id="${parent.id}"><p class="child-option child-sole"`,
      );
      expect(html).toContain("Add-on");
      expect(html).not.toContain("Includes");
      expect(html).not.toContain("one per booking");
      expect(html).not.toContain("Choose an option for");
      expect(html).not.toContain(
        "Choose add-ons to match your ticket quantity",
      );
      expect(html).not.toContain("(£0");
    });

    test("a sole paid child shows its name and price", async () => {
      const { parent, child } = await makeParent({
        children: [{ name: "Paid add-on", unitPrice: 1000 }],
      });

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain(`data-sole-child="${child.id}"`);
      expect(html).toContain("Paid add-on");
      expect(html).toContain("(£10");
      expect(html).not.toContain("Includes");
      expect(html).not.toContain("one per booking");
      expect(html).not.toContain("Choose an option for");
    });

    test("a sole hidden child keeps its markers without showing its name", async () => {
      const { parent, child } = await makeHiddenSoleChild();

      const html = await renderHidingChildName(parent, child);
      expect(html).toContain(
        `<p class="child-option child-sole" data-sole-parent="${parent.id}" data-sole-child="${child.id}"></p><label>Price per ticket`,
      );
      expect(html).toContain("</label></fieldset>");
      expect(html).not.toContain("Includes");
      expect(html).not.toContain("Choose an option for");
    });

    test("a visible sole child shows its selected attributes", async () => {
      const { parent, child } = await makeParent({
        children: [{ name: "Visible add-on", unitPrice: 1000 }],
      });
      await giveAdultsAudience(child.id);

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain(`data-sole-child="${child.id}"`);
      expect(html).toContain("listing-attributes");
      expect(html).toContain("Audience");
      expect(html).toContain("Adults");
    });

    test("a hidden sole child does not show its attributes", async () => {
      const { parent, child } = await makeHiddenSoleChild();
      await giveAdultsAudience(child.id);

      const html = await renderHidingChildName(parent, child);
      expect(html).not.toContain("Audience");
      expect(html).not.toContain("Adults");
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
      expect(html).toContain("Choose an option for Parent");
      expect(html).toContain("Free A");
      expect(html).toContain("Free B");
      expect(html).toContain(`name="child_qty_${parent.id}_${childA.id}"`);
      expect(html).toContain(`name="child_qty_${parent.id}_${childB.id}"`);
      expect(html).toContain(
        `Free A</label><label class="child-option"><select name="child_qty_${parent.id}_${childB.id}"`,
      );
      expect(html).not.toContain("(£0");
    });

    test("a mixed-price selector shows every price", async () => {
      const { parent } = await makeParent({
        children: [
          { name: "Free A", unitPrice: 0 },
          { name: "Paid B", unitPrice: 1000 },
        ],
      });

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain("Choose an option for Parent");
      expect(html).toContain("Free A");
      expect(html).toContain("Paid B");
      expect(html).toContain("(£0");
      expect(html).toContain("(£10");
    });
  },
);
