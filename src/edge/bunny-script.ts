/**
 * PIPA Tag Search API - Bunny Edge Script
 * Entry point for Bunny CDN edge deployment
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { fetchAllReportDetails } from "../lib/report-parser.ts";
import { searchTag } from "../lib/tag-parser.ts";
import type { TagResult } from "../lib/types.ts";
import { initCache, readCache, writeCache } from "./cache.ts";

// biome-ignore lint/suspicious/noConsole: Edge script logging for debugging
console.log("[PIPA] Edge script module loaded");

/**
 * Handle cache hit - fetch missing details if needed
 */
const handleCacheHit = async (
  cached: TagResult,
  tagId: string,
): Promise<TagResult> => {
  const hasDetails = cached.annualReports?.[0]?.details;
  const needsDetails = cached.annualReports?.length && !hasDetails;
  if (!needsDetails) return cached;

  const withDetails = await fetchAllReportDetails(cached);
  await writeCache(tagId, withDetails);
  return { ...withDetails, fromCache: false };
};

/**
 * Fetch fresh tag data with details
 */
const fetchFreshData = async (tagId: string): Promise<TagResult> => {
  const data = await searchTag(tagId);
  const finalData = data.found ? await fetchAllReportDetails(data) : data;
  if (finalData.found) {
    await writeCache(tagId, finalData);
  }
  return finalData;
};

/**
 * Search tag with caching
 */
const searchTagWithCache = async (
  tagId: string,
  useCache = true,
): Promise<TagResult> => {
  if (useCache) {
    const cached = await readCache(tagId);
    if (cached) return handleCacheHit(cached, tagId);
  }
  return fetchFreshData(tagId);
};

/**
 * Create JSON response
 */
const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Homepage HTML template
 */
const getHomepageHtml = (): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PIPA Tag Search</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
    h1 { color: #333; }
    .search-form { background: #f5f5f5; padding: 1.5rem; border-radius: 8px; margin-bottom: 2rem; }
    .form-group { margin-bottom: 1rem; }
    label { display: block; margin-bottom: 0.5rem; font-weight: 500; }
    select, input { padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
    select { width: 200px; }
    input[type="text"] { width: 200px; }
    button { background: #0066cc; color: white; padding: 0.5rem 1.5rem; font-size: 1rem; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background: #0055aa; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    .api-docs { background: #f9f9f9; padding: 1.5rem; border-radius: 8px; border-left: 4px solid #0066cc; }
    .api-docs h2 { margin-top: 0; }
    code { background: #e8e8e8; padding: 0.2rem 0.4rem; border-radius: 3px; font-family: monospace; }
    pre { background: #2d2d2d; color: #f8f8f2; padding: 1rem; border-radius: 4px; overflow-x: auto; }
    .endpoint { margin-bottom: 1.5rem; }
    .method { color: #22c55e; font-weight: bold; }
  </style>
</head>
<body>
  <h1>PIPA Tag Search</h1>

  <div class="search-form">
    <form id="searchForm">
      <div class="form-group">
        <label for="host">Host</label>
        <select id="host" name="host" required>
          <option value="">Please select</option>
          <option value="pipa.org.uk">pipa.org.uk</option>
        </select>
      </div>
      <div class="form-group">
        <label for="unitId">Unit ID</label>
        <input type="text" id="unitId" name="unitId" placeholder="e.g. 40000" required pattern="[0-9]+" title="Unit ID must be a number">
      </div>
      <div class="form-group">
        <label><input type="checkbox" id="useCache" name="useCache" checked> Use cache</label>
      </div>
      <button type="submit" id="searchBtn">Search</button>
    </form>
  </div>

  <div class="api-docs">
    <h2>API Documentation</h2>
    <p>This is an open API for searching PIPA (Playground Inspection Partners Association) safety tags.</p>

    <div class="endpoint">
      <h3><span class="method">GET</span> /tag/:id</h3>
      <p>Search for a PIPA tag by its ID number.</p>
      <p><strong>Parameters:</strong></p>
      <ul>
        <li><code>:id</code> - The numeric tag ID (e.g., 40000)</li>
      </ul>
      <p><strong>Example:</strong></p>
      <pre>curl https://test-searcher-upm2z.bunny.run/tag/40000</pre>
      <p><strong>Response:</strong></p>
      <pre>{
  "found": true,
  "tagId": "40000",
  "status": "Pass",
  "statusClass": "pass",
  "unitReferenceNo": "...",
  "type": "...",
  "currentOperator": "...",
  "certificateExpiryDate": "...",
  "certificateUrl": "...",
  "reportUrl": "...",
  "imageUrl": "...",
  "annualReports": [...],
  "fetchedAt": "..."
}</pre>
    </div>

    <div class="endpoint">
      <h3><span class="method">GET</span> /health</h3>
      <p>Health check endpoint.</p>
      <pre>curl https://test-searcher-upm2z.bunny.run/health</pre>
      <p><strong>Response:</strong> <code>{"status": "ok"}</code></p>
    </div>
  </div>

  <script>
    const form = document.getElementById('searchForm');
    const hostSelect = document.getElementById('host');
    const unitIdInput = document.getElementById('unitId');
    const useCacheCheckbox = document.getElementById('useCache');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!hostSelect.value) {
        alert('Please select a host');
        return;
      }
      const unitId = unitIdInput.value.trim();
      if (!unitId || !/^[0-9]+$/.test(unitId)) {
        alert('Please enter a valid numeric Unit ID');
        return;
      }
      const useCache = useCacheCheckbox.checked;
      let url = '/tag/' + encodeURIComponent(unitId);
      if (!useCache) {
        url += '?noCache=1';
      }
      window.location.href = url;
    });
  </script>
</body>
</html>`;

/**
 * Handle incoming requests
 */
const handleRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "") {
    return new Response(getHomepageHtml(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname.startsWith("/tag/")) {
    const tagId = url.pathname.slice(5);
    const useCache = !url.searchParams.has("noCache");
    const result = await searchTagWithCache(tagId, useCache);
    return jsonResponse(result);
  }

  if (url.pathname === "/health") {
    return jsonResponse({ status: "ok" });
  }

  return jsonResponse({ error: "Not found" }, 404);
};

let initialized = false;

// biome-ignore lint/suspicious/noConsole: Edge script logging for debugging
console.log("[PIPA] Registering HTTP handler...");

BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
  try {
    if (!initialized) {
      // biome-ignore lint/suspicious/noConsole: Edge script logging for debugging
      console.log("[PIPA] Initializing cache...");
      await initCache();
      initialized = true;
      // biome-ignore lint/suspicious/noConsole: Edge script logging for debugging
      console.log("[PIPA] Cache initialized successfully");
    }
    return handleRequest(request);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: Edge script error logging
    console.error("[PIPA] Request error:", error);
    return jsonResponse(
      { error: "Internal server error", message: String(error) },
      500,
    );
  }
});

// biome-ignore lint/suspicious/noConsole: Edge script logging for debugging
console.log("[PIPA] HTTP handler registered");
