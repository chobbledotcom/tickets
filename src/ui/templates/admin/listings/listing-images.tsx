import { t } from "#i18n";
import { isReadOnly } from "#shared/env.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import type { ChosenImage } from "#shared/images/picker.ts";
import type { ReorderColumnOptions } from "#shared/tables/column.ts";
import { Icon, SaveChangesButton } from "#templates/components/actions.tsx";
import {
  neighbourAnchors,
  ReorderArrows,
} from "#templates/components/reorder.tsx";

/** The Images field on a new physical-product or custom listing. Each chosen
 *  picture travels as a repeated `imageIds` input. The admin bundle's listing
 *  images control fills them from the shared image picker. The hidden inputs
 *  carry the name and thumbnail for the browser's chosen list. The server
 *  renders the same pictures so the form still shows them before the bundle
 *  runs. On a saved listing, `reorder` gives each stored picture the drag
 *  handle and the arrows, from the listing's ordered images. */
export const ListingImagesField = ({
  reorder,
  saveChanges = false,
  selected,
}: {
  reorder?: ReorderColumnOptions<ChosenImage> | undefined;
  saveChanges?: boolean;
  selected: readonly ChosenImage[];
}): JSX.Element => {
  const column = isReadOnly() ? undefined : reorder;
  return (
    <div
      class="listing-images"
      data-image-picker-heading={t("listings_table.choose_images")}
      data-image-remove-label={t("listings_table.remove_image_label", {
        name: "{name}",
      })}
      data-image-remove-text={t("listings_table.remove_image")}
      data-listing-images
    >
      <p class="muted">{t("listings_table.images_hint")}</p>
      <div data-listing-images-inputs>
        {selected.map((image) => (
          <input
            data-image-name={image.name}
            data-image-thumb={image.thumb}
            name="imageIds"
            type="hidden"
            value={String(image.id)}
          />
        ))}
      </div>
      <p class="muted" data-listing-images-empty hidden={selected.length > 0}>
        {t("listings_table.images_none")}
      </p>
      <ul
        class="listing-images-selected"
        data-listing-images-selected
        {...(column === undefined ? {} : { "data-sortable": "grid" })}
      >
        {selected.map((image, index) => (
          <li class="listing-images-item" data-image-id={String(image.id)}>
            {column && (
              <span class="listing-images-order">
                <ReorderArrows
                  {...neighbourAnchors(selected, index, column.anchor)}
                  anchor={column.anchor(image)}
                  path={column.path(image)}
                  setting="inForm"
                />
              </span>
            )}
            {image.thumb === "" ? null : (
              <img alt="" loading="lazy" src={image.thumb} />
            )}
            <button
              aria-label={t("listings_table.remove_image_label", {
                name: image.name,
              })}
              class="listing-images-remove"
              type="button"
            >
              {t("listings_table.remove_image")}
            </button>
          </li>
        ))}
      </ul>
      <div class="listing-images-actions">
        <button class="btn" data-listing-images-trigger type="button">
          <Icon name="plus" />
          <span>{t("listings_table.choose_images")}</span>
        </button>
        {saveChanges && (
          <span class="listing-images-save">{SaveChangesButton()}</span>
        )}
      </div>
    </div>
  );
};

/** The Images tab on a saved listing: the same field the create form shows,
 *  with the Save that writes the chosen links. */
/* jscpd:ignore-start -- the minimum CSRF wrapper; the save must sit in the
 * field's action row, which the shared SaveForm cannot place. */
export const ListingImagesPanel = ({
  action,
  reorder,
  selected,
}: {
  action: string;
  reorder: ReorderColumnOptions<ChosenImage>;
  selected: readonly ChosenImage[];
}): JSX.Element => (
  <CsrfForm action={action}>
    <ListingImagesField reorder={reorder} saveChanges selected={selected} />
  </CsrfForm>
);
/* jscpd:ignore-end */
