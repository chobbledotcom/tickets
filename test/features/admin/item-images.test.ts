/** The image tab handlers an image-backed record shares, driven through the
 * group routes that bind them. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadItemImagesPanel } from "#routes/admin/item-images.ts";
import { loggedMessages } from "#test-utils/activity-log.ts";
import {
  imageNamesForItem,
  makeImage,
  postImageUpload,
} from "#test-utils/admin-images.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { withStorageDisabled, withStorageMock } from "#test-utils/mocks.ts";
import { adminFormPost, getTestSession } from "#test-utils/session.ts";

const linkImages = (groupId: number, imageIds: number[]) =>
  adminFormPost(`/admin/groups/${groupId}/images`, {
    image_ids: imageIds.map(String),
  });

const uploadImage = async (groupId: number) => {
  const session = await getTestSession();
  return postImageUpload(
    `/admin/groups/${groupId}/images/upload`,
    session.cookie,
    session.csrfToken,
    "Shot",
  );
};

describeWithEnv("item image handlers", { db: true, storage: "cdn" }, () => {
  test("links the chosen images in order and logs the save", async () => {
    const group = await createTestGroup({ name: "Pictured" });
    const first = await makeImage("First");
    const second = await makeImage("Second");

    const { response } = await linkImages(group.id, [second.id, first.id]);

    expectRedirectWithFlash(
      `/admin/groups/${group.id}/images`,
      "Images updated",
    )(response);
    expect(await imageNamesForItem("group", group.id)).toEqual([
      "Second",
      "First",
    ]);
    expect(await loggedMessages()).toContain(
      "Images updated for group 'Pictured'",
    );
  });

  test("uploads an image onto the record and logs the upload", async () => {
    const group = await createTestGroup({ name: "Uploaded" });

    await withStorageMock(async () => {
      expectRedirectWithFlash(
        `/admin/groups/${group.id}/images`,
        "Image uploaded",
      )(await uploadImage(group.id));
    });

    expect(await imageNamesForItem("group", group.id)).toEqual(["Shot"]);
    expect(await loggedMessages()).toContain(
      "Image 'Shot' uploaded for group 'Uploaded'",
    );
  });

  test("sends both writes to the edit page while storage is off", async () => {
    const group = await createTestGroup({ name: "No storage" });
    const image = await makeImage("Unlinked");

    await withStorageDisabled(async () => {
      const { response } = await linkImages(group.id, [image.id]);
      const refused = expectRedirectWithFlash(
        `/admin/groups/${group.id}/edit`,
        "File storage is not configured.",
        false,
      );
      refused(response);
      refused(await uploadImage(group.id));
    });

    expect(await imageNamesForItem("group", group.id)).toEqual([]);
  });

  test("answers not found for a record that does not exist", async () => {
    const { response } = await linkImages(9999, []);
    expect(response.status).toBe(404);
    expect((await uploadImage(9999)).status).toBe(404);
  });

  test("points the panel's forms at the record's image paths", async () => {
    const group = await createTestGroup({ name: "Panel" });
    const image = await makeImage("Linked");
    await linkImages(group.id, [image.id]);

    const html = String(
      await loadItemImagesPanel("group", group.id, `/admin/groups/${group.id}`),
    );

    expect(html).toContain(`action="/admin/groups/${group.id}/images"`);
    expect(html).toContain(`action="/admin/groups/${group.id}/images/upload"`);
    expect(html).toContain("Linked");
  });
});
