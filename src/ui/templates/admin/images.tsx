/**
 * Admin image library templates.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import { isReadOnly } from "#shared/env.ts";
import { CsrfForm, type Field, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { getImageProxyUrl, isStorageEnabled } from "#shared/storage.ts";
import {
  type AdminSession,
  type Image,
  type ImageUseItemType,
  ImageUseItemTypeSchema,
} from "#shared/types.ts";
import {
  errorAdminPage,
  flashFormPage,
  successAdminPage,
} from "#templates/admin/admin-page.tsx";
import { entityDeletePage } from "#templates/admin/confirm-page.tsx";
import {
  ActionButton,
  GuideFooter,
  type IconName,
  SaveChangesButton,
} from "#templates/components/actions.tsx";
import {
  type DataColumn,
  dataTable,
} from "#templates/components/data-table.tsx";
import {
  type LinkedItemGroup,
  LinkedItemsCheckboxes,
} from "#templates/components/linked-items.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
// jscpd:ignore-end

export type ImageItemOption = {
  type: ImageUseItemType;
  id: number;
  label: string;
  /** Deactivated items render muted at the end of their row. */
  active: boolean;
};

export type ItemImagePanelProps = {
  action: string;
  uploadAction: string;
  linkedImages: Image[];
  allImages: Image[];
  error?: string | undefined;
};

const imageFields = (): Field[] => [
  {
    label: t("images.field.name"),
    name: "name",
    required: true,
    type: "text",
  },
  {
    label: t("images.field.alt_text"),
    name: "alt_text",
    type: "text",
  },
];

// No `required`: file inputs never render the attribute (renderFieldInput
// omits it) and the upload POST checks the file's presence itself.
const imageUploadField = (): Field => ({
  accept: "image/jpeg,image/png,image/webp",
  label: t("images.field.file"),
  name: "image",
  type: "file",
});

const imageValue = (image?: Image): Record<string, string | number | null> => ({
  alt_text: image?.alt_text ?? "",
  name: image?.name ?? "",
});

const thumbnail = (image: Image): JSX.Element => (
  <img
    alt={image.alt_text || image.name}
    class="image-library-thumb"
    src={getImageProxyUrl(image.filename_thumb)}
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

const imageColumns: readonly DataColumn<Image>[] = [
  { cell: (image) => thumbnail(image), header: t("images.column.thumbnail") },
  {
    cell: (image) =>
      isReadOnly() ? (
        image.name
      ) : (
        <a href={`/admin/images/${image.id}/edit`}>{image.name}</a>
      ),
    header: t("common.name"),
  },
  { cell: (image) => image.alt_text, header: t("images.field.alt_text") },
];

const imageTable = dataTable(imageColumns);

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
    <Raw
      html={renderFields([...imageFields(), imageUploadField()], imageValue())}
    />
  </SaveForm>
);

export const adminImagesPage = (
  images: Image[],
  session: AdminSession,
  successMessage?: string,
): string => {
  const storageEnabled = isStorageEnabled();
  return successAdminPage(t("terms.images"), "/admin/images")(
    session,
    successMessage,
  )(
    <>
      {storageEnabled
        ? imagesOrEmpty(images, () => imageTable(images))
        : storageDisabledNotice()}
      {/* The images page is editor-reachable, but the guide is staff-only, so
          gate the link by role — editors would otherwise get a 403. */}
      <GuideFooter adminLevel={session.adminLevel} href="/admin/guide#images">
        {t("images.guide_link")}
      </GuideFooter>
    </>,
  );
};

export const adminImageNewPage = flashFormPage(
  "images.new.heading",
  "/admin/images",
  () =>
    isStorageEnabled()
      ? imageUploadForm("/admin/images", "save", t("images.new.submit"))
      : storageDisabledNotice(),
);

export const adminImageEditPage = ({
  image,
  options,
  selected,
  session,
  error,
}: {
  image: Image;
  options: readonly ImageItemOption[];
  selected: ReadonlySet<string>;
  session: AdminSession;
  error?: string | undefined;
}): string =>
  errorAdminPage(
    t("images.edit.heading", { name: image.name }),
    "/admin/images",
  )(
    session,
    error,
  )(
    <>
      <div class="image-library-preview">{thumbnail(image)}</div>
      <CsrfForm action={`/admin/images/${image.id}/edit`}>
        <Raw html={renderFields(imageFields(), imageValue(image))} />
        {options.length === 0 ? (
          <p>{t("images.linked_items.empty")}</p>
        ) : (
          <LinkedItemsCheckboxes
            groups={imageLinkedItemGroups(options, selected)}
            name="image_items"
          />
        )}
        {SaveChangesButton()}
      </CsrfForm>
      {!isReadOnly() && (
        <>
          <h2>{t("entity.danger_zone")}</h2>
          <p class="prose">
            <ActionButton
              href={`/admin/images/${image.id}/delete`}
              icon="trash-2"
              variant="secondary"
            >
              {t("images.delete.link")}
            </ActionButton>
          </p>
        </>
      )}
    </>,
  );

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
): JSX.Element => (
  <fieldset class="checkboxes image-picker-checkboxes">
    {images.map((image) => (
      <label>
        <input
          checked={selectedIds.has(image.id)}
          name="image_ids"
          type="checkbox"
          value={String(image.id)}
        />
        {thumbnail(image)}
        <span>{image.name}</span>
      </label>
    ))}
  </fieldset>
);

/** The set of image ids in a list — used to test membership when merging linked
 *  and unlinked images. */
const imageIdSet = (images: readonly Image[]): Set<number> =>
  new Set(images.map((image) => image.id));

const itemImageOptions = (
  allImages: readonly Image[],
  linkedImages: readonly Image[],
): Image[] => {
  const linkedIds = imageIdSet(linkedImages);
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
}: ItemImagePanelProps): JSX.Element => {
  if (!isStorageEnabled()) {
    return (
      <>
        <Flash error={error} />
        {storageDisabledNotice()}
      </>
    );
  }
  const selectedIds = imageIdSet(linkedImages);
  return (
    <>
      <Flash error={error} />
      <h2>{t("images.item.current")}</h2>
      {linkedImages.length === 0 ? (
        <p>{t("images.item.none")}</p>
      ) : (
        imageTable(linkedImages)
      )}
      <h2>{t("images.item.select_existing")}</h2>
      <CsrfForm action={action}>
        {imagesOrEmpty(allImages, () =>
          itemImageCheckboxes(
            itemImageOptions(allImages, linkedImages),
            selectedIds,
          ),
        )}
        {SaveChangesButton()}
      </CsrfForm>
      <h2>{t("images.item.upload_new")}</h2>
      {imageUploadForm(uploadAction, "plus", t("images.item.upload_submit"))}
    </>
  );
};
