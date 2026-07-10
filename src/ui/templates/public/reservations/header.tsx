import { t } from "#i18n";
import { formatDatetimeLabel } from "#shared/dates.ts";
import type { AttributeWithOptions } from "#shared/db/attributes.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type {
  Image,
  ItemImageProjection,
  ListingWithCount,
} from "#shared/types.ts";
import { Badge } from "#templates/components/badge.tsx";
import { renderListingAttributes } from "../listing-attributes.ts";
import { PublicImageGallery, renderListingImage } from "../shared.tsx";

/** Header block shown above the form with listing/group details */
export const TicketPageHeader = ({
  headerName,
  headerDescription,
  headerImage,
  galleryImages,
  listingAttributes,
  singleListing,
  pastDays,
}: {
  headerName: string;
  headerDescription: string | null | undefined;
  headerImage: ItemImageProjection | null;
  galleryImages: readonly Image[];
  listingAttributes: AttributeWithOptions[] | undefined;
  singleListing: ListingWithCount | null;
  pastDays: number | null;
}): JSX.Element => (
  <>
    {/* The full CSS gallery when the header entity has images; otherwise the
        single header-image projection (a listing whose only picture is its
        stored `image_url` with no image_uses rows). */}
    {galleryImages.length > 0 ? (
      <PublicImageGallery images={galleryImages} />
    ) : (
      headerImage && <Raw html={renderListingImage(headerImage)} />
    )}
    <div class="prose">
      <h1>{headerName}</h1>
      {headerDescription && (
        <div class="description">
          <Raw html={renderMarkdown(headerDescription)} />
        </div>
      )}
      {singleListing?.date && (
        <p>
          <strong>{t("public.ticket.date_label")}</strong>{" "}
          {formatDatetimeLabel(singleListing.date)}
          {pastDays !== null && (
            <Badge variant="alert">
              {" "}
              {t("public.ticket.days_ago", { count: pastDays })}
            </Badge>
          )}
        </p>
      )}
      {singleListing?.location && (
        <p>
          <strong>{t("public.ticket.location_label")}</strong>{" "}
          {singleListing.location}
        </p>
      )}
      <Raw html={renderListingAttributes(listingAttributes)} />
    </div>
  </>
);
