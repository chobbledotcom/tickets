/**
 * Admin image library templates.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import { isReadOnly } from "#shared/env.ts";
import { CsrfForm, type Field, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { getImageProxyUrl, isStorageEnabled } from "#shared/storage.ts";
import type { AdminSession, Image, ImageUseItemType } from "#shared/types.ts";
import {
  errorAdminPage,
  successAdminPage,
} from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import {
  ActionButton,
  type IconName,
  SaveChangesButton,
  SubmitButton,
} from "#templates/components/actions.tsx";
import {
  type DataColumn,
  dataTable,
} from "#templates/components/data-table.tsx";
// jscpd:ignore-end

export type ImageItemOption = {
  type: ImageUseItemType;
  id: number;
  label: string;
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

const imageUploadField = (): Field => ({
  accept: "image/jpeg,image/png,image/webp",
  label: t("images.field.file"),
  name: "image",
  required: true,
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

/** Exhaustive per-type prefixes — a new image target type is a compile error
 * here rather than a silent fallthrough. */
const linkedTypeLabel = (): Record<ImageUseItemType, string> => ({
  group: t("terms.group"),
  listing: t("terms.listing"),
  news: t("nav.site.news"),
});

const linkedLabel = (option: ImageItemOption): string =>
  `${linkedTypeLabel()[option.type]}: ${option.label}`;

const itemCheckboxes = (
  options: readonly ImageItemOption[],
  selected: ReadonlySet<string>,
): JSX.Element => (
  <fieldset class="checkboxes image-item-checkboxes">
    {options.map((option) => {
      const value = `${option.type}:${option.id}`;
      return (
        <label>
          <input
            checked={selected.has(value)}
            name="image_items"
            type="checkbox"
            value={value}
          />
          {linkedLabel(option)}
        </label>
      );
    })}
  </fieldset>
);

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

const storageDisabledNotice = (): JSX.Element => (
  <p class="notice">{t("images.storage_off")}</p>
);

const imageUploadForm = (
  action: string,
  icon: IconName,
  label: string,
): JSX.Element => (
  <CsrfForm action={action} enctype="multipart/form-data">
    <Raw
      html={renderFields([...imageFields(), imageUploadField()], imageValue())}
    />
    <SubmitButton icon={icon}>{label}</SubmitButton>
  </CsrfForm>
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
    storageEnabled ? (
      images.length === 0 ? (
        <p>{t("images.empty")}</p>
      ) : (
        imageTable(images)
      )
    ) : (
      storageDisabledNotice()
    ),
  );
};

export const adminImageNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  errorAdminPage(t("images.new.heading"), "/admin/images")(session, error)(
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
        <h2>{t("images.linked_items.heading")}</h2>
        {options.length === 0 ? (
          <p>{t("images.linked_items.empty")}</p>
        ) : (
          itemCheckboxes(options, selected)
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

export const adminImageDeletePage = (
  image: Image,
  session: AdminSession,
  error?: string,
): string =>
  ConfirmPage({
    action: `/admin/images/${image.id}/delete`,
    active: "/admin/images",
    buttonText: t("images.delete.submit"),
    danger: true,
    error,
    label: t("images.delete.confirm_label"),
    name: image.name,
    session,
    title: t("images.delete.heading", { name: image.name }),
  });

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

const itemImageOptions = (
  allImages: readonly Image[],
  linkedImages: readonly Image[],
): Image[] => {
  const linkedIds = new Set(linkedImages.map((image) => image.id));
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
  const selectedIds = new Set(linkedImages.map((image) => image.id));
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
        {allImages.length === 0 ? (
          <p>{t("images.empty")}</p>
        ) : (
          itemImageCheckboxes(
            itemImageOptions(allImages, linkedImages),
            selectedIds,
          )
        )}
        {SaveChangesButton()}
      </CsrfForm>
      <h2>{t("images.item.upload_new")}</h2>
      {imageUploadForm(uploadAction, "plus", t("images.item.upload_submit"))}
    </>
  );
};
