import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttachmentMediaType } from "#shared/attachment-media-type.ts";

describe("attachment media types", () => {
  test("labels common downloadable file types", () => {
    const examples = [
      ["data.csv", "text/csv"],
      ["letter.doc", "application/msword"],
      [
        "letter.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      ["animation.gif", "image/gif"],
      ["photo.jpeg", "image/jpeg"],
      ["photo.jpg", "image/jpeg"],
      ["film.mov", "video/quicktime"],
      ["song.mp3", "audio/mpeg"],
      ["film.mp4", "video/mp4"],
      ["guide.pdf", "application/pdf"],
      ["image.png", "image/png"],
      ["slides.ppt", "application/vnd.ms-powerpoint"],
      [
        "slides.pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ],
      ["notes.txt", "text/plain"],
      ["sound.wav", "audio/wav"],
      ["film.webm", "video/webm"],
      ["image.webp", "image/webp"],
      ["sheet.xls", "application/vnd.ms-excel"],
      [
        "sheet.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      ["files.zip", "application/zip"],
    ] as const;

    for (const [filename, mediaType] of examples) {
      expect(getAttachmentMediaType(filename)).toBe(mediaType);
    }
  });

  test("matches extensions without case sensitivity", () => {
    expect(getAttachmentMediaType("GUIDE.PDF")).toBe("application/pdf");
  });

  test("uses generic bytes for an unknown extension", () => {
    expect(getAttachmentMediaType("archive.uncommon")).toBe(
      "application/octet-stream",
    );
  });

  test("uses generic bytes when there is no extension", () => {
    expect(getAttachmentMediaType("README")).toBe("application/octet-stream");
  });
});
