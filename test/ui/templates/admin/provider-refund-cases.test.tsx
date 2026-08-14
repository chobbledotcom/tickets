import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import type {
  ProviderRefundCase,
  ProviderRefundCasePage,
} from "#shared/db/provider-refund-cases.ts";
import { money } from "#shared/payment/money.ts";
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
      revision: 4,
      state: "needs_owner_choice",
      updatedAt: Date.UTC(2026, 7, 13, 10, 30),
    },
  ],
  nextCursor: "opaque-next-page",
};

const detail: ProviderRefundCase = {
  ...queue.cases[0]!,
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
  state: Exclude<ProviderRefundCase["state"], "needs_owner_choice">,
): ProviderRefundCase => ({
  ...detail,
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

    expect(html).toContain("Refunds needing attention");
    expect(html).toContain('<section class="prose" id="refund-recovery">');
    expect(html).toContain("SumUp");
    expect(html).toContain("£25");
    expect(html).toContain('href="/admin/privacy/refunds/17"');
    expect(html).toContain(
      'href="/admin/privacy?refund_after=opaque-next-page"',
    );
    expect(html).not.toContain("charge-17");
  });

  test("requires an explicit owner choice and posts the seen revision", () => {
    const html = adminProviderRefundCasePage(OWNER_SESSION, detail, {});

    expect(html).toContain("charge-17");
    expect(html).toContain('action="/admin/privacy/refunds/17"');
    expect(html).toContain('name="revision" type="hidden" value="4"');
    expect(html).toContain(
      'name="choice" required type="radio" value="provider_confirmed_returned"',
    );
    expect(html).toContain(
      'name="choice" required type="radio" value="provider_confirmed_not_sent"',
    );
    expect(html).not.toContain("checked");
  });

  test("offers only the choice proved by exact provider-conflict money", () => {
    const returned = adminProviderRefundCasePage(
      OWNER_SESSION,
      {
        ...detail,
        decision: { captured, kind: "returned", refunded: money(1, "GBP")! },
        reason: "provider_conflict",
        state: "needs_owner_choice",
      },
      {},
    );
    const notSent = adminProviderRefundCasePage(
      OWNER_SESSION,
      {
        ...detail,
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

    expect(returned).toContain('value="provider_confirmed_returned"');
    expect(returned).not.toContain('value="provider_confirmed_not_sent"');
    expect(notSent).toContain('value="provider_confirmed_not_sent"');
    expect(notSent).not.toContain('value="provider_confirmed_returned"');
  });

  test("makes inconclusive conflict evidence reachable only by rechecking", () => {
    const html = adminProviderRefundCasePage(
      OWNER_SESSION,
      {
        ...detail,
        decision: { captured, kind: "wait", refunded: money(1, "GBP")! },
        reason: "provider_conflict",
        state: "needs_owner_choice",
      },
      {},
    );

    expect(html).toContain('id="refund-check-conflict"');
    expect(html).toContain('name="choice" type="hidden" value="check_again"');
    expect(html).toContain("Check the provider again");
    expect(html).not.toContain('type="radio"');
  });

  test("shows the charge's own currency beside an irreversible choice", () => {
    const yenCase = {
      ...detail,
      captured: money(1_000, "JPY")!,
    };

    const queueHtml = String(
      <ProviderRefundCaseQueue page={{ cases: [yenCase], nextCursor: null }} />,
    );
    const detailHtml = adminProviderRefundCasePage(OWNER_SESSION, yenCase, {});

    expect(queueHtml).toContain("¥1,000 JPY");
    expect(detailHtml).toContain("¥1,000 JPY");
    expect(detailHtml).not.toContain("£10");
  });

  test("labels provider checks as checks without offering another send", () => {
    for (const state of ["send_armed", "observing"] as const) {
      const html = adminProviderRefundCasePage(
        OWNER_SESSION,
        automaticCase(state),
        {},
      );

      expect(html).toContain('action="/admin/privacy/refunds/17"');
      expect(html).toContain('name="revision" type="hidden" value="4"');
      expect(html).toContain('name="choice" type="hidden" value="check_again"');
      expect(html).toContain("Check the provider again");
      expect(html).not.toContain("Send this refund");
      expect(html).not.toContain('type="radio"');
    }
  });

  test("labels a ready refund as the one money-sending owner action", () => {
    const html = adminProviderRefundCasePage(
      OWNER_SESSION,
      automaticCase("ready"),
      {},
    );

    expect(html).toContain('id="refund-send-ready"');
    expect(html).toContain('name="choice" type="hidden" value="check_again"');
    expect(html).toContain('<button class="danger" type="submit">');
    expect(html).toContain("Send this refund");
    expect(html).not.toContain("Check the provider again");
  });

  test("requires a specific Money-recorded confirmation for returned cash", () => {
    const html = adminProviderRefundCasePage(
      OWNER_SESSION,
      automaticCase("completed"),
      {},
    );

    expect(html).toContain("matching entry in Money is still due");
    expect(html).toContain(
      'name="choice" required type="radio" value="money_recorded"',
    );
    expect(html).not.toContain("provider_confirmed_returned");
    expect(html).not.toContain("check_again");
    expect(html).not.toContain("Why this needs attention");
  });

  test("renders the queue link as plain text in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = String(<ProviderRefundCaseQueue page={queue} />);

    expect(html).toContain("Open refund 17");
    expect(html).not.toContain('href="/admin/privacy/refunds/17"');
  });
});
