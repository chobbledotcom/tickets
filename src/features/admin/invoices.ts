/** Admin invoice routes: list, create, view, cancel, and delete. */

/* jscpd:ignore-start */
import { decryptWithOwnerKey } from "#crypto/hybrid.ts";
import {
  getAttendeeBalanceState,
  getAttendeeOrderSummary,
} from "#db/attendees/balance.ts";
import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import { decryptAttendeeFields } from "#db/attendees/pii.ts";
import {
  getAttendeeNamesByIds,
  getAttendeeRaw,
} from "#db/attendees/queries.ts";
import {
  cancelInvoice,
  createInvoice,
  deleteInvoice,
  getInvoice,
  getInvoices,
  getOpenInvoice,
  type InvoiceRow,
  type InvoiceSummary,
  nextInvoiceNumber,
} from "#db/invoices.ts";
import { map, unique } from "#fp";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import {
  authPage,
  formPolicyFor,
  pageGuardFor,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { orNotFound } from "#routes/entity.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { adminDestinationAt } from "#shared/admin-surface.ts";
import { getActiveEmailConfig } from "#shared/email.ts";
import { sendEmailOk } from "#shared/email-ok.ts";
import {
  buildInvoiceBodyData,
  renderInvoiceBody,
} from "#shared/invoices/body.ts";
import { invoiceLines } from "#shared/invoices/lines.ts";
import { invoiceShareUrl } from "#shared/invoices/share.ts";
import { nowIso } from "#shared/now.ts";
import { requireValue } from "#shared/required-value.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { parseEmail, type ValidEmail } from "#shared/validation/email.ts";
import {
  adminInvoiceNewPage,
  adminInvoicePage,
  adminInvoicesPage,
} from "#templates/admin/invoices.tsx";
import { getInvoiceForm } from "#templates/fields/invoice.ts";

/* jscpd:ignore-end */

/** A whole positive number from the query string, or null. */
const parsePositiveNumberOrNull = (value: string | null): number | null => {
  const parsed = Number(value ?? "");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/** Send one invoice email, returning false when no provider is configured or
 *  the provider refused it. The invoice itself is already stored. */
const sendInvoiceEmail = async (
  invoice: InvoiceRow,
  bodyHtml: string,
  shareUrl: string,
  to: ValidEmail,
): Promise<boolean> => {
  const config = getActiveEmailConfig();
  if (config === null) return false;
  return sendEmailOk(config, {
    html:
      `${bodyHtml}<p><a href="${escapeHtml(shareUrl)}">` +
      `${escapeHtml(t("invoices.email.view"))}</a></p>`,
    subject: t("invoices.email.subject", { number: invoice.id }),
    text: t("invoices.email.text", { number: invoice.id, url: shareUrl }),
    to,
  });
};

/** The success note: whether the email went out. */
const createdMessage = (number: number, delivered: boolean): string => {
  if (delivered) {
    return t("invoices.success.created_and_emailed", { number });
  }
  return t("invoices.success.created_without_email", { number });
};

const handleInvoicesGet = authPage(
  pageGuardFor(adminDestinationAt("/admin/invoices")),
)(async (session, _request, flash) => {
  const privateKey = await requireRequestPrivateKey();
  const invoices = await getInvoices();
  const attendeeNames = await getAttendeeNamesByIds(
    unique(map((invoice: InvoiceSummary) => invoice.attendee_id)(invoices)),
    privateKey,
  );
  return adminInvoicesPage({ attendeeNames, flash, invoices, session });
});

const handleInvoiceNewGet: TypedRouteHandler<"GET /admin/invoices/new"> =
  authPage(pageGuardFor(adminDestinationAt("/admin/invoices/new")))(
    async (session, request, flash) =>
      adminInvoiceNewPage({
        attendeeId: parsePositiveNumberOrNull(
          new URL(request.url).searchParams.get("attendee"),
        ),
        flash,
        nextNumber: await nextInvoiceNumber(),
        session,
      }),
  );

/** Render the body, store the invoice, email it, and redirect to its page. */
const createInvoiceResponse = async (input: {
  amountDue: number;
  attendee: { email: string; name: string };
  attendeeId: number;
  number: number;
}): Promise<Response> => {
  const summary = await getAttendeeOrderSummary(input.attendeeId);
  const created = nowIso();
  const bodyHtml = await renderInvoiceBody(
    buildInvoiceBodyData({
      created,
      customer: input.attendee,
      lines: await invoiceLines(summary),
      number: input.number,
      totals: {
        due: input.amountDue,
        paid: summary.depositPaid,
        total: summary.fullPrice,
      },
    }),
  );
  const { invoice, shareToken } = await createInvoice({
    attendeeId: input.attendeeId,
    bodyHtml,
    created,
    id: input.number,
  });
  const shareUrl = invoiceShareUrl(shareToken);
  const email = parseEmail(input.attendee.email);
  const delivered =
    email !== null &&
    (await sendInvoiceEmail(invoice, bodyHtml, shareUrl, email));
  return redirect(
    `/admin/invoices/${invoice.id}`,
    createdMessage(input.number, delivered),
    true,
  );
};

const handleInvoiceNewPost: TypedRouteHandler<"POST /admin/invoices/new"> = (
  request,
) =>
  withAuth(
    request,
    formPolicyFor(adminDestinationAt("/admin/invoices/new")),
    async (_session, form) => {
      const checked = getInvoiceForm().validate(form);
      if (!checked.valid) {
        return errorRedirect("/admin/invoices/new", checked.error);
      }
      const { attendee_id: attendeeId, number } = checked.values;
      const raw = await getAttendeeRaw(attendeeId);
      if (!raw || raw.kind !== ATTENDEE_KIND) {
        return errorRedirect(
          "/admin/invoices/new",
          t("invoices.error.attendee_missing"),
        );
      }
      const attendee = await decryptAttendeeFields(
        raw,
        await requireRequestPrivateKey(),
      );
      const state = requireValue(
        await getAttendeeBalanceState(attendeeId),
        "An invoice attendee has no balance state",
      );
      if (state.remainingBalance <= 0) {
        return errorRedirect(
          "/admin/invoices/new",
          t("invoices.error.nothing_due"),
        );
      }
      if ((await getOpenInvoice(attendeeId)) !== null) {
        return errorRedirect(
          "/admin/invoices/new",
          t("invoices.error.open_invoice_exists"),
        );
      }
      if ((await getInvoice(number)) !== null) {
        return errorRedirect(
          "/admin/invoices/new",
          t("invoices.error.number_taken"),
        );
      }
      return createInvoiceResponse({
        amountDue: state.remainingBalance,
        attendee,
        attendeeId,
        number,
      });
    },
  );

const handleInvoiceGet: TypedRouteHandler<"GET /admin/invoices/:id"> = (
  request,
  { id },
) =>
  pageGuardFor(adminDestinationAt("/admin/invoices/:id"))(
    request,
    async (session) =>
      orNotFound(getInvoice(id), async (invoice) => {
        const privateKey = await requireRequestPrivateKey();
        const [bodyHtml, shareToken] = await Promise.all([
          decryptWithOwnerKey(invoice.body, privateKey),
          decryptWithOwnerKey(invoice.share_token, privateKey),
        ]);
        return orNotFound(getAttendeeRaw(invoice.attendee_id), async (raw) => {
          const attendee = await decryptAttendeeFields(raw, privateKey);
          return htmlResponse(
            adminInvoicePage({
              attendeeEmail: attendee.email,
              attendeeName: attendee.name,
              bodyHtml,
              flash: applyFlash(request),
              invoice,
              session,
              shareUrl: invoiceShareUrl(shareToken),
            }),
          );
        });
      }),
  );

/** A POST command on one stored invoice. Its own gate runs first. A missing
 *  row answers 404. The work then decides where to return. */
const invoiceCommandRoute =
  (
    destination: string,
    run: (id: number) => Promise<Response>,
  ): TypedRouteHandler<"POST /admin/invoices/:id/cancel"> =>
  (request, { id }) =>
    withAuth(request, formPolicyFor(adminDestinationAt(destination)), () =>
      orNotFound(getInvoice(id), () => run(id)),
    );

/** Return to a page with the note that names the invoice it is about. */
const invoiceNotice = (path: string, message: string): Response =>
  redirect(path, message, true);

const handleInvoiceCancelPost = invoiceCommandRoute(
  "/admin/invoices/:id/cancel",
  async (id) => {
    if (!(await cancelInvoice(id))) {
      return errorRedirect(
        `/admin/invoices/${id}`,
        t("invoices.error.not_open"),
      );
    }
    return invoiceNotice(
      `/admin/invoices/${id}`,
      t("invoices.success.cancelled", { number: id }),
    );
  },
);

const handleInvoiceDeletePost = invoiceCommandRoute(
  "/admin/invoices/:id/delete",
  async (id) => {
    await deleteInvoice(id);
    return invoiceNotice(
      "/admin/invoices",
      t("invoices.success.deleted", { number: id }),
    );
  },
);

export const adminHandlers = defineAdminRoutes({
  "GET /admin/invoices": handleInvoicesGet,
  "GET /admin/invoices/:id": handleInvoiceGet,
  "GET /admin/invoices/new": handleInvoiceNewGet,
  "POST /admin/invoices/:id/cancel": handleInvoiceCancelPost,
  "POST /admin/invoices/:id/delete": handleInvoiceDeletePost,
  "POST /admin/invoices/new": handleInvoiceNewPost,
});
