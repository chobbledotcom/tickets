/**
 * Delivery agent run sheet.
 *
 * The only page a delivery-agent user can see. It lists the drop-offs and
 * collections assigned to the logistics agents that user drives, for today and
 * tomorrow, with addresses (and map links), phone numbers and the logistics
 * time. Each leg can be toggled done so a driver can tick off their round.
 */

import { t } from "#i18n";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { markAdminFooter } from "#templates/admin/footer.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { MapsLinks } from "#templates/components/maps-links.tsx";
import { PhoneLinks } from "#templates/components/phone-links.tsx";
import { Layout } from "#templates/layout.tsx";

/** A single drop-off or collection job within a booking on the run sheet. */
export type DeliveryLegView = {
  kind: "start" | "end";
  /** Name of the logistics agent (van/crew) this leg belongs to. */
  agentName: string;
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
  success?: string | undefined;
  /** True when the user has no logistics agents assigned to them. */
  noAgents: boolean;
}

/**
 * Render the agent run sheet, grouped by day.
 */
export const agentDeliveriesPage = (
  groups: DeliveryDayGroup[],
  phonePrefix: string,
  opts: DeliveriesPageOpts,
  session: AdminSession,
): string =>
  String(
    <Layout title={t("deliveries.title")}>
      {session.adminLevel === "agent" ? (
        <AgentHeader />
      ) : (
        <>
          {/* Deliveries lives in the Calendar section, so highlight Calendar:
              it gives the Calendar sub-nav a parent link to sit beneath in the
              desktop sidebar. */}
          <AdminNav active="/admin/calendar" session={session} />
          <h1>{t("deliveries.title")}</h1>
        </>
      )}
      <Flash
        {...(opts.error !== undefined ? { error: opts.error } : {})}
        {...(opts.success !== undefined ? { success: opts.success } : {})}
      />
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
    </Layout>,
  );
