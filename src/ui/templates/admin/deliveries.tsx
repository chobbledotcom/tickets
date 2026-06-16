/**
 * Delivery agent run sheet.
 *
 * The only page a delivery-agent user can see. It lists the drop-offs and
 * collections assigned to the logistics agents that user drives, for today and
 * tomorrow, with addresses (and map links), phone numbers and the logistics
 * time. Each leg can be toggled done so a driver can tick off their round.
 */

import { CsrfForm, Flash } from "#shared/forms.tsx";
import { phoneLinks } from "#shared/phone.ts";
import { SubmitButton } from "#templates/components/actions.tsx";
import { MapsLinks } from "#templates/components/maps-links.tsx";
import { Layout } from "#templates/layout.tsx";

/** A single drop-off or collection on the run sheet. */
export type DeliveryLegView = {
  kind: "start" | "end";
  attendeeId: number;
  listingId: number;
  listingName: string;
  attendeeName: string;
  address: string;
  phone: string;
  /** Name of the logistics agent (van/crew) this leg belongs to. */
  agentName: string;
  /** Logistics time label ("" when unset). */
  time: string;
  done: boolean;
};

/** A day's worth of legs under a friendly heading (Today / Tomorrow). */
export type DeliveryDayGroup = {
  heading: string;
  legs: DeliveryLegView[];
};

/** Header shared by every agent page: just a title and a logout button — no
 * staff navigation, since agents may only ever reach this page. */
const AgentHeader = (): JSX.Element => (
  <header class="agent-header">
    <h1>Deliveries</h1>
    <CsrfForm action="/admin/logout" class="inline">
      <SubmitButton icon="log-out">Logout</SubmitButton>
    </CsrfForm>
  </header>
);

/** The phone number with a tel: link when it normalises to a callable number. */
const PhoneLine = ({
  phone,
  phonePrefix,
}: {
  phone: string;
  phonePrefix: string;
}): JSX.Element | null => {
  if (!phone) return null;
  const links = phoneLinks(phone, phonePrefix);
  return (
    <p class="delivery-phone">
      {links ? <a href={links.tel}>{phone}</a> : phone}
    </p>
  );
};

/** One leg card: what to do, where, when, and a done toggle. */
const LegCard = ({
  leg,
  phonePrefix,
}: {
  leg: DeliveryLegView;
  phonePrefix: string;
}): JSX.Element => (
  <li class={leg.done ? "delivery-leg done" : "delivery-leg"}>
    <p class="delivery-kind">
      {leg.kind === "start" ? "Drop-off" : "Collection"}
      {leg.time ? ` · ${leg.time}` : ""} · {leg.agentName}
    </p>
    <p class="delivery-listing">{leg.listingName}</p>
    <p class="delivery-attendee">{leg.attendeeName}</p>
    {leg.address && (
      <p class="delivery-address">
        {leg.address}
        <MapsLinks query={leg.address} />
      </p>
    )}
    <PhoneLine phone={leg.phone} phonePrefix={phonePrefix} />
    <CsrfForm action="/admin/deliveries/mark" class="inline">
      <input name="attendee_id" type="hidden" value={String(leg.attendeeId)} />
      <input name="listing_id" type="hidden" value={String(leg.listingId)} />
      <input name="kind" type="hidden" value={leg.kind} />
      <input name="done" type="hidden" value={leg.done ? "0" : "1"} />
      <SubmitButton icon={leg.done ? "rotate-ccw" : "check"}>
        {leg.done ? "Mark not done" : "Mark done"}
      </SubmitButton>
    </CsrfForm>
  </li>
);

export interface DeliveriesPageOpts {
  error?: string;
  success?: string;
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
): string =>
  String(
    <Layout title="Deliveries">
      <AgentHeader />
      <Flash error={opts.error} success={opts.success} />
      {opts.noAgents ? (
        <p>
          <em>
            You have no logistics agents assigned yet. Ask the site owner to
            assign you.
          </em>
        </p>
      ) : groups.every((group) => group.legs.length === 0) ? (
        <p>
          <em>No deliveries scheduled for today or tomorrow.</em>
        </p>
      ) : (
        groups.map((group) => (
          <section class="delivery-day">
            <h2>{group.heading}</h2>
            {group.legs.length === 0 ? (
              <p>
                <em>Nothing scheduled.</em>
              </p>
            ) : (
              <ul class="delivery-legs">
                {group.legs.map((leg) => (
                  <LegCard leg={leg} phonePrefix={phonePrefix} />
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </Layout>,
  );
