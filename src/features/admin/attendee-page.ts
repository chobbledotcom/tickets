/**
 * The attendee entity page (edit-pages.md): one declarative definition of
 * the tabbed /admin/attendees/:id page.
 *
 *   Overview  — summary table, bookings, answers, payment details, a short
 *               activity preview, contact history
 *   Edit      — the attendee form (attendee-form.tsx), warnings and errors
 *   Ledger    — the attendee account statement (owner-only)
 *   Activity  — the full activity log
 *   Actions   — refund / resend / send text / merge, danger zone: delete
 *
 * The banner (status + notes) is visible on every tab — system-note alerts
 * must never hide behind a tab. Submit handlers live in
 * attendee-form-routes.ts; the shared loaders live in attendee-page-data.ts.
 */

import { t } from "#i18n";
import { loadAttendeeBalancePanel } from "#routes/admin/attendee-balance.ts";
import { attendeeBookingsFromLines } from "#routes/admin/attendee-form-model.ts";
import {
  buildEditFormFromAttendee,
  buildTemplateData,
  getRenderListings,
  type LoadedAttendee,
  loadAttendeeActivity,
  loadAttendeeActivityPreview,
  loadAttendeeForEdit,
  loadContactRecords,
  loadQuestionsForExisting,
} from "#routes/admin/attendee-page-data.ts";
import { loadMergePanel } from "#routes/admin/attendees-merge.ts";
import {
  type ActionDef,
  defineEntityPage,
  type EntityPage,
  type PageCtx,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { getAllAttendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { settings } from "#shared/db/settings.ts";
import { getNotesForAttendee } from "#shared/db/system-notes.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";
import {
  AttendeeAnswersTable,
  AttendeeBookingsTable,
} from "#templates/admin/attendee-detail.tsx";
import { AttendeeFormPanel } from "#templates/admin/attendee-form.tsx";
import {
  attendeeBanner,
  attendeeSummaryRows,
  ContactHistory,
} from "#templates/admin/attendee-page.tsx";
import { PaymentDetails } from "#templates/admin/attendees.tsx";

/** An attendee is refundable when they have a captured payment that has not
 * already been refunded — the same condition the refund route enforces. */
const isRefundable = (attendee: Attendee): boolean =>
  !!attendee.payment_id && !attendee.refunded;

/** The attendee-scoped action routes live under the entity's own base. */
const actionBase = ({ attendee }: LoadedAttendee): string =>
  `/admin/attendees/${attendee.id}`;

/** Thread the current tab back through a sub-action's confirm page. */
const withReturn = (href: string, ctx: PageCtx): string =>
  `${href}?return_url=${encodeURIComponent(ctx.returnUrl)}`;

/** The Actions tab entries. Every `visible` mirrors its target's own gate. */
const ATTENDEE_ACTIONS: readonly ActionDef<LoadedAttendee>[] = [
  {
    href: (entity, ctx) => withReturn(`${actionBase(entity)}/refund`, ctx),
    icon: "credit-card",
    labelKey: "attendee_form.action_refund",
    visible: ({ attendee }) => isRefundable(attendee),
  },
  {
    href: (entity, ctx) =>
      withReturn(`${actionBase(entity)}/resend-notification`, ctx),
    icon: "rotate-ccw",
    labelKey: "attendee_form.action_resend",
  },
  {
    href: ({ attendee }) =>
      `/admin/sms?listing=${attendee.listing_id}&attendee=${attendee.id}`,
    icon: "arrow-right",
    labelKey: "attendee_form.action_send_text",
  },
  {
    danger: true,
    href: (entity) => `${actionBase(entity)}/delete`,
    icon: "trash-2",
    labelKey: "attendee_form.action_delete",
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
      rows: ({ attendee, existing }) =>
        Promise.resolve(
          attendeeSummaryRows({
            allowedDomain: getEffectiveDomain(),
            attendee,
            hasRealLine: existing.some((line) => line.booking.quantity > 0),
            phonePrefix: settings.phonePrefix,
          }),
        ),
    },
    {
      kind: "custom",
      load: async ({ attendee, existing }) => {
        const renderListings = await getRenderListings(existing);
        const { parsed } = buildEditFormFromAttendee(
          attendee,
          existing,
          renderListings,
        );
        return AttendeeBookingsTable({
          bookings: attendeeBookingsFromLines(parsed.lines),
        });
      },
    },
    {
      kind: "custom",
      load: async ({ attendee, existing }) => {
        const { questions, selectedAnswerIds } = await loadQuestionsForExisting(
          attendee.id,
          existing,
        );
        return AttendeeAnswersTable({ questions, selectedAnswerIds });
      },
    },
    {
      kind: "custom",
      load: ({ attendee }, ctx) =>
        Promise.resolve(
          Raw({
            html: PaymentDetails({
              attendee,
              // The balance link targets the owner-only Balance tab, so it
              // must only render for owners (never render a forbidden link).
              showBalanceLink: ctx.session.adminLevel === "owner",
            }),
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
      load: async ({ attendee }, ctx) =>
        ContactHistory({
          attendee,
          contactRecords: await loadContactRecords(attendee),
          isOwner: ctx.session.adminLevel === "owner",
        }),
    },
  ],
  slug: "",
};

/** The tabbed attendee page. */
export const attendeePage: EntityPage<LoadedAttendee> = defineEntityPage({
  banner: async ({ attendee }) =>
    attendeeBanner({
      attendee,
      notes: await getNotesForAttendee(
        attendee.id,
        await requireRequestPrivateKey(),
      ),
      statuses: await getAllAttendeeStatuses(),
    }),
  basePath: (id) => `/admin/attendees/${id}`,
  guard: requireSessionOr,
  load: (id) => loadAttendeeForEdit(id),
  navActive: "/admin/attendees",
  tabs: [
    overviewTab,
    {
      labelKey: "entity.tab.edit",
      sections: [{ kind: "custom", load: loadEditPanel }],
      slug: "edit",
    },
    {
      labelKey: "entity.tab.ledger",
      sections: [
        {
          account: ({ attendee }) => attendeeAccount(attendee.id),
          kind: "ledger",
        },
      ],
      slug: "ledger",
      // The ledger exposes money movements, so it is owner-only — matching
      // the standalone /admin/ledger* routes.
      visible: (_entity, session) => session.adminLevel === "owner",
    },
    {
      labelKey: "entity.tab.balance",
      sections: [
        {
          kind: "custom",
          load: ({ attendee }, ctx) =>
            loadAttendeeBalancePanel(attendee.id, ctx.baseUrl),
        },
      ],
      slug: "balance",
      // The balance panel exposes order money and the customer pay link, so
      // it is owner-only like the Ledger tab (and the old /balance route).
      visible: (_entity, session) => session.adminLevel === "owner",
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
      labelKey: "entity.tab.actions",
      sections: [
        {
          actions: ATTENDEE_ACTIONS,
          kind: "actions",
          titleKey: "entity.tab.actions",
        },
        {
          kind: "custom",
          load: ({ attendee }, ctx) =>
            loadMergePanel(attendee, ctx.query.get("token") ?? ""),
        },
      ],
      slug: "actions",
    },
  ],
  titleOf: ({ attendee }) =>
    t("attendee_form.title_edit", { value: attendee.name }),
});
