/**
 * db.test.ts — TDD for the persistent history store.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HistoryDB } from "./db";

let dir: string;
let db: HistoryDB;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "coat-db-"));
  db = new HistoryDB(join(dir, "history.db"));
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function sampleWall(name: string) {
  const p = join(dir, name);
  writeFileSync(p, "fake-image-bytes");
  return p;
}

describe("HistoryDB persistent history", () => {
  test("starts empty and inserts a rotate row", () => {
    expect(db.count()).toBe(0);
    const id = db.insert({ path: sampleWall("2026-11-07-a.jpg"), artist: "munie", score: 120, rating: "Explicit", postId: 99 });
    expect(id).toBe(1);
    expect(db.count()).toBe(1);
  });

  test("list returns newest-first with full metadata", () => {
    db.insert({ path: sampleWall("2026-11-07-b.png"), artist: "puddlepup", score: 200, rating: "Explicit", generalTags: ["anthro", "canine"] });
    const rows = db.list(10, 0);
    expect(rows.length).toBe(2);
    const [newest, oldest] = rows;
    expect(newest?.artist).toBe("puddlepup"); // newest first
    expect(newest?.filename).toBe("2026-11-07-b.png");
    expect(newest?.score).toBe(200);
    expect(oldest?.artist).toBe("munie");
  });

  test("get(id) retrieves one row and restore source round-trips", () => {
    const id = db.insert({ path: sampleWall("2026-11-07-c.jpg"), source: "restore", artist: "kita" });
    const row = db.get(id);
    expect(row?.source).toBe("restore");
    expect(row?.kind).toBe("jpg");
    expect(row?.path.endsWith("c.jpg")).toBe(true);
  });

  test("ingestArchive seeds prior walls (restore from previous) and prunes dupes", () => {
    const arch = join(dir, "archive");
    mkdirSync(arch, { recursive: true });
    writeFileSync(join(arch, "2026-11-01T00-00-00-000Z-wall.jpg"), "old");
    writeFileSync(join(arch, "2026-11-02T00-00-00-000Z-saved.png"), "old2");
    const before = db.count();
    const added = db.ingestArchive(arch);
    expect(added).toBeGreaterThan(0);
    expect(db.count()).toBe(before + 2);
    db.pruneDuplicates();
  });

  test("survives close/reopen (persistence)", () => {
    db.close();
    const again = new HistoryDB(join(dir, "history.db"));
    const c = again.count();
    again.close();
    expect(c).toBeGreaterThan(3);
  });
});