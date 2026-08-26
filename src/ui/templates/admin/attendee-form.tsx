/**
 * The editable attendee form (create and edit).
 *
 * An attendee has ONE shared date range — a start date plus a length — applied
 * to every daily listing they book. The listing editor is a fixed table with
 * one quantity box per bookable listing, so a quantity of 1 or more books it
 * and 0 leaves it out. There are no add-line or remove-line buttons, and the
 * form works without JavaScript.
 */

/* jscpd:ignore-start */
import { compact, range } from "#fp";
import { t } from "#i18n";
import {
  ATTENDEE_FORM_ID,
  DAY_COUNT_FIELD,
  resolveStatusId,
  STATUS_FIELD,
} from "#routes/admin/attendee-form-model.ts";
import { addDays, formatDateLabel } from "#shared/dates.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { START_DATE_FIELD } from "#shared/order-select.ts";
import { AdminPage, renderAdminPage } from "#templates/admin/admin-page.tsx";
import { ListingEditor } from "#templates/admin/attendee-form/listing-editor.tsx";
import { LogisticsSection } from "#templates/admin/attendee-form/logistics.tsx";
import type {
  AttendeeFormProps,
  AttendeeFormTemplateData,
} from "#templates/admin/attendee-form/types.ts";
import { EditQuestions } from "#templates/admin/attendees.tsx";
import { SaveActions } from "#templates/components/actions.tsx";
import { AddressFieldWithLookup } from "#templates/components/address-field.tsx";
import {
  type FormSection,
  FormSections,
} from "#templates/components/aggregate-sections.tsx";
import { ErrorAlert } from "#templates/components/error.tsx";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
import {
  SelectField,
  type SelectOption,
} from "#templates/components/select-field.tsx";
import { PHONE_INPUT_PATTERN } from "#templates/fields/ticket.ts";
import { type AdminSession, MAX_DURATION_DAYS } from "#types";

/* jscpd:ignore-end */

/** Option list for the day-count select: 1…horizon, each labelled with the
 * resulting end date when a start date is known. */
const dayCountOptions = (startDate: string): SelectOption[] =>
  range(1, MAX_DURATION_DAYS + 1).map((n) => ({
    label: startDate
      ? t("attendee_form.day_count_option_with_end", {
          count: n,
          end: formatDateLabel(addDays(startDate, n - 1)),
        })
      : t("attendee_form.day_count_option", { count: n }),
    value: String(n),
  }));

/** Shared start date + length for every daily listing. The length is a select
 * of day counts (the end date is derived, never edited directly). The
 * "availability inaccurate" notice shows until a date is saved, and a small
 * progressive-enhancement script (client/admin/attendee-dates.ts) re-shows it
 * when the dates are changed and reveals the length select once a start date is
 * set.
 *
 * The dates only apply to daily listings, so the whole section is hidden when
 * there are none in play, and the start date is never HTML-`required` — it's
 * optional unless a daily listing is actually booked, which the server enforces. */
const SharedDateFields = ({ data }: AttendeeFormProps): JSX.Element => {
  // Shown when there's no saved/known date yet (a bare create form); the PE
  // re-shows it whenever the dates are dirtied so the operator re-saves.
  const noticeHidden = !(data.mode === "create" && !data.parsed.startDate);
  return (
    <>
      <p class="small">{t("attendee_form.dates_hint")}</p>
      {data.dateError && <ErrorAlert>{data.dateError}</ErrorAlert>}
      <label for={START_DATE_FIELD}>
        {t("attendee_form.start_date")}
        <input
          id={START_DATE_FIELD}
          name={START_DATE_FIELD}
          type="date"
          value={data.parsed.startDate}
        />
      </label>
      <output class="warning" data-availability-notice hidden={noticeHidden}>
        {t("attendee_form.availability_notice")}
      </output>
      <label data-day-count-label for={DAY_COUNT_FIELD}>
        {t("attendee_form.length")}
        <SelectField
          id={DAY_COUNT_FIELD}
          name={DAY_COUNT_FIELD}
          options={dayCountOptions(data.parsed.startDate)}
          value={String(data.parsed.dayCount)}
        />
      </label>
    </>
  );
};

/**
 * The status dropdown and a status/balance mismatch notice (precomputed by the
 * route). The outstanding balance itself is not editable here — it projects
 * from the money ledger, and owners adjust it through the ledger (an auditable
 * write-off correction) rather than a free-text field on this form.
 */
const StatusField = ({ data }: AttendeeFormProps): JSX.Element => {
  const { statusId } = data.parsed;
  const selectedId = resolveStatusId(statusId, data.statuses);
  return (
    <>
      {data.balanceNotice && (
        <output class={data.balanceNotice.tone}>
          {data.balanceNotice.message}
        </output>
      )}
      {data.statuses.length <= 1 ? (
        <input name={STATUS_FIELD} type="hidden" value={selectedId} />
      ) : (
        <label for={STATUS_FIELD}>
          {t("common.status")}
          <SelectField
            id={STATUS_FIELD}
            name={STATUS_FIELD}
            options={data.statuses.map((s) => ({
              label: s.name,
              value: String(s.id),
            }))}
            value={String(selectedId)}
          />
        </label>
      )}
    </>
  );
};

/**
 * True when the last submit left any error on the form — an attendee, date,
 * form-wide, save, or per-line error. When it did, each error is an
 * {@link ErrorAlert} (focusable), so the browser hands autofocus to the first
 * one and scrolls straight to it; the name field then gives up its default
 * autofocus so a failed submit lands on the problem, not the page top.
 */
const formHasError = (data: AttendeeFormTemplateData): boolean =>
  Boolean(
    data.saveError || data.formError || data.attendeeError || data.dateError,
  ) || data.parsed.lines.some((line) => line.error !== null);

/**
 * The editable attendee form: contact details, the shared date range, optional
 * custom questions, and the listing editor — all inside one CsrfForm. The
 * CsrfForm renders the flash inline when a redirect targeted this form's id.
 */
/** The attendee's own contact fields — name, status, and the optional email,
 * phone, address, and special instructions. The form's first section. */
const ContactDetailFields = ({ data }: AttendeeFormProps): JSX.Element => (
  <>
    <label for="name">
      {t("common.name")}
      <input
        autocomplete="off"
        autofocus={!formHasError(data)}
        id="name"
        name="name"
        required
        type="text"
        value={data.parsed.name}
      />
    </label>

    <StatusField data={data} />

    <label for="email">
      {t("common.email")}
      <input
        autocomplete="off"
        id="email"
        name="email"
        type="email"
        value={data.parsed.email || ""}
      />
    </label>

    <label for="phone">
      {t("common.phone")}
      <input
        autocomplete="off"
        id="phone"
        name="phone"
        pattern={PHONE_INPUT_PATTERN}
        title={t("attendee_form.phone_title")}
        type="text"
        value={data.parsed.phone || ""}
      />
    </label>

    <AddressFieldWithLookup address={data.parsed.address || ""} />

    <label for="special_instructions">
      {t("common.special_instructions")}
      <textarea
        autocomplete="off"
        id="special_instructions"
        maxlength={250}
        name="special_instructions"
        rows={3}
      >
        {data.parsed.special_instructions || ""}
      </textarea>
    </label>
  </>
);

/** The form's sections in order: contact details, then the custom questions
 * and shared dates when they apply, then the listing registrations. Each is a
 * legend-led {@link FormSection}, so a header can never regress to a bare
 * heading. */
const editFormSections = (data: AttendeeFormTemplateData): FormSection[] =>
  compact([
    {
      children: <ContactDetailFields data={data} />,
      legend: t("attendee_form.details_heading"),
    },
    data.questions.length > 0
      ? {
          children: (
            <EditQuestions
              questions={data.questions}
              selectedAnswerIds={data.selectedAnswerIds}
              selectedTextAnswers={data.selectedTextAnswers}
            />
          ),
          legend: t("attendee_form.custom_questions"),
        }
      : undefined,
    data.hasDailyListings
      ? {
          children: <SharedDateFields data={data} />,
          legend: t("attendee_form.dates_heading"),
        }
      : undefined,
    {
      children: (
        <>
          {data.hasMixedTimings && (
            <output class="warning">
              {t("attendee_form.mixed_timings_warning")}
            </output>
          )}
          <ListingEditor data={data} />
        </>
      ),
      legend: t("attendee_form.registrations_heading"),
    },
  ]);

const AttendeeEditForm = ({ data }: AttendeeFormProps): JSX.Element => {
  const isEdit = data.mode === "edit";
  const formAction =
    data.mode === "create"
      ? "/admin/attendees/new"
      : `/admin/attendees/${data.attendee!.id}`;
  return (
    <CsrfForm action={formAction} id={ATTENDEE_FORM_ID}>
      {data.returnUrl && (
        <input name="return_url" type="hidden" value={data.returnUrl} />
      )}

      {/* Create renders its own title inside the form (the standalone page has
          no entity heading above it); edit gets its "Attendee: …" heading from
          the entity page shell. */}
      {!isEdit && <h1>{t("attendee_form.title_create")}</h1>}

      <FormSections sections={editFormSections(data)} />

      <LogisticsSection logistics={data.logistics} />

      <hr />

      <SaveActions>
        {isEdit ? t("attendee_form.save") : t("attendee_form.create")}
      </SaveActions>
    </CsrfForm>
  );
};

/**
 * The full form block: save/form errors, the warnings summary, the
 * attendee-level error, then the form itself. Rendered as the whole create
 * page and as the entity page's Edit tab.
 */
export const AttendeeFormPanel = ({ data }: AttendeeFormProps): JSX.Element => (
  <>
    {data.saveError && <ErrorAlert>{data.saveError}</ErrorAlert>}
    {data.formError && <ErrorAlert>{data.formError}</ErrorAlert>}
    {data.topWarnings.length > 0 && (
      <output class="warning" role="alert">
        <strong>{t("attendee_form.double_check")}</strong>
        <ul>
          {data.topWarnings.map((w) => (
            <li>{w}</li>
          ))}
        </ul>
      </output>
    )}
    {data.attendeeError && <ErrorAlert>{data.attendeeError}</ErrorAlert>}
    <AttendeeEditForm data={data} />
  </>
);

/**
 * The standard admin-attendees page shell: the {@link AdminPage} scaffold and
 * a `prose` heading whose `<h1>` reuses the page title. Extra prose
 * (below the heading) goes in `prose`; the page body (below the prose block)
 * goes in `children`. Shared by the create form and the contact-history editor.
 */
export const AttendeesPage = (props: {
  active?: string;
  children: JSX.Element;
  prose?: JSX.Element;
  session: AdminSession;
  title: string;
}): string => {
  const {
    active = "/admin/attendees",
    children,
    prose,
    session,
    title,
  } = props;
  return renderAdminPage(
    active,
    session,
    title,
    <>
      <ProseHeading heading={title}>{prose}</ProseHeading>
      {children}
    </>,
  );
};

/** Render the standalone create page (/admin/attendees/new). Edit renders
 * through the attendee entity page instead. */
export const attendeeFormPage = (
  data: AttendeeFormTemplateData,
  session: AdminSession,
): string =>
  String(
    // The title lives inside the form (see AttendeeEditForm), so the page shell
    // carries no prose heading of its own — just the <title> for the tab.
    <AdminPage
      active="/admin/attendees/new"
      session={session}
      title={t("attendee_form.title_create")}
    >
      <AttendeeFormPanel data={data} />
    </AdminPage>,
  );
