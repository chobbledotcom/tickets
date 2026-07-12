/**
 * The editable attendee form (create + edit).
 *
 * An attendee has ONE shared date range — a start date plus a length —
 * applied to every daily listing they book. The listing editor is a fixed
 * table with one quantity box per bookable listing (plus any inactive
 * listing the attendee already booked); quantity ≥ 1 books it, 0 leaves it
 * out, so there are no add/remove-line buttons. When something is already
 * booked (an edit, or a create pre-filled from the calendar) the not-booked
 * rows hide behind a "Show all listings" toggle (pure CSS); a bare create
 * form has nothing booked, so it drops the toggle and shows every listing.
 * The form works without JavaScript.
 *
 * `attendeeFormPage` is the standalone /admin/attendees/new page;
 * {@link AttendeeFormPanel} is the same warnings + errors + form block the
 * attendee entity page's Edit tab embeds.
 */

import { compact } from "#fp";
import { t } from "#i18n";
import type { BalanceNotice } from "#routes/admin/attendee-form-model.ts";
import {
  ATTENDEE_FORM_ID,
  type AttendeeFormLine,
  DAY_COUNT_FIELD,
  isPaymentLockedLine,
  isRetainedLine,
  LINE_KEY_PREFIX,
  LINE_LISTING_PREFIX,
  LINE_PACKAGE_PREFIX,
  NO_QUANTITY_PREFIX,
  type ParsedAttendeeForm,
  QTY_PREFIX,
  resolveStatusId,
  SHOW_ALL_FIELD,
  SHOW_PACKAGE_PATHS_FIELD,
  STATUS_FIELD,
} from "#routes/admin/attendee-form-model.ts";
import {
  type AttendeeLogisticsData,
  endAgentField,
  endTimeField,
  SPLIT_AGENTS_FIELD,
  startAgentField,
  startTimeField,
} from "#routes/admin/attendee-logistics.ts";
import {
  addDays,
  formatDateLabel,
  formatDateRangeLabel,
} from "#shared/dates.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { START_DATE_FIELD } from "#shared/order-select.ts";
import {
  type AdminSession,
  type Attendee,
  MAX_DURATION_DAYS,
} from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import {
  BookingStatusBadges,
  InactiveNote,
} from "#templates/admin/attendee-detail.tsx";
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

/** Template data for the attendee form: everything the editable form itself
 * renders. The other tabs' data (log, ledger, notes, contact history) lives
 * with those tabs, not here. */
export type AttendeeFormTemplateData = {
  /** "create" or "edit". */
  mode: "create" | "edit";
  /** Parsed form values (shared range + one line per rendered listing). */
  parsed: ParsedAttendeeForm;
  /** Attendee being edited (edit mode only; create mode passes null). */
  attendee: Attendee | null;
  /** All attendee statuses, for the status dropdown. */
  statuses: AttendeeStatus[];
  /** Status/balance mismatch notice, or null when they agree. */
  balanceNotice: BalanceNotice | null;
  /** True when the attendee's existing daily bookings disagree on date/length —
   * saving normalises them onto the one shared range. */
  hasMixedTimings: boolean;
  /** True when at least one daily listing is in play (active, or already booked
   * by this attendee). The shared date range only affects daily listings, so the
   * whole Dates section is hidden when this is false. */
  hasDailyListings: boolean;
  /** Attendee-level error (e.g. "Name is required"). */
  attendeeError: string | null;
  /** Shared-date error (e.g. missing start date for a booked daily listing). */
  dateError: string | null;
  /** Form-wide error shown above the form (e.g. a paid line was marked
   * no-quantity), kept out of the per-line quantity table. */
  formError: string | null;
  /** A recoverable save failure (capacity, no lines) shown above the form on
   * the in-place 400 re-render. */
  saveError?: string | undefined;
  /** Custom questions across the attendee's booked listings. */
  questions: QuestionWithAnswers[];
  /** Currently-selected answer ids for the rendered questions. */
  selectedAnswerIds: number[];
  /** Currently-entered free-text answers, keyed by question id. */
  selectedTextAnswers: Map<number, string>;
  /** Optional return URL the caller came from. */
  returnUrl?: string | undefined;
  /** Overbooking / over-duration warnings per listing id (booked lines only). */
  lineWarnings: Map<number, string[]>;
  /** Live package names by group id, for each line's "via <package>" label. */
  packageNamesById: Map<number, string>;
  /** Parent listing names, for a folded row's "add-on under <parent>" label. */
  parentNamesById: Map<number, string>;
  /** All warnings flattened, for the top-of-form summary. */
  topWarnings: string[];
  /** Logistics selectors data, or undefined when logistics doesn't apply. */
  logistics?: AttendeeLogisticsData | undefined;
};

/** Props for the attendee-form parts that take only the whole form data. */
type AttendeeFormProps = { data: AttendeeFormTemplateData };

/** The line's booking-path label: "via <package>" for a package path (its id
 * when the package no longer exists), "add-on under <parent>" for a folded
 * child row, nothing for the listing's own row. */
const pathLabel = (
  line: AttendeeFormLine,
  data: AttendeeFormTemplateData,
): string | null => {
  if (line.packageGroupId > 0) {
    const name = data.packageNamesById.get(line.packageGroupId);
    return name === undefined
      ? t("attendee_form.path_missing_package", { id: line.packageGroupId })
      : t("attendee_form.path_via_package", { name });
  }
  if (line.parentListingId > 0) {
    return t("attendee_form.path_addon_under", {
      name:
        data.parentNamesById.get(line.parentListingId) ??
        String(line.parentListingId),
    });
  }
  return null;
};

/** Which CSS bucket a line renders in: a row with a booking (or a submitted
 * quantity) always shows; a blank package-path line hides behind the "show
 * package options" toggle; a blank standalone line behind "show all
 * listings". */
const lineRowClass = (line: AttendeeFormLine, booked: boolean): string => {
  if (booked) return "attendee-line";
  return line.packageGroupId > 0
    ? "attendee-line attendee-line-package-blank"
    : "attendee-line attendee-line-empty";
};

/** One row of the listing editor — one booking path and its quantity box. */
const ListingRow = ({
  line,
  index,
  warnings,
  data,
}: {
  line: AttendeeFormLine;
  index: number;
  warnings: string[];
  data: AttendeeFormTemplateData;
}): JSX.Element => {
  const listing = line.listing!;
  const booked = isRetainedLine(line) || Boolean(line.existingBooking);
  const isDaily = listing.listing_type === "daily";
  const label = pathLabel(line, data);
  // A paid line can't be marked no-quantity until its charge is refunded, so the
  // box is disabled with an explaining tooltip rather than left to fail on save.
  const paymentLocked = isPaymentLockedLine(line);
  return (
    <tr class={lineRowClass(line, booked)}>
      <td>
        <a href={`/admin/listing/${listing.id}`}>{listing.name}</a>
        {label ? <span class="muted small booking-path"> {label}</span> : null}
        <InactiveNote active={listing.active} />
        {BookingStatusBadges({
          checkedIn: Boolean(line.existingBooking?.checked_in),
          refunded: Boolean(line.existingBooking?.refunded),
        })}
      </td>
      <td>
        <span class="muted small">
          {isDaily
            ? t("attendee_form.shared_dates")
            : t("attendee_form.fixed_date")}
        </span>
      </td>
      <td class="attendee-line-qty">
        <input
          aria-label={t("attendee_form.qty_aria", { title: listing.name })}
          class="line-qty"
          max={listing.max_quantity}
          min="0"
          name={`${QTY_PREFIX}${index}`}
          style="width:5em"
          type="number"
          value={line.quantity === null ? "0" : String(line.quantity)}
        />
        <label class="small">
          <input
            checked={line.noQuantity}
            class="no-quantity-toggle"
            disabled={paymentLocked}
            name={`${NO_QUANTITY_PREFIX}${index}`}
            title={
              paymentLocked
                ? t("attendee_form.paid_no_quantity_line")
                : undefined
            }
            type="checkbox"
            value="1"
          />
          {t("attendee_form.no_quantity")}
        </label>
        <input
          name={`${LINE_LISTING_PREFIX}${index}`}
          type="hidden"
          value={String(line.listingId)}
        />
        <input
          name={`${LINE_KEY_PREFIX}${index}`}
          type="hidden"
          value={line.key}
        />
        {line.packageGroupId > 0 ? (
          <input
            name={`${LINE_PACKAGE_PREFIX}${index}`}
            type="hidden"
            value={String(line.packageGroupId)}
          />
        ) : null}
      </td>
      <td>
        {line.existingBooking?.start_at ? (
          <div class="muted small">
            {formatDateRangeLabel(
              line.existingBooking.start_at,
              line.existingBooking.end_at,
            )}
          </div>
        ) : null}
        {line.error ? <ErrorAlert>{line.error}</ErrorAlert> : null}
        {warnings.map((w) => (
          <div class="warning small" role="alert">
            {w}
          </div>
        ))}
      </td>
    </tr>
  );
};

/** The fixed listing editor: one quantity box per listing. When at least one
 * line is already booked — an edit, or a create deep-linked from the calendar
 * with pre-selected listings — the not-booked rows tuck behind an un-ticked
 * "Show all listings" toggle (pure CSS). A bare create form has nothing booked,
 * so every row would hide behind that toggle; there we drop it and show every
 * listing instead. */
const ListingEditor = ({ data }: AttendeeFormProps): JSX.Element => {
  const hasBookedLines = data.parsed.lines.some(
    (line) => isRetainedLine(line) || Boolean(line.existingBooking),
  );
  const hasPackagePathLines = data.parsed.lines.some(
    (line) => !line.existingBooking && line.packageGroupId > 0,
  );
  return (
    <div
      class={
        hasBookedLines ? "listing-editor" : "listing-editor show-all-listings"
      }
    >
      {hasBookedLines && (
        <label class="show-all">
          <input
            class="show-all-toggle"
            name={SHOW_ALL_FIELD}
            type="checkbox"
          />
          {t("attendee_form.show_all_listings")}
        </label>
      )}
      {hasPackagePathLines && (
        <label class="show-all">
          <input
            class="package-paths-toggle"
            name={SHOW_PACKAGE_PATHS_FIELD}
            type="checkbox"
          />
          {t("attendee_form.show_package_paths")}
        </label>
      )}
      <div class="table-scroll">
        <table class="line-editor">
          <thead>
            <tr>
              <th>{t("terms.listing")}</th>
              <th>{t("attendee_form.col_dates")}</th>
              <th>{t("attendee_form.col_qty")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.parsed.lines.map((line, index) => (
              <ListingRow
                data={data}
                index={index}
                line={line}
                warnings={data.lineWarnings.get(line.listingId) ?? []}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/** The one assignment a leg (or leg pair) renders: its agents, the start/end
 * times and agent ids, and — for a split per-listing pair — the listing id. */
type LogisticsAssignmentProps = {
  agents: AttendeeLogisticsData["agents"];
  assignment: AttendeeLogisticsData["single"];
  listingId?: number | undefined;
};

/** One leg (start or end) as a single tidy row: a label, the time-of-day input
 * (logistics metadata only; never availability) and the agent select. Used for
 * the shared single pair (listingId omitted) or a specific listing (split). */
const LogisticsLeg = ({
  agents,
  leg,
  assignment,
  listingId,
}: LogisticsAssignmentProps & {
  leg: "start" | "end";
}): JSX.Element => {
  const isStart = leg === "start";
  const label = isStart
    ? t("attendee_form.start_leg")
    : t("attendee_form.end_leg");
  const time = isStart ? assignment.startTime : assignment.endTime;
  const agentId = isStart ? assignment.startAgentId : assignment.endAgentId;
  return (
    <div class="logistics-leg">
      <span class="logistics-leg-label">{label}</span>
      <input
        aria-label={
          isStart
            ? t("attendee_form.leg_time_start")
            : t("attendee_form.leg_time_end")
        }
        name={(isStart ? startTimeField : endTimeField)(listingId)}
        type="time"
        value={time}
      />
      <select
        aria-label={
          isStart
            ? t("attendee_form.leg_agent_start")
            : t("attendee_form.leg_agent_end")
        }
        class="logistics-leg-agent"
        name={(isStart ? startAgentField : endAgentField)(listingId)}
      >
        <option selected={agentId === null} value="">
          {t("attendee_form.agent_none")}
        </option>
        {agents.map((agent) => (
          <option selected={agent.id === agentId} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
    </div>
  );
};

/** Both legs (start then end) of one assignment, as a start/end row pair. The
 * shared single pair omits `listingId`; a split per-listing pair passes it. */
const LogisticsLegPair = ({
  agents,
  assignment,
  listingId,
}: LogisticsAssignmentProps): JSX.Element => (
  <>
    <LogisticsLeg
      agents={agents}
      assignment={assignment}
      leg="start"
      listingId={listingId}
    />
    <LogisticsLeg
      agents={agents}
      assignment={assignment}
      leg="end"
      listingId={listingId}
    />
  </>
);

/**
 * Logistics agent + time selectors for logistics listings. A "different agents
 * per item" checkbox switches (pure CSS) between one shared start/end pair and
 * a pair per logistics listing. Grouped in a fieldset/legend like the listing
 * editor. Only rendered when logistics applies. Shared by the Edit tab's form
 * and the Logistics tab's form (attendee-logistics-tab.tsx).
 */
export const LogisticsSection = ({
  logistics,
}: {
  logistics: AttendeeLogisticsData | undefined;
}): JSX.Element | null => {
  if (!logistics) return null;
  return (
    <fieldset class="logistics-agents listing-section">
      <legend>{t("attendee_form.logistics_heading")}</legend>
      <label class="split-agents">
        <input
          checked={logistics.split}
          class="split-agents-toggle"
          name={SPLIT_AGENTS_FIELD}
          type="checkbox"
          value="1"
        />
        {t("attendee_form.split_agents")}
      </label>
      <div class="logistics-single">
        <LogisticsLegPair
          agents={logistics.agents}
          assignment={logistics.single}
        />
      </div>
      <div class="logistics-split">
        {logistics.lines.map((line) => (
          <fieldset class="logistics-line">
            <legend>{line.name}</legend>
            <LogisticsLegPair
              agents={logistics.agents}
              assignment={line.assignment}
              listingId={line.listingId}
            />
          </fieldset>
        ))}
      </div>
    </fieldset>
  );
};

/** Option list for the day-count select: 1…horizon, each labelled with the
 * resulting end date when a start date is known. */
const dayCountOptions = (startDate: string): SelectOption[] => {
  const options: SelectOption[] = [];
  for (let n = 1; n <= MAX_DURATION_DAYS; n++) {
    const label = startDate
      ? t("attendee_form.day_count_option_with_end", {
          count: n,
          end: formatDateLabel(addDays(startDate, n - 1)),
        })
      : t("attendee_form.day_count_option", { count: n });
    options.push({ label, value: String(n) });
  }
  return options;
};

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
}): JSX.Element => {
  const {
    active = "/admin/attendees",
    children,
    prose,
    session,
    title,
  } = props;
  return (
    <AdminPage active={active} session={session} title={title}>
      <ProseHeading heading={title}>{prose}</ProseHeading>
      {children}
    </AdminPage>
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
