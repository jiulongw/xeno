import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AttachmentType =
  | "image"
  | "video"
  | "audio"
  | "voice"
  | "document"
  | "animation"
  | "sticker";

export interface Attachment {
  type: AttachmentType;
  path: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
  size?: number;
}

export function inferAttachmentType(mimeType: string): AttachmentType {
  const normalized = mimeType.toLowerCase();
  if (!normalized) {
    return "document";
  }

  if (normalized.includes("sticker")) {
    return "sticker";
  }
  if (normalized === "image/gif") {
    return "animation";
  }
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }

  return "document";
}

export async function getMediaDir(home: string, subdir?: string): Promise<string> {
  const mediaDir = subdir ? join(home, "media", subdir) : join(home, "media");
  await mkdir(mediaDir, { recursive: true });
  return mediaDir;
}

export async function saveMedia(
  home: string,
  data: Buffer,
  extension?: string,
  subdir?: string,
): Promise<string> {
  const mediaDir = await getMediaDir(home, subdir);
  const normalizedExtension = normalizeExtension(extension);
  const fileName = `${randomUUID()}.${normalizedExtension}`;
  const destination = join(mediaDir, fileName);

  await writeFile(destination, data);
  return destination;
}

function normalizeExtension(value: string | undefined): string {
  if (!value) {
    return "bin";
  }

  const normalized = value.trim().replace(/^\./, "").toLowerCase();
  if (!normalized) {
    return "bin";
  }

  return normalized.replace(/[^a-z0-9]+/g, "") || "bin";
}
