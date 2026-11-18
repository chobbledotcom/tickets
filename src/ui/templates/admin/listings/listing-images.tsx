import { t } from "#i18n";
import type { ImagePickerOption } from "#shared/images/picker.ts";
import { Icon } from "#templates/components/actions.tsx";

/** The Images field on a new physical-product listing. Each chosen picture
 *  travels as a repeated `imageIds` input. The admin bundle's listing images
 *  control fills them from the shared image picker. The hidden inputs carry
 *  the name and thumbnail so a rejected create re-renders the same pictures
 *  without another read. */
export const ListingImagesField = ({
  selected,
}: {
  selected: readonly ImagePickerOption[];
}): JSX.Element => (
  <div class="listing-images" data-listing-images>
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
    <ul class="listing-images-selected" data-listing-images-selected />
    <button class="btn" data-listing-images-trigger type="button">
      <Icon name="plus" />
      <span>{t("listings_table.choose_images")}</span>
    </button>
  </div>
);
