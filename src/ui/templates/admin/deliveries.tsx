/**
 * Delivery agent run sheet.
 *
 * A delivery-agent user only ever sees today and tomorrow — the two days a
 * driver works from. Staff (owner/manager) get the same run sheet plus the
 * shared calendar date picker, so they can open any date (and its following
 * day) rather than being pinned to today. It lists the drop-offs and
 * collections assigned to the logistics agents that user drives, with
 * addresses (and map links), phone numbers and the logistics time. Each leg
 * can be toggled done. The heading and body come from the owner's Liquid
 * templates in `deliveries/run-sheet.tsx`.
 */

import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { Flash } from "#shared/forms/flash.tsx";
import {
  flashProps,
  renderAdminPageSpec,
} from "#templates/admin/admin-page-spec.tsx";
import type { RunSheetDay } from "#templates/admin/deliveries/run-sheet.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { DatePicker, type DatePickerDate } from "#templates/date-picker.tsx";
import type { AdminSession } from "#types";

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

export interface DeliveriesPageOpts {
  /** Where the run-sheet template lives, or null when this viewer cannot edit
   * it. Owners see it. Agents are pinned to their round. */
  editTemplateHref?: string | null;
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
  days: RunSheetDay[],
  opts: DeliveriesPageOpts,
  session: AdminSession,
  dateNav: DeliveriesDateNav | null,
): string =>
  renderAdminPageSpec({
    active: "/admin/deliveries",
    body: (
      <>
        <Flash {...flashProps(opts.error, opts.success)} />
        {/* The route supplies a picker only for staff; agents get null and so
            stay pinned to today and tomorrow. */}
        {dateNav && <DeliveriesDatePicker nav={dateNav} />}
        {opts.editTemplateHref && (
          <p class="muted">
            <small>
              <a href={opts.editTemplateHref}>
                {t("deliveries.edit_template")}
              </a>
            </small>
          </p>
        )}
        {opts.noAgents ? (
          <p>
            <em>{t("deliveries.no_agents")}</em>
          </p>
        ) : days.every((day) => day.empty) ? (
          <p>
            <em>{t("deliveries.none_scheduled")}</em>
          </p>
        ) : (
          days.map((day) => (
            <section class="delivery-day">
              <div class="prose">
                <h2>{day.heading}</h2>
                <Raw html={day.bodyHtml} />
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
      </>
    ),
    session,
    staff: {},
    title: t("deliveries.title"),
  });
