import { errorRedirect, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import {
  createAuthedFormRoute,
  type FormValidator,
} from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { addListingLink, updateListingLink } from "#shared/db/attendees.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import { defineForm } from "#shared/forms.tsx";
import type { ListingWithCount } from "#shared/types.ts";

type ListingLinkOption = {
  active: boolean;
  id: number;
  name: string;
};

const listingOptionLabel = { label: "Select listing...", value: "" };
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

export const createLinkListingForm = (listings: ListingLinkOption[] = []) =>
  defineForm({
    fields: [
      {
        id: "add_listing_id",
        label: "Listing",
        name: "listing_id",
        options: [
          listingOptionLabel,
          ...listings
            .filter((listing) => listing.active)
            .map((listing) => ({
              label: listing.name,
              value: String(listing.id),
            })),
        ],
        parse: (value) => Number.parseInt(value, 10),
        required: true,
        type: "select",
        validate: (value) => {
          const listingId = Number.parseInt(value, 10);
          return listingId > 0 ? null : "Listing is required";
        },
      },
      defaultQuantityField,
      defaultDateField,
    ] as const,
    id: "linkListing",
  });

export const linkListingUpdateForm = defineForm({
  fields: [defaultQuantityField, defaultDateField] as const,
  id: "linkListingUpdate",
});

export const linkListingForm = createLinkListingForm();
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

/** Parse quantity, date, and (for daily listings) duration from form for an listing link operation */
const parseLinkFormFields = (
  values: LinkFormValues,
  listing: ListingWithCount,
): LinkFormValues => ({
  date: listing.listing_type === "daily" ? values.date : null,
  durationDays:
    listing.listing_type === "daily" ? listing.duration_days : undefined,
  quantity: parseQuantity(String(values.quantity), listing.max_quantity),
});

/** Resolve listing, parse form fields, run op, check capacity, redirect on success */
const applyLinkOp = async (
  attendeeId: number,
  listingId: number,
  values: LinkFormValues,
  operate: (fields: LinkFormValues) => ReturnType<typeof addListingLink>,
  onSuccess: (listing: ListingWithCount) => Promise<Response>,
): Promise<Response> => {
  const listing = await getListingWithCount(listingId);
  if (!listing) {
    return errorRedirect(`/admin/attendees/${attendeeId}`, "Listing not found");
  }

  const result = await operate(parseLinkFormFields(values, listing));
  return result.success
    ? onSuccess(listing)
    : errorRedirect(
        `/admin/attendees/${attendeeId}`,
        "Not enough spots available",
      );
};

type LinkRouteParams = { attendeeId: number; listingId?: number };

const invalidLinkResponse = (attendeeId: number, error: string): Response =>
  errorRedirect(`/admin/attendees/${attendeeId}`, error);

const createLinkRoute = <TValues extends LinkFormValues>(
  form: FormValidator<TValues>,
  getListingId: (values: TValues, params: LinkRouteParams) => number,
  operate: (
    params: { attendeeId: number; listingId: number },
    values: TValues,
    fields: LinkFormValues,
  ) => ReturnType<typeof addListingLink>,
  onSuccess: (
    listing: ListingWithCount,
    params: { attendeeId: number; listingId: number },
  ) => Promise<Response>,
) =>
  createAuthedFormRoute<TValues, LinkRouteParams>({
    form,
    onInvalid: ({ error, params }) =>
      invalidLinkResponse(params.attendeeId, error),
    onValid: ({ params, values }) => {
      const listingId = getListingId(values, params);
      const linkParams = { attendeeId: params.attendeeId, listingId };
      return applyLinkOp(
        linkParams.attendeeId,
        linkParams.listingId,
        values,
        (fields) => operate(linkParams, values, fields),
        (listing) => onSuccess(listing, linkParams),
      );
    },
  });

export const handleUpdateListingLink: TypedRouteHandler<"POST /admin/attendees/:attendeeId/listing/:listingId"> =
  createLinkRoute(
    linkListingUpdateForm,
    (_values, params) => params.listingId!,
    ({ attendeeId, listingId }, _values, fields) =>
      updateListingLink(attendeeId, listingId, fields),
    (listing, { attendeeId }) =>
      Promise.resolve(
        redirect(
          `/admin/attendees/${attendeeId}`,
          `Updated ${listing.name}`,
          true,
        ),
      ),
  );

export const handleAddListingLink: TypedRouteHandler<"POST /admin/attendees/:attendeeId/link"> =
  createLinkRoute(
    linkListingForm,
    (values) => values.listing_id,
    ({ attendeeId, listingId }, _values, fields) =>
      addListingLink(attendeeId, { listingId, ...fields }),
    async (listing, { attendeeId, listingId }) => {
      await logActivity(`Attendee linked to '${listing.name}'`, listingId);
      return redirect(
        `/admin/attendees/${attendeeId}`,
        `Added to ${listing.name}`,
        true,
      );
    },
  );
