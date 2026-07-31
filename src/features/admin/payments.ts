/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import {
  loadPaymentCasePage,
  type PaymentCasePageData,
} from "#routes/admin/payments/data.ts";
import {
  createPaymentDecisionForm,
  type PaymentDecisionFormValues,
  paymentSelectionFromValue,
} from "#routes/admin/payments/form.ts";
import { fulfilPayment } from "#routes/api/payment-processing/index.ts";
import { OWNER_FORM, ownerPage, ownerResponsePage } from "#routes/auth.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  authedHandlerWithStep,
  createAuthedFormRoute,
} from "#shared/app-forms.ts";
import { getOpenPaymentCases } from "#shared/db/payments/cases.ts";
import { PaymentDecisionRejectedError } from "#shared/db/payments/decisions.ts";
import {
  resumePaymentDecision,
  submitPaymentDecision,
} from "#shared/payment-runtime/operator.ts";
import { adminPaymentCasePage } from "#templates/admin/payments/detail.tsx";
import { adminPaymentsPage } from "#templates/admin/payments/list.tsx";

/* jscpd:ignore-end */

type CaseParams = { caseId: number };
type RetryParams = CaseParams & { decisionId: number };

const casePath = (data: PaymentCasePageData): string =>
  `/admin/payments/${data.context.case.id}`;

const loadCase = async ({
  caseId,
}: CaseParams): Promise<PaymentCasePageData | null> =>
  loadPaymentCasePage(caseId);

const handlePaymentsGet = ownerPage(async (session, _request, flash) =>
  adminPaymentsPage(await getOpenPaymentCases(), session, flash.success),
);

const handlePaymentCaseGet: TypedRouteHandler<"GET /admin/payments/:caseId"> = (
  request,
  { caseId },
) =>
  ownerResponsePage(async (session, _request, flash) => {
    const data = await loadPaymentCasePage(caseId);
    return data === null
      ? new Response(null, { status: 404 })
      : htmlResponse(
          adminPaymentCasePage(data, session, {
            error: flash.error,
            success: flash.success,
          }),
        );
  })(request);

const rejectedDecisionResponse = (
  error: PaymentDecisionRejectedError,
  path: string,
): Response =>
  errorRedirect(path, t(`admin.payments.decision_rejected.${error.reason}`));

const handlePaymentCasePost = createAuthedFormRoute<
  PaymentDecisionFormValues,
  CaseParams,
  PaymentCasePageData
>({
  auth: OWNER_FORM,
  form: (data) => createPaymentDecisionForm(data.context, data.accounts),
  loadContext: loadCase,
  onInvalid: ({ context, error }) => errorRedirect(casePath(context), error),
  onValid: async ({ context, session, values }) => {
    try {
      const outcome = await submitPaymentDecision(
        {
          actorId: session.userId,
          caseId: context.context.case.id,
          caseRevision: values.case_revision,
          reason: values.reason,
          selection: paymentSelectionFromValue(
            values.decision,
            context.context,
            context.accounts,
          ),
        },
        fulfilPayment,
      );
      const message = t(`admin.payments.flash.${outcome.status}`);
      return outcome.status === "completed"
        ? redirect("/admin/payments", message, true)
        : redirect(casePath(context), message, true);
    } catch (error) {
      if (error instanceof PaymentDecisionRejectedError) {
        return rejectedDecisionResponse(error, casePath(context));
      }
      throw error;
    }
  },
});

const handlePaymentCaseRetryPost = authedHandlerWithStep<
  RetryParams,
  PaymentCasePageData
>({ auth: OWNER_FORM, loadContext: loadCase }, async ({ context, params }) => {
  const outcome = await resumePaymentDecision(params.decisionId, fulfilPayment);
  return redirect(
    outcome.status === "completed" ? "/admin/payments" : casePath(context),
    t(`admin.payments.flash.${outcome.status}`),
    true,
  );
});

export const adminHandlers = defineRoutes({
  "GET /admin/payments": handlePaymentsGet,
  "GET /admin/payments/:caseId": handlePaymentCaseGet,
  "POST /admin/payments/:caseId": handlePaymentCasePost,
  "POST /admin/payments/:caseId/retry/:decisionId": handlePaymentCaseRetryPost,
});
