import { defineForm, type FormValuesFor } from "#lib/forms.tsx";

type EventLinkOption = {
  active: boolean;
  id: number;
  name: string;
};

const eventOptionLabel = { label: "Select event...", value: "" };
const dateOptionLabel = { label: "Select date...", value: "" };
const defaultQuantityField = {
  defaultValue: "1",
  label: "Quantity",
  min: 1,
  name: "quantity",
  type: "number",
  validate: (value: string) =>
    Number(value) >= 1 ? null : "Quantity must be at least 1",
} as const;
const defaultDateField = {
  label: "Date",
  name: "date",
  options: [dateOptionLabel],
  type: "select",
} as const;

export const createLinkEventForm = (events: EventLinkOption[] = []) =>
  defineForm({
    fields: [
      {
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
export type LinkEventValues = FormValuesFor<typeof linkEventForm.fields>;
export type LinkEventUpdateValues = FormValuesFor<
  typeof linkEventUpdateForm.fields
>;
