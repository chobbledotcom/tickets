/**
 * Listing form parsing and resource builders.
 *
 * Turns the raw create/edit form into a {@link ListingInput}. It wraps the
 * shared listing fields into per-request create/update REST resources, so the
 * dynamic `day_price_*` inputs can be read alongside the validated values.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { listingAttributeOptions } from "#db/attributes.ts";
import type { TxScope } from "#db/client.ts";
import {
  requireMembershipValidation,
  validateListingGroupMembershipsTx,
} from "#db/groups/membership.ts";
import { copyPackageMemberOverridesTx } from "#db/groups.ts";
import {
  type AssignPlan,
  moveUndatedBookingsToDayTx,
  wouldBeStaySpanDays,
} from "#db/listings/daily-switch.ts";
import { listingsTable } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { range } from "#fp";
import { t } from "#i18n";
import { formDataToParams } from "#routes/csrf.ts";
import { listingSaveOrphanedAddOnTx } from "#shared/add-on-reachability.ts";
import {
  applyDemoOverrides,
  LISTING_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  checkedValues,
  type ValidationResult,
} from "#shared/forms/validation.ts";
import {
  generateUniqueListingSlug,
  keepDailyListingDate,
  refuseUndatedListingSwitch,
} from "#shared/listings-actions.ts";
import {
  LISTING_FIELDS,
  type ListingInput,
} from "#shared/records/listing-fields.ts";
import { listingRecord } from "#shared/records/listings.ts";
import {
  formFieldsInput,
  shownFieldKeys,
  unshownFieldOrNull,
} from "#shared/rest/field-reads.ts";
import type { WriteVerdict } from "#shared/rest/record.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { normalizeSlug } from "#shared/slug.ts";
import { commaParts } from "#shared/split.ts";
import { parseOptionalMinorUnits } from "#shared/validation/money.ts";
import { showUseDefaultsToggle } from "#templates/admin/listings/form-values.tsx";
import {
  getListingEditForm,
  getListingForm,
  type ListingFormValues,
  type ListingFormView,
} from "#templates/fields/listing.ts";
import {
  type DayPrices,
  type ListingType,
  type ListingWithCount,
  parseDayPrices,
} from "#types";
import {
  persistListingJoins,
  prepareListingJoins,
} from "./api-listing-joins.ts";

type ListingWriteMode = "create" | "update";
type EmptyBookableDaysPolicy = "defaultAllDays" | "preserveEmpty";

export const parseListingForm = (formData: FormData): FormParams =>
  applyDemoOverrides(formDataToParams(formData), LISTING_DEMO_FIELDS);

const EMPTY_BOOKABLE_DAYS_POLICY = {
  create: {
    daily: "defaultAllDays",
    standard: "defaultAllDays",
  },
  update: {
    daily: "preserveEmpty",
    standard: "defaultAllDays",
  },
} as const satisfies Record<
  ListingWriteMode,
  Record<ListingType, EmptyBookableDaysPolicy>
>;

const parseBookableDays = (
  value: string,
  listingType: ListingType,
  mode: ListingWriteMode,
): string[] | undefined => {
  const days = commaParts(value);
  if (days.length > 0) return days;
  return EMPTY_BOOKABLE_DAYS_POLICY[mode][listingType] === "preserveEmpty"
    ? days
    : undefined;
};

/**
 * Read the per-day-count price inputs (`day_price_1`, `day_price_2`, …) from
 * the raw form into a {@link DayPrices} map. Only days 1..maxDays are read,
 * matching the inputs the form renders. Blank rows are skipped so the count
 * is not offered. {@link parseDayPrices} drops any non-numeric entries.
 */
const parseDayPricesFromForm = (
  form: FormParams,
  maxDays: number,
): DayPrices => {
  const result: DayPrices = {};
  for (const n of range(1, maxDays + 1)) {
    // Optional per-day price: blank ⇒ skip (that day is not offered). A non-blank
    // value that fails to parse is caught by validateDayPricesFromForm before
    // the save, so here a null result is only ever a blank.
    const price = parseOptionalMinorUnits(form.getString(`day_price_${n}`));
    if (price !== null) result[n] = price;
  }
  return parseDayPrices(result);
};

/**
 * Reject the save when a `day_price_*` field carries a non-blank value that
 * is not a valid amount for the currency. Examples: `10.005` in GBP, `10.5`
 * in JPY, or `abc`. Without this, {@link parseDayPricesFromForm} silently
 * drops an invalid value. On an update that removes an existing day price
 * instead of surfacing the error. Blank fields are skipped (that duration is
 * not offered). Returns an error message, or null when every present day
 * price is valid. These dynamic fields are not part of the static field
 * schema, so they are validated here through the resource's `validate` hook.
 */
const validateDayPricesFromForm = (form: FormParams): string | null => {
  const hasInvalid = [...form.entries()].some(
    ([field, raw]) =>
      field.startsWith("day_price_") &&
      raw.trim() !== "" &&
      parseOptionalMinorUnits(raw) === null,
  );
  return hasInvalid
    ? "Enter a valid day price for each duration, or leave it blank."
    : null;
};

/** A listing form definition, for a create or an edit. */
type ListingDefinition<Values> = {
  readonly fields: readonly {
    readonly name: string;
    readonly visible?: boolean;
  }[];
  readonly validate: (form: FormParams) => ValidationResult<Values>;
};

/** Read one submitted listing form. A form that sends a field box its page
 *  did not show is refused. Each shown box is read by its field kind. The
 *  "use listing defaults" switch sits outside the form definition. */
const readListingForm = <Values extends ListingFormValues>(
  definition: ListingDefinition<Values>,
  view: ListingFormView,
  submitted: FormParams,
  mode: ListingWriteMode,
): Result<{
  input: Omit<ListingInput, "slug" | "slugIndex">;
  values: Values;
}> => {
  const shown = shownFieldKeys(
    LISTING_FIELDS,
    definition.fields,
    showUseDefaultsToggle(view.closed, settings.listingDefaults)
      ? ["use_defaults"]
      : [],
  );
  if (
    unshownFieldOrNull(LISTING_FIELDS, [...submitted.keys()], shown) !== null
  ) {
    return errorResult(t("fields.validation.unshown_field"));
  }
  const parsed = checkedValues(definition.validate(submitted));
  if (!parsed.ok) return parsed;
  const dayError = validateDayPricesFromForm(submitted);
  if (dayError !== null) return errorResult(dayError);
  const values = parsed.value;
  const fields = formFieldsInput(
    LISTING_FIELDS,
    { ...values, use_defaults: submitted.getString("use_defaults") },
    shown,
  );
  return okResult({
    input: {
      ...fields,
      bookableDays: parseBookableDays(
        values.bookable_days,
        fields.listingType,
        mode,
      ),
      dayPrices: parseDayPricesFromForm(submitted, values.duration_days ?? 1),
      groupIds: submitted.getNumberArray("group_ids"),
    },
    values,
  });
};

/** Read a create form into the listing input, with a fresh slug. */
const extractListingInput = async (
  view: ListingFormView,
  submitted: FormParams,
): Promise<Result<ListingInput>> => {
  const read = readListingForm(getListingForm(view), view, submitted, "create");
  if (!read.ok) return read;
  const { slug, slugIndex } = await generateUniqueListingSlug();
  return okResult({ ...read.value.input, slug, slugIndex });
};

/** Read an edit form into the listing input, with its submitted slug. */
const extractListingUpdateInput = async (
  view: ListingFormView,
  submitted: FormParams,
): Promise<Result<ListingInput & { date: string }>> => {
  const read = readListingForm(
    getListingEditForm(view),
    view,
    submitted,
    "update",
  );
  if (!read.ok) return read;
  const slug = normalizeSlug(read.value.values.slug);
  const slugIndex = await hmacHash(slug);
  // The page always shows the date box.
  const input = read.value.input as ListingInput & { date: string };
  return okResult({ ...input, slug, slugIndex });
};

/** The page save's join write, through the same pair the JSON API uses. The
 *  page form carries no child or attribute fields, so the prepare step yields
 *  no child edges and no attribute options. The persist writes the group
 *  memberships and the per-day-count prices. The `base` mirror is reconciled
 *  from the `unit_price` column by afterCommit. */
const writeListingJoins = async (
  tx: TxScope,
  id: number,
  input: ListingInput,
): Promise<void> => {
  await persistListingJoins(tx, id, prepareListingJoins(input));
};

/** Create-only afterWrite. Persist the joins. For a duplicate, copy the
 * source's package overrides and attribute selections onto the new rows in the
 * SAME transaction. The duplicate then never commits as a live package member
 * at the default price when the override copy fails. */
/** One listing join write, run inside the row's transaction. */
type ListingJoinWriter = (
  tx: TxScope,
  id: number,
  input: ListingInput,
) => Promise<void>;

const writeCreateListingJoins: (form: FormParams) => ListingJoinWriter =
  (form) => async (tx, id, input) => {
    await writeListingJoins(tx, id, input);
    const sourceId = form.getOptionalInt("duplicated_from");
    if (sourceId !== null) {
      await copyPackageMemberOverridesTx(tx, sourceId, id);
      await listingAttributeOptions.copyLinksTx(tx, sourceId, id);
      // The override copy can raise the pick count above the fresh-join
      // default of one the membership check judged. Revalidate it as persisted.
      requireMembershipValidation(
        await validateListingGroupMembershipsTx(tx)([id], input.groupIds!),
      );
    }
  };

/** One listing write's answer: the row, or the text that refused it. */
type ListingWriteResult =
  | { ok: true; row: ListingWithCount }
  | { ok: false; error: string };

export type ListingCreateResult = ListingWriteResult;
export type ListingUpdateResult =
  | ListingWriteResult
  | { ok: false; notFound: true };

/** One write's success answer, or null for its failure. */
const writtenResult = <Row>(verdict: WriteVerdict<Row>) =>
  verdict.kind === "written" ? { ok: true as const, row: verdict.row } : null;

/** One write's refusal answer, or the door's own missing-row answer. */
const failedResult = <Row, Missing>(
  verdict: WriteVerdict<Row>,
  missing: Missing,
): { error: string; ok: false } | Missing => {
  if (verdict.kind === "refused") {
    return { error: verdict.message, ok: false };
  }
  return missing;
};

/** Parse the create form into the record's input, then write through the
 * record with the create door's join plan. */
export const buildCreateListingResource = (
  form: FormParams,
  view: ListingFormView,
) => ({
  create: async (submitted: FormParams): Promise<ListingCreateResult> => {
    const parsed = await extractListingInput(view, submitted);
    if (!parsed.ok) return parsed;
    const input = parsed.value;
    const verdict = await listingRecord.create(input, {
      persist: (tx, id) => writeCreateListingJoins(form)(tx, id, input),
    });
    return (
      writtenResult(verdict) ??
      failedResult(verdict, { error: "Listing not found", ok: false })
    );
  },
});

/** Build a per-request listings update command (includes the slug field).
 * `stored` is the row the save must not clobber: a daily listing's hidden date
 * box submits empty, and that empty date keeps the stored one. `assign` is the
 * confirmed switch move: date every undated booking, then let the save commit
 * the type flip. Without it, a bare switch is refused while undated bookings
 * remain. */
export const buildUpdateListingResource = (
  stored: ListingWithCount,
  view: ListingFormView,
  assign?: AssignPlan,
) => {
  /** The validated edit input, with the stored daily date kept when the form
   * sends an empty date box. */
  const parseInput = async (
    submitted: FormParams,
  ): Promise<Result<ListingInput>> => {
    const parsed = await extractListingUpdateInput(view, submitted);
    if (!parsed.ok) return parsed;
    const input = parsed.value;
    return okResult({
      ...input,
      date: keepDailyListingDate(input.date, stored, input.listingType),
    });
  };

  return {
    parseInput,
    update: async (
      id: number,
      submitted: FormParams,
    ): Promise<ListingUpdateResult> => {
      if (!(await listingsTable.read.exists({ id }))) {
        return { notFound: true, ok: false };
      }
      const parsed = await parseInput(submitted);
      if (!parsed.ok) return parsed;
      const dated = parsed.value;
      const verdict = await listingRecord.update(id, dated, {
        // The add-on reachability half of the save refuses inside the row
        // write's transaction, so two concurrent page-removing saves cannot
        // both commit. Without a confirmed move, a type switch that leaves
        // undated bookings behind is refused here too.
        checkTx:
          assign === undefined
            ? (tx, rowId) => refuseUndatedListingSwitch(tx, rowId, dated)
            : (tx, rowId) => listingSaveOrphanedAddOnTx(tx, rowId, dated),
        persist: (tx, rowId) =>
          assign === undefined
            ? writeListingJoins(tx, rowId, dated)
            : moveAssignedListing(tx, rowId, dated, stored, assign),
      });
      return (
        writtenResult(verdict) ??
        failedResult(verdict, { notFound: true, ok: false })
      );
    },
  };
};

/** The update's join write when the operator confirmed a type switch: write
 *  the edges, then date every undated booking. */
const moveAssignedListing = async (
  tx: TxScope,
  id: number,
  input: ListingInput,
  stored: ListingWithCount,
  assign: AssignPlan,
): Promise<void> => {
  await writeListingJoins(tx, id, input);
  await moveUndatedBookingsToDayTx(
    tx,
    id,
    stored.name,
    assign.date,
    wouldBeStaySpanDays(input),
  );
};
