/* jscpd:ignore-start */
import { t } from "#i18n";
import { verifyIdentifier } from "#routes/admin/confirmation.ts";
import {
  hasLedgerName,
  loadLedgerNames,
  loadLedgerNamesForAccounts,
} from "#routes/admin/ledger/names.ts";
import {
  ownerHtml,
  ownerTypeRefHtml,
} from "#routes/admin/ledger/route-helpers.ts";
import { accountFromRoute } from "#routes/admin/ledger/statements.ts";
import { type AuthSession, OWNER_FORM, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import type { IdParam } from "#routes/entity.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { isRowAccountType } from "#shared/accounting/accounts.ts";
import {
  deleteManualLedgerEntry,
  getTransferById,
  isManualLedgerTransfer,
  manualLedgerEntryOptionsFor,
  postManualLedgerEntry,
  updateManualLedgerEntry,
} from "#shared/accounting/manual-entries.ts";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { utcToLocalInput } from "#shared/timezone.ts";
import {
  defineLedgerEntryAddForm,
  type LedgerEntryAddOption,
  ledgerEntryForm,
} from "#templates/admin/ledger/entry-form.ts";
import {
  adminLedgerEntryEditPage,
  adminLedgerEntryNewPage,
} from "#templates/admin/ledger/entry-pages.tsx";
import type { LedgerNames } from "#templates/admin/ledger.tsx";

/* jscpd:ignore-end */

const pathFromUrlValue = (value: string | null, fallback: string): string => {
  if (!value || !URL.canParse(value, "http://localhost")) return fallback;
  const url = new URL(value, "http://localhost");
  return `${url.pathname}${url.search}${url.hash}`;
};

const returnUrlFromRequest = (request: Request, fallback: string): string =>
  pathFromUrlValue(
    new URL(request.url).searchParams.get("return_url"),
    fallback,
  );

const returnUrlFromForm = (form: FormParams, fallback: string): string =>
  pathFromUrlValue(form.getString("return_url"), fallback);

const editEntryPath = (id: number, returnUrl: string): string =>
  `/admin/ledger/entries/${id}/edit?return_url=${encodeURIComponent(returnUrl)}`;

const addEntryPath = (account: AccountRef, returnUrl: string): string =>
  `/admin/ledger/${account.type}/${account.id}/add?return_url=${encodeURIComponent(
    returnUrl,
  )}`;

const transferFormValues = (transfer: Transfer) => ({
  amount: toMajorUnits(transfer.amount),
  occurred_at: utcToLocalInput(transfer.occurredAt, settings.timezone),
});

const blankEntryValues = (options: LedgerEntryAddOption[]) => ({
  amount: "",
  entry_type: options[0]!.type,
  occurred_at: utcToLocalInput(nowIso(), settings.timezone),
});

const addOptions = (account: AccountRef): LedgerEntryAddOption[] =>
  manualLedgerEntryOptionsFor(account).map((option) => ({
    ...option,
    hint: t(option.hintKey),
    label: t(option.labelKey),
  }));

const loadAddableAccount = async (
  type: string,
  ref: string,
): Promise<{
  account: AccountRef;
  names: LedgerNames;
  options: LedgerEntryAddOption[];
} | null> => {
  const account = accountFromRoute(type, ref);
  if (!account || !isRowAccountType(account.type)) return null;
  const options = addOptions(account);
  if (options.length === 0) return null;
  const names = await loadLedgerNamesForAccounts([account]);
  return hasLedgerName(account.type, account.id, names)
    ? { account, names, options }
    : null;
};

type OwnerLedgerFormHandler = ResponseHandler<
  [session: AuthSession, form: FormParams]
>;

const ownerLedgerForm = (
  request: Request,
  handler: OwnerLedgerFormHandler,
): Promise<Response> => withAuth(request, OWNER_FORM, handler);

const accountStatementPath = (account: AccountRef): string =>
  `/admin/ledger/${account.type}/${account.id}`;

const getEditableTransferById = async (
  id: number,
): Promise<Transfer | null> => {
  const transfer = await getTransferById(id);
  return transfer && isManualLedgerTransfer(transfer) ? transfer : null;
};

type PostedTransfer = {
  transfer: Transfer;
  returnUrl: string;
  redirectUrl: string;
};

const editPostedTransfer = async (
  id: number,
  form: FormParams,
): Promise<PostedTransfer | null> => {
  const transfer = await getEditableTransferById(id);
  if (!transfer) return null;
  const returnUrl = returnUrlFromForm(form, "/admin/ledger");
  return { redirectUrl: editEntryPath(id, returnUrl), returnUrl, transfer };
};

type PostedTransferHandler = ResponseHandler<
  [posted: PostedTransfer, form: FormParams]
>;

/** Load the record an entry GET page is about, then render the page with the
 * request's flash error and return URL. A missing record renders nothing
 * (null), which the owner page wrappers turn into a 404. Shared by the add
 * and edit pages so the load-flash-render shape stays one mechanism. */
const loadedEntryPage = async <Loaded>(
  request: Request,
  load: Promise<Loaded | null>,
  fallbackReturnUrl: (loaded: Loaded) => string,
  render: (
    loaded: Loaded,
    error: string | undefined,
    returnUrl: string,
  ) => string | Promise<string>,
): Promise<string | null> => {
  const loaded = await load;
  if (!loaded) return null;
  const flash = applyFlash(request);
  return render(
    loaded,
    flash.error,
    returnUrlFromRequest(request, fallbackReturnUrl(loaded)),
  );
};

const postedTransferRoute =
  (handler: PostedTransferHandler) =>
  (request: Request, params: IdParam): Promise<Response> =>
    ownerLedgerForm(request, async (_session, form) => {
      const posted = await editPostedTransfer(params.id, form);
      return posted ? handler(posted, form) : notFoundResponse();
    });

export const handleLedgerEntryAddGet: TypedRouteHandler<"GET /admin/ledger/:type/:ref/add"> =
  ownerTypeRefHtml((request, session, { type, ref }) =>
    loadedEntryPage(
      request,
      loadAddableAccount(type, ref),
      (loaded) => accountStatementPath(loaded.account),
      (loaded, error, returnUrl) =>
        adminLedgerEntryNewPage({
          ...loaded,
          error,
          returnUrl,
          session,
          values: blankEntryValues(loaded.options),
        }),
    ),
  );

export const handleLedgerEntryAddPost: TypedRouteHandler<
  "POST /admin/ledger/:type/:ref/add"
> = (request, { type, ref }) =>
  ownerLedgerForm(request, async (session, form) => {
    const loaded = await loadAddableAccount(type, ref);
    if (!loaded) return notFoundResponse();
    const returnUrl = returnUrlFromForm(
      form,
      accountStatementPath(loaded.account),
    );
    const redirectUrl = addEntryPath(loaded.account, returnUrl);
    const parsed = defineLedgerEntryAddForm(loaded.options).validate(form);
    if (!parsed.valid) return errorRedirect(redirectUrl, parsed.error);
    await postManualLedgerEntry({
      account: loaded.account,
      amount: parsed.values.amount,
      occurredAt: parsed.values.occurred_at,
      postedBy: String(session.userId),
      type: parsed.values.entry_type,
    });
    await logActivity("Manual ledger entry added");
    return redirect(returnUrl, t("admin.ledger.flash.added"), true);
  });

export const handleLedgerEntryEditGet: TypedRouteHandler<
  "GET /admin/ledger/entries/:id/edit"
> = (request, { id }) =>
  ownerHtml(request, (session) =>
    loadedEntryPage(
      request,
      getEditableTransferById(id),
      () => "/admin/ledger",
      async (transfer, error, returnUrl) =>
        adminLedgerEntryEditPage({
          error,
          names: await loadLedgerNames([transfer]),
          returnUrl,
          session,
          transfer,
          values: transferFormValues(transfer),
        }),
    ),
  );

const updatePostedTransfer: PostedTransferHandler = async (posted, form) => {
  const parsed = ledgerEntryForm.validate(form);
  if (!parsed.valid) return errorRedirect(posted.redirectUrl, parsed.error);
  await updateManualLedgerEntry(
    posted.transfer,
    parsed.values.amount,
    parsed.values.occurred_at,
  );
  await logActivity(`Ledger entry #${posted.transfer.id} updated`);
  return redirect(posted.returnUrl, t("admin.ledger.flash.updated"), true);
};

const deletePostedTransfer: PostedTransferHandler = async (posted, form) => {
  if (
    !verifyIdentifier(
      formatCurrency(posted.transfer.amount),
      form.getString("confirm_identifier"),
    )
  ) {
    return errorRedirect(
      posted.redirectUrl,
      t("admin.ledger.delete.amount_mismatch"),
    );
  }
  await deleteManualLedgerEntry(posted.transfer);
  await logActivity(`Ledger entry #${posted.transfer.id} deleted`);
  return redirect(posted.returnUrl, t("admin.ledger.flash.deleted"), true);
};

export const handleLedgerEntryEditPost: TypedRouteHandler<"POST /admin/ledger/entries/:id/edit"> =
  postedTransferRoute(updatePostedTransfer);

export const handleLedgerEntryDeletePost: TypedRouteHandler<"POST /admin/ledger/entries/:id/delete"> =
  postedTransferRoute(deletePostedTransfer);
