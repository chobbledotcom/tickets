/**
 * Record each storyboard, package its HTML player, and publish the whole set
 * under one content-addressed CDN directory. The app receives the returned
 * base only after every object is uploaded and verified.
 */

import { join } from "@std/path";
import {
  type CdnObject,
  cdnObjectsHash,
  publishCdnObjects,
  type StaticCdnConfig,
} from "#scripts/static-cdn.ts";
import { JS } from "#shared/content-types.ts";
import { packageGuideAnimation } from "./package.ts";
import { recordGuideSession } from "./record/run.ts";
import { removeTree } from "./remove-tree.ts";
import { bundleGuideRenderer } from "./render/bundle.ts";
import { GUIDE_SLUGS, guideStoryboard } from "./storyboards/index.ts";

const HASH_CHARS = 16;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": JS,
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
};

const contentTypeFor = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot);
  const contentType = CONTENT_TYPES[extension];
  if (contentType === undefined) {
    throw new Error(`No guide content type for ${name}`);
  }
  return contentType;
};

const collectObjects = async (
  directory: string,
  prefix: string,
): Promise<CdnObject[]> => {
  const objects: CdnObject[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    const objectPath = `${prefix}/${entry.name}`;
    if (entry.isDirectory) {
      objects.push(...(await collectObjects(path, objectPath)));
    } else {
      objects.push({
        bytes: await Deno.readFile(path),
        contentType: contentTypeFor(entry.name),
        path: objectPath,
      });
    }
  }
  return objects;
};

export interface PublishGuideOptions {
  fetcher?: typeof fetch;
  fromSession?: string;
  playerBundle?: string;
  slug?: string;
}

export interface PublishedGuides {
  baseUrl: string;
  hash: string;
  slugs: readonly string[];
}

export const publishGuideAnimations = async (
  config: StaticCdnConfig,
  options: PublishGuideOptions = {},
): Promise<PublishedGuides> => {
  const slugs = options.slug === undefined ? GUIDE_SLUGS : [options.slug];
  if (options.fromSession !== undefined && slugs.length !== 1) {
    throw new Error("--from takes exactly one guide");
  }
  const playerBundle = options.playerBundle ?? (await bundleGuideRenderer());
  const tempRoot = await Deno.makeTempDir({ prefix: "guide-publish-" });
  try {
    const objects: CdnObject[] = [
      {
        bytes: new TextEncoder().encode(playerBundle),
        contentType: JS,
        path: "player.js",
      },
    ];
    for (const slug of slugs) {
      const storyboard = guideStoryboard(slug);
      const sessionDir = options.fromSession ?? join(tempRoot, slug, "session");
      if (options.fromSession === undefined) {
        await recordGuideSession(storyboard, sessionDir);
      }
      const guideDir = join(tempRoot, slug, "player");
      await packageGuideAnimation(sessionDir, guideDir);
      objects.push(...(await collectObjects(guideDir, slug)));
    }
    const hash = (await cdnObjectsHash(objects)).slice(0, HASH_CHARS);
    const basePath = `guides/${hash}`;
    await publishCdnObjects(
      config,
      objects.map((object) => ({
        ...object,
        path: `${basePath}/${object.path}`,
      })),
      options.fetcher,
    );
    return {
      baseUrl: `${config.cdnUrl}/${basePath}`,
      hash,
      slugs,
    };
  } finally {
    await removeTree(tempRoot);
  }
};
