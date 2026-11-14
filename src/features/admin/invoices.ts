/** Admin invoice routes: list, create, view, cancel, and delete. */

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
import { settings } from "#db/settings.ts";
import { map, unique } from "#fp";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { createIdEntityHandler, orNotFound } from "#routes/entity.ts";
import {
  adminRedirect,
  errorRedirect,
  htmlResponse,
} from "#routes/response.ts";
import {
  authPageAt,
  formGuardAt,
  formPolicyAt,
  pageGuardAt,
} from "#routes/route-gates.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { getActiveEmailConfig } from "#shared/email.ts";
import { sendEmailOk } from "#shared/email-ok.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  buildInvoiceBodyData,
  type InvoiceBodyData,
  renderInvoiceBody,
  renderInvoiceText,
} from "#shared/invoices/body.ts";
import { openInvoiceBody } from "#shared/invoices/seal.ts";
import { invoiceShareUrl } from "#shared/invoices/share.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { nowIso } from "#shared/now.ts";
import { orderLineItems } from "#shared/order-line-items.ts";
import { requireValue } from "#shared/required-value.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
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
import { INVOICE_BODY_TEMPLATE } from "#templates/invoice/defaults.ts";

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

const handleInvoicesGet = authPageAt("invoices")(
  async (session, _request, flash) => {
    const privateKey = await requireRequestPrivateKey();
    const invoices = await getInvoices();
    const attendeeNames = await getAttendeeNamesByIds(
      unique(map((invoice: InvoiceSummary) => invoice.attendee_id)(invoices)),
      privateKey,
    );
    return adminInvoicesPage({ attendeeNames, flash, invoices, session });
  },
);

const handleInvoiceNewGet: TypedRouteHandler<"GET /admin/invoices/new"> =
  authPageAt("invoiceNew")(async (session, request, flash) => {
    const attendee = new URL(request.url).searchParams.get("attendee");
    return adminInvoiceNewPage({
      attendeeId: attendee === null ? null : parsePositiveInt(attendee),
      flash,
      nextNumber: await nextInvoiceNumber(),
      session,
    });
  });

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

/** The facts an invoice for a draft states, ready for the site's template. */
const draftBodyData = async (draft: InvoiceDraft): Promise<InvoiceBodyData> =>
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
  });

/** Run one step of the create flow with the booking's draft and the invoice
 *  text the form carries. Answer with the redirect that refused either. A form
 *  with no text field uses `missingText`. A blank field asks for the built-in
 *  text, because a create of blank text stores that text. */
const withInvoiceForm = async (
  form: FormParams,
  missingText: string,
  use: ResponseHandler<[draft: InvoiceDraft, template: string]>,
): Promise<Response> => {
  const hasText = form.has("body");
  const submitted = (form.get("body") ?? "").trim();
  if (submitted.length > MAX_TEXTAREA_LENGTH) {
    return errorRedirect(
      adminPath("invoiceNew", {}),
      t("invoices.error.body_too_long"),
    );
  }
  const template = hasText
    ? submitted === ""
      ? INVOICE_BODY_TEMPLATE
      : submitted
    : missingText;
  const draft = await loadInvoiceDraft(form);
  return draft instanceof Response ? draft : use(draft, template);
};

/** The preview step: validate the form, then show the invoice template the
 *  operator edits and the invoice it makes for this booking. Sending the form
 *  again from the preview page re-renders the invoice with the edited text. */
const handleInvoicePreviewPost: TypedRouteHandler<
  "POST /admin/invoices/preview"
> = (request) =>
  withAuth(request, formPolicyAt("invoicePreview"), async (session, form) =>
    withInvoiceForm(
      form,
      settings.invoiceBodyTemplate === ""
        ? INVOICE_BODY_TEMPLATE
        : settings.invoiceBodyTemplate,
      async (draft, template) => {
        const data = await draftBodyData(draft);
        return htmlResponse(
          adminInvoicePreviewPage({
            attendeeEmail: draft.attendee.email,
            attendeeId: draft.attendeeId,
            attendeeName: draft.attendee.name,
            // Only a configured provider with a usable address sends.
            delivered:
              getActiveEmailConfig() !== null &&
              parseEmail(draft.attendee.email) !== null,
            number: draft.number,
            previewHtml: renderInvoiceBody(
              await renderInvoiceText(data, template),
            ),
            session,
            template,
          }),
        );
      },
    ),
  );

/** Store the edited invoice, email it, and redirect to its page. */
const handleInvoiceNewPost: TypedRouteHandler<"POST /admin/invoices/new"> = (
  request,
) =>
  withAuth(request, formPolicyAt("invoiceNew"), async (_session, form) =>
    // Clearing the text returns to the built-in template, and so does a
    // template identical to it. The site keeps anything else for the next
    // invoice.
    withInvoiceForm(form, INVOICE_BODY_TEMPLATE, async (draft, template) => {
      await settings.update.invoiceBodyTemplate(
        template === INVOICE_BODY_TEMPLATE ? "" : template,
      );
      const bodyHtml = renderInvoiceBody(
        await renderInvoiceText(await draftBodyData(draft), template),
      );
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
    }),
  );

/** One invoice page, loaded and gated by the shared record-page factory. */
const invoicePageFor = createIdEntityHandler(getInvoice)(
  pageGuardAt("invoice"),
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

/** A command route on one stored invoice, gated by its route declaration. */
const invoiceCommand = (pattern: AdminDestinationId) =>
  createIdEntityHandler(getInvoice)(formGuardAt(pattern));

/** A command on one stored invoice answers 404 when its row is gone. */
const handleInvoiceCancelPost: TypedRouteHandler<"POST /admin/invoices/:id/cancel"> =
  invoiceCommand("invoiceCancel")(async (invoice) => {
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
  invoiceCommand("invoiceDelete")(async (invoice) => {
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
