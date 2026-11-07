/**
 * rotate-utils.test.ts — TDD contract for coat's rotate-selection logic.
 *
 * These tests lock the behavior the tray "Rotate now" depends on: given an e621
 * API page it must pick a still image (settable as a wallpaper), fall back to a
 * relaxed query when the strict tags return nothing, and never emit webm/video.
 */
import { describe, expect, test } from "bun:test";
import { buildTagCandidates, pickFirstUsable, postMeta } from "./rotate-utils";

const STILL_JPG = { id: 1, file: { url: "https://e621.net/data/x.jpg", ext: "jpg" }, score: { total: 90 } };
const STILL_PNG = { id: 2, file: { url: "https://e621.net/data/y.png", ext: "png" }, score: { total: 88 } };
const VIDEO = { id: 3, file: { url: "https://e621.net/data/z.mp4", ext: "mp4" }, score: { total: 95 } };
const WEBM = { id: 4, file: { url: "https://e621.net/data/w.webm", ext: "webm" }, score: { total: 70 } };
const NO_FILE = { id: 5, file: { url: null, ext: "jpg" }, score: { total: 60 } };
const ARTIST_POST = {
  id: 42,
  file: { url: "https://static1.e621.net/data/f.jpg", ext: "jpg" },
  sample: { url: "https://static1.e621.net/data/sample/f.jpg" },
  score: { total: 110, up: 119, down: -9 },
  rating: "e",
  tags: { artist: ["munie"], general: ["anthro", "blush"], species: ["canine"], character: [], copyright: [], meta: [] },
};

describe("pickFirstUsable — the rotate button must only set a still image", () => {
  test("picks the first still-image post (jpg/png/bmp), skipping videos/webm", () => {
    expect(pickFirstUsable([VIDEO, WEBM, STILL_JPG])).toEqual(STILL_JPG);
  });

  test("skips posts with no file url entirely", () => {
    expect(pickFirstUsable([NO_FILE, STILL_PNG])).toEqual(STILL_PNG);
  });

  test("returns undefined when only videos/webm/no-file posts remain (nothing settable)", () => {
    expect(pickFirstUsable([VIDEO, WEBM, NO_FILE])).toBeUndefined();
  });

  test("returns undefined on empty input", () => {
    expect(pickFirstUsable([])).toBeUndefined();
  });
});

describe("buildTagCandidates — rotate must succeed even when the strict tag page is empty", () => {
  test("returns the original tags plus a score-stripped fallback", () => {
    const c = buildTagCandidates("male/male score:>80 -gore");
    expect(c).toContain("male/male score:>80 -gore");
    expect(c).toContain("male/male -gore");
  });

  test("dedupes when there is no score filter", () => {
    const c = buildTagCandidates("male/male -gore");
    expect(c).toEqual(["male/male -gore"]);
  });

  test("never yields an empty candidate", () => {
    const c = buildTagCandidates("   ");
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((t) => t.trim().length > 0)).toBe(true);
  });
});

describe("postMeta — the GUI/tray must show artist + full metadata", () => {
  test("extracts artist, score, rating, sample URL and tag buckets", () => {
    const m = postMeta(ARTIST_POST);
    expect(m.artist).toBe("munie");
    expect(m.score).toBe(110);
    expect(m.rating).toBe("Explicit");
    expect(m.sampleUrl).toBe("https://static1.e621.net/data/sample/f.jpg");
    expect(m.fullUrl).toBe("https://static1.e621.net/data/f.jpg");
    expect(m.tags.general).toContain("anthro");
    expect(m.tags.species).toContain("canine");
    expect(m.id).toBe(42);
  });

  test("falls back to (unknown) artist when missing", () => {
    const m = postMeta(STILL_JPG);
    expect(m.artist).toBe("(unknown)");
    expect(m.sampleUrl).toBeNull();
  });

  test("maps explicit rating nicely", () => {
    expect(postMeta({ ...STILL_JPG, rating: "q" }).rating).toBe("Questionable");
    expect(postMeta({ ...STILL_JPG, rating: "s" }).rating).toBe("Sensitive");
  });
});