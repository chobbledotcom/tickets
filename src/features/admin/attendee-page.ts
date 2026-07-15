/**
 * The attendee entity page: one declarative definition of
 * the tabbed /admin/attendees/:id page.
 *
 *   Overview  — summary table, bookings, answers, payment details, a short
 *               activity preview, contact history
 *   Edit      — the attendee form (attendee-form.tsx), warnings and errors
 *   Ledger    — the order summary, account statement, balance collection and
 *               activity history (owner-only)
 *   Activity  — the full activity log
 *   Actions   — refund / resend / send text / merge, danger zone: delete
 *
 * The banner (status + notes) is visible on every tab — system-note alerts
 * must never hide behind a tab. Submit handlers live in
 * attendee-form-routes.ts; the shared loaders live in attendee-page-data.ts.
 */

import { t } from "#i18n";
import { loadAttendeeActionState } from "#routes/admin/attendee-action-state.ts";
import { attendeeBookingsFromLines } from "#routes/admin/attendee-form-model.ts";
import { loadAttendeeLedgerPanel } from "#routes/admin/attendee-ledger-panel.ts";
import { loadLogisticsPanel } from "#routes/admin/attendee-logistics-tab.ts";
import {
  buildEditFormFromAttendee,
  buildTemplateData,
  getRenderListings,
  type LoadedAttendee,
  loadAttendeeActivity,
  loadAttendeeActivityPreview,
  loadAttendeeForEdit,
  loadContactRecords,
  loadPackagePaths,
  loadQuestionsForExisting,
} from "#routes/admin/attendee-page-data.ts";
import { loadMergePanel } from "#routes/admin/attendees-merge.ts";
import {
  type ActionDef,
  customSection,
  defineEntityPage,
  type EntityPage,
  type PageCtx,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { writeFormTab } from "#routes/admin/entity-write-tab.ts";
import { loadPreviousBookings } from "#routes/admin/previous-bookings.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { settings } from "#shared/db/settings.ts";
import { getNotesForAttendee } from "#shared/db/system-notes.ts";
import { isReadOnly } from "#shared/env.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { isOwnerRole } from "#shared/types.ts";
import {
  AttendeeAnswersTable,
  AttendeeBookingsTable,
} from "#templates/admin/attendee-detail.tsx";
import { AttendeeFormPanel } from "#templates/admin/attendee-form.tsx";
import { AddNoteLink } from "#templates/admin/attendee-notes.tsx";
import {
  attendeeBanner,
  attendeeSummaryRows,
  ContactHistory,
} from "#templates/admin/attendee-page.tsx";
import { PaymentDetails } from "#templates/admin/attendees.tsx";

/** The attendee-scoped action routes live under the entity's own base. */
const actionBase = ({ attendee }: LoadedAttendee): string =>
  `/admin/attendees/${attendee.id}`;

/** The visibility gate for everything that changes a record: shown only while
 * no checkout is pending. Mirrors the server-side pending guards exactly. */
const notMidPayment = ({ pendingCheckout }: LoadedAttendee): boolean =>
  !pendingCheckout;

/** Thread the current tab back through a sub-action's confirm page. */
const withReturn = (href: string, ctx: PageCtx): string =>
  `${href}?return_url=${encodeURIComponent(ctx.returnUrl)}`;

/** The Actions tab entries. Every `visible` mirrors its target's own gate. */
const ATTENDEE_ACTIONS: readonly ActionDef<LoadedAttendee>[] = [
  {
    href: (entity, ctx) => withReturn(`${actionBase(entity)}/refund`, ctx),
    icon: "credit-card",
    labelKey: "attendee_form.action_refund",
    visible: ({ canRefund }) => canRefund,
  },
  {
    href: (entity, ctx) =>
      withReturn(`${actionBase(entity)}/resend-notification`, ctx),
    icon: "rotate-ccw",
    labelKey: "attendee_form.action_resend",
    visible: ({ homeListingExists }) => homeListingExists,
  },
  {
    href: ({ attendee }) =>
      `/admin/sms?listing=${attendee.listing_id}&attendee=${attendee.id}`,
    icon: "arrow-right",
    labelKey: "attendee_form.action_send_text",
    visible: ({ homeListingExists }) => homeListingExists,
  },
  {
    danger: true,
    href: (entity) => `${actionBase(entity)}/delete`,
    icon: "trash-2",
    labelKey: "attendee_form.action_delete",
    visible: ({ canDelete }) => canDelete === true,
  },
];

/** Build the Edit tab's form panel from the stored attendee. The POST
 * failure path bypasses this and re-renders the submitted values instead
 * (attendee-form-routes.ts). */
const loadEditPanel = async (
  entity: LoadedAttendee,
  ctx: PageCtx,
): Promise<JSX.Element> => {
  const { attendee, existing } = entity;
  const renderListings = await getRenderListings(existing);
  const { parsed, hasMixedTimings } = buildEditFormFromAttendee(
    attendee,
    existing,
    renderListings,
    await loadPackagePaths(),
  );
  const questionData = await loadQuestionsForExisting(attendee.id, existing);
  const data = await buildTemplateData("edit", parsed, attendee, {
    ...questionData,
    hasMixedTimings,
    returnUrl: ctx.query.get("return_url") ?? "",
  });
  return AttendeeFormPanel({ data });
};

/** The Overview tab's sections. */
const overviewTab: TabDef<LoadedAttendee> = {
  labelKey: "entity.tab.overview",
  sections: [
    {
      kind: "summary",
      rows: ({ attendee, existing, pendingCheckout }) =>
        Promise.resolve(
          attendeeSummaryRows({
            allowedDomain: getEffectiveDomain(),
            attendee,
            hasRealLine: existing.some((line) => line.booking.quantity > 0),
            pendingCheckout,
            phonePrefix: settings.phonePrefix,
          }),
        ),
    },
    customSection(async ({ attendee, existing }) => {
      const renderListings = await getRenderListings(existing);
      // The read-only bookings table needs no blank path lines.
      const { parsed } = buildEditFormFromAttendee(
        attendee,
        existing,
        renderListings,
        [],
      );
      return AttendeeBookingsTable({
        bookings: attendeeBookingsFromLines(parsed.lines),
      });
    }),
    customSection(async ({ attendee, existing }) => {
      const { questions, selectedAnswerIds } = await loadQuestionsForExisting(
        attendee.id,
        existing,
      );
      return AttendeeAnswersTable({ questions, selectedAnswerIds });
    }),
    {
      kind: "custom",
      load: ({ attendee }, ctx) =>
        Promise.resolve(
          PaymentDetails({
            attendee,
            // The balance link targets the owner-only Ledger tab, so it
            // must only render for owners (never render a forbidden link).
            showBalanceLink: ctx.session.adminLevel === "owner",
          }),
        ),
    },
    {
      kind: "activity",
      load: ({ attendee }) => loadAttendeeActivityPreview(attendee.id),
      viewAllTab: "activity",
    },
    {
      kind: "custom",
      load: async ({ attendee, pendingCheckout }, ctx) => {
        const [contactRecords, previousBookings] = await Promise.all([
          loadContactRecords(attendee),
          loadPreviousBookings(attendee),
        ]);
        return ContactHistory({
          attendee,
          contactRecords,
          isOwner: isOwnerRole(ctx.session.adminLevel),
          pendingCheckout,
          previousBookings,
        });
      },
    },
  ],
  slug: "",
};

/** The tabbed attendee page. */
export const attendeePage: EntityPage<LoadedAttendee> = defineEntityPage({
  banner: async ({ attendee, pendingCheckout }, ctx) =>
    attendeeBanner({
      attendee,
      isOwner: isOwnerRole(ctx.session.adminLevel),
      notes: await getNotesForAttendee(
        attendee.id,
        await requireRequestPrivateKey(),
      ),
      pendingCheckout,
      statuses: await attendeeStatuses.getAll(),
    }),
  basePath: (id) => `/admin/attendees/${id}`,
  guard: requireSessionOr,
  load: (id) => loadAttendeeForEdit(id),
  // A single attendee is a page *within* the Attendees section: highlight the
  // top-level link, but never re-open the section's "Add" sub-nav beside it.
  navActive: { section: "/admin/attendees" },
  proseExtra: ({ attendee }) =>
    Promise.resolve(
      isReadOnly() ? null : AddNoteLink({ attendeeId: attendee.id }),
    ),
  tabs: [
    overviewTab,
    // The write tabs and the actions tab hide while a checkout is pending: the
    // payment claims the exact staged rows when it lands, so every mutation is
    // blocked server-side — the page must not offer tabs that only fail. The
    // banner explains the state; a hidden tab's URL 404s (visible IS the gate).
    writeFormTab("edit", "entity.tab.edit", loadEditPanel, notMidPayment),
    writeFormTab(
      "logistics",
      "entity.tab.logistics",
      loadLogisticsPanel,
      notMidPayment,
    ),
    {
      labelKey: "entity.tab.ledger",
      sections: [
        {
          kind: "custom",
          load: ({ attendee }, ctx) =>
            loadAttendeeLedgerPanel(
              attendee.id,
              ctx.baseUrl,
              ctx.returnUrl,
              ctx.tabHref("activity"),
            ),
        },
      ],
      slug: "ledger",
      // The ledger exposes money movements and the customer pay link, so it is
      // owner-only — matching the standalone /admin/ledger* routes. It also
      // hides while a checkout is pending: it embeds manual charge/payment
      // forms, and a manual leg posted mid-payment would combine with
      // activation's own legs into a surprise balance (a pending stage has
      // zero legs, so the tab has nothing to show anyway).
      visible: (entity, session) =>
        session.adminLevel === "owner" && notMidPayment(entity),
    },
    {
      labelKey: "entity.tab.activity",
      sections: [
        {
          kind: "activity",
          load: ({ attendee }) => loadAttendeeActivity(attendee.id),
        },
      ],
      slug: "activity",
    },
    {
      intent: "write-form",
      labelKey: "entity.tab.actions",
      sections: [
        {
          actions: ATTENDEE_ACTIONS,
          kind: "actions",
          prepare: async (entity) => ({
            ...entity,
            canDelete: (
              await loadAttendeeActionState(
                entity.attendee.id,
                entity.pendingCheckout,
              )
            ).canDelete,
          }),
          titleKey: "entity.tab.actions",
        },
        {
          kind: "custom",
          load: ({ attendee }, ctx) =>
            loadMergePanel(attendee, ctx.query.get("token") ?? ""),
        },
      ],
      slug: "actions",
      visible: notMidPayment,
    },
  ],
  titleOf: ({ attendee }) =>
    t("attendee_form.title_edit", { value: attendee.name }),
});
