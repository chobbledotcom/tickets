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
  attendeeActions,
  paymentRecoveryAction,
} from "#routes/admin/attendees-route-helpers.ts";
import {
  type ActionDef,
  customSection,
  defineEntityPage,
  type EntityPage,
  type PageCtx,
  prepareOwnerFields,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { writeFormTab } from "#routes/admin/entity-write-tab.ts";
import { loadPreviousBookings } from "#routes/admin/previous-bookings.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { getPaymentWorkStatus } from "#shared/db/payment-review.ts";
import { settings } from "#shared/db/settings.ts";
import { isReadOnly } from "#shared/env.ts";
import type { PaymentWorkStatus } from "#shared/payment/admit-move.ts";
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

type AttendeePageEntity = LoadedAttendee & {
  readonly paymentWorkStatus: PaymentWorkStatus | "not_loaded";
};

const refreshPaymentAction = paymentRecoveryAction("refresh-payment");

/** Load payment review state only for the Actions tab. */
const loadAttendeePageEntity = async (
  id: number,
): Promise<AttendeePageEntity | null> => {
  const entity = await loadAttendeeForEdit(id);
  return entity === null
    ? null
    : { ...entity, paymentWorkStatus: "not_loaded" };
};

/** The attendee-scoped action routes live under the entity's own base. */
const actionBase = ({ attendee }: AttendeePageEntity): string =>
  `/admin/attendees/${attendee.id}`;

/** Thread the current tab back through a sub-action's confirm page. */
const withReturn = (href: string, ctx: PageCtx): string =>
  `${href}?return_url=${encodeURIComponent(ctx.returnUrl)}`;

type AttendeeActionName = keyof typeof attendeeActions;
const alwaysAllow = (): boolean => true;

/** Whether this attendee still has a real booking target. */
const hasBooking = ({ existing }: AttendeePageEntity): boolean =>
  existing.some(({ booking }) => booking.quantity > 0);

/** Gate a rendered link with the same scope schema as its target route. */
const actionWhen =
  (
    action: AttendeeActionName,
    allowed: NonNullable<
      ActionDef<AttendeePageEntity>["visible"]
    > = alwaysAllow,
  ): NonNullable<ActionDef<AttendeePageEntity>["visible"]> =>
  (entity, session) =>
    attendeeActions[action].isAvailable(hasBooking(entity)) &&
    allowed(entity, session);

/** Gate owner payment actions on one named durable row state. */
const ownerPaymentWhen = (
  action: AttendeeActionName,
  status: PaymentWorkStatus,
  allowed: (entity: AttendeePageEntity) => boolean = alwaysAllow,
): NonNullable<ActionDef<AttendeePageEntity>["visible"]> =>
  actionWhen(
    action,
    (entity, session) =>
      isOwnerRole(session.adminLevel) &&
      entity.paymentWorkStatus === status &&
      allowed(entity),
  );

/** Build one attendee-scoped confirmation action. */
const attendeeAction = (
  segment: string,
  config: Omit<ActionDef<AttendeePageEntity>, "href">,
): ActionDef<AttendeePageEntity> => ({
  ...config,
  href: (entity, ctx) => withReturn(`${actionBase(entity)}/${segment}`, ctx),
});

/** The Actions tab entries. Every `visible` mirrors its target's own gate. */
const ATTENDEE_ACTIONS: readonly ActionDef<AttendeePageEntity>[] = [
  attendeeAction("refund", {
    icon: "credit-card",
    labelKey: "attendee_form.action_refund",
    visible: ownerPaymentWhen("refund", "clear", ({ canRefund }) => canRefund),
  }),
  attendeeAction("payment-review", {
    icon: "check",
    labelKey: "attendee_form.action_payment_review",
    visible: ownerPaymentWhen("payment-review", "needs_review"),
  }),
  attendeeAction("resend-notification", {
    icon: "rotate-ccw",
    labelKey: "attendee_form.action_resend",
    visible: actionWhen("resend-notification"),
  }),
  {
    href: ({ attendee }) =>
      `/admin/sms?listing=${attendee.listing_id}&attendee=${attendee.id}`,
    icon: "arrow-right",
    labelKey: "attendee_form.action_send_text",
    visible: actionWhen("send-text"),
  },
  {
    danger: true,
    href: (entity) => `${actionBase(entity)}/delete`,
    icon: "trash-2",
    labelKey: "attendee_form.action_delete",
    visible: actionWhen("delete"),
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
const overviewTab: TabDef<AttendeePageEntity> = {
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
      load: ({ attendee, hasIndexedPaymentReference }, ctx) =>
        Promise.resolve(
          PaymentDetails({
            attendee,
            refreshPaymentUrl: hasIndexedPaymentReference
              ? refreshPaymentAction.url(attendee.id)
              : null,
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
      load: async ({ attendee }, ctx) => {
        const [contactRecords, previousBookings] = await Promise.all([
          loadContactRecords(attendee),
          loadPreviousBookings(attendee),
        ]);
        return ContactHistory({
          attendee,
          contactRecords,
          isOwner: isOwnerRole(ctx.session.adminLevel),
          previousBookings,
        });
      },
    },
  ],
  slug: "",
};

/** The tabbed attendee page. */
export const attendeePage: EntityPage<AttendeePageEntity> = defineEntityPage({
  banner: async ({ attendee }, ctx) =>
    attendeeBanner({
      attendee,
      isOwner: ctx.session.adminLevel === "owner",
      notes: await getNotesFor(
        attendeeNotes(attendee.id),
        await requireRequestPrivateKey(),
      ),
      statuses: await attendeeStatuses.getAll(),
    }),
  basePath: (id) => `/admin/attendees/${id}`,
  guard: requireSessionOr,
  load: (id) => loadAttendeePageEntity(id),
  // A single attendee is a page *within* the Attendees section: highlight the
  // top-level link, but never re-open the section's "Add" sub-nav beside it.
  navActive: { section: "/admin/attendees" },
  proseExtra: ({ attendee }) =>
    Promise.resolve(
      isReadOnly() ? null : AddNoteLink({ attendeeId: attendee.id }),
    ),
  tabs: [
    overviewTab,
    writeFormTab<AttendeePageEntity>("edit", "entity.tab.edit", loadEditPanel),
    writeFormTab<AttendeePageEntity>(
      "logistics",
      "entity.tab.logistics",
      loadLogisticsPanel,
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
      // owner-only — matching the standalone /admin/ledger* routes.
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
      intent: "write-form",
      labelKey: "entity.tab.actions",
      sections: [
        {
          actions: ATTENDEE_ACTIONS,
          kind: "actions",
          prepare: prepareOwnerFields<AttendeePageEntity>(async (entity) => ({
            paymentWorkStatus: await getPaymentWorkStatus(entity.attendee.id),
          })),
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
