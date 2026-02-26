#!/usr/bin/env bun

import { join } from "node:path";
import { exists, fs, loadEnv, path, readJson, write } from "./utils.js";

await loadEnv();

const CONFIG = {
  siteConfig: path("_data", "site.json"),
  reviewsDir: path("reviews"),
  actorId: "nwua9Gu5YrADL7ZDj",
  maxReviews: 9999,
};

const formatFilename = (name, date) => {
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 30);
  return `${safeName}-google-${date.toISOString().split("T")[0]}.md`;
};

const fetchReviews = async (placeId, opts = {}) => {
  const url = `https://api.apify.com/v2/acts/${CONFIG.actorId}/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`;

  console.log("Fetching all available reviews...");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startUrls: [
        { url: `https://www.google.com/maps/place/?q=place_id:${placeId}` },
      ],
      maxReviews: opts.maxReviews || CONFIG.maxReviews,
      reviewsSort: opts.sort || "newest",
      language: opts.language || "en",
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const results = await res.json();
  if (!Array.isArray(results)) throw new Error("Invalid API response format");

  return results
    .flatMap((item) => item.reviews || [])
    .map((r) => ({
      content: r.text || r.reviewText,
      date: new Date(r.publishedAtDate),
      rating: r.stars,
      author: r.name || r.authorName,
      authorUrl: r.reviewerUrl || r.authorUrl,
    }))
    .filter((r) => r.content?.length > 5);
};

const saveReview = async (review, dir) => {
  const filename = formatFilename(review.author, review.date);
  const filepath = join(dir, filename);

  if (await exists(filepath)) return false;

  await write(
    filepath,
    `---
name: ${review.author}
url: ${review.authorUrl}
rating: ${review.rating}
---

${review.content}
`,
  );

  console.log(`${filename} (${review.rating}/5 stars)`);
  return true;
};

const main = async () => {
  if (!process.env.APIFY_API_TOKEN) {
    console.error("Error: APIFY_API_TOKEN required in .env file");
    console.error("Get token: https://console.apify.com/account/integrations");
    process.exit(1);
  }

  if (!(await exists(CONFIG.siteConfig))) {
    console.error(`Error: ${CONFIG.siteConfig} not found`);
    process.exit(1);
  }

  const siteConfig = await readJson(CONFIG.siteConfig);
  if (!siteConfig.google_place_id) {
    console.error("Error: google_place_id missing from site.json");
    process.exit(1);
  }

  fs.mkdir(CONFIG.reviewsDir);

  const reviews = await fetchReviews(siteConfig.google_place_id);
  console.log(`Found ${reviews.length} reviews`);

  const saved = (
    await Promise.all(reviews.map((r) => saveReview(r, CONFIG.reviewsDir)))
  ).filter(Boolean).length;

  console.log(
    `\nSaved ${saved} new reviews (${reviews.length - saved} already existed)`,
  );
};

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
