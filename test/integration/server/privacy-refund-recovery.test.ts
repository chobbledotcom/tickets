/** Owner-only HTTP boundary for provider refund recovery. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { queryOne } from "#shared/db/client.ts";
import {
  armRefundSend,
  markRefundCompleted,
  readRefundAuthorityState,
} from "#shared/payment/refund-authority.ts";
import { markRefundProviderConflict } from "#shared/payment/refund-authority-choice.ts";
import { refundRequestIdentityIndex } from "#shared/payment/refund-request-identity.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  chargeMoney,
  completedRefund,
  foundCharge,
} from "#test-utils/payment-state.ts";
import {
  addProviderRefundTestCase,
  readyRefundTestState,
} from "#test-utils/provider-refund-cases.ts";
import {
  adminGet,
  createTestManagerSession,
  testCookie,
} from "#test-utils/session.ts";
import {
  expectUnreadableProviderCheck,
  refundCasePath,
  returnedProviderCheck,
  submitRefundCase as submitCase,
  unreadableProviderCheck,
} from "./privacy-refund-recovery-helpers.ts";

const MISSING_CASE_PATH = refundCasePath(987_654_321);

describeWithEnv("server (provider refund recovery)", { db: true }, () => {
  testRequiresAuth(MISSING_CASE_PATH);
  testRequiresAuth(MISSING_CASE_PATH, {
    body: { choice: "provider_confirmed_returned", revision: "1" },
    method: "POST",
  });

  test("returns 403 when a manager opens a copied owner detail address", async () => {
    const cookie = await createTestManagerSession(
      "refund-case-manager-get",
      "refund-case-manager-get",
    );

    expectStatus(403)(await awaitTestRequest(MISSING_CASE_PATH, { cookie }));
  });

  test("returns 403 when a manager submits a copied owner decision", async () => {
    const cookie = await createTestManagerSession(
      "refund-case-manager-post",
      "refund-case-manager-post",
    );

    const response = await submitCase(cookie, { choice: "check_again" });
    expectStatus(403)(response);
    expect(await response.text()).not.toContain("Check the provider again");
  });

  test("returns 404 when an owner opens a case which does not exist", async () => {
    expectStatus(404)(await adminGet(MISSING_CASE_PATH));
  });

  test("returns 404 when an owner submits a case which no longer exists", async () => {
    expectStatus(404)(await submitCase(await testCookie()));
  });

  test("returns 404 when an owner checks a case which no longer exists", async () => {
    expectStatus(404)(
      await submitCase(await testCookie(), { choice: "check_again" }),
    );
  });

  test("requires one declared choice and a positive seen revision", async () => {
    await expectFlashRedirect(
      MISSING_CASE_PATH,
      "Choose exactly what the payment provider shows.",
      false,
    )(
      await submitCase(await testCookie(), {
        choice: "",
        revision: "not-a-revision",
      }),
    );
  });

  test("refuses a malformed refund queue cursor", async () => {
    expectStatus(400)(await adminGet("/admin/privacy?refund_after=20"));
  });

  test("checks one active case through the canonical provider engine", async () => {
    const reference = "owner-check-again-reference";
    const id = await addProviderRefundTestCase(
      reference,
      armRefundSend(
        readyRefundTestState("owner-check-again-request"),
        11,
        Date.now() + 60_000,
      ),
    );
    using provider = returnedProviderCheck(
      "Checking returned money must not send a refund",
    );

    await expectFlashRedirect(
      refundCasePath(id),
      "Checked the payment provider again.",
    )(await submitCase(await testCookie(), { choice: "check_again" }, id));

    expect(provider.read.calls).toHaveLength(1);
    expect(provider.read.calls[0]!.args).toEqual([reference]);
    expect(provider.send.calls).toHaveLength(0);
    const row = await queryOne<{ refund_state: string }>(
      "SELECT refund_state FROM payment_charges WHERE id = ?",
      [id],
    );
    expect(
      readRefundAuthorityState(row!.refund_state, "checked case"),
    ).toMatchObject({ kind: "completed", local: { kind: "due" } });
    const messages = (await getAllActivityLog()).map(({ message }) => message);
    expect(messages).toContain(
      `Refund recovery ${id}: owner asked the site to check the provider again`,
    );
    expect(messages.join(" ")).not.toContain(reference);
  });

  test("says no refund was sent when an active provider check is unreadable", async () => {
    const id = await addProviderRefundTestCase(
      "owner-unreadable-active-reference",
      armRefundSend(
        readyRefundTestState("owner-unreadable-active-request"),
        11,
        Date.now() + 60_000,
      ),
    );
    using provider = unreadableProviderCheck(
      "An unreadable check must not send a refund",
    );

    await expectUnreadableProviderCheck(
      id,
      provider,
      "The provider could not supply trustworthy payment evidence. No refund was sent, and this work remains protected.",
      `Refund recovery ${id}: provider evidence was unreadable; no refund was sent`,
    );
  });

  test("turns a persistently unreadable ready refund into a required choice", async () => {
    const id = await addProviderRefundTestCase(
      "owner-unreadable-ready-reference",
      readyRefundTestState("owner-unreadable-ready-request"),
    );
    using provider = unreadableProviderCheck(
      "Unreadable ready work must not send a refund",
    );

    await expectUnreadableProviderCheck(
      id,
      provider,
      "The provider could not settle what happened. No refund was sent; check the payment there and make the required choice.",
      `Refund recovery ${id}: provider evidence opened a required owner choice; no refund was sent`,
    );
    const row = await queryOne<{ refund_state: string }>(
      "SELECT refund_state FROM payment_charges WHERE id = ?",
      [id],
    );
    expect(
      readRefundAuthorityState(row!.refund_state, "unreadable ready case"),
    ).toMatchObject({
      kind: "needs_owner_choice",
      reason: "provider_unreadable",
    });
  });

  test("a ready intent is reachable and sends only through the canonical engine", async () => {
    const reference = "owner-ready-reference";
    const identity = await refundRequestIdentityIndex(
      { kind: "tagged", provider: "sumup", reference },
      1,
    );
    const id = await addProviderRefundTestCase(
      reference,
      readyRefundTestState(identity),
    );
    using read = stub(sumupPaymentProvider, "readCharge", () =>
      Promise.resolve(foundCharge(chargeMoney(2_500))),
    );
    using send = stub(sumupPaymentProvider, "refundCharge", (request) =>
      Promise.resolve(completedRefund(request.charge)),
    );

    const detail = await adminGet(refundCasePath(id));
    const detailHtml = await detail.text();
    expect(detailHtml).toContain("Send this refund");
    expect(detailHtml).toContain('button class="danger"');
    expect(detailHtml).not.toContain("Check the provider again");
    await expectFlashRedirect(
      refundCasePath(id),
      "Continued the ready refund safely.",
    )(await submitCase(await testCookie(), { choice: "check_again" }, id));

    expect(read.calls).toHaveLength(1);
    expect(send.calls).toHaveLength(1);
    const row = await queryOne<{ refund_state: string }>(
      "SELECT refund_state FROM payment_charges WHERE id = ?",
      [id],
    );
    expect(
      readRefundAuthorityState(row!.refund_state, "ready owner case"),
    ).toMatchObject({ kind: "completed", local: { kind: "due" } });
    expect((await getAllActivityLog()).map(({ message }) => message)).toContain(
      `Refund recovery ${id}: owner authorized the ready refund to continue`,
    );
  });

  test("rechecks inconclusive provider-conflict evidence without sending", async () => {
    const reference = "owner-waiting-conflict-reference";
    const id = await addProviderRefundTestCase(
      reference,
      markRefundProviderConflict(
        readyRefundTestState("owner-waiting-conflict-request"),
        12,
        {
          captured: { amount: 2_500, currency: "GBP" },
          kind: "wait",
          refunded: { amount: 100, currency: "GBP" },
        },
      ),
    );
    using provider = returnedProviderCheck(
      "Rechecking a conflict must not send a refund",
    );

    const detail = await adminGet(refundCasePath(id));
    expect(await detail.text()).toContain("Check the provider again");
    await expectFlashRedirect(
      refundCasePath(id),
      "The provider could not settle what happened. No refund was sent; check the payment there and make the required choice.",
      false,
    )(await submitCase(await testCookie(), { choice: "check_again" }, id));

    expect(provider.read.calls).toHaveLength(1);
    expect(provider.send.calls).toHaveLength(0);
    const row = await queryOne<{ refund_state: string }>(
      "SELECT refund_state FROM payment_charges WHERE id = ?",
      [id],
    );
    expect(
      readRefundAuthorityState(row!.refund_state, "rechecked conflict"),
    ).toMatchObject({
      decision: { kind: "returned" },
      kind: "needs_owner_choice",
      reason: "provider_conflict",
    });
    const returnedChoice = await adminGet(refundCasePath(id));
    const returnedChoiceHtml = await returnedChoice.text();
    expect(returnedChoiceHtml).toContain('value="provider_confirmed_returned"');
    expect(returnedChoiceHtml).not.toContain(
      'value="provider_confirmed_not_sent"',
    );
  });

  test("refuses check-again outside an active provider check", async () => {
    const ownerChoice = await addProviderRefundTestCase("owner-choice-check");
    const completed = await addProviderRefundTestCase(
      "completed-check",
      markRefundCompleted(
        readyRefundTestState("completed-check-request"),
        30,
        "provider",
      ),
    );

    for (const id of [ownerChoice, completed]) {
      await expectFlashRedirect(
        refundCasePath(id),
        "This refund changed while you were checking it. Read the current details and choose again.",
        false,
      )(await submitCase(await testCookie(), { choice: "check_again" }, id));
    }
  });

  test("refuses an owner decision made from a stale case revision", async () => {
    const id = await addProviderRefundTestCase("stale-owner-decision");

    await expectFlashRedirect(
      refundCasePath(id),
      "This refund changed while you were checking it. Read the current details and choose again.",
      false,
    )(await submitCase(await testCookie(), { revision: "99" }, id));
    const row = await queryOne<{ refund_revision: number }>(
      "SELECT refund_revision FROM payment_charges WHERE id = ?",
      [id],
    );
    expect(row?.refund_revision).toBe(1);
  });

  test("lets the owner complete the real returned-money journey without leaking the reference", async () => {
    const reference = "owner-only-provider-reference";
    const id = await addProviderRefundTestCase(reference);

    const queue = await adminGet("/admin/privacy");
    const queueHtml = await queue.text();
    expect(queue.status).toBe(200);
    expect(queueHtml).toContain(`Open refund ${id}`);
    expect(queueHtml).not.toContain(reference);

    const detail = await adminGet(refundCasePath(id));
    const detailHtml = await detail.text();
    expect(detail.status).toBe(200);
    expect(detailHtml).toContain(reference);
    expect(detailHtml).toContain(
      "The provider confirms that the money was returned",
    );
    expect(detailHtml).not.toContain("checked");

    await expectFlashRedirect(
      "/admin/privacy",
      "Saved the provider decision.",
    )(await submitCase(await testCookie(), {}, id));
    const due = await queryOne<{
      refund_revision: number;
      refund_state: string;
    }>(
      `SELECT refund_revision, refund_state
         FROM payment_charges
        WHERE id = ?`,
      [id],
    );
    expect(due?.refund_revision).toBe(2);
    expect(
      readRefundAuthorityState(due!.refund_state, "route result"),
    ).toMatchObject({ kind: "completed", local: { kind: "due" } });

    const recording = await adminGet(refundCasePath(id));
    expect(await recording.text()).toContain(
      "I confirm that this returned money is now recorded in Money.",
    );
    await expectFlashRedirect(
      "/admin/privacy",
      "Saved the provider decision.",
    )(
      await submitCase(
        await testCookie(),
        { choice: "money_recorded", revision: "2" },
        id,
      ),
    );
    expectStatus(404)(await adminGet(refundCasePath(id)));

    const messages = (await getAllActivityLog()).map(({ message }) => message);
    expect(messages).toContain(
      `Refund recovery ${id}: owner confirmed that the provider returned the money`,
    );
    expect(messages).toContain(
      `Refund recovery ${id}: owner confirmed the returned money is recorded in Money`,
    );
    expect(messages.join(" ")).not.toContain(reference);
  });
});
