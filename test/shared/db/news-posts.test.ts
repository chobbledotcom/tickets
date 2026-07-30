import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import { appendImageToItem, getImagesForItem } from "#shared/db/images.ts";
import {
  computeNewsSlugIndex,
  deleteNewsPostWithImages,
  getNewsPostById,
  getNewsPostBySlugIndex,
  getNewsPostCards,
  getNewsPostNames,
  getNewsPostSummaries,
  hasNewsPosts,
  updateNewsPost,
} from "#shared/db/news-posts.ts";
import { BROKEN_IMAGE_FILENAME } from "#shared/images/broken.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { insertBrokenImage, makeImage } from "#test-utils/admin-images.ts";
import { expectEncryptedAtRest } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

describeWithEnv("db > news-posts", { db: true }, () => {
  const errors = setupErrorSpy();
  describe("encryption + single reads", () => {
    test("stores every free-text column encrypted and decrypts on read", async () => {
      const created = await createTestNewsPost("Launch day", {
        content: "We are **live**",
        metaDescription: "Launch description",
        metaTitle: "Launch | Acme",
        snippet: "We launched!",
      });
      const raw = await queryAll<{
        content: string;
        meta_description: string;
        meta_title: string;
        name: string;
        snippet: string;
        created: string;
      }>(
        "SELECT name, meta_title, meta_description, snippet, content, created FROM news_posts WHERE id = ?",
        [created.id],
      );
      // At rest, everything is ciphertext (enc:… envelope), not plaintext.
      expectEncryptedAtRest(
        raw[0]?.name,
        raw[0]?.meta_title,
        raw[0]?.meta_description,
        raw[0]?.snippet,
        raw[0]?.content,
      );
      expect(raw[0]?.name).not.toContain("Launch day");
      // `created` stays plaintext ISO so SQL can order newest-first.
      expect(raw[0]?.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const back = await getNewsPostById(created.id);
      expect(back?.name).toBe("Launch day");
      expect(back?.meta_title).toBe("Launch | Acme");
      expect(back?.meta_description).toBe("Launch description");
      expect(back?.snippet).toBe("We launched!");
      expect(back?.content).toBe("We are **live**");
      expect(back?.created).toBe(created.created);
    });

    test("getNewsPostById returns null for a missing id", async () => {
      expect(await getNewsPostById(9999)).toBeNull();
    });

    test("empty optional fields stay empty strings, never ciphertext", async () => {
      const created = await createTestNewsPost("Bare post");
      const raw = await queryAll<{ snippet: string; content: string }>(
        "SELECT snippet, content FROM news_posts WHERE id = ?",
        [created.id],
      );
      expect(raw[0]?.snippet).toBe("");
      expect(raw[0]?.content).toBe("");
      const back = await getNewsPostById(created.id);
      expect(back?.snippet).toBe("");
      expect(back?.content).toBe("");
    });
  });

  describe("updateNewsPost", () => {
    test("rewrites every editable field (slug included) but never created", async () => {
      const created = await createTestNewsPost("Before", {
        snippet: "old snippet",
      });
      const updated = await updateNewsPost(created.id, {
        content: "new content",
        metaDescription: "new description",
        metaTitle: "new title",
        name: "After",
        slug: "edited-slug",
        snippet: "new snippet",
      });
      if (!updated.ok) throw new Error(`news update failed: ${updated.error}`);
      expect(updated.value.name).toBe("After");
      expect(updated.value.snippet).toBe("new snippet");
      expect(updated.value.content).toBe("new content");
      expect(updated.value.meta_title).toBe("new title");
      expect(updated.value.meta_description).toBe("new description");
      expect(updated.value.created).toBe(created.created);
      // The edited slug (and its blind index) now resolve the post.
      expect(updated.value.slug).toBe("edited-slug");
      const bySlug = await getNewsPostBySlugIndex(
        await computeNewsSlugIndex("edited-slug"),
      );
      expect(bySlug?.id).toBe(created.id);
    });
  });

  describe("getNewsPostCards", () => {
    test("lists newest first with slug and the first linked image decrypted", async () => {
      await createTestNewsPost("Older", {
        created: "2026-07-01T10:00:00.000Z",
        snippet: "old news",
      });
      const newer = await createTestNewsPost("Newer", {
        created: "2026-07-02T10:00:00.000Z",
        snippet: "fresh news",
      });
      const [first, second] = await makeImageOrder(newer.id);

      const cards = await getNewsPostCards();
      expect(cards.map((card) => card.name)).toEqual(["Newer", "Older"]);
      expect(cards[0]?.snippet).toBe("fresh news");
      // The card carries the decrypted /news permalink.
      expect(cards[0]?.slug).toBe("2026-07-02-newer");
      // The FIRST linked image (by sort_order) projects into the card.
      expect(cards[0]?.image_url).toBe(first.filename);
      expect(cards[0]?.image_thumb_url).toBe(first.filename_thumb);
      expect(cards[0]?.image_alt_text).toBe(first.alt_text);
      expect(cards[0]?.image_url).not.toBe(second.filename);
      // A post with no images projects the empty-string convention.
      expect(cards[1]?.image_url).toBe("");
      expect(cards[1]?.image_thumb_url).toBe("");
      expect(cards[1]?.image_alt_text).toBe("");
    });

    test("projects the broken-image marker for a broken linked image", async () => {
      const post = await createTestNewsPost("Broken picture post");
      await appendImageToItem(await insertBrokenImage(), {
        itemId: post.id,
        itemType: "news",
      });

      const cards = await getNewsPostCards();
      expect(cards[0]?.image_url).toBe(BROKEN_IMAGE_FILENAME);
      expect(cards[0]?.image_thumb_url).toBe(BROKEN_IMAGE_FILENAME);
      expect(
        errors.contains(
          `news post ${post.id} image decrypted to an empty value`,
        ),
      ).toBe(true);
      expect(
        errors.contains(
          `news post ${post.id} thumbnail image decrypted to an empty value`,
        ),
      ).toBe(true);
    });

    test("same-day posts tie-break by id, newest insert first", async () => {
      const sameCreated = "2026-07-03T09:00:00.000Z";
      await createTestNewsPost("First insert", { created: sameCreated });
      await createTestNewsPost("Second insert", { created: sameCreated });
      const cards = await getNewsPostCards();
      expect(cards.map((card) => card.name)).toEqual([
        "Second insert",
        "First insert",
      ]);
    });
  });

  describe("slug permalink", () => {
    test("generates yyyy-MM-dd-name from the created date and name", async () => {
      const post = await createTestNewsPost("Big Launch!", {
        created: "2026-07-06T12:00:00.000Z",
      });
      expect(post.slug).toBe("2026-07-06-big-launch");
    });

    test("disambiguates a same-day, same-name collision with a suffix", async () => {
      const created = "2026-07-06T12:00:00.000Z";
      const first = await createTestNewsPost("Update", { created });
      const second = await createTestNewsPost("Update", { created });
      const third = await createTestNewsPost("Update", { created });
      expect(first.slug).toBe("2026-07-06-update");
      expect(second.slug).toBe("2026-07-06-update-2");
      expect(third.slug).toBe("2026-07-06-update-3");
    });

    test("stores the slug encrypted with a plaintext blind index", async () => {
      const post = await createTestNewsPost("Indexed", {
        created: "2026-07-06T12:00:00.000Z",
      });
      const raw = await queryAll<{ slug: string; slug_index: string }>(
        "SELECT slug, slug_index FROM news_posts WHERE id = ?",
        [post.id],
      );
      expectEncryptedAtRest(raw[0]?.slug);
      // The index is the plaintext HMAC of the slug, not the slug itself.
      expect(raw[0]?.slug_index).not.toBe("");
      expect(raw[0]?.slug_index).not.toContain("2026-07-06-indexed");
    });

    test("getNewsPostBySlugIndex round-trips the post; null for an unknown slug", async () => {
      const post = await createTestNewsPost("Findable", {
        created: "2026-07-06T12:00:00.000Z",
      });
      const found = await getNewsPostBySlugIndex(
        await computeNewsSlugIndex(post.slug),
      );
      expect(found?.id).toBe(post.id);
      expect(found?.name).toBe("Findable");
      expect(
        await getNewsPostBySlugIndex(await computeNewsSlugIndex("nope")),
      ).toBeNull();
    });

    test("update can keep the existing slug while the name changes", async () => {
      const post = await createTestNewsPost("Original name", {
        created: "2026-07-06T12:00:00.000Z",
      });
      // The caller passes the post's own slug back to keep the permalink stable
      // even as the name changes (the slug is no longer derived from the name).
      await updateNewsPost(post.id, {
        content: "",
        metaDescription: "",
        metaTitle: "",
        name: "Renamed",
        slug: post.slug,
        snippet: "",
      });
      const reloaded = await getNewsPostById(post.id);
      expect(reloaded?.name).toBe("Renamed");
      expect(reloaded?.slug).toBe("2026-07-06-original-name");
    });
  });

  describe("getNewsPostSummaries", () => {
    // The news feed and the admin news page both show these summaries in the
    // order they come back, so newest-first is part of what this returns.
    test("lists newest first, most recently created of a shared day first", async () => {
      await createTestNewsPost("Oldest", {
        created: "2026-07-01T10:00:00.000Z",
      });
      await createTestNewsPost("Same day, written first", {
        created: "2026-07-03T10:00:00.000Z",
      });
      await createTestNewsPost("Same day, written second", {
        created: "2026-07-03T10:00:00.000Z",
      });

      const summaries = await getNewsPostSummaries();

      expect(summaries.map((summary) => summary.name)).toEqual([
        "Same day, written second",
        "Same day, written first",
        "Oldest",
      ]);
    });
  });

  describe("getNewsPostNames", () => {
    test("maps id to decrypted name", async () => {
      const post = await createTestNewsPost("Named post");
      const names = await getNewsPostNames();
      expect(names.get(post.id)).toBe("Named post");
    });
  });

  describe("hasNewsPosts", () => {
    test("false when empty, true once a post exists, false after delete", async () => {
      expect(await hasNewsPosts()).toBe(false);
      const post = await createTestNewsPost("Existence");
      expect(await hasNewsPosts()).toBe(true);
      await deleteNewsPostWithImages(post.id);
      expect(await hasNewsPosts()).toBe(false);
    });

    test("request cache is invalidated by a write inside the same request", () =>
      runWithRequestCache(async () => {
        expect(await hasNewsPosts()).toBe(false);
        await createTestNewsPost("Mid-request");
        expect(await hasNewsPosts()).toBe(true);
      }));
  });

  describe("deleteNewsPostWithImages", () => {
    test("removes the post and prunes its image uses, keeping the images", async () => {
      const post = await createTestNewsPost("Doomed");
      const image = await makeImage("Kept Image");
      await appendImageToItem(image.id, { itemId: post.id, itemType: "news" });
      expect(await getImagesForItem("news", post.id)).toHaveLength(1);

      await deleteNewsPostWithImages(post.id);
      expect(await getNewsPostById(post.id)).toBeNull();
      expect(await getImagesForItem("news", post.id)).toHaveLength(0);
      const kept = await queryAll<{ id: number }>(
        "SELECT id FROM images WHERE id = ?",
        [image.id],
      );
      expect(kept).toHaveLength(1);
    });
  });
});

/** Link two images to a post in order; returns them [first, second]. */
const makeImageOrder = async (postId: number) => {
  const first = await makeImage("Card First");
  const second = await makeImage("Card Second");
  await appendImageToItem(first.id, { itemId: postId, itemType: "news" });
  await appendImageToItem(second.id, { itemId: postId, itemType: "news" });
  return [first, second] as const;
};
