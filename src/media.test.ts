import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { inferAttachmentType, saveMedia } from "./media";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xeno-media-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("inferAttachmentType", () => {
  test("maps known MIME categories", () => {
    expect(inferAttachmentType("image/jpeg")).toBe("image");
    expect(inferAttachmentType("video/mp4")).toBe("video");
    expect(inferAttachmentType("audio/ogg")).toBe("audio");
    expect(inferAttachmentType("application/pdf")).toBe("document");
    expect(inferAttachmentType("image/gif")).toBe("animation");
    expect(inferAttachmentType("application/x-tgsticker")).toBe("sticker");
  });
});

describe("saveMedia", () => {
  test("writes a file under the media directory and returns its path", async () => {
    const home = await makeTempHome();
    const payload = Buffer.from("media payload");

    const path = await saveMedia(home, payload, "txt");
    const fileName = basename(path);

    expect(path.startsWith(join(home, "media"))).toBe(true);
    expect(fileName.endsWith(".txt")).toBe(true);

    const content = await readFile(path, "utf-8");
    expect(content).toBe("media payload");
  });

  test("writes a file under a media subdirectory when provided", async () => {
    const home = await makeTempHome();
    const payload = Buffer.from("received payload");

    const path = await saveMedia(home, payload, "txt", "received");
    expect(path.startsWith(join(home, "media", "received"))).toBe(true);
  });
});
