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
import { SubmitButton } from "#templates/components/actions.tsx";
import { MapsLinks } from "#templates/components/maps-links.tsx";
import { PhoneLinks } from "#templates/components/phone-links.tsx";
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
    <h1>{t("deliveries.title")}</h1>
    <CsrfForm action="/admin/logout" class="inline">
      <SubmitButton icon="log-out">{t("nav.logout")}</SubmitButton>
    </CsrfForm>
  </header>
);

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
      {leg.kind === "start"
        ? t("deliveries.dropoff")
        : t("deliveries.collection")}
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
    {leg.phone && (
      <p class="delivery-phone">
        <PhoneLinks phone={leg.phone} phonePrefix={phonePrefix} />
      </p>
    )}
    <CsrfForm action="/admin/deliveries/mark" class="inline">
      <input name="attendee_id" type="hidden" value={String(leg.attendeeId)} />
      <input name="listing_id" type="hidden" value={String(leg.listingId)} />
      <input name="kind" type="hidden" value={leg.kind} />
      <input name="done" type="hidden" value={leg.done ? "0" : "1"} />
      <SubmitButton icon={leg.done ? "rotate-ccw" : "check"}>
        {leg.done ? t("deliveries.mark_not_done") : t("deliveries.mark_done")}
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
    <Layout title={t("deliveries.title")}>
      <AgentHeader />
      <Flash error={opts.error} success={opts.success} />
      {opts.noAgents ? (
        <p>
          <em>{t("deliveries.no_agents")}</em>
        </p>
      ) : groups.every((group) => group.legs.length === 0) ? (
        <p>
          <em>{t("deliveries.none_scheduled")}</em>
        </p>
      ) : (
        groups.map((group) => (
          <section class="delivery-day">
            <h2>{group.heading}</h2>
            {group.legs.length === 0 ? (
              <p>
                <em>{t("deliveries.nothing_scheduled")}</em>
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
