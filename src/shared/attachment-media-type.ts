import { extname } from "@std/path";

/** Common attachment types. Every other file stays safely downloadable. */
const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

/** Return a useful content type for a common attachment, else generic bytes. */
export const getAttachmentMediaType = (filename: string): string => {
  const mediaType = MEDIA_TYPE_BY_EXTENSION[extname(filename).toLowerCase()];
  return mediaType === undefined ? "application/octet-stream" : mediaType;
};
