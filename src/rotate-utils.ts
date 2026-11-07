/**
 * rotate-utils.ts — pure selection logic for the rotate lane.
 *
 * Kept dependency-free and side-effect-free so the "Rotate now" contract is
 * unit-testable (TDD): pick a still image from an e621 page, and build the tag
 * fallback list so a strict-but-empty page never leaves the button dead.
 */

/** Still-image extensions Windows SPI renders reliably (jpg/png/bmp). webp/gif
 *  slip through the e621 API but set BLACK — excluded here. */
export const STILL_EXTS: Record<string, true> = { jpg: true, jpeg: true, png: true, bmp: true };

export interface E621Post {
  id?: number;
  file?: { url?: string | null; ext?: string };
  score?: { total?: number };
}

export type UsablePost = E621Post & { file: { url: string; ext: string } };

/**
 * Pick the first post that has a downloadable, still-image file. Videos
 * (mp4/webm) and posts without a real url are skipped — the rotate button can
 * only ever set a jpg/png/bmp. Returns undefined when nothing is settable.
 */
export function pickFirstUsable(posts: E621Post[] | undefined | null): UsablePost | undefined {
  if (!posts) return undefined;
  return posts.find((p): p is UsablePost => {
    const ext = p.file?.ext ?? "";
    return Boolean(p.file?.url) && (ext in STILL_EXTS);
  });
}

/**
 * Build the ordered tag-query candidates for one rotate: the strict tags only,
 * then the same tags with `score:>` filters stripped (so a tight query whose
 * page comes back empty can still fall back to a broader, working search).
 * Deduped, never empty.
 */
export function buildTagCandidates(tags: string): string[] {
  const keep = tags.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (keep.length === 0) return ["male/male"]; // never emit an empty query
  const strict = keep.join(" ");
  const relaxed = keep.filter((t) => !/^score:>\d+$/.test(t)).join(" ");
  const out: string[] = [];
  if (strict) out.push(strict);
  if (relaxed && relaxed !== strict) out.push(relaxed);
  return out;
}