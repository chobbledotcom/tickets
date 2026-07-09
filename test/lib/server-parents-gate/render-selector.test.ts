// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  bookingPageHtml,
  childField,
  deactivateTestListing,
  describeWithEnv,
  followRedirectWithFlash,
  makeParent,
  makeTwoDefaultChildren,
  parentField,
  submitMultiTicketForm,
} from "#test-utils";
import { selectOptionsFromHtml, selectOptionsHtml } from "./helpers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > render: selector & price visibility",
  { db: true, triggers: true },
  () => {
    test("a rejected multi-child submission re-fills the chosen child", async () => {
      await settings.update.terms("You must accept the rules.");
      const { parent, childA, childB } = await makeTwoDefaultChildren({
        maxQuantity: 5,
      });

      // Choose 1 of childB with valid contact, but don't agree to terms →
      // rejected with the form stashed; the follow-up GET must re-fill childB's
      // chosen quantity (its select restores option 1 as selected). childA is
      // submitted with a garbage value, which the re-render restores as 0.
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
      // childB's per-unit select restores quantity 1; childA's garbage value
      // restores as 0 (the parsed-fallback branch).
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

    test("a parent's pay-more children render non-required price inputs", async () => {
      // The no-JS baseline emits a price input for EVERY pay-more child of a
      // parent; none may be HTML-required or the browser blocks submit demanding
      // a price for an unselected child.
      // A bookable but NON-pay-more sibling must get no price input at all.
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
      // The child block is wrapped in its labelled fieldset (a broken string
      // concatenation would emit "NaN" in place of the opening tag).
      expect(html).toContain(
        `<fieldset class="child-selector" data-parent-id="${parent.id}">`,
      );
      // Both pay-more child price inputs are present but neither is HTML-required.
      expect(html).toContain(`name="child_price_${parent.id}_${childA.id}"`);
      expect(html).toContain(`name="child_price_${parent.id}_${childB.id}"`);
      // The non-pay-more bookable child renders its per-unit quantity select but
      // NO price input (the pay-more input is gated on the child's own
      // can_pay_more, not merely its bookability).
      expect(html).toContain(`name="child_qty_${parent.id}_${fixedChild.id}"`);
      expect(html).not.toContain(
        `name="child_price_${parent.id}_${fixedChild.id}"`,
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

    test("only the active child is selectable; the inactive one renders disabled", async () => {
      // The render must mirror the server's active check: an inactive child is
      // rendered as a disabled (fixed-0) quantity control and never selectable,
      // leaving the lone active child as the sole bookable option — which, being
      // the only bookable child, renders informational (auto-filled by the fold)
      // and posts NO quantity field of its own.
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const [liveChild, deadChild] = [children[0]!, children[1]!];
      await deactivateTestListing(deadChild.id);

      const html = await bookingPageHtml(parent.slug);
      // The active child is the sole bookable option, so it is informational and
      // posts no `child_qty_*` field (the fold auto-fills it to the parent qty).
      expect(html).not.toContain(
        `name="child_qty_${parent.id}_${liveChild.id}"`,
      );
      expect(html).toContain(`data-sole-child="${liveChild.id}"`);
      // The inactive child renders a disabled select fixed at 0 and is never
      // a selectable quantity control.
      expect(html).toMatch(
        new RegExp(
          `<select name="child_qty_${parent.id}_${deadChild.id}"[^>]*\\sdisabled`,
        ),
      );
    });

    test("a multi-child parent renders a per-unit quantity select and a 'choose N in total' note", async () => {
      // Each bookable child gets its own quantity select (0..cap), and a note
      // tells the buyer how many add-ons to choose in total (the parent's max).
      const { parent, children } = await makeParent({
        children: [{ maxQuantity: 2 }, { maxQuantity: 2 }],
        parent: { maxQuantity: 2 },
      });
      const [childA, childB] = [children[0]!, children[1]!];

      const html = await bookingPageHtml(parent.slug);
      // Both children get a per-unit quantity select; neither is forced/hidden.
      expect(html).toContain(
        `<select name="child_qty_${parent.id}_${childA.id}"`,
      );
      expect(html).toContain(
        `<select name="child_qty_${parent.id}_${childB.id}"`,
      );
      // The select offers 0..2 (the parent's effective max).
      const optionsA = await selectOptionsHtml(
        parent.slug,
        `child_qty_${parent.id}_${childA.id}`,
      );
      expect(optionsA).toContain('value="2"');
      expect(optionsA).not.toContain('value="3"');
      // The "choose N in total" note names the parent's quantity (2).
      expect(html).toContain("Choose 2 add-ons in total");
    });

    test("a sole pay-more child auto-fills and still renders its price input", async () => {
      // The single-bookable-child path is informational (no quantity field)
      // but still renders a pay-more child's non-required price input so a buyer
      // can name a price without choosing.
      const { parent, child } = await makeParent({
        children: [{ canPayMore: true, maxPrice: 5000, unitPrice: 1000 }],
      });

      const html = await bookingPageHtml(parent.slug);
      // No `child_qty_*` is posted for the sole child (the fold auto-fills it).
      expect(html).not.toContain(`name="child_qty_${parent.id}_${child.id}"`);
      // The pay-more price input is still rendered.
      expect(html).toContain(`name="child_price_${parent.id}_${child.id}"`);
    });

    test("a sole bookable child renders informational with no submitted quantity field", async () => {
      // A sole bookable child must NOT post a fixed quantity (it would over-submit
      // when the parent qty is below the child's cap and the fold would reject it
      // as 'too many'). It renders informational; the fold auto-fills Q.
      const { parent, child } = await makeParent({
        children: [{ maxQuantity: 5, name: "Add-on" }],
        parent: { maxQuantity: 5 },
      });

      const html = await bookingPageHtml(parent.slug);
      // No quantity field of any kind (hidden or select) is emitted for the sole
      // child, so nothing is posted for it and the fold's auto-fill assigns Q.
      expect(html).not.toContain(`name="child_qty_${parent.id}_${child.id}"`);
      // It is shown informationally instead: its name renders (just the name — no
      // "Includes … — one per booking" framing) with no "choose an option" legend.
      expect(html).toContain(`data-sole-child="${child.id}"`);
      expect(html).toContain("Add-on");
      expect(html).not.toContain("Includes");
      expect(html).not.toContain("one per booking");
      expect(html).not.toContain("Choose an option for");
      // A free sole child (unit_price 0) shows no "(£0)" price either.
      expect(html).not.toContain("(£0");
    });

    test("a sole paid child shows just its name and price, with no legend", async () => {
      // The buyer makes no choice for a sole child, so the "Choose an option for
      // {parent}" legend is suppressed and the child shows only its name plus its
      // (non-zero) price — never the old "Includes … — one per booking" framing.
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

    test("a sole hidden child renders no name or price label but keeps its markers and price input", async () => {
      // A hidden listing the operator has chosen not to surface publicly: the
      // auto-selected sole child still folds in, so its data
      // marker and pay-more price input stay in the DOM for the fold/compat
      // scripts — but nothing identifying (name or price label) is shown.
      const { parent, child } = await makeParent({
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

      const html = await bookingPageHtml(parent.slug);
      // Functional markers + price input remain so the fold and client scripts
      // still drive off them.
      expect(html).toContain(`data-sole-child="${child.id}"`);
      expect(html).toContain(`name="child_price_${parent.id}_${child.id}"`);
      // Nothing visible identifies the hidden child.
      expect(html).not.toContain("Hidden add-on");
      expect(html).not.toContain("Includes");
      expect(html).not.toContain("Choose an option for");
    });

    test("a multi-child selector hides every price when all bookable children are free", async () => {
      // When every option is £0 there is nothing to compare, so every price label
      // is dropped — but the legend and the per-child quantity selects remain (a
      // genuine choice still exists).
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
      expect(html).not.toContain("(£0");
    });

    test("a multi-child selector shows every price (including £0) when one sibling is paid", async () => {
      // One paid sibling among free children keeps all prices visible — including
      // the £0 one — so the buyer can compare the free option against the paid one.
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
      // The free sibling's £0 price is shown alongside the paid one's £10.
      expect(html).toContain("(£0");
      expect(html).toContain("(£10");
    });

    test("a Square free parent with a paid child renders a present-but-non-required email", async () => {
      // Square requires an email for paid orders, but the page itself is free
      // (only a POSSIBLE child is paid); the email field must be present so a
      // buyer who picks the paid child can fill it, yet non-required so picking
      // the free child / leaving the parent at zero doesn't block submit.
      // Server-side validation enforces it when the folded order is paid.
      await settings.update.paymentProvider("square");
      try {
        const { parent } = await makeParent({
          children: [{ unitPrice: 0 }, { unitPrice: 1500 }],
          parent: { fields: "" },
        });

        const html = await bookingPageHtml(parent.slug);
        expect(html).toContain('name="email"');
        expect(html).not.toMatch(/name="email"[^>]*\srequired/);
      } finally {
        await settings.update.setPaymentProviderNone();
      }
    });

    test("a child's stricter contact field is rendered (non-required) on the parent page", async () => {
      // Parent collects only email; the child also requires phone. The buyer must
      // SEE the phone field to fill it, but it renders non-required (server-side
      // validation is authoritative for the selected child).
      const { parent } = await makeParent({
        children: [{ fields: "email,phone" }],
        parent: { fields: "email" },
      });

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain('name="phone"');
      // The child-only field is present but not HTML-required.
      expect(html).not.toMatch(/name="phone"[^>]*\srequired/);
    });
  },
);
