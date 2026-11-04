/** Admin invoice routes: list, create, view, cancel, and delete. */

/* jscpd:ignore-start */
import { decryptWithOwnerKey } from "#crypto/hybrid.ts";
import {
  getAttendeeBalanceState,
  getAttendeeOrderSummary,
  type OrderSummary,
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
  formGuard,
  formPolicyAt,
  pageGuardFor,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { createIdEntityHandler, orNotFound } from "#routes/entity.ts";
import {
  adminRedirect,
  errorRedirect,
  htmlResponse,
} from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import {
  adminDestinationAt,
  adminPath,
  adminPattern,
} from "#shared/admin-surface.ts";
import { getActiveEmailConfig } from "#shared/email.ts";
import { sendEmailOk } from "#shared/email-ok.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  buildInvoiceBodyData,
  renderInvoiceBody,
  renderInvoiceText,
} from "#shared/invoices/body.ts";
import { openInvoiceBody } from "#shared/invoices/seal.ts";
import { invoiceShareUrl } from "#shared/invoices/share.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { nowIso } from "#shared/now.ts";
import { orderLineItems } from "#shared/order-line-items.ts";
import { requireValue } from "#shared/required-value.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { parseEmail, type ValidEmail } from "#shared/validation/email.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import {
  adminInvoiceNewPage,
  adminInvoicePage,
  adminInvoicePreviewPage,
  adminInvoicesPage,
} from "#templates/admin/invoices.tsx";
import { getInvoiceForm } from "#templates/fields/invoice.ts";

/* jscpd:ignore-end */

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
const createdMessage = (number: number, delivered: boolean): string =>
  t(
    delivered
      ? "invoices.success.created_and_emailed"
      : "invoices.success.created_without_email",
    { number },
  );

const handleInvoicesGet = authPage(
  pageGuardFor(adminDestinationAt(adminPattern("invoices"))),
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
  authPage(pageGuardFor(adminDestinationAt(adminPattern("invoiceNew"))))(
    async (session, request, flash) => {
      const attendee = new URL(request.url).searchParams.get("attendee");
      return adminInvoiceNewPage({
        attendeeId: attendee === null ? null : parsePositiveInt(attendee),
        flash,
        nextNumber: await nextInvoiceNumber(),
        session,
      });
    },
  );

/** What a validated create form loaded: the booking, its money, and the
 *  number the invoice will take. */
type InvoiceDraft = {
  amountDue: number;
  attendee: { email: string; name: string };
  attendeeId: number;
  number: number;
  summary: OrderSummary;
};

/** Read the create form and load what an invoice needs, or the redirect that
 *  explains why the site refused it. */
const loadInvoiceDraft = async (
  form: FormParams,
): Promise<Response | InvoiceDraft> => {
  const newInvoicePath = adminPath("invoiceNew", {});
  const checked = getInvoiceForm().validate(form);
  if (!checked.valid) return errorRedirect(newInvoicePath, checked.error);
  const { attendee_id: attendeeId, number } = checked.values;
  const raw = await getAttendeeRaw(attendeeId);
  if (!raw || raw.kind !== ATTENDEE_KIND) {
    return errorRedirect(newInvoicePath, t("invoices.error.attendee_missing"));
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
    return errorRedirect(newInvoicePath, t("invoices.error.nothing_due"));
  }
  if ((await getOpenInvoice(attendeeId)) !== null) {
    return errorRedirect(
      newInvoicePath,
      t("invoices.error.open_invoice_exists"),
    );
  }
  if ((await getInvoice(number)) !== null) {
    return errorRedirect(newInvoicePath, t("invoices.error.number_taken"));
  }
  return {
    amountDue: state.remainingBalance,
    attendee,
    attendeeId,
    number,
    summary: await getAttendeeOrderSummary(attendeeId),
  };
};

/** The built-in invoice text for a draft: the booking's facts in the Markdown
 *  template the operator then edits. */
const draftBodyText = async (draft: InvoiceDraft): Promise<string> =>
  renderInvoiceText(
    buildInvoiceBodyData({
      created: nowIso(),
      customer: draft.attendee,
      lines: await orderLineItems(draft.summary.lines, t("invoices.package")),
      number: draft.number,
      totals: {
        due: draft.amountDue,
        paid: draft.summary.depositPaid,
        total: draft.summary.fullPrice,
      },
    }),
  );

/** Read the create form and continue with the draft it holds, or answer with
 *  the redirect that refused it. */
const withInvoiceDraft = async (
  form: FormParams,
  use: (draft: InvoiceDraft) => Response | Promise<Response>,
): Promise<Response> => {
  const draft = await loadInvoiceDraft(form);
  return draft instanceof Response ? draft : use(draft);
};

/** The preview step: validate the form, then show the text the operator edits
 *  and says whether the site will email it. */
const handleInvoicePreviewPost: TypedRouteHandler<
  "POST /admin/invoices/preview"
> = (request) =>
  withAuth(
    request,
    formPolicyAt(adminPattern("invoicePreview")),
    async (session, form) =>
      withInvoiceDraft(form, async (draft) =>
        htmlResponse(
          adminInvoicePreviewPage({
            attendeeEmail: draft.attendee.email,
            attendeeId: draft.attendeeId,
            attendeeName: draft.attendee.name,
            body: await draftBodyText(draft),
            // Only a configured provider with a usable address sends.
            delivered:
              getActiveEmailConfig() !== null &&
              parseEmail(draft.attendee.email) !== null,
            number: draft.number,
            session,
          }),
        ),
      ),
  );

/** Store the edited invoice, email it, and redirect to its page. */
const handleInvoiceNewPost: TypedRouteHandler<"POST /admin/invoices/new"> = (
  request,
) =>
  withAuth(
    request,
    formPolicyAt(adminPattern("invoiceNew")),
    async (_session, form) => {
      const newInvoicePath = adminPath("invoiceNew", {});
      const bodyText = (form.get("body") ?? "").trim();
      if (bodyText === "") {
        return errorRedirect(newInvoicePath, t("invoices.error.body_required"));
      }
      if (bodyText.length > MAX_TEXTAREA_LENGTH) {
        return errorRedirect(newInvoicePath, t("invoices.error.body_too_long"));
      }
      return withInvoiceDraft(form, async (draft) => {
        const bodyHtml = renderInvoiceBody(bodyText);
        const { invoice, shareToken } = await createInvoice({
          attendeeId: draft.attendeeId,
          bodyHtml,
          created: nowIso(),
          id: draft.number,
        });
        const shareUrl = invoiceShareUrl(shareToken);
        const email = parseEmail(draft.attendee.email);
        const delivered =
          email !== null &&
          (await sendInvoiceEmail(invoice, bodyHtml, shareUrl, email));
        return adminRedirect(
          "invoice",
          { id: invoice.id },
          createdMessage(draft.number, delivered),
          true,
        );
      });
    },
  );

/** One invoice page, loaded and gated by the shared record-page factory. */
const invoicePageFor = createIdEntityHandler(getInvoice)(
  pageGuardFor(adminDestinationAt(adminPattern("invoice"))),
);

const handleInvoiceGet: TypedRouteHandler<"GET /admin/invoices/:id"> =
  invoicePageFor(async (invoice, session, request) => {
    const privateKey = await requireRequestPrivateKey();
    const shareToken = await decryptWithOwnerKey(
      invoice.share_token,
      privateKey,
    );
    return orNotFound(getAttendeeRaw(invoice.attendee_id), async (raw) => {
      const [attendee, bodyHtml] = await Promise.all([
        decryptAttendeeFields(raw, privateKey),
        openInvoiceBody(invoice.body, shareToken),
      ]);
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
  });

/** A command on one stored invoice answers 404 when its row is gone. */
const handleInvoiceCancelPost: TypedRouteHandler<"POST /admin/invoices/:id/cancel"> =
  createIdEntityHandler(getInvoice)(
    formGuard(formPolicyAt(adminPattern("invoiceCancel"))),
  )(async (invoice) => {
    if (!(await cancelInvoice(invoice.id))) {
      return errorRedirect(
        adminPath("invoice", { id: invoice.id }),
        t("invoices.error.not_open"),
      );
    }
    return adminRedirect(
      "invoice",
      { id: invoice.id },
      t("invoices.success.cancelled", { number: invoice.id }),
      true,
    );
  });

const handleInvoiceDeletePost: TypedRouteHandler<"POST /admin/invoices/:id/delete"> =
  createIdEntityHandler(getInvoice)(
    formGuard(formPolicyAt(adminPattern("invoiceDelete"))),
  )(async (invoice) => {
    await deleteInvoice(invoice.id);
    return adminRedirect(
      "invoices",
      {},
      t("invoices.success.deleted", { number: invoice.id }),
      true,
    );
  });

export const adminHandlers = defineAdminRoutes({
  "GET /admin/invoices": handleInvoicesGet,
  "GET /admin/invoices/:id": handleInvoiceGet,
  "GET /admin/invoices/new": handleInvoiceNewGet,
  "POST /admin/invoices/:id/cancel": handleInvoiceCancelPost,
  "POST /admin/invoices/:id/delete": handleInvoiceDeletePost,
  "POST /admin/invoices/new": handleInvoiceNewPost,
  "POST /admin/invoices/preview": handleInvoicePreviewPost,
});
