/// <reference lib="dom" />
/**
 * The rich editor's pictures: the image library that one editor reads, and
 * the image node view that shows the picture a stored address names. The
 * document keeps the short form (`img#7`), so the markdown serializes back
 * unchanged.
 */

import type { Node } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import * as v from "valibot";
import { bindFirst } from "#shared/fp-bind.ts";
import {
  IMAGE_LIBRARY_CHANGED,
  type ImageOption,
  ImageOptionsReplySchema,
} from "#shared/images/picker.ts";
import { shortFormImageId } from "#shared/images/short-form.ts";

/** The site's image library as one editor reads it: fetched on first use,
 * then cached. `forget` drops the cache, so the next read fetches again. */
export interface ImageLibrary {
  forget: () => void;
  load: () => Promise<ImageOption[]>;
}

const fetchImageOptions = async (): Promise<ImageOption[]> => {
  const response = await fetch("/admin/images/options");
  if (!response.ok) {
    throw new Error(`image options responded ${response.status}`);
  }
  return v.parse(ImageOptionsReplySchema, await response.json()).images;
};

export const createImageLibrary = (): ImageLibrary => {
  let options: Promise<ImageOption[]> | null = null;
  if (typeof document !== "undefined") {
    document.addEventListener(IMAGE_LIBRARY_CHANGED, () => {
      options = null;
    });
  }
  return {
    forget: () => {
      options = null;
    },
    load: () => {
      options ??= fetchImageOptions().catch((error) => {
        // A failed load must not poison every later open in this session.
        options = null;
        throw error;
      });
      return options;
    },
  };
};

/** The address the rich editor shows for a stored image source. A
 * short-form address resolves through the library, and any other address
 * shows as written. Null when the library lacks the image or cannot load:
 * the picture then shows its alt text. */
const previewSourceOrNull = async (
  library: ImageLibrary,
  src: string,
): Promise<string | null> => {
  const id = shortFormImageId(src);
  if (id === undefined) return src;
  try {
    const option = (await library.load()).find((image) => image.id === id);
    return option === undefined ? null : option.full;
  } catch {
    // A library that cannot load leaves the picture to its alt text.
    return null;
  }
};

/** The attributes that the markdown schema's image node stores. A reference
 * without alt text reads as an empty one. */
const ImageAttrsSchema = v.object({
  alt: v.nullable(v.string(), ""),
  src: v.string(),
  title: v.nullable(v.string()),
});

/** Sets an attribute, or removes it when the value is null or empty. An
 * empty src makes the browser request the page itself. */
const setOrRemoveAttribute = (
  element: Element,
  name: string,
  value: string | null,
): void => {
  if (value === null || value === "") {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(name, value);
};

/** One picture in the rich editor, and the node state it shows. */
interface Picture {
  image: HTMLImageElement;
  library: ImageLibrary;
  shown: Node;
}

/** Shows a node state: the alt text and title at once, the source when the
 * library answers. A newer node state can replace this one before the
 * answer arrives. The late answer then changes nothing. */
const showNode = async (picture: Picture, node: Node): Promise<void> => {
  picture.shown = node;
  const { alt, src, title } = v.parse(ImageAttrsSchema, node.attrs);
  picture.image.alt = alt;
  setOrRemoveAttribute(picture.image, "title", title);
  const source = await previewSourceOrNull(picture.library, src);
  if (picture.shown !== node) return;
  setOrRemoveAttribute(picture.image, "src", source);
};

const imageNodeViewFor = (library: ImageLibrary, node: Node): NodeView => {
  const image = document.createElement("img");
  const picture: Picture = { image, library, shown: node };
  void showNode(picture, node);
  return {
    dom: image,
    // A node view keyed by type only ever receives nodes of that type.
    update: (next) => {
      void showNode(picture, next);
      return true;
    },
  };
};

/** The image node view over one editor's library. */
export const imageNodeView = bindFirst(imageNodeViewFor);
