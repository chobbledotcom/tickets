import type { AttendeeFormLine } from "#routes/admin/attendee-form-model.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  parseNonNegativeInt,
  parsePositiveInt as parsePositiveIntId,
} from "#shared/validation/number.ts";

/** Per-line hidden field carrying the line's listing id: `line_listing_<i>`.
 * The presence of this field defines a line. `<i>` is the line's position in
 * the rendered editor, shared by every other per-line field. */
export const LINE_LISTING_PREFIX = "line_listing_";
/** Per-line quantity field: `qty_<i>`. */
export const QTY_PREFIX = "qty_";
/** Per-line "no quantity" checkbox: `noqty_<i>`. */
export const NO_QUANTITY_PREFIX = "noqty_";
/** Per-line hidden field carrying an existing booking row's stable key. */
export const LINE_KEY_PREFIX = "line_key_";
/** Per-line hidden field carrying the package path selected for a blank line. */
export const LINE_PACKAGE_PREFIX = "line_package_";

/** The packages each listing can book through, with each path's per-unit price
 * override. A null price means the listing's own price applies. */
export type PackagePricesByListingId = ReadonlyMap<
  number,
  ReadonlyMap<number, number | null>
>;

type SubmittedLine = { index: number; listingId: number };

type LineResolver = (
  id: number,
  key: string,
) => Pick<AttendeeFormLine, "listing" | "existingBooking">;

/** The package a blank line books through. Invalid or stale choices use the
 * listing's own standalone row instead of storing a missing package. */
const resolveNewLinePackage = (
  raw: string,
  listingId: number,
  packagesByListingId: PackagePricesByListingId,
): number => {
  const groupId = parsePositiveIntId(raw);
  return groupId !== null &&
    packagesByListingId.get(listingId)?.has(groupId) === true
    ? groupId
    : 0;
};

/** Find valid line indexes and listing ids in document order. The first field
 * for an index owns it, even when that field carries an invalid listing id. */
const submittedLines = (form: FormParams): SubmittedLine[] => {
  const lines: SubmittedLine[] = [];
  const seen = new Set<number>();
  for (const [field, raw] of form.entries()) {
    if (!field.startsWith(LINE_LISTING_PREFIX)) continue;
    // Line indexes start at 0, so this must accept zero (unlike listing ids).
    const index = parseNonNegativeInt(field.slice(LINE_LISTING_PREFIX.length));
    if (index === null || seen.has(index)) continue;
    seen.add(index);
    const listingId = parsePositiveIntId(raw);
    if (listingId === null) continue;
    lines.push({ index, listingId });
  }
  return lines;
};

/** Resolve one submitted line and read the rest of its indexed fields. */
const parseLine = (
  form: FormParams,
  { index, listingId }: SubmittedLine,
  resolve: LineResolver,
  packagesByListingId: PackagePricesByListingId,
): AttendeeFormLine => {
  const key = form.getString(`${LINE_KEY_PREFIX}${index}`);
  const resolved = resolve(listingId, key);
  const noQuantity = form.getString(`${NO_QUANTITY_PREFIX}${index}`) !== "";
  const packageGroupId =
    resolved.existingBooking?.package_group_id ??
    resolveNewLinePackage(
      form.getString(`${LINE_PACKAGE_PREFIX}${index}`),
      listingId,
      packagesByListingId,
    );
  return {
    error: null,
    key,
    listingId,
    noQuantity,
    packageGroupId,
    packagePrice:
      packageGroupId > 0
        ? (packagesByListingId.get(listingId)?.get(packageGroupId) ?? null)
        : null,
    parentListingId: resolved.existingBooking?.parent_listing_id ?? 0,
    quantity: noQuantity
      ? 0
      : parseNonNegativeInt(form.getString(`${QTY_PREFIX}${index}`)),
    ...resolved,
  };
};

/** One editor line per `line_listing_<i>` field in document order, de-duplicated
 * by index. Saved rows keep their stored path. Blank lines use their validated
 * package path. A checked `noqty_<i>` forces quantity to zero. */
export const parseLines = (
  form: FormParams,
  resolve: LineResolver,
  packagesByListingId: PackagePricesByListingId,
): AttendeeFormLine[] =>
  submittedLines(form).map((line) =>
    parseLine(form, line, resolve, packagesByListingId),
  );
