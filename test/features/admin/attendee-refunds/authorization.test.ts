import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  type RefundCtx,
  setupRefundTest,
} from "#test/features/admin/refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { refundCompletes, withRefundMock } from "#test-utils/refund-routes.ts";
import { createTestManagerSession } from "#test-utils/session.ts";

type RefundSurface = {
  confirm: (ctx: RefundCtx) => string;
  key: string;
  label: string;
  page: (ctx: RefundCtx) => string;
  url: (ctx: RefundCtx) => string;
};

const REFUND_SURFACES: readonly RefundSurface[] = [
  {
    confirm: ({ attendee }) => attendee.name,
    key: "single",
    label: "single-attendee refunds",
    page: ({ attendee }) => `/admin/attendees/${attendee.id}/actions`,
    url: ({ attendee }) => `/admin/attendees/${attendee.id}/refund`,
  },
  {
    confirm: ({ listing }) => listing.name,
    key: "bulk",
    label: "bulk refunds",
    page: ({ listing }) => `/admin/listing/${listing.id}/actions`,
    url: ({ listing }) => `/admin/listing/${listing.id}/refund-all`,
  },
];

const refundPost = (
  surface: RefundSurface,
  ctx: RefundCtx,
  cookie: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      surface.url(ctx),
      {
        confirm_identifier: surface.confirm(ctx),
        csrf_token: ctx.csrfToken,
      },
      cookie,
    ),
  );

describeWithEnv("refund authorization", { db: true }, () => {
  for (const surface of REFUND_SURFACES) {
    test(`${surface.label} are owner-only before provider work`, async () => {
      const ctx = await setupRefundTest(`pi_auth_${surface.key}`);
      const managerCookie = await createTestManagerSession(
        `manager-refund-${surface.key}`,
        `manager-refund-${surface.key}`,
      );

      expect(
        (
          await awaitTestRequest(surface.url(ctx), {
            cookie: managerCookie,
          })
        ).status,
      ).toBe(403);
      expect(
        (await awaitTestRequest(surface.url(ctx), { cookie: ctx.cookie }))
          .status,
      ).toBe(200);

      await withRefundMock(refundCompletes, async (refundCharge) => {
        expect((await refundPost(surface, ctx, managerCookie)).status).toBe(
          403,
        );
        expect(refundCharge.calls).toHaveLength(0);

        expect((await refundPost(surface, ctx, ctx.cookie)).status).toBe(302);
        expect(refundCharge.calls).toHaveLength(1);
      });
    });
  }

  test("managers never see links to the forbidden refund routes", async () => {
    const ctx = await setupRefundTest("pi_auth_links");
    const managerCookie = await createTestManagerSession(
      "manager-refund-links",
      "manager-refund-links",
    );

    for (const surface of REFUND_SURFACES) {
      const url = surface.url(ctx);
      const ownerResponse = await awaitTestRequest(surface.page(ctx), {
        cookie: ctx.cookie,
      });
      const managerResponse = await awaitTestRequest(surface.page(ctx), {
        cookie: managerCookie,
      });

      expect(ownerResponse.status).toBe(200);
      expect(managerResponse.status).toBe(200);
      const ownerHtml = await ownerResponse.text();
      const managerHtml = await managerResponse.text();
      expect(ownerHtml).toContain(url);
      expect(managerHtml).not.toContain(url);
    }
  });
});
