/**
 * Creating and saving attendees. Viewing one renders through `attendee-page.ts`.
 * The calendar deep-links a create with `?select_<id>=1&start_date=…`.
 *
 * A failure re-renders the submitted form in place and never redirects. Entered
 * data and per-line errors then survive without a stash that must live until
 * the next GET.
 */

import { attendeeStatuses } from "#db/attendee-statuses.ts";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { getAllListings } from "#db/listings/records.ts";
import { logisticsAgents } from "#db/logistics-agents.ts";
import type { SelectedQuestionAnswers } from "#db/question-types.ts";
import { parseQuestionAnswers } from "#db/questions/parsing.ts";
import { settings } from "#db/settings.ts";
/* jscpd:ignore-start */
import { identity, mapById } from "#fp";
import { t } from "#i18n";
import {
  type ParsedAttendeeForm,
  parseAttendeeForm,
  resolveStatusId,
} from "#routes/admin/attendee-form-model.ts";
import {
  applyCreate,
  applyEdit,
  type SaveOutcome,
} from "#routes/admin/attendee-form-save.ts";
import { validateParsedForm } from "#routes/admin/attendee-form-validation.ts";
import { parseLogisticsPlan } from "#routes/admin/attendee-logistics.ts";
import { attendeePage } from "#routes/admin/attendee-page.ts";
import {
  buildCreateForm,
  buildTemplateData,
  getRenderListings,
  loadAttendeeForEdit,
  loadPackagePaths,
  packagesByListingIdFrom,
} from "#routes/admin/attendee-page-data.ts";
import {
  emptySelectedQuestionAnswers,
  loadQuestionsForExisting,
} from "#routes/admin/attendee-questions.ts";
import {
  AUTH_FORM,
  type AuthSession,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";

import {
  ATTENDEE_DEMO_FIELDS,
  loadAfterDemoOverrides,
} from "#shared/demo/overrides.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  selectedListingQuantities,
  selectedStartDate,
} from "#shared/order-select.ts";
import { buildTaxSavePlan } from "#shared/tax/save.ts";
import type { AttendeeFormTemplateData } from "#templates/admin/attendee-form/types.ts";
import {
  AttendeeFormPanel,
  attendeeFormPage,
} from "#templates/admin/attendee-form.tsx";
import type { Attendee, ListingWithCount } from "#types";
/* jscpd:ignore-end */

/** Handle GET /admin/attendees/new — render the create form, pre-filled from a
 * calendar deep link when present. */
export const handleAttendeeNewGet: TypedRouteHandler<
  "GET /admin/attendees/new"
> = (request) =>
  requireSessionOr(request, async (session) => {
    applyFlash(request);
    const renderListings = await getRenderListings([]);
    const params = new URL(request.url).searchParams;
    const parsed = buildCreateForm(
      renderListings,
      await loadPackagePaths(),
      selectedListingQuantities(params),
      selectedStartDate(params),
    );
    const data = await buildTemplateData("create", parsed, null, {
      returnUrl: getSearchParam(request, "return_url"),
    });
    return htmlResponse(attendeeFormPage(data, session));
  });

// ---------------------------------------------------------------------------
// POST handlers — shared submit logic
// ---------------------------------------------------------------------------

/** Everything the submit handler needs about an attendee being edited. */
type EditContext = SelectedQuestionAnswers & {
  attendee: Attendee | null;
  existingByKey: Map<string, ListingAttendeeRow>;
};

const EMPTY_EDIT_CONTEXT: EditContext = {
  attendee: null,
  existingByKey: new Map(),
  ...emptySelectedQuestionAnswers(),
};

/** Edit mode: load the attendee, its existing lines (indexed by key), and its
 * question/answer context. Returns null when the attendee does not exist. */
const loadEditContext = async (
  attendeeId: number,
): Promise<EditContext | null> => {
  const loaded = await loadAttendeeForEdit(attendeeId);
  if (!loaded) return null;
  return {
    attendee: loaded.attendee,
    existingByKey: new Map(
      loaded.existing.map(({ key, booking }) => [key, booking]),
    ),
    ...(await loadQuestionsForExisting(attendeeId, loaded.existing)),
  };
};

/** Re-render the submitted form in place: the bare create page in create
 * mode, the entity page's Edit tab in edit mode. Entered values and their
 * errors survive deterministically, with no redirect or stash involved. */
const renderSubmittedForm = (
  session: AuthSession,
  data: AttendeeFormTemplateData,
): Promise<Response> =>
  // A null attendee is exactly create mode — the standalone page.
  data.attendee === null
    ? Promise.resolve(htmlResponse(attendeeFormPage(data, session)))
    : attendeePage.renderPage(session, data.attendee.id, "edit", {
        panel: () => Promise.resolve(AttendeeFormPanel({ data })),
      });

/** Common submit handler for create + edit. `attendeeId` is null in create. */
const handleSubmit =
  (mode: "create" | "edit", attendeeId: number | null) =>
  (request: Request): Promise<Response> =>
    withAuth(request, AUTH_FORM, (session, form) =>
      handleSubmitInner(mode, attendeeId, session, form),
    );

/** Inner submit logic — parse, validate, then run the atomic create or edit. */
const handleSubmitInner = async (
  mode: "create" | "edit",
  attendeeId: number | null,
  session: AuthSession,
  form: FormParams,
): Promise<Response> => {
  const edit = await loadAfterDemoOverrides(form, ATTENDEE_DEMO_FIELDS, () =>
    mode === "edit" && attendeeId !== null
      ? loadEditContext(attendeeId)
      : Promise.resolve(EMPTY_EDIT_CONTEXT),
  );
  if (edit === null) return notFoundResponse();
  const {
    atBooking,
    attendee,
    existingByKey,
    questions,
    selectedAnswerIds,
    selectedTextAnswers,
  } = edit;

  const listingsById = mapById(identity<ListingWithCount>)(
    await getAllListings(),
  );
  // Coerce a missing/blank status back to the public default (the form offers
  // no "no status" choice) — the same resolver the template pre-selects with.
  const statuses = await attendeeStatuses.getAll();
  const rawParsed = parseAttendeeForm(
    form,
    listingsById,
    existingByKey,
    packagesByListingIdFrom(await loadPackagePaths()),
  );
  const parsed: ParsedAttendeeForm = {
    ...rawParsed,
    statusId: resolveStatusId(rawParsed.statusId, statuses),
  };
  const renderOpts = {
    atBooking,
    questions,
    returnUrl: parsed.returnUrl,
    selectedAnswerIds,
    selectedTextAnswers,
  };

  const result = validateParsedForm(parsed);
  // Re-render the submitted form in place with the given errors merged onto
  // the render options — the validation and save failure paths share this.
  const showErrors = async (
    errors: Parameters<typeof buildTemplateData>[3],
  ): Promise<Response> =>
    renderSubmittedForm(
      session,
      await buildTemplateData(mode, result.values, attendee, {
        ...renderOpts,
        ...errors,
      }),
    );
  if (!result.valid) {
    return showErrors({
      attendeeError: result.attendeeError?.message ?? null,
      dateError: result.dateError,
      formError: result.formError,
    });
  }

  // The logistics plan is read from the submitted agent selects (only when the
  // feature is on). It is applied after the booking rows exist.
  const logisticsPlan = settings.features.logistics
    ? parseLogisticsPlan(
        form,
        parsed.lines,
        new Set((await logisticsAgents.getAll()).map((a) => a.id)),
      )
    : null;

  // Apply atomic create or edit. On a recoverable failure (capacity, no lines)
  // re-render the submitted form in place so entered data is never lost.
  let outcome: SaveOutcome;
  if (mode === "create") {
    outcome = await applyCreate(parsed, logisticsPlan, listingsById);
  } else {
    const answers = parseQuestionAnswers({ optional: true })(form, questions);
    if (!answers.ok) return showErrors({ formError: answers.error });
    const taxPlan = await buildTaxSavePlan(attendeeId!);
    if (
      taxPlan.preview.changed &&
      form.getString("tax_preview") !== taxPlan.preview.token
    ) {
      return showErrors({ saveError: t("attendee_form.tax_changed") });
    }
    outcome = await applyEdit(
      attendeeId!,
      parsed,
      attendee!,
      questions,
      answers,
      logisticsPlan,
      existingByKey,
      taxPlan,
    );
  }
  if (outcome.ok) return outcome.response;
  return showErrors({ saveError: outcome.saveError });
};

// ---------------------------------------------------------------------------
// POST route exports
// ---------------------------------------------------------------------------

/** Handle POST /admin/attendees/new — create a new attendee. */
export const handleAttendeeNewPost: TypedRouteHandler<"POST /admin/attendees/new"> =
  handleSubmit("create", null);

/** Handle POST /admin/attendees/:attendeeId — update an existing attendee. */
export const handleAttendeeEditPost: TypedRouteHandler<
  "POST /admin/attendees/:attendeeId"
> = (request, { attendeeId }) => handleSubmit("edit", attendeeId)(request);
