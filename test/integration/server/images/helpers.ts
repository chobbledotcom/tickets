import { expect } from "@std/expect";
import { imagesTable, setImagesForItem } from "#shared/db/images.ts";
import { nonEmptyString } from "#shared/validation/string.ts";

/** Insert an image row and link it to a listing, as if it were already
 * uploaded and stored. Shared by tests that check a listing's *other*
 * stored images survive an unrelated upload or deletion. */
export const linkStoredImage = async (
  listingId: number,
  filename: string,
  filenameThumb = `${filename}-thumb.webp`,
) => {
  const image = await imagesTable.insert({
    filename: nonEmptyString(filename, "test image filename"),
    filenameThumb: nonEmptyString(
      filenameThumb,
      "test image thumbnail filename",
    ),
    name: filename,
  });
  await setImagesForItem("listing", listingId, [image.id]);
  return image;
};

/** Assert a 302 redirect with a flash error cookie containing the given substring */
export const expectImageErrorRedirect = (
  response: Response,
  errorSubstring: string,
): void => {
  expect(response.status).toBe(302);
  const cookies = response.headers.getSetCookie();
  const flash = cookies.find((c) => c.startsWith("flash_"));
  expect(flash).toBeDefined();
  const cookiePart = flash!.split(";")[0]!;
  // Cookie is "flash_{id}={value}", extract value after first "="
  const decoded = decodeURIComponent(cookiePart.split("=").slice(1).join("="));
  expect(decoded).toContain(errorSubstring);
};
