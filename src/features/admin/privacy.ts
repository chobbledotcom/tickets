/**
 * Privacy page routes (owner-only).
 *
 * Hosts the data-minimisation tools described in plain language on the page:
 * purging orphaned attendee records (records left with no listing booking),
 * toggling whether that purge runs automatically, and performing a GDPR
 * erasure of a single contact's recognition record by email or phone.
 */

import { assert } from "@std/assert";
import { t } from "#i18n";
import {
  OWNER_FORM,
  ownerResponsePage,
  requireOwnerOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  infoRedirect,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { ownerFormHandler } from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import {
  contactHash,
  forgetContact,
  isContactChannel,
} from "#shared/db/contact-preferences.ts";
import {
  countPurgeableOrphanedAttendees,
  getOrphanPaymentWorkPage,
  purgeOrphanedAttendees,
} from "#shared/db/orphan-attendees.ts";
import {
  type ProviderRefundOwnerChoice,
  resolveProviderRefundCase,
} from "#shared/db/provider-refund-case-resolution.ts";
import {
  listProviderRefundCases,
  loadProviderRefundCase,
  type ProviderRefundCase,
} from "#shared/db/provider-refund-cases.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import {
  isOrphanRetentionValue,
  orphanRetentionCutoffIso,
} from "#shared/orphan-retention.ts";
import { readProviderRefundCursor } from "#shared/provider-refund-cursor.ts";
import {
  type ProviderRefundResult,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  parseNonNegativeInt,
  parsePositiveInt,
} from "#shared/validation/number.ts";
import { adminPrivacyPage } from "#templates/admin/privacy.tsx";
import { adminProviderRefundCasePage } from "#templates/admin/provider-refund-cases.tsx";

const PRIVACY_PATH = "/admin/privacy";
const refundCasePath = (id: number): string => `${PRIVACY_PATH}/refunds/${id}`;

/** GET /admin/privacy — explainer plus the orphan-purge and erasure forms. */
const paymentWorkCursor = (request: Request) => {
  const after = parseNonNegativeInt(getSearchParam(request, "work_after"));
  const before = parseNonNegativeInt(getSearchParam(request, "work_before"));
  if (after !== null && before === null) return { after } as const;
  if (before !== null && after === null) return { before } as const;
  return {};
};

const handlePrivacyGet = ownerResponsePage(async (session, request, flash) => {
  const refundCursor = new URL(request.url).searchParams.get("refund_after");
  const refundAfter =
    refundCursor === null
      ? undefined
      : await readProviderRefundCursor(refundCursor);
  if (refundAfter === null) {
    return htmlResponse(t("privacy.refunds.invalid_cursor"), 400);
  }
  const [purgeableOrphanCount, paymentWorkPage, providerRefundCases] =
    await Promise.all([
      countPurgeableOrphanedAttendees(nowIso()),
      getOrphanPaymentWorkPage(paymentWorkCursor(request)),
      listProviderRefundCases(refundAfter),
    ]);
  return htmlResponse(
    adminPrivacyPage(session, {
      autoPurgeOrphans: settings.autoPurgeOrphans,
      error: flash.error,
      info: flash.info,
      orphanRetention: settings.orphanPurgeRetention,
      paymentWorkPage,
      providerRefundCases,
      purgeableOrphanCount,
      success: flash.success,
    }),
  );
});

type RefundCaseRoute = (
  request: Request,
  params: { id: number },
) => Promise<Response>;

const handleRefundCaseGet: RefundCaseRoute = (request, { id }) =>
  requireOwnerOr(request, async (session) => {
    const refundCase = await loadProviderRefundCase(
      id,
      await requireRequestPrivateKey(),
    );
    return refundCase === null
      ? notFoundResponse()
      : htmlResponse(
          adminProviderRefundCasePage(session, refundCase, applyFlash(request)),
        );
  });

const OWNER_CHOICE_LOG = {
  money_recorded: "privacy.refunds.log_money_recorded",
  provider_confirmed_not_sent: "privacy.refunds.log_not_sent",
  provider_confirmed_returned: "privacy.refunds.log_returned",
} as const satisfies Record<ProviderRefundOwnerChoice, string>;

const isOwnerChoice = (value: string): value is ProviderRefundOwnerChoice =>
  Object.hasOwn(OWNER_CHOICE_LOG, value);

type ExistingProviderRefundResult = Exclude<
  ProviderRefundResult,
  { kind: "unchanged" }
>;

type AutomaticRefundCaseState = Exclude<
  ProviderRefundCase["state"],
  "needs_owner_choice"
>;

const AUTOMATIC_PROVIDER_CHECK = {
  completed: false,
  observing: true,
  ready: true,
  send_armed: true,
} as const satisfies Record<AutomaticRefundCaseState, boolean>;

const mayCheckProvider = (refundCase: ProviderRefundCase): boolean =>
  refundCase.state === "needs_owner_choice"
    ? refundCase.decision.kind === "wait"
    : AUTOMATIC_PROVIDER_CHECK[refundCase.state];

const CHECK_STOP_COPY = {
  needs_owner_choice: {
    log: "privacy.refunds.log_choice_opened",
    message: "privacy.refunds.choice_opened",
  },
  pending: null,
  ready: null,
  returned: null,
  withheld: {
    log: "privacy.refunds.log_unreadable",
    message: "privacy.refunds.unreadable",
  },
} as const satisfies Record<
  ExistingProviderRefundResult["kind"],
  { readonly log: string; readonly message: string } | null
>;

const checkProviderAgain = async (
  id: number,
  revision: number,
): Promise<Response> => {
  const refundCase = await loadProviderRefundCase(
    id,
    await requireRequestPrivateKey(),
  );
  if (refundCase === null) return notFoundResponse();
  if (refundCase.revision !== revision || !mayCheckProvider(refundCase)) {
    return errorRedirect(refundCasePath(id), t("privacy.refunds.changed"));
  }
  const sendsReadyRefund = refundCase.state === "ready";
  const result = await requestProviderRefund({
    evidence: { kind: "read_provider" },
    mode: sendsReadyRefund ? "send" : "observe_only",
    reference: refundCase.reference,
  });
  assert(
    result.kind !== "unchanged",
    "Existing refund recovery lost its durable authority",
  );
  const stopped = CHECK_STOP_COPY[result.kind];
  if (stopped !== null) {
    await logActivity(t(stopped.log, { id }));
    return errorRedirect(refundCasePath(id), t(stopped.message));
  }
  await logActivity(
    t(
      sendsReadyRefund
        ? "privacy.refunds.log_continued"
        : "privacy.refunds.log_checked",
      { id },
    ),
  );
  return redirect(
    refundCasePath(id),
    t(
      sendsReadyRefund
        ? "privacy.refunds.continued"
        : "privacy.refunds.checked",
    ),
    true,
  );
};

const handleRefundCasePost: RefundCaseRoute = (request, { id }) =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const choice = form.getString("choice");
    const revision = parsePositiveInt(form.getString("revision"));
    if (
      revision === null ||
      (choice !== "check_again" && !isOwnerChoice(choice))
    ) {
      return errorRedirect(
        refundCasePath(id),
        t("privacy.refunds.error_choice"),
      );
    }
    if (choice === "check_again") return await checkProviderAgain(id, revision);
    const result = await resolveProviderRefundCase({
      activityMessage: t(OWNER_CHOICE_LOG[choice], { id }),
      choice,
      id,
      privateKey: await requireRequestPrivateKey(),
      revision,
    });
    if (result === "missing") return notFoundResponse();
    if (result === "changed") {
      return errorRedirect(refundCasePath(id), t("privacy.refunds.changed"));
    }
    return redirect(PRIVACY_PATH, t("privacy.refunds.resolved"), true);
  });

/**
 * POST /admin/privacy/orphans — save the retention age and auto-purge toggle.
 * The "Delete now" button additionally purges matching records immediately;
 * the "Save" button only stores the settings.
 */
const handleOrphansPost = ownerFormHandler(async ({ form }) => {
  const retention = form.getString("retention");
  if (!isOrphanRetentionValue(retention)) {
    return errorRedirect(PRIVACY_PATH, t("privacy.orphans.error_retention"));
  }
  await settings.update.orphanPurgeRetention(retention);
  await settings.update.autoPurgeOrphans(form.has("auto_purge"));

  if (form.getString("action") === "purge") {
    const deleted = await purgeOrphanedAttendees(
      orphanRetentionCutoffIso(retention, nowMs()),
    );
    await logActivity(t("privacy.orphans.log_purged", { count: deleted }));
    return redirect(
      PRIVACY_PATH,
      t("privacy.orphans.flash_purged", { count: deleted }),
      true,
    );
  }
  return redirect(PRIVACY_PATH, t("privacy.orphans.flash_saved"), true);
});

/**
 * POST /admin/privacy/erase — delete one contact's recognition record, found
 * by hashing the entered email or phone the same way bookings record it.
 */
const handleErasePost = ownerFormHandler(async ({ form }) => {
  const channel = form.getString("contact_type");
  const identifier = form.getString("identifier").trim();
  if (!identifier) {
    return errorRedirect(PRIVACY_PATH, t("privacy.erase.error_identifier"));
  }
  if (!isContactChannel(channel)) {
    return errorRedirect(PRIVACY_PATH, t("privacy.erase.error_type"));
  }
  const deleted = await forgetContact(await contactHash(channel, identifier));
  if (deleted === 0) {
    return infoRedirect(PRIVACY_PATH, t("privacy.erase.flash_none"));
  }
  await logActivity(t("privacy.erase.log_done"));
  return redirect(PRIVACY_PATH, t("privacy.erase.flash_done"), true);
});

/** Privacy routes */
export const adminHandlers = defineRoutes({
  "GET /admin/privacy": handlePrivacyGet,
  "GET /admin/privacy/refunds/:id": handleRefundCaseGet,
  "POST /admin/privacy/erase": handleErasePost,
  "POST /admin/privacy/orphans": handleOrphansPost,
  "POST /admin/privacy/refunds/:id": handleRefundCasePost,
});
