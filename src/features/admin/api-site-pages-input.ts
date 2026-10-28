/**
 * The site-pages JSON API's input layer: the JSON body → page-write mapping
 * both the create and the update run. The parent plan sits here too, and the
 * update validates it first. The rules and messages match the Site → Pages
 * form.
 */

import type { TxScope } from "#db/client.ts";
import {
  addPageItem,
  getAllPageItems,
  removePageItem,
} from "#db/site-page-items.ts";
import type { SitePageWriteInput } from "#db/site-pages.ts";
import { t } from "#i18n";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import {
  optionalBoolean,
  requireEntityField,
} from "#shared/rest/crud-parsers.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { isReservedSlug, wouldCreateCycle } from "#shared/site-pages/core.ts";
import { loadPageForest } from "#shared/site-pages/load.ts";
import { normalizeSlug, validateSlug } from "#shared/slug.ts";
import type { SitePage, SitePageItem } from "#types";
import { CONTENT_FIELD_LIMITS } from "./content-form-fields.ts";

/** JSON body accepted by POST /api/admin/site-pages. A new page is always a
 *  root page, so the create body carries no parent. */
export type CreateSitePageBody = {
  content?: string;
  hidden?: boolean;
  meta_description?: string;
  meta_title?: string;
  name: string;
  slug: string;
};

/** JSON body accepted by PUT /api/admin/site-pages/:pageId. `parent` names
 *  the page to nest under, or null to move the page to the top level. */
export type UpdateSitePageBody = Partial<
  CreateSitePageBody & { parent: number | null }
>;

// DELETE /api/admin/site-pages/:pageId takes the shared DeleteBody the
// crud-parsers module exports.

/** The maxlength refusal names the field by the label the form's own refusal
 *  uses, so both surfaces answer with the same words. */
const FIELD_LABELS = {
  content: () => t("fields.content"),
  meta_description: () => t("fields.meta_description"),
  meta_title: () => t("fields.meta_title"),
} as const;

/** The stored text values the writable text fields keep when the body is
 *  silent, keyed by the JSON field name. */
const storedText = (
  existing: SitePage | null,
): Record<keyof typeof FIELD_LABELS, string> => ({
  content: existing?.content ?? "",
  meta_description: existing?.meta_description ?? "",
  meta_title: existing?.meta_title ?? "",
});

/** Run `clean` over one supplied field's raw value: absent keeps the stored
 *  value, and a supplied non-string is refused with the field-named
 *  message. */
const withSupplied = (
  body: Record<string, unknown>,
  key: string,
  stored: string,
  clean: (value: string) => Result<string>,
): Result<string> => {
  const raw = body[key];
  if (raw === undefined) return clean(stored);
  if (typeof raw !== "string") return errorResult(`${key} must be a string`);
  return clean(raw);
};

/** One writable text field: a value past the field's cap gets the form's own
 *  length refusal. The form reads submitted values trimmed, so the API trims
 *  too. */
const optionalTextField = (
  body: Record<string, unknown>,
  key: keyof typeof FIELD_LABELS,
  stored: string,
): Result<string> =>
  withSupplied(body, key, stored, (raw) => {
    const value = raw.trim();
    const max = CONTENT_FIELD_LIMITS[key];
    if (value.length > max) return tooLong(FIELD_LABELS[key](), max);
    return okResult(value);
  });

/** The "longer than the field's cap" refusal, in the form's own words. The
 *  slug, the page name, and the text fields all refuse with the same message,
 *  so the message construction lives once. */
const tooLong = (label: string, max: number): Result<never> =>
  errorResult(
    t("fields.validation.max_length", {
      label,
      max,
    }),
  );

/** The slug: absent keeps the stored one. A supplied value normalises and
 *  validates through the same rule the form's slug field runs, then the
 *  reserved-word check the form's handler runs. The write itself refuses a
 *  slug a listing, group, or page already owns. */
const optionalSlug = (body: Record<string, unknown>, stored: string) =>
  withSupplied(body, "slug", stored, (raw) => {
    const slug = normalizeSlug(raw);
    const invalid = validateSlug(slug);
    if (invalid) return errorResult(invalid);
    // The form's slug field refuses a value past the input cap, after the
    // format check and before the reserved words. The same refusal here.
    if (slug.length > MAX_INPUT_LENGTH)
      return tooLong(t("common.slug"), MAX_INPUT_LENGTH);
    if (isReservedSlug(slug)) {
      return errorResult(t("site.pages.error.reserved"));
    }
    return okResult(slug);
  });

/** The page name's read: the shared entity field rule, then the form's
 *  length cap with the form's own words. */
const pageName = (
  body: Record<string, unknown>,
  stored: string | null,
): Result<string> => {
  const name = requireEntityField(body, "name", stored);
  if (name.ok && name.value.length > MAX_INPUT_LENGTH) {
    return tooLong(t("site.pages.field.name"), MAX_INPUT_LENGTH);
  }
  return name;
};

/** The shared input mapping for a page create or update: the same fields,
 *  the same rules and the same messages on both surfaces. `existing` is null
 *  on a create, where every absent field takes the form's own default. */
export const toPageWrite = (
  body: Record<string, unknown>,
  existing: SitePage | null,
): Result<SitePageWriteInput> => {
  const stored = storedText(existing);
  const name = pageName(body, existing?.name ?? null);
  const hidden = optionalBoolean(body, "hidden", existing?.hidden ?? false);
  const slug = optionalSlug(body, existing?.slug ?? "");
  const textFields = ["content", "meta_description", "meta_title"] as const;
  const text: Record<(typeof textFields)[number], string> = {
    content: "",
    meta_description: "",
    meta_title: "",
  };
  for (const key of textFields) {
    const field = optionalTextField(body, key, stored[key]);
    if (!field.ok) return field;
    text[key] = field.value;
  }
  // The name refuses first: the field order the form's own validation
  // reports in, then the box, then the slug, then the text fields.
  if (!name.ok) return name;
  if (!hidden.ok) return hidden;
  if (!slug.ok) return slug;
  return okResult({
    content: text.content,
    hidden: hidden.value,
    metaDescription: text.meta_description,
    metaTitle: text.meta_title,
    name: name.value,
    slug: slug.value,
  });
};

/** The content-page write fields a fixed page does not carry. A body that
 *  names one gets the field-named refusal. A fixed page holds only its
 *  content, so a client cannot send it the other fields. The type refuses a
 *  name outside the declared update body. The fixed-page test reads its cases
 *  from that schema. A new schema field must join this list. */
const FIXED_PAGE_BARRED_FIELDS: readonly Exclude<
  keyof UpdateSitePageBody,
  "content"
>[] = ["hidden", "meta_description", "meta_title", "name", "parent", "slug"];

/** The fixed page's content: the one writable field of a home, contact or
 *  terms page. A body naming any content-page field a fixed page does not
 *  carry is refused with the field-named message. A supplied content runs
 *  the shared text rule: trimmed, and a non-string is refused with the field
 *  message. A value past the form's textarea cap answers the form's length
 *  message. A silent body keeps the stored text unchanged. The stored text
 *  can exceed the cap, because the terms editor stores text with no length
 *  cap. The cap check runs on a supplied value only. */
export const toFixedPageContent = (
  body: Record<string, unknown>,
  stored: string,
): Result<string> => {
  for (const field of FIXED_PAGE_BARRED_FIELDS) {
    if (body[field] !== undefined) {
      return errorResult(`${field} cannot change on a fixed page`);
    }
  }
  if (body.content === undefined) return okResult(stored);
  return optionalTextField(body, "content", stored);
};

/** The tx step both parent writes share: drop the page's current parent
 *  edge, if it has one, then run the next step. */
const dropCurrentEdgeThen =
  (
    pageId: number,
    edge: SitePageItem | undefined,
    next: (tx: TxScope) => Promise<boolean>,
  ) =>
  async (tx: TxScope): Promise<boolean> => {
    if (edge) await removePageItem(edge.page_id, "page", pageId, tx);
    return next(tx);
  };

/** The parent change one update body asks for. `null` removes the current
 *  parent edge, so the page sits at the top level again. A page id moves the
 *  page under that page. A body that sends the page's own current parent
 *  writes nothing. The target must be a page, and must not be the page
 *  itself or one of its own descendants. The page keeps its subtree when it
 *  moves, so a move under a descendant closes a loop. The atomic re-check
 *  runs inside the write transaction (addPageItem), so a concurrent add
 *  cannot slip past. */
export const planParentChange = async (
  page: SitePage,
  raw: unknown,
): Promise<Result<(tx: TxScope) => Promise<boolean>>> => {
  const currentEdge = (await getAllPageItems()).find(
    (item) => item.item_type === "page" && item.item_id === page.id,
  );
  if (raw === null) {
    return okResult(
      dropCurrentEdgeThen(page.id, currentEdge, async () => true),
    );
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return errorResult("parent must be a page id or null");
  }
  const { forest } = await loadPageForest();
  if (forest.parentByChild.get(page.id) === raw) {
    // The page already sits under this parent: nothing to write.
    return okResult(async () => true);
  }
  if (!forest.byId.has(raw) || wouldCreateCycle(forest, raw, page.id)) {
    return errorResult(t("site.pages.error.ineligible"));
  }
  // A move replaces the current parent edge in the same transaction, so the
  // single-parent re-check in addPageItem sees the edge gone.
  return okResult(
    dropCurrentEdgeThen(page.id, currentEdge, (tx) =>
      addPageItem(raw, "page", page.id, tx),
    ),
  );
};
