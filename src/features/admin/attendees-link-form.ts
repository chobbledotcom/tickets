import { errorRedirect, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import {
  createAuthedFormRoute,
  type FormValidator,
} from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { addEventLink, updateEventLink } from "#shared/db/attendees.ts";
import { getEventWithCount } from "#shared/db/events.ts";
import { defineForm } from "#shared/forms.tsx";
import type { EventWithCount } from "#shared/types.ts";

type EventLinkOption = {
  active: boolean;
  id: number;
  name: string;
};

const eventOptionLabel = { label: "Select event...", value: "" };
const dateOptionLabel = { label: "Select date...", value: "" };
const defaultQuantityField = {
  defaultValue: "1",
  id: "add_quantity",
  label: "Quantity",
  min: 1,
  name: "quantity",
  required: true,
  type: "number",
  validate: (value: string) =>
    Number(value) >= 1 ? null : "Quantity must be at least 1",
} as const;
const defaultDateField = {
  id: "add_date",
  label: "Date",
  name: "date",
  options: [dateOptionLabel],
  type: "select",
} as const;

export const createLinkEventForm = (events: EventLinkOption[] = []) =>
  defineForm({
    fields: [
      {
        id: "add_event_id",
        label: "Event",
        name: "event_id",
        options: [
          eventOptionLabel,
          ...events
            .filter((event) => event.active)
            .map((event) => ({ label: event.name, value: String(event.id) })),
        ],
        parse: (value) => Number.parseInt(value, 10),
        required: true,
        type: "select",
        validate: (value) => {
          const eventId = Number.parseInt(value, 10);
          return eventId > 0 ? null : "Event is required";
        },
      },
      defaultQuantityField,
      defaultDateField,
    ] as const,
    id: "linkEvent",
  });

export const linkEventUpdateForm = defineForm({
  fields: [defaultQuantityField, defaultDateField] as const,
  id: "linkEventUpdate",
});

export const linkEventForm = createLinkEventForm();
type LinkFormValues = {
  date: string | null;
  durationDays?: number;
  quantity: number;
};

/** Parse a quantity value from a form field, clamping to [1, max] */
export const parseQuantity = (value: string, max: number): number => {
  const parsed = Math.floor(Number(value));
  return Math.max(1, Math.min(max, Number.isNaN(parsed) ? 1 : parsed));
};

/** Parse quantity, date, and (for daily events) duration from form for an event link operation */
const parseLinkFormFields = (
  values: LinkFormValues,
  event: EventWithCount,
): LinkFormValues => ({
  date: event.event_type === "daily" ? values.date : null,
  durationDays: event.event_type === "daily" ? event.duration_days : undefined,
  quantity: parseQuantity(String(values.quantity), event.max_quantity),
});

/** Resolve event, parse form fields, run op, check capacity, redirect on success */
const applyLinkOp = async (
  attendeeId: number,
  eventId: number,
  values: LinkFormValues,
  operate: (fields: LinkFormValues) => ReturnType<typeof addEventLink>,
  onSuccess: (event: EventWithCount) => Promise<Response>,
): Promise<Response> => {
  const event = await getEventWithCount(eventId);
  if (!event) {
    return errorRedirect(`/admin/attendees/${attendeeId}`, "Event not found");
  }

  const result = await operate(parseLinkFormFields(values, event));
  return result.success
    ? onSuccess(event)
    : errorRedirect(
        `/admin/attendees/${attendeeId}`,
        "Not enough spots available",
      );
};

type LinkRouteParams = { attendeeId: number; eventId?: number };

const invalidLinkResponse = (attendeeId: number, error: string): Response =>
  errorRedirect(`/admin/attendees/${attendeeId}`, error);

const createLinkRoute = <TValues extends LinkFormValues>(
  form: FormValidator<TValues>,
  getEventId: (values: TValues, params: LinkRouteParams) => number,
  operate: (
    params: { attendeeId: number; eventId: number },
    values: TValues,
    fields: LinkFormValues,
  ) => ReturnType<typeof addEventLink>,
  onSuccess: (
    event: EventWithCount,
    params: { attendeeId: number; eventId: number },
  ) => Promise<Response>,
) =>
  createAuthedFormRoute<TValues, LinkRouteParams>({
    form,
    onInvalid: ({ error, params }) =>
      invalidLinkResponse(params.attendeeId, error),
    onValid: ({ params, values }) => {
      const eventId = getEventId(values, params);
      const linkParams = { attendeeId: params.attendeeId, eventId };
      return applyLinkOp(
        linkParams.attendeeId,
        linkParams.eventId,
        values,
        (fields) => operate(linkParams, values, fields),
        (event) => onSuccess(event, linkParams),
      );
    },
  });

export const handleUpdateEventLink: TypedRouteHandler<"POST /admin/attendees/:attendeeId/event/:eventId"> =
  createLinkRoute(
    linkEventUpdateForm,
    (_values, params) => params.eventId!,
    ({ attendeeId, eventId }, _values, fields) =>
      updateEventLink(attendeeId, eventId, fields),
    (event, { attendeeId }) =>
      Promise.resolve(
        redirect(
          `/admin/attendees/${attendeeId}`,
          `Updated ${event.name}`,
          true,
        ),
      ),
  );

export const handleAddEventLink: TypedRouteHandler<"POST /admin/attendees/:attendeeId/link"> =
  createLinkRoute(
    linkEventForm,
    (values) => values.event_id,
    ({ attendeeId, eventId }, _values, fields) =>
      addEventLink(attendeeId, { eventId, ...fields }),
    async (event, { attendeeId, eventId }) => {
      await logActivity(`Attendee linked to '${event.name}'`, eventId);
      return redirect(
        `/admin/attendees/${attendeeId}`,
        `Added to ${event.name}`,
        true,
      );
    },
  );
