import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type {
  ProviderRefundCase,
  ProviderRefundCasePage,
} from "#db/provider-refund-cases.ts";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import { money } from "#payment/money.ts";
import {
  adminProviderRefundCasePage,
  ProviderRefundCaseQueue,
} from "#templates/admin/provider-refund-cases.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";

const captured = money(2_500, "GBP")!;
const queue: ProviderRefundCasePage = {
  cases: [
    {
      captured,
      id: 17,
      provider: "sumup",
      refunded: money(0, "GBP")!,
      revision: 4,
      state: "needs_owner_choice",
      updatedAt: Date.UTC(2026, 7, 13, 10, 30),
    },
  ],
  nextCursor: "opaque-next-page",
};

const detail: ProviderRefundCase = {
  ...queue.cases[0]!,
  choices: ["provider_confirmed_returned", "provider_confirmed_not_sent"],
  decision: { kind: "returned_or_not_sent" },
  reason: "possibly_sent",
  reference: {
    kind: "tagged",
    provider: "sumup",
    reference: "charge-17",
  },
  state: "needs_owner_choice",
};

const automaticCase = (
  state: Exclude<
    ProviderRefundCase["state"],
    "needs_owner_choice" | "needs_provider_check"
  >,
): ProviderRefundCase => ({
  ...detail,
  choices: null,
  decision: null,
  reason: null,
  state,
});

describe("provider refund recovery templates", () => {
  beforeAll(async () => {
    await setupAdminPageTest();
    await ensureMessageGroups(MESSAGE_GROUPS);
  });

  test("renders a bounded blind queue with a detail link and opaque cursor", () => {
    const html = String(<ProviderRefundCaseQueue page={queue} />);

    assertStringIncludes(html, "Refunds needing attention");
    assertStringIncludes(html, '<section id="refund-recovery">');
    assertStringIncludes(
      html,
      '<div class="prose"><h2>Refunds needing attention</h2>',
    );
    assertStringIncludes(html, "SumUp");
    assertStringIncludes(html, "£25");
    assertStringIncludes(html, 'href="/admin/privacy/refunds/17"');
    assertStringIncludes(
      html,
      'href="/admin/privacy?refund_after=opaque-next-page"',
    );
    assert(!html.includes("charge-17"));
  });

  test("requires an explicit owner choice and posts the seen revision", () => {
    const html = adminProviderRefundCasePage(OWNER_SESSION, detail, {});

    assertStringIncludes(html, "charge-17");
    assertStringIncludes(html, 'action="/admin/privacy/refunds/17"');
    assertStringIncludes(html, 'name="revision" type="hidden" value="4"');
    assertStringIncludes(
      html,
      'name="choice" required type="radio" value="provider_confirmed_returned"',
    );
    assertStringIncludes(
      html,
      'name="choice" required type="radio" value="provider_confirmed_not_sent"',
    );
    assert(!html.includes("checked"));
  });

  test("shows the returned part and the missing part before an owner acts", () => {
    const partialCase: ProviderRefundCase = {
      ...detail,
      captured: money(2_500, "GBP")!,
      choices: ["provider_confirmed_returned"],
      decision: {
        captured: money(2_500, "GBP")!,
        kind: "returned",
        refunded: money(400, "GBP")!,
      },
      reason: "provider_conflict",
      refunded: money(400, "GBP")!,
      state: "needs_owner_choice",
    };
    const awaitingMoney: ProviderRefundCase = {
      ...automaticCase("completed"),
      refunded: money(400, "GBP")!,
    };

    for (const [name, html] of [
      [
        "the returned choice",
        adminProviderRefundCasePage(OWNER_SESSION, partialCase, {}),
      ],
      [
        "the Money attestation",
        adminProviderRefundCasePage(OWNER_SESSION, awaitingMoney, {}),
      ],
    ] as const) {
      assertStringIncludes(html, "£25 GBP", name);
      assertStringIncludes(html, "Provider returned", name);
      assertStringIncludes(html, "£4 GBP", name);
      assertStringIncludes(html, "Not returned", name);
      assertStringIncludes(html, "£21 GBP", name);
    }

    const nothingReturned = adminProviderRefundCasePage(
      OWNER_SESSION,
      detail,
      {},
    );
    assertStringIncludes(nothingReturned, "£25 GBP");
    assert(!nothingReturned.includes("Provider returned"));
    assert(!nothingReturned.includes("Not returned"));
  });

  test("separates a partial provider check from conclusive owner choices", () => {
    const partial = adminProviderRefundCasePage(
      OWNER_SESSION,
      {
        ...detail,
        choices: null,
        decision: { captured, kind: "returned", refunded: money(1, "GBP")! },
        reason: "provider_conflict",
        state: "needs_provider_check",
      },
      {},
    );
    const returned = adminProviderRefundCasePage(
      OWNER_SESSION,
      {
        ...detail,
        choices: ["provider_confirmed_returned"],
        decision: { captured, kind: "returned", refunded: captured },
        reason: "provider_conflict",
        refunded: captured,
        state: "needs_owner_choice",
      },
      {},
    );
    const notSent = adminProviderRefundCasePage(
      OWNER_SESSION,
      {
        ...detail,
        choices: ["provider_confirmed_not_sent"],
        decision: {
          captured,
          kind: "not_sent",
          refunded: money(0, "GBP")!,
        },
        reason: "provider_conflict",
        state: "needs_owner_choice",
      },
      {},
    );

    assertStringIncludes(
      partial,
      'name="choice" type="hidden" value="check_again"',
    );
    assert(!partial.includes('type="radio"'));
    assertStringIncludes(returned, 'value="provider_confirmed_returned"');
    assert(!returned.includes('value="provider_confirmed_not_sent"'));
    assertStringIncludes(returned, "Provider returned");
    assert(!returned.includes("Not returned"));
    assertStringIncludes(notSent, 'value="provider_confirmed_not_sent"');
    assert(!notSent.includes('value="provider_confirmed_returned"'));
  });

  test("makes inconclusive conflict evidence reachable only by rechecking", () => {
    const html = adminProviderRefundCasePage(
      OWNER_SESSION,
      {
        ...detail,
        choices: null,
        decision: { captured, kind: "wait", refunded: money(1, "GBP")! },
        reason: "provider_conflict",
        state: "needs_provider_check",
      },
      {},
    );

    assertStringIncludes(html, 'id="refund-check-conflict"');
    assertStringIncludes(
      html,
      'name="choice" type="hidden" value="check_again"',
    );
    assertStringIncludes(html, "Check the provider again");
    assert(!html.includes('type="radio"'));
  });

  test("shows the charge's own currency beside an irreversible choice", () => {
    const yenCase = {
      ...detail,
      captured: money(1_000, "JPY")!,
      refunded: money(0, "JPY")!,
    };

    const queueHtml = String(
      <ProviderRefundCaseQueue page={{ cases: [yenCase], nextCursor: null }} />,
    );
    const detailHtml = adminProviderRefundCasePage(OWNER_SESSION, yenCase, {});

    assertStringIncludes(queueHtml, "¥1,000 JPY");
    assertStringIncludes(detailHtml, "¥1,000 JPY");
    assert(!detailHtml.includes("£10"));
  });

  test("labels provider checks as checks without offering another send", () => {
    for (const state of ["send_armed", "observing"] as const) {
      const html = adminProviderRefundCasePage(
        OWNER_SESSION,
        automaticCase(state),
        {},
      );

      assertStringIncludes(html, 'action="/admin/privacy/refunds/17"');
      assertStringIncludes(html, 'name="revision" type="hidden" value="4"');
      assertStringIncludes(
        html,
        'name="choice" type="hidden" value="check_again"',
      );
      assertStringIncludes(html, "Check the provider again");
      assert(!html.includes("Send this refund"));
      assert(!html.includes('type="radio"'));
    }
  });

  test("labels a ready refund as the one money-sending owner action", () => {
    const html = adminProviderRefundCasePage(
      OWNER_SESSION,
      automaticCase("ready"),
      {},
    );

    assertStringIncludes(html, 'id="refund-send-ready"');
    assertStringIncludes(
      html,
      'name="choice" type="hidden" value="check_again"',
    );
    assertStringIncludes(html, '<button class="danger" type="submit">');
    assertStringIncludes(html, "Send this refund");
    assert(!html.includes("Check the provider again"));
  });

  test("marks a choice as a money action only when it can re-queue a send", () => {
    const withNotSent = adminProviderRefundCasePage(OWNER_SESSION, detail, {});
    assertStringIncludes(withNotSent, '<button class="danger" type="submit">');

    // Confirming money that already came back sends nothing, so the machine
    // says this settled-return decision is not a money action.
    const returnedOnly = adminProviderRefundCasePage(
      OWNER_SESSION,
      {
        ...detail,
        choices: ["provider_confirmed_returned"],
        decision: { captured, kind: "returned", refunded: captured },
        reason: "provider_conflict",
        refunded: captured,
      },
      {},
    );
    assertStringIncludes(returnedOnly, '<button type="submit">');
    assert(!returnedOnly.includes('<button class="danger" type="submit">'));
  });

  test("requires a specific Money-recorded confirmation for returned cash", () => {
    const html = adminProviderRefundCasePage(
      OWNER_SESSION,
      automaticCase("completed"),
      {},
    );

    assertStringIncludes(html, "matching entry in Money is still due");
    assertStringIncludes(
      html,
      'name="choice" required type="radio" value="money_recorded"',
    );
    assert(!html.includes("provider_confirmed_returned"));
    assert(!html.includes("check_again"));
    assert(!html.includes("Why this needs attention"));
  });

  test("renders the queue link as plain text in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = String(<ProviderRefundCaseQueue page={queue} />);

    assertStringIncludes(html, "Open refund 17");
    assert(!html.includes('href="/admin/privacy/refunds/17"'));
  });
});
