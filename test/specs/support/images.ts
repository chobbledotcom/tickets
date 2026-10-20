/**
 * The owner's image library: the images a page's editor offers by name while
 * they write. The editor's dropdown loads its choices from the image-options
 * route, so the stories read the owner's choices there, through the owner's
 * own session.
 */

import { expect } from "@std/expect";
import { getAllImages } from "#db/images.ts";
import { openAdminPage } from "#test/specs/support/browser.ts";
import {
  requiredWorldValue,
  scenarioEnv,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { TEST_STORAGE_ZONE } from "#test-utils/internal.ts";

/** The route the editor's image dropdown loads the owner's choices from. */
export const IMAGE_OPTIONS = "/admin/images/options";

/** The library answers only when a storage zone is configured. The setting
 * lasts for the scenario and the world puts it back afterwards. */
const configureLibrary = (world: TicketsWorld): void => {
  scenarioEnv(world, {
    STORAGE_ZONE_KEY: TEST_STORAGE_ZONE.zoneKey,
    STORAGE_ZONE_NAME: TEST_STORAGE_ZONE.zoneName,
  });
};

/** The owner has one image in the library, under the name the story uses. */
export const ownerHasImageInLibrary = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  configureLibrary(world);
  await makeImage(name);
};

/** The owner's library is empty. The fresh scenario database holds no images,
 * so this pins the premise rather than making one. */
export const ownerHasNoImagesInLibrary = async (
  world: TicketsWorld,
): Promise<void> => {
  configureLibrary(world);
  const images = await getAllImages();
  if (images.length > 0) {
    throw new Error(`the library already holds ${images.length} images`);
  }
};

/** The image the library filed under one name, or a loud failure when it
 * holds no such image — a story that carried on would reference the wrong
 * image, or none. */
export const imageIdNamed = async (name: string): Promise<number> => {
  const images = await getAllImages();
  const found = images.find((image) => image.name === name);
  return requiredWorldValue(found?.id, `the image called "${name}"`);
};

/** The image names the editor is offered, in the order the site serves them.
 * Read through the owner's session, so a story cannot see choices a different
 * role could not load. Each field is asserted where the story reads it, so a
 * broken list fails the story loudly instead of reading as "no images
 * offered". */
export const imageChoicesOffered = async (
  world: TicketsWorld,
): Promise<string[]> => {
  const served = (await openAdminPage(world, IMAGE_OPTIONS)).currentHtml;
  const { images } = JSON.parse(served);
  expect(Array.isArray(images)).toBe(true);
  return images.map((image: { name: unknown }) => {
    expect(typeof image.name).toBe("string");
    return image.name as string;
  });
};
