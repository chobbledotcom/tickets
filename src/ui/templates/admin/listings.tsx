/**
 * Admin listing page templates - detail, edit, delete
 */

import { compact, filter, joinStrings, map, pipe } from "#fp";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { formatCountdown } from "#routes/format.ts";
import { targetQuery } from "#shared/bulk-email.ts";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import {
  formatDateLabel,
  formatDatetimeLabel,
  formatDatetimeShort,
} from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { buildEmbedSnippets } from "#shared/embed.ts";
import { isReadOnly } from "#shared/env.ts";
import type { Field } from "#shared/forms.tsx";
import {
  booleanToCheckbox,
  ConfirmForm,
  CsrfForm,
  entityToFieldValues,
  type FieldValues,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { utcToLocalInput } from "#shared/timezone.ts";
import {
  type AdminSession,
  type Attendee,
  availableDayCounts,
  dayPriceFor,
  type Group,
  isPaidListing,
  type ListingWithCount,
  normalizeDurationDays,
} from "#shared/types.ts";
import { buildSharedDetailRows } from "#templates/admin/detail-rows.tsx";
import { ListingGroupSelect } from "#templates/admin/group-select.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  AttendeeTable,
  type AttendeeTableRow,
  type TableQuestionData,
} from "#templates/attendee-table.tsx";
import {
  MaybeButtonLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import {
  assignBuiltSiteField,
  attachmentField,
  getAddAttendeeFields,
  imageField,
  initialSiteMonthsField,
  listingFields,
  monthsPerUnitField,
  slugField,
} from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { renderListingImage } from "#templates/public.tsx";

/** Date option for the date filter dropdown */
export type DateOption = { value: string; label: string };

/** Attendee filter type */
export type AttendeeFilter = "all" | "in" | "out";

/** Re-export shared detail functions for template composition */
export {
  calculateTotalRevenue,
  countCheckedIn,
  countCheckedInRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";
/** Re-export formatAddressInline from shared module for template composition */
export { formatAddressInline } from "#templates/attendee-table.tsx";

import {
  buildAnswerSummaryRows as buildAnswerSummaryDetailRows,
  renderDetailRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";

/** Build answer count summary rows as an HTML string of <tr> elements */
export const buildAnswerSummaryRows = (
  questionData: TableQuestionData | undefined,
): string => renderDetailRows(buildAnswerSummaryDetailRows(questionData));

/** Check if listing is within 10% of capacity */
export const nearCapacity = (listing: ListingWithCount): boolean =>
  listing.attendee_count >= listing.max_attendees * 0.9;

/**
 * Check if an attendee has an incomplete/failed payment.
 * True when the listing is paid, the attendee has no payment reference,
 * but was charged a non-zero price (distinguishing from admin-added attendees
 * who have price_paid=0).
 */
export const isIncompletePayment = (
  attendee: Attendee,
  hasPaidListing: boolean,
): boolean =>
  hasPaidListing &&
  !attendee.payment_id &&
  Number.parseInt(attendee.price_paid, 10) > 0;

/** Render a single row in the Failed Payments table */
const FailedPaymentRow = ({
  attendee,
  listingId,
}: {
  attendee: Attendee;
  listingId: number;
}): string =>
  String(
    <tr>
      <td>{attendee.name}</td>
      <td>{attendee.quantity}</td>
      <td>{formatDatetimeShort(attendee.created)}</td>
      <td>
        <CsrfForm
          action={`/admin/listing/${listingId}/attendee/${attendee.id}/delete-incomplete`}
          class="inline"
        >
          <button class="link-button danger" type="submit">
            Delete
          </button>
        </CsrfForm>
      </td>
    </tr>,
  );

/** Render a table of attendees with failed/incomplete payments */
const FailedPaymentsTable = ({
  attendees,
  listingId,
}: {
  attendees: Attendee[];
  listingId: number;
}): string =>
  String(
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Qty</th>
          <th>Registered</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <Raw
          html={pipe(
            map((a: Attendee) => FailedPaymentRow({ attendee: a, listingId })),
            joinStrings,
          )(attendees)}
        />
      </tbody>
    </table>,
  );

/** Check-in message to display after toggling */
export type CheckinMessage = { name: string; status: string } | null;

/** Filter attendees by check-in status */
const filterAttendees = (
  attendees: Attendee[],
  activeFilter: AttendeeFilter,
): Attendee[] => {
  if (activeFilter === "in") {
    return filter((a: Attendee) => a.checked_in)(attendees);
  }
  if (activeFilter === "out") {
    return filter((a: Attendee) => !a.checked_in)(attendees);
  }
  return attendees;
};

/** Render a filter link, bold if active */
const FilterLink = ({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}): string =>
  active
    ? String(<strong>{label}</strong>)
    : String(<a href={href}>{label}</a>);

/** Build the path suffix for a checkin filter (preserves date query) */
const filterSuffix = (activeFilter: AttendeeFilter): string =>
  activeFilter === "all" ? "" : `/${activeFilter}`;

/** Date selector dropdown for daily listings */
const DateSelector = ({
  basePath,
  activeFilter,
  dateFilter,
  dates,
}: {
  basePath: string;
  activeFilter: AttendeeFilter;
  dateFilter: string | null;
  dates: DateOption[];
}): string => {
  const suffix = filterSuffix(activeFilter);
  const options = [
    `<option value="${basePath}${suffix}#attendees"${
      !dateFilter ? " selected" : ""
    }>All dates</option>`,
    ...dates.map(
      (d) =>
        `<option value="${basePath}${suffix}?date=${d.value}#attendees"${
          dateFilter === d.value ? " selected" : ""
        }>${d.label}</option>`,
    ),
  ].join("");
  return `<select data-nav-select aria-label="Filter by date">${options}</select>`;
};

/** Options for rendering the admin listing detail page */
/** Group + current attendee count, supplied when the listing is in a capped
 * group so the detail page can show group-wide capacity beneath the
 * listing's own. Only the cap > 0 case needs surfacing. */
export type GroupContext = {
  group: Group;
  attendeeCount: number;
};

export type AdminListingPageOptions = {
  listing: ListingWithCount;
  attendees: Attendee[];
  allowedDomain: string;
  session: AdminSession;
  checkinMessage?: CheckinMessage;
  activeFilter?: AttendeeFilter;
  dateFilter?: string | null;
  availableDates?: DateOption[];
  errorMessage?: string;
  phonePrefix?: string;
  successMessage?: string;
  questionData?: TableQuestionData;
  groupContext?: GroupContext;
  /** Whether any of the listing's attendees (across all dates) have an email
   * address — gates the owner-only "Email" action. */
  hasEmailableAttendees?: boolean;
};

/** Top action nav for the listing detail page */
const ListingActionNav = ({
  listing,
  dateFilter,
  hasPaidListing,
  isOwner,
  hasEmailableAttendees,
}: {
  listing: ListingWithCount;
  dateFilter: string | null;
  hasPaidListing: boolean;
  isOwner: boolean;
  hasEmailableAttendees: boolean;
}): JSX.Element => {
  const readOnly = isReadOnly();
  return (
    <nav>
      <ul>
        {!readOnly && (
          <li>
            <a href={`/admin/listing/${listing.id}/edit`}>Edit</a>
          </li>
        )}
        {!readOnly && (
          <li>
            <a href={`/admin/listing/${listing.id}/duplicate`}>Duplicate</a>
          </li>
        )}
        <li>
          <a href={`/admin/listing/${listing.id}/log`}>Log</a>
        </li>
        {!listing.purchase_only && (
          <li>
            <a href={`/admin/listing/${listing.id}/scanner`}>Scanner</a>
          </li>
        )}
        <li>
          <a href={`/admin/listing/${listing.id}/questions`}>Questions</a>
        </li>
        {!readOnly && (
          <li>
            <a href={`/admin/listing/${listing.id}/qr`}>Booking QR</a>
          </li>
        )}
        {isOwner && (
          <li>
            <MaybeButtonLink
              disabled={!hasEmailableAttendees}
              href={`/admin/emails${targetQuery({
                kind: "listing",
                listingId: listing.id,
              })}`}
              title={
                hasEmailableAttendees
                  ? undefined
                  : "No attendees have an email address"
              }
            >
              Email
            </MaybeButtonLink>
          </li>
        )}
        <li>
          <a
            href={`/admin/listing/${listing.id}/export${
              dateFilter ? `?date=${dateFilter}` : ""
            }`}
          >
            Export CSV
          </a>
        </li>
        {hasPaidListing && (
          <li>
            <a class="danger" href={`/admin/listing/${listing.id}/refund-all`}>
              Refund All
            </a>
          </li>
        )}
        {listing.active ? (
          <li>
            <a class="danger" href={`/admin/listing/${listing.id}/deactivate`}>
              Deactivate
            </a>
          </li>
        ) : (
          <li>
            <a href={`/admin/listing/${listing.id}/reactivate`}>Reactivate</a>
          </li>
        )}
        <li>
          <a class="danger" href={`/admin/listing/${listing.id}/delete`}>
            Delete
          </a>
        </li>
      </ul>
    </nav>
  );
};

/** Detail row listing each offered day count and its price, shown when a
 * listing has customisable days so owners can verify pricing at a glance. */
const CustomisableDaysRow = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => {
  const counts = availableDayCounts(listing);
  return (
    <tr>
      <th>Customisable Days</th>
      <td>
        Visitors choose 1&ndash;{normalizeDurationDays(listing.duration_days)}{" "}
        days.{" "}
        {counts.length > 0 ? (
          <span>
            {counts
              .map(
                (n) =>
                  `${n} day${n === 1 ? "" : "s"}: ${formatCurrency(
                    dayPriceFor(listing, n)!,
                  )}`,
              )
              .join(", ")}
          </span>
        ) : (
          <em>No day prices set</em>
        )}
      </td>
    </tr>
  );
};

/** Daily-specific schedule rows (bookable days, booking window) */
const DailyScheduleRows = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => (
  <>
    <tr>
      <th>Bookable Days</th>
      <td>{formatBookableDays(listing.bookable_days)}</td>
    </tr>
    <tr>
      <th>Booking Window</th>
      <td>
        {listing.minimum_days_before} to{" "}
        {listing.maximum_days_after === 0
          ? "unlimited"
          : listing.maximum_days_after}{" "}
        days from today
      </td>
    </tr>
    <tr>
      <th>Booking Duration</th>
      <td>{listing.duration_days} day(s)</td>
    </tr>
  </>
);

/** Attendee count cell content (varies by daily/date-filter state) */
const AttendeeCountDisplay = ({
  listing,
  isDaily,
  dateFilter,
  adjustedCount,
  completeQuantitySum,
}: {
  listing: ListingWithCount;
  isDaily: boolean;
  dateFilter: string | null;
  adjustedCount: number;
  completeQuantitySum: number;
}): JSX.Element => {
  if (isDaily && dateFilter) {
    const overCap = completeQuantitySum >= listing.max_attendees;
    return (
      <span class={overCap ? "danger-text" : ""}>
        {completeQuantitySum} / {listing.max_attendees} &mdash;{" "}
        {listing.max_attendees - completeQuantitySum} remain
      </span>
    );
  }
  const nearCap = adjustedCount >= listing.max_attendees * 0.9;
  return (
    <span class={nearCap ? "danger-text" : ""}>
      {adjustedCount}
      {!isDaily && (
        <>
          {" "}
          / {listing.max_attendees} &mdash;{" "}
          {listing.max_attendees - adjustedCount} remain
        </>
      )}
    </span>
  );
};

/** Attendees row (header + count summary + daily capacity note) */
const AttendeesSummaryRow = ({
  listing,
  isDaily,
  dateFilter,
  dailySuffix,
  adjustedCount,
  completeQuantitySum,
}: {
  listing: ListingWithCount;
  isDaily: boolean;
  dateFilter: string | null;
  dailySuffix: string;
  adjustedCount: number;
  completeQuantitySum: number;
}): JSX.Element => (
  <tr>
    <th>Listing Attendees{dailySuffix}</th>
    <td>
      <AttendeeCountDisplay
        adjustedCount={adjustedCount}
        completeQuantitySum={completeQuantitySum}
        dateFilter={dateFilter}
        isDaily={isDaily}
        listing={listing}
      />
      {isDaily && !dateFilter && (
        <>
          {" "}
          <small>Capacity of {listing.max_attendees} applies per date</small>
        </>
      )}
    </td>
  </tr>
);

/** Group capacity row shown below the listing-attendees row when the listing
 * belongs to a capped group. The label makes the group source explicit so
 * admins see why a not-yet-full listing might still be sold out. */
const GroupAttendeesRow = ({
  group,
  groupAttendeeCount,
  dailySuffix,
}: {
  group: Group;
  groupAttendeeCount: number;
  dailySuffix: string;
}): JSX.Element => {
  const remaining = Math.max(0, group.max_attendees - groupAttendeeCount);
  const overCap = groupAttendeeCount >= group.max_attendees;
  const nearCap = groupAttendeeCount >= group.max_attendees * 0.9;
  return (
    <tr>
      <th>Group Attendees{dailySuffix}</th>
      <td>
        <span class={overCap || nearCap ? "danger-text" : ""}>
          {groupAttendeeCount} / {group.max_attendees} &mdash; {remaining}{" "}
          remain
        </span>{" "}
        <small>
          across all listings in{" "}
          <a href={`/admin/groups/${group.id}`}>{group.name}</a>
        </small>
      </td>
    </tr>
  );
};

/** Listing details table - all listing metadata rows */
const ListingDetailsTable = ({
  listing,
  allowedDomain,
  ticketUrl,
  embedScriptCode,
  embedIframeCode,
  isDaily,
  dateFilter,
  dailySuffix,
  adjustedCount,
  completeQuantitySum,
  groupContext,
  sharedRowsHtml,
}: {
  listing: ListingWithCount;
  allowedDomain: string;
  ticketUrl: string;
  embedScriptCode: string;
  embedIframeCode: string;
  isDaily: boolean;
  dateFilter: string | null;
  dailySuffix: string;
  adjustedCount: number;
  completeQuantitySum: number;
  groupContext: GroupContext | undefined;
  sharedRowsHtml: string;
}): JSX.Element => (
  <article>
    <div class="table-scroll">
      <table class="listing-details-table">
        <tbody>
          <tr>
            <th colspan="2">{listing.name}</th>
          </tr>
          {listing.date && (
            <tr>
              <th>Listing Date</th>
              <td>
                <span>
                  <a href={`/admin/calendar?date=${listing.date.slice(0, 10)}`}>
                    {formatDatetimeLabel(listing.date)}
                  </a>{" "}
                  <small>
                    <em>({formatCountdown(listing.date)})</em>
                  </small>
                </span>
              </td>
            </tr>
          )}
          {listing.location && (
            <tr>
              <th>Location</th>
              <td>{listing.location}</td>
            </tr>
          )}
          <tr>
            <th>Listing Type</th>
            <td>{listing.listing_type === "daily" ? "Daily" : "Standard"}</td>
          </tr>
          {listing.customisable_days && (
            <CustomisableDaysRow listing={listing} />
          )}
          {listing.months_per_unit > 0 && (
            <tr>
              <th>Renewal</th>
              <td>{listing.months_per_unit} month(s) per ticket</td>
            </tr>
          )}
          {listing.non_transferable && (
            <tr>
              <th>Non-Transferable</th>
              <td>Yes &mdash; ID verification required at entry</td>
            </tr>
          )}
          {listing.hidden && (
            <tr>
              <th>Hidden</th>
              <td>Yes &mdash; not shown in public listings list</td>
            </tr>
          )}
          {listing.listing_type === "daily" && (
            <DailyScheduleRows listing={listing} />
          )}
          <tr>
            <th>Registration Closes</th>
            <td>
              {listing.closes_at ? (
                <span>
                  {formatDatetimeLabel(listing.closes_at)}{" "}
                  <small>
                    <em>({formatCountdown(listing.closes_at)})</em>
                  </small>
                </span>
              ) : (
                <em>No deadline</em>
              )}
            </td>
          </tr>
          <tr>
            <th>Public URL</th>
            <td>
              <a href={ticketUrl}>
                {`${allowedDomain}/ticket/${listing.slug}`}
              </a>
              <small>
                {" "}
                (<a href={`/ticket/${listing.slug}/qr`}>QR Code</a>)
              </small>
            </td>
          </tr>
          {listing.thank_you_url && (
            <tr>
              <th>
                <label for={`thank-you-url-${listing.id}`}>Thank You URL</label>
              </th>
              <td>
                <input
                  data-select-on-click
                  id={`thank-you-url-${listing.id}`}
                  readonly
                  type="text"
                  value={listing.thank_you_url}
                />
              </td>
            </tr>
          )}
          {listing.webhook_url && (
            <tr>
              <th>
                <label for={`webhook-url-${listing.id}`}>Webhook URL</label>
              </th>
              <td>
                <input
                  data-select-on-click
                  id={`webhook-url-${listing.id}`}
                  readonly
                  type="text"
                  value={listing.webhook_url}
                />
              </td>
            </tr>
          )}
          <tr>
            <th>
              <label for={`embed-script-${listing.id}`}>Embed Script</label>
            </th>
            <td>
              <input
                data-select-on-click
                id={`embed-script-${listing.id}`}
                readonly
                type="text"
                value={embedScriptCode}
              />
            </td>
          </tr>
          <tr>
            <th>
              <label for={`embed-iframe-${listing.id}`}>Embed Iframe</label>
            </th>
            <td>
              <input
                data-select-on-click
                id={`embed-iframe-${listing.id}`}
                readonly
                type="text"
                value={embedIframeCode}
              />
            </td>
          </tr>
          <AttendeesSummaryRow
            adjustedCount={adjustedCount}
            completeQuantitySum={completeQuantitySum}
            dailySuffix={dailySuffix}
            dateFilter={dateFilter}
            isDaily={isDaily}
            listing={listing}
          />
          {groupContext && (
            <GroupAttendeesRow
              dailySuffix={dailySuffix}
              group={groupContext.group}
              groupAttendeeCount={groupContext.attendeeCount}
            />
          )}
          <Raw html={sharedRowsHtml} />
        </tbody>
      </table>
    </div>
  </article>
);

/** Attendees filter links (All / Checked In / Checked Out) */
const AttendeesFilterLinks = ({
  basePath,
  dateQs,
  activeFilter,
}: {
  basePath: string;
  dateQs: string;
  activeFilter: AttendeeFilter;
}): JSX.Element => (
  <p>
    <Raw
      html={FilterLink({
        active: activeFilter === "all",
        href: `${basePath}${dateQs}#attendees`,
        label: "All",
      })}
    />
    {" / "}
    <Raw
      html={FilterLink({
        active: activeFilter === "in",
        href: `${basePath}/in${dateQs}#attendees`,
        label: "Checked In",
      })}
    />
    {" / "}
    <Raw
      html={FilterLink({
        active: activeFilter === "out",
        href: `${basePath}/out${dateQs}#attendees`,
        label: "Checked Out",
      })}
    />
  </p>
);

/** Attendees article section (header, optional check-in flash, filters, table) */
const AttendeesSection = ({
  allowedDomain,
  checkinMessage,
  isDaily,
  availableDates,
  activeFilter,
  dateFilter,
  basePath,
  dateQs,
  returnUrl,
  tableRows,
  questionData,
  phonePrefix,
}: {
  allowedDomain: string;
  checkinMessage: CheckinMessage | undefined;
  isDaily: boolean;
  availableDates: DateOption[];
  activeFilter: AttendeeFilter;
  dateFilter: string | null;
  basePath: string;
  dateQs: string;
  returnUrl: string;
  tableRows: AttendeeTableRow[];
  questionData: TableQuestionData | undefined;
  phonePrefix: string | undefined;
}): JSX.Element => {
  const checkedInLabel = checkinMessage?.status === "in" ? "in" : "out";
  const checkedInClass =
    checkinMessage?.status === "in"
      ? "checkin-message-in"
      : "checkin-message-out";
  return (
    <article>
      <div class="prose">
        <h2 id="attendees">Attendees</h2>
        {checkinMessage && (
          <p class={checkedInClass} id="message">
            Checked {checkinMessage.name} {checkedInLabel}
          </p>
        )}
      </div>
      {isDaily && availableDates.length > 0 && (
        <Raw
          html={DateSelector({
            activeFilter,
            basePath,
            dateFilter,
            dates: availableDates,
          })}
        />
      )}
      <AttendeesFilterLinks
        activeFilter={activeFilter}
        basePath={basePath}
        dateQs={dateQs}
      />
      <div class="table-scroll">
        <Raw
          html={AttendeeTable({
            activeFilter,
            allowedDomain,
            phonePrefix,
            questionData,
            returnUrl,
            rows: tableRows,
            showDate: isDaily,
            showListing: false,
          })}
        />
      </div>
    </article>
  );
};

/** Failed payments article (only rendered when there are incomplete attendees) */
const FailedPaymentsSection = ({
  attendees,
  listingId,
}: {
  attendees: Attendee[];
  listingId: number;
}): JSX.Element => (
  <article>
    <div class="prose">
      <h2 id="failed-payments">Failed Payments</h2>
      <p>{attendees.length} attendee(s) with unresolved payments</p>
    </div>
    <div class="table-scroll">
      <Raw html={FailedPaymentsTable({ attendees, listingId })} />
    </div>
  </article>
);

/** Add attendee form article (only rendered in writable mode) */
const AddAttendeeSection = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => (
  <article>
    <h2 id="add-attendee">Add Attendee</h2>
    <CsrfForm action={`/admin/listing/${listing.id}/attendee`}>
      <Raw
        html={renderFields(
          getAddAttendeeFields(
            listing.fields,
            listing.listing_type === "daily",
            listing.customisable_days && listing.listing_type === "daily"
              ? availableDayCounts(listing)
              : undefined,
          ),
        )}
      />
      <SubmitButton icon="plus">Add Attendee</SubmitButton>
    </CsrfForm>
  </article>
);

/** Compute derived attendee stats needed by the detail page */
const computeAttendeeStats = (
  listing: ListingWithCount,
  attendees: Attendee[],
  hasPaidListing: boolean,
): {
  incompleteAttendees: Attendee[];
  completeAttendees: Attendee[];
  adjustedCount: number;
  completeQuantitySum: number;
} => {
  const incompleteAttendees = hasPaidListing
    ? filter((a: Attendee) => isIncompletePayment(a, true))(attendees)
    : [];
  const completeAttendees = hasPaidListing
    ? filter((a: Attendee) => !isIncompletePayment(a, true))(attendees)
    : attendees;
  const adjustedCount =
    listing.attendee_count - sumQuantity(incompleteAttendees);
  const completeQuantitySum = sumQuantity(completeAttendees);
  return {
    adjustedCount,
    completeAttendees,
    completeQuantitySum,
    incompleteAttendees,
  };
};

export const adminListingPage = ({
  listing,
  attendees,
  allowedDomain,
  session,
  checkinMessage,
  activeFilter = "all",
  dateFilter = null,
  availableDates = [],
  errorMessage,
  phonePrefix,
  successMessage,
  questionData,
  groupContext,
  hasEmailableAttendees = false,
}: AdminListingPageOptions): string => {
  const ticketUrl = `https://${allowedDomain}/ticket/${listing.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } =
    buildEmbedSnippets(ticketUrl);
  const isDaily = listing.listing_type === "daily";
  const hasPaidListing = isPaidListing(listing);

  const {
    incompleteAttendees,
    completeAttendees,
    adjustedCount,
    completeQuantitySum,
  } = computeAttendeeStats(listing, attendees, hasPaidListing);

  const filteredAttendees = filterAttendees(completeAttendees, activeFilter);
  const dailySuffix = isDaily
    ? dateFilter
      ? ` (${formatDateLabel(dateFilter)})`
      : " (total)"
    : "";
  const sharedRows = buildSharedDetailRows({
    attendeeCount: isDaily && dateFilter ? completeQuantitySum : adjustedCount,
    attendees: completeAttendees,
    hasPaidListing,
    labelSuffix: dailySuffix,
    maxCapacity: isDaily && !dateFilter ? 0 : listing.max_attendees,
    questionData,
    skipAttendees: true,
  });
  const basePath = `/admin/listing/${listing.id}`;
  const dateQs = dateFilter ? `?date=${dateFilter}` : "";
  const suffix = filterSuffix(activeFilter);
  const returnUrl = `${basePath}${suffix}${dateQs}#attendees`;
  const tableRows: AttendeeTableRow[] = pipe(
    map(
      (a: Attendee): AttendeeTableRow => ({
        attendee: a,
        listingId: listing.id,
        listingName: listing.name,
      }),
    ),
  )(filteredAttendees);

  return String(
    <Layout title={`Listing: ${listing.name}`}>
      <AdminNav active="/admin/" session={session} />
      <ListingActionNav
        dateFilter={dateFilter}
        hasEmailableAttendees={hasEmailableAttendees}
        hasPaidListing={hasPaidListing}
        isOwner={session.adminLevel === "owner"}
        listing={listing}
      />
      <Flash success={successMessage} />
      {!listing.active && (
        <div class="error" role="alert">
          This listing is deactivated and cannot be booked
        </div>
      )}
      <Flash error={errorMessage} />
      <ListingDetailsTable
        adjustedCount={adjustedCount}
        allowedDomain={allowedDomain}
        completeQuantitySum={completeQuantitySum}
        dailySuffix={dailySuffix}
        dateFilter={dateFilter}
        embedIframeCode={embedIframeCode}
        embedScriptCode={embedScriptCode}
        groupContext={groupContext}
        isDaily={isDaily}
        listing={listing}
        sharedRowsHtml={renderDetailRows(sharedRows)}
        ticketUrl={ticketUrl}
      />
      <AttendeesSection
        activeFilter={activeFilter}
        allowedDomain={allowedDomain}
        availableDates={availableDates}
        basePath={basePath}
        checkinMessage={checkinMessage}
        dateFilter={dateFilter}
        dateQs={dateQs}
        isDaily={isDaily}
        phonePrefix={phonePrefix}
        questionData={questionData}
        returnUrl={returnUrl}
        tableRows={tableRows}
      />
      {incompleteAttendees.length > 0 && (
        <FailedPaymentsSection
          attendees={incompleteAttendees}
          listingId={listing.id}
        />
      )}
      {!isReadOnly() && <AddAttendeeSection listing={listing} />}
    </Layout>,
  );
};

/** Format an ISO datetime string for datetime-local input (YYYY-MM-DDTHH:MM) */
const formatDatetimeLocal = (iso: string | null): string | null => {
  if (!iso) return null;
  return utcToLocalInput(iso, settings.timezone);
};

const formatBookableDays = (days: string[]): string => days.join(",");

/**
 * Render the per-day-count price inputs for "customisable days" listings: one
 * text input per day from 1 to the listing's maximum booking duration,
 * pre-filled from the stored `day_prices`. Rendered on every listing form but
 * only meaningful when "Customisable Days" is enabled (the client script and
 * server validation both gate on that checkbox). New listings start with a
 * single row; increasing the maximum and saving reveals more rows.
 */
export const renderDayPricesFieldset = (listing?: ListingWithCount): string => {
  const max = listing ? normalizeDurationDays(listing.duration_days) : 1;
  const prices = listing?.day_prices ?? {};
  const rows = Array.from({ length: max }, (_, i) => i + 1)
    .map((n) => {
      const stored = prices[n];
      const value = stored !== undefined ? toMajorUnits(stored) : "";
      return (
        `<label>${n} day${n === 1 ? "" : "s"} price` +
        `<input type="text" inputmode="decimal" name="day_price_${n}" ` +
        `value="${escapeHtml(value)}" pattern="\\d+(\\.\\d{1,2})?" ` +
        `placeholder="e.g. 10.00" title="A non-negative number (e.g. 10.00)" />` +
        "</label>"
      );
    })
    .join("");
  return (
    `<fieldset data-day-prices id="day-prices">` +
    "<legend>Day Prices (customisable days)</legend>" +
    "<p><small>Set a price for each number of days you want to offer. Leave a " +
    "row blank to not offer that length. The maximum matches the Booking " +
    "Duration (days) above — increase it and save to add more rows.</small></p>" +
    rows +
    "</fieldset>"
  );
};

const listingFieldFormatters: Partial<
  Record<keyof ListingWithCount, (e: ListingWithCount) => string | null>
> = {
  assign_built_site: (e) => booleanToCheckbox(e.assign_built_site),
  bookable_days: (e) => formatBookableDays(e.bookable_days),
  can_pay_more: (e) => booleanToCheckbox(e.can_pay_more),
  closes_at: (e) => formatDatetimeLocal(e.closes_at),
  customisable_days: (e) => booleanToCheckbox(e.customisable_days),
  date: (e) => (e.date ? formatDatetimeLocal(e.date) : null),
  hidden: (e) => booleanToCheckbox(e.hidden),
  initial_site_months: (e) =>
    e.initial_site_months ? String(e.initial_site_months) : "",
  max_price: (e) => toMajorUnits(e.max_price),
  months_per_unit: (e) => (e.months_per_unit ? String(e.months_per_unit) : ""),
  non_transferable: (e) => booleanToCheckbox(e.non_transferable),
  purchase_only: (e) => booleanToCheckbox(e.purchase_only),
  unit_price: (e) => (e.unit_price > 0 ? toMajorUnits(e.unit_price) : ""),
};

const allListingFields: Field[] = [
  ...listingFields,
  monthsPerUnitField,
  initialSiteMonthsField,
  assignBuiltSiteField,
];

const listingToFieldValues = (listing: ListingWithCount): FieldValues =>
  entityToFieldValues(listing, allListingFields, listingFieldFormatters, {
    slug: listing.slug,
  });

/** Listing fields with autofocus on the name field */
const listingFieldsWithAutofocus: Field[] = pipe(
  map((f: Field): Field => (f.name === "name" ? { ...f, autofocus: true } : f)),
)(listingFields);

// ---------------------------------------------------------------------------
// Sectioned listing form
//
// The listing form is grouped into labelled <fieldset> sections plus a
// collapsible Advanced <details> for the technical fields most owners never
// touch. Each array below fixes the field order within its section; names
// absent from the assembled field list (builder-only or storage-only fields,
// or slug on the create form) are skipped. The "Booking Duration & Day Prices"
// section is assembled inline because it interleaves the day-prices fieldset
// and the edit-only duration-change warning.
//
// Conditional visibility (daily-only fields, day prices, max price) is handled
// entirely in CSS via :has() — see the form rules in mvp.css. The day-prices
// block sits right under the "Customisable Days" checkbox so enabling it
// reveals the prices in place.
// ---------------------------------------------------------------------------

const BASICS_FIELDS = [
  "name",
  "listing_type",
  "description",
  "date",
  "location",
  "image",
  "attachment",
] as const;

const TICKET_FIELDS = [
  "max_attendees",
  "max_quantity",
  "closes_at",
  "unit_price",
  "can_pay_more",
  "max_price",
] as const;

const DAILY_FIELDS = [
  "bookable_days",
  "minimum_days_before",
  "maximum_days_after",
] as const;

const OPTION_FIELDS = [
  "fields",
  "non_transferable",
  "purchase_only",
  "hidden",
] as const;

const ADVANCED_FIELDS = [
  "thank_you_url",
  "webhook_url",
  "months_per_unit",
  "initial_site_months",
  "assign_built_site",
  "slug",
] as const;

/**
 * Whether the Advanced section should render expanded. Open it when any of its
 * fields already carries a value, so editors don't lose track of a configured
 * webhook or renewal tier. Slug is deliberately excluded: it is always set, so
 * counting it would force the section open on every edit. Builder-only fields
 * only count when the builder is enabled (otherwise they aren't rendered).
 */
const advancedSectionHasValues = (
  listing: ListingWithCount,
  builderEnabled: boolean,
): boolean => {
  if (listing.thank_you_url || listing.webhook_url) return true;
  return (
    builderEnabled &&
    (listing.months_per_unit > 0 ||
      listing.initial_site_months > 0 ||
      listing.assign_built_site)
  );
};

/** Edit-only warning shown next to the booking-duration field: changing it
 * rewrites end_at on every existing booking. Wired up by initDurationWarning. */
const DurationWarning = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => (
  <div
    data-duration-original={listing.duration_days}
    hidden
    id="duration-warning"
  >
    <p>
      <strong>Warning:</strong> Changing booking duration will update existing
      bookings for this listing.
    </p>
    <label>
      <input id="duration-warning-confirm" type="checkbox" />I understand
    </label>
  </div>
);

/**
 * Render the body of a listing form (create, duplicate, or edit) as grouped
 * sections. The surrounding <form>, page heading, and submit button differ per
 * page and stay in the individual page functions.
 */
const ListingFormSections = ({
  fields,
  values,
  groups,
  selectedGroupId,
  dayPricesListing,
  durationWarning,
  imagePreview,
  advancedOpen,
}: {
  fields: Field[];
  values: FieldValues;
  groups: Group[];
  selectedGroupId: number;
  /** Listing whose duration sizes the day-price rows (absent on create). */
  dayPricesListing?: ListingWithCount;
  /** Pre-rendered edit-only duration-change warning ("" on create/duplicate). */
  durationWarning: string;
  /** Pre-rendered edit-only current-image preview ("" otherwise). */
  imagePreview: string;
  advancedOpen: boolean;
}): JSX.Element => {
  const fieldMap = new Map<string, Field>(fields.map((f) => [f.name, f]));
  const sec = (names: readonly string[]): string =>
    renderFields(compact(names.map((n) => fieldMap.get(n))), values);
  return (
    <>
      <fieldset class="listing-section">
        <legend>Basics</legend>
        <div class="stack">
          <Raw html={sec(BASICS_FIELDS)} />
          {imagePreview && <Raw html={imagePreview} />}
          <ListingGroupSelect
            groups={groups}
            selectedGroupId={selectedGroupId}
          />
        </div>
      </fieldset>

      <fieldset class="listing-section">
        <legend>Tickets &amp; Pricing</legend>
        <div class="stack">
          <Raw html={sec(TICKET_FIELDS)} />
        </div>
      </fieldset>

      <fieldset class="listing-section listing-section--daily">
        <legend>Daily Scheduling</legend>
        <div class="stack">
          <Raw html={sec(DAILY_FIELDS)} />
        </div>
      </fieldset>

      <fieldset class="listing-section">
        <legend>Booking Duration &amp; Day Prices</legend>
        <div class="stack">
          <Raw html={sec(["duration_days"])} />
          {durationWarning && <Raw html={durationWarning} />}
          <Raw html={sec(["customisable_days"])} />
          <Raw html={renderDayPricesFieldset(dayPricesListing)} />
        </div>
      </fieldset>

      <fieldset class="listing-section">
        <legend>Options &amp; Visibility</legend>
        <div class="stack">
          <Raw html={sec(OPTION_FIELDS)} />
        </div>
      </fieldset>

      <details class="listing-advanced" open={advancedOpen}>
        <summary>Advanced settings</summary>
        <div class="stack">
          <Raw html={sec(ADVANCED_FIELDS)} />
        </div>
      </details>
    </>
  );
};

/**
 * Admin listing create page
 */
export const adminListingNewPage = (
  groups: Group[],
  session: AdminSession,
  error?: string,
): string => {
  const storageEnabled = isStorageEnabled();
  const builderEnabled = isBuilderEnabled();
  const fields = [
    ...listingFields,
    ...(builderEnabled
      ? [monthsPerUnitField, initialSiteMonthsField, assignBuiltSiteField]
      : []),
    ...(storageEnabled ? [imageField, attachmentField] : []),
  ];
  return String(
    <Layout title="Add Listing">
      <AdminNav active="/admin/" session={session} />

      <CsrfForm action="/admin/listing" enctype="multipart/form-data">
        <h1>Add Listing</h1>
        <Flash error={error} />
        <ListingFormSections
          advancedOpen={!!error}
          durationWarning=""
          fields={fields}
          groups={groups}
          imagePreview=""
          selectedGroupId={0}
          values={{}}
        />
        <SubmitButton icon="plus">Create Listing</SubmitButton>
      </CsrfForm>
    </Layout>,
  );
};

/**
 * Admin duplicate listing page - create form pre-filled with existing listing settings
 */
export const adminDuplicateListingPage = (
  listing: ListingWithCount,
  groups: Group[],
  session: AdminSession,
): string => {
  const values = listingToFieldValues(listing);
  values.name = "";
  const builderEnabled = isBuilderEnabled();
  const storageEnabled = isStorageEnabled();
  const dupFields = [
    ...listingFieldsWithAutofocus,
    ...(builderEnabled
      ? [monthsPerUnitField, initialSiteMonthsField, assignBuiltSiteField]
      : []),
    ...(storageEnabled ? [imageField, attachmentField] : []),
  ];

  return String(
    <Layout title={`Duplicate: ${listing.name}`}>
      <AdminNav active="/admin/" session={session} />
      <div class="prose">
        <h2>Duplicate Listing</h2>
        <p>
          Creating a new listing based on <strong>{listing.name}</strong>.
        </p>
      </div>
      <CsrfForm action="/admin/listing" enctype="multipart/form-data">
        <ListingFormSections
          advancedOpen={advancedSectionHasValues(listing, builderEnabled)}
          dayPricesListing={listing}
          durationWarning=""
          fields={dupFields}
          groups={groups}
          imagePreview=""
          selectedGroupId={listing.group_id}
          values={values}
        />
        <SubmitButton icon="plus">Create Listing</SubmitButton>
      </CsrfForm>
    </Layout>,
  );
};

/**
 * Admin listing edit page
 */
export const adminListingEditPage = (
  listing: ListingWithCount,
  groups: Group[],
  session: AdminSession,
  error?: string,
): string => {
  const storageEnabled = isStorageEnabled();
  const builderEnabled = isBuilderEnabled();
  // Slug is editable only here (auto-generated on create), so it lives in the
  // edit form's field list rather than the shared definitions.
  const fields = [
    ...listingFields,
    ...(builderEnabled
      ? [monthsPerUnitField, initialSiteMonthsField, assignBuiltSiteField]
      : []),
    ...(storageEnabled ? [imageField, attachmentField] : []),
    slugField,
  ];
  const imagePreview =
    storageEnabled && listing.image_url
      ? renderListingImage(listing, "listing-image-full")
      : "";
  const durationWarning = String(<DurationWarning listing={listing} />);
  return String(
    <Layout title={`Edit: ${listing.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />
      <CsrfForm
        action={`/admin/listing/${listing.id}/edit`}
        enctype="multipart/form-data"
        id="listing-edit-form"
      >
        <ListingFormSections
          advancedOpen={
            advancedSectionHasValues(listing, builderEnabled) || !!error
          }
          dayPricesListing={listing}
          durationWarning={durationWarning}
          fields={fields}
          groups={groups}
          imagePreview={imagePreview}
          selectedGroupId={listing.group_id}
          values={listingToFieldValues(listing)}
        />
        <SubmitButton icon="save" id="listing-edit-submit">
          Save Changes
        </SubmitButton>
      </CsrfForm>
      {storageEnabled && listing.image_url && (
        <CsrfForm action={`/admin/listing/${listing.id}/image/delete`}>
          <SubmitButton class="secondary" icon="trash-2">
            Remove Image
          </SubmitButton>
        </CsrfForm>
      )}
      {storageEnabled && listing.attachment_name && (
        <div class="attachment-info">
          <p>
            Current attachment: <strong>{listing.attachment_name}</strong>
          </p>
          <CsrfForm action={`/admin/listing/${listing.id}/attachment/delete`}>
            <SubmitButton class="secondary" icon="trash-2">
              Remove Attachment
            </SubmitButton>
          </CsrfForm>
        </div>
      )}
    </Layout>,
  );
};

/**
 * Admin delete listing confirmation page
 */
export const adminDeleteListingPage = (
  listing: ListingWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Delete: ${listing.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/listing/${listing.id}/delete`}
        buttonText="Delete Listing"
        label="Listing name"
        name={listing.name}
      >
        <p>
          <strong>Warning:</strong> This will permanently delete the listing,
          all {listing.attendee_count} attendee(s), any associated payment
          records, and all activity log entries for this listing.
        </p>
        <p>
          To delete this listing, type its name "{listing.name}" into the box
          below:
        </p>
      </ConfirmForm>
    </Layout>,
  );

/**
 * Admin deactivate listing confirmation page
 */
export const adminDeactivateListingPage = (
  listing: ListingWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Deactivate: ${listing.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/listing/${listing.id}/deactivate`}
        buttonText="Deactivate Listing"
        label="Listing name"
        name={listing.name}
      >
        <p>
          <strong>Warning:</strong> Deactivating this listing will:
        </p>
        <ul>
          <li>Return a 404 error on the public ticket page</li>
          <li>Prevent new registrations</li>
          <li>Reject any pending payments</li>
        </ul>
        <p>Existing attendees will not be affected.</p>
        <p>
          To deactivate this listing, type its name "{listing.name}" into the
          box below:
        </p>
      </ConfirmForm>
    </Layout>,
  );

/**
 * Admin reactivate listing confirmation page
 */
export const adminReactivateListingPage = (
  listing: ListingWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Reactivate: ${listing.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/listing/${listing.id}/reactivate`}
        buttonText="Reactivate Listing"
        danger={false}
        label="Listing name"
        name={listing.name}
      >
        <p>
          Reactivating this listing will make it available for registrations
          again.
        </p>
        <p>
          The public ticket page will be accessible and new attendees can
          register.
        </p>
        <p>
          To reactivate this listing, type its name "{listing.name}" into the
          box below:
        </p>
      </ConfirmForm>
    </Layout>,
  );
