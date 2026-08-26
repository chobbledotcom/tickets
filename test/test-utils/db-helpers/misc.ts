import type { NewsPostWriteInput } from "#db/news-posts.ts";
import type { SitePageWriteInput } from "#db/site-pages.ts";
import type { NewsPost, SitePage } from "#types";
import { createTestListing } from "./listings.ts";

export const createTestInvite = async (
  username: string,
  adminLevel = "manager",
): Promise<{ inviteCode: string; cookie: string; csrfToken: string }> => {
  const { getTestSession } = await import("#test-utils/session.ts");
  const { awaitTestRequest } = await import("#test-utils/mocks.ts");
  const { cookie, csrfToken } = await getTestSession();
  const inviteResponse = await awaitTestRequest("/admin/users", {
    cookie,
    data: { admin_level: adminLevel, csrf_token: csrfToken, username },
  });
  const location = inviteResponse.headers.get("location") ?? "";
  const url = new URL(location, "http://localhost");
  const inviteLink = url.searchParams.get("invite") ?? "";
  const codeMatch = inviteLink.match(/\/join\/([A-Za-z0-9_-]+)/);
  if (!codeMatch?.[1]) {
    throw new Error(
      `Failed to create invite for ${username}: ${inviteResponse.status} ${location}`,
    );
  }
  return { cookie, csrfToken, inviteCode: codeMatch[1] };
};

export const getEmbeddableTicketResponse = async (): Promise<Response> => {
  const { awaitTestRequest } = await import("#test-utils/mocks.ts");
  const listing = await createTestListing({
    maxAttendees: 50,
    thankYouUrl: "https://example.com",
  });
  return awaitTestRequest(`/ticket/${listing.slug}`);
};

/** Assert that the admin password can be verified against the stored hash,
 *  and that the hash uses the pbkdf2 scheme. Shared by the users-db and auth
 *  tests which both verify this same invariant. */
export const assertAdminPasswordVerifies = async (): Promise<void> => {
  const { expect } = await import("@std/expect");
  const { getUserByUsername, verifyUserPassword } = await import(
    "#db/users.ts"
  );
  const { TEST_ADMIN_PASSWORD, TEST_ADMIN_USERNAME } = await import(
    "#test-utils/internal.ts"
  );
  const user = await getUserByUsername(TEST_ADMIN_USERNAME);
  expect(user).not.toBeNull();
  const result = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
  expect(result).toBeTruthy();
  expect(result).toContain("pbkdf2:");
};

/** Assert that verifyUserPassword returns null for an incorrect password. */
export const assertAdminPasswordRejects = async (): Promise<void> => {
  const { expect } = await import("@std/expect");
  const { getUserByUsername, verifyUserPassword } = await import(
    "#db/users.ts"
  );
  const { TEST_ADMIN_USERNAME } = await import("#test-utils/internal.ts");
  const user = await getUserByUsername(TEST_ADMIN_USERNAME);
  expect(user).not.toBeNull();
  const result = await verifyUserPassword(user!, "wrongpassword");
  expect(result).toBeNull();
};

/** Create a site page directly at the DB layer (the admin create flow has its
 * own suite). The blind index is computed inside `createSitePage` from the
 * slug, so tests never hand-roll it. */
export const createTestSitePage = async (
  slug: string,
  extra: Partial<Omit<SitePageWriteInput, "slug">> = {},
): Promise<SitePage> => {
  const { createSitePage } = await import("#db/site-pages.ts");
  const result = await createSitePage({
    content: extra.content ?? "",
    metaDescription: extra.metaDescription ?? "",
    metaTitle: extra.metaTitle ?? "",
    name: extra.name ?? `Page ${slug}`,
    slug,
  });
  if (!result.ok) throw new Error(`site page slug is already used: ${slug}`);
  return result.value;
};

/** Create a news post directly at the DB layer (the admin create flow has its
 * own suite). `created` is stamped by the column default. */
export const createTestNewsPost = async (
  name: string,
  extra: Partial<Omit<NewsPostWriteInput, "name">> & { created?: string } = {},
): Promise<NewsPost> => {
  const { createNewsPost } = await import("#db/news-posts.ts");
  return createNewsPost({
    content: extra.content ?? "",
    ...(extra.created !== undefined ? { created: extra.created } : {}),
    metaDescription: extra.metaDescription ?? "",
    metaTitle: extra.metaTitle ?? "",
    name,
    snippet: extra.snippet ?? "",
  });
};
