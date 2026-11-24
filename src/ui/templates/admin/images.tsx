/**
 * Admin image library templates.
 */

import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { isReadOnly } from "#shared/env.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { Flash } from "#shared/forms/flash.tsx";
import { renderFields } from "#shared/forms/rendering.tsx";
import { idSet } from "#shared/fp-records.ts";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import { LAZY_THUMBNAIL_FROM } from "#shared/images/picker.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import type {
  ReorderColumnOptions,
  TableColumn,
} from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import {
  errorAdminPage,
  flashFormPage,
  successListPage,
} from "#templates/admin/admin-page.tsx";
import { entityDeletePage } from "#templates/admin/confirm-page.tsx";
import {
  imageFields,
  imageUploadFields,
} from "#templates/admin/image-picker.tsx";
import {
  ActionButton,
  guideFooterFor,
  type IconName,
  SaveChangesButton,
} from "#templates/components/actions.tsx";
import {
  type LinkedItemGroup,
  LinkedItemsCheckboxes,
} from "#templates/components/linked-items.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import {
  type AdminSession,
  type Image,
  type ImageUseItemType,
  ImageUseItemTypeSchema,
} from "#types";

export type ImageItemOption = {
  type: ImageUseItemType;
  id: number;
  label: string;
  /** Deactivated items render muted at the end of their row. */
  active: boolean;
};

export type ItemImagePanelProps = {
  action: string;
  /** The drag handle and arrows of the record's ordered images. */
  reorder: ReorderColumnOptions<Image>;
  uploadAction: string;
  linkedImages: Image[];
  allImages: Image[];
  error?: string | undefined;
};

const imageValue = (image?: Image): Record<string, string | number | null> => ({
  altText: image?.altText ?? "",
  name: image?.name ?? "",
});

/** One image thumbnail. `position` is its zero-based place among the page's
 *  thumbnails, so the count carries across the collections one page renders. */
const thumbnail = (image: Image, position: number): JSX.Element => (
  <img
    alt={image.altText || image.name}
    class="image-library-thumb"
    loading={position >= LAZY_THUMBNAIL_FROM ? "lazy" : undefined}
    src={getImageProxyUrl(image.filenameThumb)}
  />
);

/** Exhaustive per-type group headings — a new image target type is a compile
 * error here rather than a silent fallthrough. */
const imageItemTypeLabels = (): Record<ImageUseItemType, string> => ({
  group: t("terms.groups"),
  listing: t("terms.listings"),
  news: t("nav.site.news"),
  page: t("nav.site.pages"),
});

/** One LinkedItemGroup per linkable type, in the schema's type order. */
const imageLinkedItemGroups = (
  options: readonly ImageItemOption[],
  selected: ReadonlySet<string>,
): LinkedItemGroup[] => {
  const labels = imageItemTypeLabels();
  return ImageUseItemTypeSchema.options.map((type) => ({
    label: labels[type],
    options: options
      .filter((option) => option.type === type)
      .map((option) => {
        const value = `${option.type}:${option.id}`;
        return {
          active: option.active,
          checked: selected.has(value),
          label: option.label,
          value,
        };
      }),
  }));
};

const imageColumns: readonly TableColumn<Image>[] = [
  translatedTableColumn(
    "thumbnail",
    "images.column.thumbnail",
    (image, _context, position) => thumbnail(image, position),
  ),
  translatedTableColumn("name", "common.name", (image) =>
    isReadOnly() ? (
      image.name
    ) : (
      <a href={adminPath("imageEdit", { id: image.id })}>{image.name}</a>
    ),
  ),
  translatedTableColumn(
    "alt_text",
    "images.field.alt_text",
    (image) => image.altText,
  ),
];

const imageTable = defineTable(imageColumns);

/** One library grid item: the name and thumbnail as one real link, then the
 *  alt text in a box that scrolls rather than growing. Read-only sessions get
 *  the same item without the link, because the edit page refuses them. */
const imageGridItem = (image: Image, position: number): JSX.Element => {
  const name = <h2 class="image-library-name">{image.name}</h2>;
  const picture = thumbnail(image, position);
  return (
    <li class="image-library-item">
      {isReadOnly() ? (
        <>
          {name}
          {picture}
        </>
      ) : (
        <a
          class="image-library-open"
          data-image-edit-id={String(image.id)}
          data-image-edit-name={image.name}
          href={adminPath("imageEdit", { id: image.id })}
        >
          {name}
          {picture}
        </a>
      )}
      {image.altText === "" ? null : (
        <p class="image-library-alt" tabindex="0">
          {image.altText}
        </p>
      )}
    </li>
  );
};

/** The library uses the shared modal shell for image edits. */
const imageGrid = (images: readonly Image[]): JSX.Element => (
  <ul
    class="image-library-grid"
    data-image-library
    data-modal-loading={t("images.edit.loading")}
  >
    {images.map((image, position) => imageGridItem(image, position))}
  </ul>
);

/** Show the "no images" note when the list is empty, otherwise render it. */
const imagesOrEmpty = (
  images: readonly Image[],
  renderList: () => JSX.Element,
): JSX.Element =>
  images.length === 0 ? <p>{t("images.empty")}</p> : renderList();

const storageDisabledNotice = (): JSX.Element => (
  <p class="notice">{t("images.storage_off")}</p>
);

const imageUploadForm = (
  action: string,
  icon: IconName,
  label: string,
): JSX.Element => (
  <SaveForm
    action={action}
    enctype="multipart/form-data"
    submitIcon={icon}
    submitLabel={label}
  >
    <Raw html={renderFields(imageUploadFields(), imageValue())} />
  </SaveForm>
);

export const adminImagesPage = successListPage<Image>(
  "terms.images",
  "/admin/images",
  (images, session) => ({
    empty: <p>{t("images.empty")}</p>,
    // The images page is editor-reachable, but the guide is staff-only, so
    // the footer gates the link by role — editors otherwise get a 403.
    guideFooter: guideFooterFor(
      "/admin/guide#images",
      "images.guide_link",
      session.adminLevel,
    ),
    items: images,
    render: imageGrid,
    ...(isStorageEnabled() ? {} : { unavailable: storageDisabledNotice() }),
  }),
);

export const adminImageNewPage = flashFormPage(
  "images.new.heading",
  "/admin/images",
  () =>
    isStorageEnabled()
      ? imageUploadForm("/admin/images", "save", t("images.new.submit"))
      : storageDisabledNotice(),
);

/** Everything the image edit form needs, whichever presentation shows it. */
export type ImageEditContent = {
  image: Image;
  options: readonly ImageItemOption[];
  selected: ReadonlySet<string>;
};

/** The image's own delete action. A read-only session gets none, because the
 *  delete route refuses it. */
const imageDeleteZone = (image: Image): JSX.Element => (
  <div class="prose">
    <h2>{t("entity.danger_zone")}</h2>
    <p>
      <ActionButton
        href={`/admin/images/${image.id}/delete`}
        icon="trash-2"
        variant="secondary"
      >
        {t("images.delete.link")}
      </ActionButton>
    </p>
  </div>
);

/** The image edit form. The full page and the modal both render this body, so
 *  their fields and their action URL cannot drift apart. */
export const imageEditBody = ({
  image,
  options,
  selected,
}: ImageEditContent): JSX.Element => (
  <>
    <div class="image-library-preview">{thumbnail(image, 0)}</div>
    <CsrfForm action={adminPath("imageEdit", { id: image.id })}>
      <Raw html={renderFields(imageFields(), imageValue(image))} />
      {options.length === 0 ? (
        <p>{t("images.linked_items.empty")}</p>
      ) : (
        <LinkedItemsCheckboxes
          groups={imageLinkedItemGroups(options, selected)}
          name="imageItems"
        />
      )}
      {SaveChangesButton()}
    </CsrfForm>
    {isReadOnly() ? null : imageDeleteZone(image)}
  </>
);

/** What the full edit page shows: the form body, the viewer, and any message
 *  from a rejected save. */
export type ImageEditPageProps = ImageEditContent & {
  session: AdminSession;
  error?: string | undefined;
};

export const adminImageEditPage = ({
  session,
  error,
  ...content
}: ImageEditPageProps): string =>
  errorAdminPage(
    t("images.edit.heading", { name: content.image.name }),
    "/admin/images",
  )(
    session,
    error,
  )(imageEditBody(content));

export const adminImageDeletePage = entityDeletePage((image: Image) => ({
  action: `/admin/images/${image.id}/delete`,
  active: { section: "/admin/images" },
  buttonText: t("images.delete.submit"),
  danger: true,
  label: t("images.delete.confirm_label"),
  name: image.name,
  title: t("images.delete.heading", { name: image.name }),
}));

const itemImageCheckboxes = (
  images: readonly Image[],
  selectedIds: ReadonlySet<number>,
  startPosition: number,
): JSX.Element => (
  <fieldset class="checkboxes image-picker-checkboxes">
    {images.map((image, index) => (
      <label>
        <input
          checked={selectedIds.has(image.id)}
          name="imageIds"
          type="checkbox"
          value={String(image.id)}
        />
        {thumbnail(image, startPosition + index)}
        <span>{image.name}</span>
      </label>
    ))}
  </fieldset>
);

const itemImageOptions = (
  allImages: readonly Image[],
  linkedImages: readonly Image[],
): Image[] => {
  const linkedIds = idSet(linkedImages);
  return [
    ...linkedImages,
    ...allImages.filter((image) => !linkedIds.has(image.id)),
  ];
};

export const ItemImagesPanel = ({
  action,
  uploadAction,
  linkedImages,
  allImages,
  error,
  reorder,
}: ItemImagePanelProps): JSX.Element => {
  if (!isStorageEnabled()) {
    return (
      <>
        <Flash error={error} />
        {storageDisabledNotice()}
      </>
    );
  }
  const selectedIds = idSet(linkedImages);
  return (
    <>
      <Flash error={error} />
      <h2>{t("images.item.current")}</h2>
      {linkedImages.length === 0 ? (
        <p>{t("images.item.none")}</p>
      ) : (
        renderTable(imageTable, linkedImages, { reorder })
      )}
      <h2>{t("images.item.select_existing")}</h2>
      <CsrfForm action={action}>
        {imagesOrEmpty(allImages, () =>
          itemImageCheckboxes(
            itemImageOptions(allImages, linkedImages),
            selectedIds,
            linkedImages.length,
          ),
        )}
        {SaveChangesButton()}
      </CsrfForm>
      <h2>{t("images.item.upload_new")}</h2>
      {imageUploadForm(uploadAction, "plus", t("images.item.upload_submit"))}
    </>
  );
};
