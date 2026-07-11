/**
 * Delivery agent run sheet.
 *
 * A delivery-agent user only ever sees today and tomorrow — the two days a
 * driver works from. Staff (owner/manager) get the same run sheet plus the
 * shared calendar date picker, so they can open any date (and its following
 * day) rather than being pinned to today. It lists the drop-offs and
 * collections assigned to the logistics agents that user drives, with
 * addresses (and map links), phone numbers and the logistics time. Each leg
 * can be toggled done so a driver can tick off their round.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { flashProps } from "#templates/admin/admin-page.tsx";
import { markAdminFooter } from "#templates/admin/footer.tsx";
import { StaffAdminNav } from "#templates/admin/nav.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { MapsLinks } from "#templates/components/maps-links.tsx";
import { PhoneLinks } from "#templates/components/phone-links.tsx";
import { DatePicker, type DatePickerDate } from "#templates/date-picker.tsx";
import { Layout } from "#templates/layout.tsx";
/* jscpd:ignore-end */

/** The date-picker context shown to staff so they can open any delivery date.
 * `selected` is the currently opened date (null = today's default view). */
export type DeliveriesDateNav = {
  availableDates: DatePickerDate[];
  today: string;
  selected: string | null;
  viewMonth: string | null;
};

/** The calendar date picker, wired to reopen the run sheet on a chosen date.
 * Uses the same component as the calendar page, so paging months and jumping
 * dates behave identically. */
const DeliveriesDatePicker = ({
  nav,
}: {
  nav: DeliveriesDateNav;
}): JSX.Element => (
  <DatePicker
    anchorId="calendar"
    ariaLabel={t("deliveries.select_date")}
    clearHref="/admin/deliveries"
    dates={nav.availableDates}
    dayHref={(value) => `/admin/deliveries?date=${value}`}
    monthHref={(month) =>
      `/admin/deliveries?${
        nav.selected ? `date=${nav.selected}&` : ""
      }cal=${month}#calendar`
    }
    selected={nav.selected}
    today={nav.today}
    viewMonth={nav.viewMonth}
  />
);

/** A single drop-off or collection job within a booking on the run sheet. */
export type DeliveryLegView = {
  kind: "start" | "end";
  /** Name of the logistics agent (van/crew) this leg belongs to. */
  agentName: string;
  /** Calendar date of this leg (YYYY-MM-DD), matching the run-sheet day. */
  date: string;
  /** Logistics time label ("" when unset). */
  time: string;
  done: boolean;
};

/** One booking on the run sheet, with its drop-off and/or collection jobs for
 * the day grouped together so a driver sees the same listing's legs side by
 * side rather than as two unrelated rows. */
export type DeliveryBookingView = {
  attendeeId: number;
  listingId: number;
  listingName: string;
  attendeeName: string;
  address: string;
  phone: string;
  /** The booking's ticket token — the id the customer can quote to confirm. */
  ticketToken: string;
  /** The jobs (drop-off and/or collection) for this booking on this day. */
  legs: DeliveryLegView[];
};

/** A day's worth of bookings under a friendly heading (Today / Tomorrow). */
export type DeliveryDayGroup = {
  heading: string;
  bookings: DeliveryBookingView[];
};

/** Header for an agent-class user: just the title and no staff navigation,
 * since an agent may only ever reach this page. The logout button lives in the
 * footer (rendered because we flag this as an admin page). */
const AgentHeader = (): JSX.Element => {
  // Only rendered for agent-class users (the bare run-sheet header).
  markAdminFooter("agent");
  return (
    <header class="agent-header">
      <h1>{t("deliveries.title")}</h1>
    </header>
  );
};

/** One job (drop-off or collection) within a booking: what to do, when, which
 * agent, and a done toggle. The attendee/listing ids for the mark form come
 * from the parent booking, since a job belongs to exactly one booking. */
const LegItem = ({
  booking,
  leg,
}: {
  booking: DeliveryBookingView;
  leg: DeliveryLegView;
}): JSX.Element => (
  <li class={leg.done ? "delivery-leg done" : "delivery-leg"}>
    <span>
      {leg.kind === "start"
        ? t("deliveries.dropoff")
        : t("deliveries.collection")}
      {leg.time ? ` · ${leg.time}` : ""} · {leg.agentName}
    </span>
    <CsrfForm action="/admin/deliveries/mark" class="delivery-mark inline">
      <input
        name="attendee_id"
        type="hidden"
        value={String(booking.attendeeId)}
      />
      <input
        name="listing_id"
        type="hidden"
        value={String(booking.listingId)}
      />
      <input name="kind" type="hidden" value={leg.kind} />
      <input name="date" type="hidden" value={leg.date} />
      <input name="done" type="hidden" value={leg.done ? "0" : "1"} />
      <button type="submit">
        {leg.done ? t("deliveries.mark_not_done") : t("deliveries.mark_done")}
      </button>
    </CsrfForm>
  </li>
);

/** One booking card: the listing/attendee details once, then every job (the
 * drop-off and/or collection for the day) nested beneath, so a same-day
 * drop-off-and-collection shows both legs under a single entry. */
const BookingCard = ({
  booking,
  phonePrefix,
}: {
  booking: DeliveryBookingView;
  phonePrefix: string;
}): JSX.Element => (
  <li>
    <ul>
      <li>
        <strong>{t("deliveries.name_label")}</strong> {booking.attendeeName}
      </li>
      <li>
        <strong>{t("deliveries.listing_label")}</strong> {booking.listingName}
      </li>
      {booking.address && (
        <li>
          <strong>{t("deliveries.address_label")}</strong> {booking.address}
          <MapsLinks query={booking.address} />
        </li>
      )}
      {booking.phone && (
        <li class="delivery-phone">
          <strong>{t("deliveries.phone_label")}</strong>{" "}
          <PhoneLinks phone={booking.phone} phonePrefix={phonePrefix} />
        </li>
      )}
      <li>
        <strong>{t("deliveries.token_label")}</strong> {booking.ticketToken}
      </li>
      <li>
        <ul>
          {booking.legs.map((leg) => (
            <LegItem booking={booking} leg={leg} />
          ))}
        </ul>
      </li>
    </ul>
  </li>
);

export interface DeliveriesPageOpts {
  error?: string | undefined;
  /** True when the user has no logistics agents assigned to them. */
  noAgents: boolean;
  success?: string | undefined;
}

/**
 * Render the agent run sheet, grouped by day. Staff are given the calendar
 * date picker (`dateNav`) so they can open any date; agents pass `null` and
 * stay pinned to today.
 */
export const agentDeliveriesPage = (
  groups: DeliveryDayGroup[],
  phonePrefix: string,
  opts: DeliveriesPageOpts,
  session: AdminSession,
  dateNav: DeliveriesDateNav | null,
): string =>
  String(
    <Layout
      beforeContent={
        <StaffAdminNav active="/admin/deliveries" session={session} />
      }
      title={t("deliveries.title")}
    >
      {session.adminLevel === "agent" && <AgentHeader />}
      <Flash {...flashProps(opts.error, opts.success)} />
      {/* The route supplies a picker only for staff; agents get null and so
            stay pinned to today and tomorrow. */}
      {dateNav && <DeliveriesDatePicker nav={dateNav} />}
      {opts.noAgents ? (
        <p>
          <em>{t("deliveries.no_agents")}</em>
        </p>
      ) : groups.every((group) => group.bookings.length === 0) ? (
        <p>
          <em>{t("deliveries.none_scheduled")}</em>
        </p>
      ) : (
        groups.map((group) => (
          <section class="delivery-day">
            <div class="prose">
              <h2>{group.heading}</h2>
              {group.bookings.length === 0 ? (
                <p>
                  <em>{t("deliveries.nothing_scheduled")}</em>
                </p>
              ) : (
                <ul class="delivery-bookings">
                  {group.bookings.map((booking) => (
                    <BookingCard booking={booking} phonePrefix={phonePrefix} />
                  ))}
                </ul>
              )}
            </div>
          </section>
        ))
      )}
      {/* Agent-only drivers are not staff, so GuideFooter renders nothing for
            them; owners and managers get the link to the logistics guide. */}
      <GuideFooter
        adminLevel={session.adminLevel}
        href="/admin/guide#logistics"
      >
        {t("deliveries.guide_link")}
      </GuideFooter>
    </Layout>,
  );
