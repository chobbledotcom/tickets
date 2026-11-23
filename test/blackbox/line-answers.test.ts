/** A free-text question that asks once for each listing. The owner adds it on
 * the questions page. A buyer who books two listings gives one answer for
 * each. The owner reads each answer, with its listing, on the attendee's page.
 * A paid order carries the answers through the sealed order, not through
 * Stripe. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { requireValue } from "#shared/required-value.ts";
import { deliverPayment, openCardShop } from "#test/blackbox/card-shop.ts";
import {
  addDiscos,
  addQuestion,
  attendeeIds,
  attendeePage,
  book,
  fieldFor,
  openDiscos,
  textOf,
} from "#test/blackbox/discos.ts";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import type { FakeStripe } from "#test/blackbox/fake-stripe.ts";
import { addBooking } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const HEADING = t("attendee_detail.line_answers");

describeWithEnv(
  "a question that asks once for each listing",
  { db: true },
  () => {
    let fake: FakeStripe | undefined;
    afterEach(async () => {
      await fake?.close();
      fake = undefined;
    });

    test("the booking page shows one field for each listing", async () => {
      const discos = await openDiscos();
      const question = await addQuestion(discos.owner, "Pupil name", "listing");

      const page = await createApp(inProcess).get(
        `/ticket/${discos.discoA.slug}+${discos.discoB.slug}`,
      );

      expect(page.html).toContain(
        `name="${fieldFor(question, discos.discoA)}"`,
      );
      expect(page.html).toContain(
        `name="${fieldFor(question, discos.discoB)}"`,
      );
      expect(page.html).not.toContain(`name="question${question}"`);
    });

    test("a free order keeps one answer for each listing, and the attendee page shows each with its listing", async () => {
      const discos = await openDiscos();
      const question = await addQuestion(discos.owner, "Pupil name", "listing");

      const booked = await book(discos, [2, 2], {
        [fieldFor(question, discos.discoA)]: "Ava",
        [fieldFor(question, discos.discoB)]: "Ben",
      });

      expect(booked.status).toBe(302);
      expect(await attendeePage(discos)).toContain(
        `${HEADING} Pupil name (Disco A) Ava Pupil name (Disco B) Ben`,
      );
    });

    test("a missing answer for a booked listing stops the order and names the listing", async () => {
      const discos = await openDiscos();
      const question = await addQuestion(discos.owner, "Pupil name", "listing");

      const buyer = createApp(inProcess);
      const refused = await book(
        discos,
        [1, 1],
        { [fieldFor(question, discos.discoA)]: "Ava" },
        buyer,
      );
      const shown = await buyer.get(refused.location ?? "");

      expect(textOf(shown.html)).toContain(
        "Please answer: Pupil name (Disco B)",
      );
      expect(await attendeeIds(discos.api, discos.discoA)).toEqual([]);
      expect(await attendeeIds(discos.api, discos.discoB)).toEqual([]);
    });

    test("a listing that the order does not book needs no answer, and an answer typed for it is not kept", async () => {
      const discos = await openDiscos();
      const question = await addQuestion(discos.owner, "Pupil name", "listing");

      const booked = await book(discos, [1, 0], {
        [fieldFor(question, discos.discoA)]: "Ava",
        [fieldFor(question, discos.discoB)]: "Ben",
      });

      expect(booked.status).toBe(302);
      const page = await attendeePage(discos);
      expect(page).toContain(`${HEADING} Pupil name (Disco A) Ava`);
      expect(page).not.toContain("Ben");
    });

    test("a paid order keeps the answers out of Stripe, and the webhook files each against its listing", async () => {
      const shop = await openCardShop();
      fake = shop.fake;
      const discos = await addDiscos(shop.owner, shop.api, 500);
      const question = await addQuestion(discos.owner, "Pupil name", "listing");

      const sent = await book(discos, [2, 2], {
        [fieldFor(question, discos.discoA)]: "Ava",
        [fieldFor(question, discos.discoB)]: "Ben",
      });
      const checkout = requireValue(
        shop.fake.checkouts.at(-1),
        "The app opened no checkout",
      );

      expect(sent.location).toMatch(/^https:\/\/checkout\.stripe\.test\//);
      expect(checkout.amountTotal).toBe(2000);
      expect(JSON.stringify(checkout.metadata)).not.toMatch(/Ava|Ben/);
      expect(await attendeeIds(discos.api, discos.discoA)).toEqual([]);

      expect((await deliverPayment(shop, checkout)).status).toBe(200);

      expect(await attendeePage(discos)).toContain(
        `${HEADING} Pupil name (Disco A) Ava Pupil name (Disco B) Ben`,
      );
    });

    test("a choice question asks once for the booking, whatever level the form sends", async () => {
      const { api, owner } = await openDiscos();

      const added = await owner.submit("/admin/questions", {
        answerLevel: "listing",
        displayType: "radio",
        text: "Size",
      });
      const id = added.location?.match(/\/admin\/questions\/(\d+)/)?.[1];
      const row = await api.get(`/api/admin/questions/${id}`);

      expect(row.body).toMatchObject({
        question: { answer_level: "booking", display_type: "radio" },
      });
    });

    test("an attendee with no answer for a listing has no such section", async () => {
      const discos = await openDiscos();
      await addBooking(discos.api, discos.discoA, { name: "Walk In" });

      expect(await attendeePage(discos)).not.toContain(HEADING);
    });

    test("the edit form of an attendee offers no field for a question that asks once for each listing", async () => {
      const discos = await openDiscos();
      const pupil = await addQuestion(discos.owner, "Pupil name", "listing");
      const note = await addQuestion(discos.owner, "Note", "booking");
      await book(discos, [1, 0], {
        [fieldFor(pupil, discos.discoA)]: "Ava",
        [`question${note}`]: "Nut allergy",
      });
      const [id] = await attendeeIds(discos.api, discos.discoA);

      const form = await discos.owner.get(
        `/admin/attendees/${requireValue(id, "Disco A has no booking")}/edit`,
      );

      expect(form.html).toContain(`name="question${note}"`);
      expect(form.html).not.toContain(`name="question${pupil}`);
    });
  },
);
