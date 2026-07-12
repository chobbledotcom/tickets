// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getAttendeeAnswersBatch } from "#shared/db/questions/attendee-answers/reads.ts";
import { listingQuestions } from "#shared/db/questions/queries.ts";
import { assignQuestion } from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { deactivateTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  bookingPageHtml,
  bookParent,
  expectNoBooking,
  expectRejectedBooking,
  expectReserved,
  makeParent,
  parentField,
} from "#test-utils/parents.ts";
import { stubCheckoutIntent } from "./helpers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > questions & thank-you URL",
  { db: true, triggers: true },
  () => {
    test("a selected child's question is parsed and saved against its line", async () => {
      const { parent, child } = await makeParent();
      const { question, answer } = await assignQuestion(
        child.id,
        "Size?",
        "Large",
      );

      // The child question renders once, non-required, in the parent page.
      const html = await bookingPageHtml(parent.slug);
      const occurrences =
        html.split(`name="question_${question.id}"`).length - 1;
      expect(occurrences).toBe(1);
      expect(html).not.toContain(`name="question_${question.id}" required`);

      const res = await bookParent(parent.slug, {
        ...parentField(parent, "1"),
        [`question_${question.id}`]: String(answer.id),
      });
      expectReserved(res);
      const childRows = await getAttendeesRaw(child.id);
      const batch = await getAttendeeAnswersBatch([childRows[0]!.id], {
        texts: false,
      });
      expect(batch.get(childRows[0]!.id)).toEqual([answer.id]);
    });

    test("a required child question missing for the selected child rejects", async () => {
      const { parent, child } = await makeParent();
      await assignQuestion(child.id, "Size?", "Large");

      const res = await bookParent(parent.slug, parentField(parent, "1"));
      await expectRejectedBooking(res, parent.id);
    });

    test("a question shared by sibling children renders once; a page question stays required", async () => {
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const [childA, childB] = [children[0]!, children[1]!];

      // A page-level question on the parent (renders required in the main block),
      // plus a question assigned to BOTH children (renders once, non-required).
      const { question: pageQ } = await assignQuestion(
        parent.id,
        "Parent question?",
        "Yes",
      );
      const { question: sharedQ } = await assignQuestion(
        childA.id,
        "Shared child question?",
        "Maybe",
      );
      await listingQuestions.setIds(childB.id, [sharedQ.id]);

      const html = await bookingPageHtml(parent.slug);
      // Page question renders required.
      expect(html).toContain(`name="question_${pageQ.id}" required`);
      // Shared child question renders exactly once and non-required.
      const sharedCount =
        html.split(`name="question_${sharedQ.id}"`).length - 1;
      expect(sharedCount).toBe(1);
      expect(html).not.toContain(`name="question_${sharedQ.id}" required`);
    });

    test("a child's all-deactivated choice question is dropped from the page", async () => {
      const { parent, child } = await makeParent();

      // The only answer is deactivated, so the question is not answerable and
      // must not render a control a buyer can't satisfy.
      const { question } = await assignQuestion(
        child.id,
        "Dead question?",
        "Inactive",
        false,
      );

      const html = await bookingPageHtml(parent.slug);
      expect(html).not.toContain(`name="question_${question.id}"`);
    });

    test("a parent's configured thank-you URL survives folding a child", async () => {
      const { parent } = await makeParent({
        parent: { thankYouUrl: "https://example.com/thanks-parent" },
      });

      const res = await bookParent(parent.slug, parentField(parent, "1"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://example.com/thanks-parent",
      );
    });

    test("a paid parent's thank-you URL is carried into the checkout intent", async () => {
      // The paid path folds a required paid child, making the order
      // multi-listing; the webhook's single-listing thank-you derivation would
      // drop the parent's URL, so it must be set explicitly on the intent.
      // Capture the intent handed to the provider and assert it.
      const { checkout, getCaptured } =
        await stubCheckoutIntent("cs_parent_paid");

      const { parent } = await makeParent({
        children: [{ maxAttendees: 50, unitPrice: 1000 }],
        parent: {
          maxAttendees: 50,
          thankYouUrl: "https://example.com/thanks-parent",
          unitPrice: 1000,
        },
      });

      try {
        const res = await bookParent(parent.slug, parentField(parent, "1"));
        expect(res.status).toBe(302);
        // The order folded the child (two distinct listings) yet still carries
        // the parent's configured thank-you URL.
        const listingIds = new Set(
          getCaptured()?.items.map((i) => i.listingId),
        );
        expect(listingIds.size).toBe(2);
        expect(getCaptured()?.thankYouUrl).toBe(
          "https://example.com/thanks-parent",
        );
      } finally {
        checkout.restore();
      }
    });

    test("an inactive child makes its parent sold out (rejected)", async () => {
      const { parent, child } = await makeParent({
        parent: { name: "Base unit" },
      });
      // Deactivating the only child leaves the parent with no bookable child.
      await deactivateTestListing(child.id);

      const res = await bookParent(parent.slug, parentField(parent, "1"));
      await expectRejectedBooking(
        res,
        parent.id,
        "Base unit has no available options right now.",
      );
    });

    test("an inactive child is skipped, leaving an active sibling to fold", async () => {
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const [dead, live] = [children[0]!, children[1]!];
      await deactivateTestListing(dead.id);

      // With the inactive child skipped, the live sibling is the sole bookable
      // child and auto-selects.
      const res = await bookParent(parent.slug, parentField(parent, "1"));
      expectReserved(res);
      expect((await getAttendeesRaw(live.id)).length).toBe(1);
      await expectNoBooking(dead);
    });
  },
);
