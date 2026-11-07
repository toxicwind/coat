/**
 * db.ts — coat's persistent history store (SQLite via bun:sqlite).
 *
 * Tracks every wall event (rotate / save / restore) with full e621 metadata so
 * history can be browsed, queried, and restored — across daemon restarts. A
 * single file at the coat state dir; ingest on first open so prior sessions'
 * archive/* files become queryable rows (restore-from-previous).
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export type HistorySource = "rotate" | "save" | "restore";

export interface WallRow {
  id: number;
  ts: string;
  source: HistorySource;
  kind: string;
  path: string;
  filename: string | null;
  artist: string | null;
  score: number | null;
  rating: string | null;
  post_id: number | null;
  tags: string | null; // JSON array of general tags
  sample_url: string | null;
  full_url: string | null;
  bytes: number | null;
}

export interface WallInput {
  path: string;
  ts?: string;
  source?: HistorySource;
  artist?: string | null;
  score?: number | null;
  rating?: string | null;
  postId?: number | null;
  generalTags?: string[];
  sampleUrl?: string | null;
  fullUrl?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS walls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rotate',
  kind TEXT NOT NULL DEFAULT 'wall',
  path TEXT NOT NULL,
  filename TEXT,
  artist TEXT,
  score INTEGER,
  rating TEXT,
  post_id INTEGER,
  tags TEXT,
  sample_url TEXT,
  full_url TEXT,
  bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_walls_ts ON walls(ts);
CREATE INDEX IF NOT EXISTS idx_walls_artist ON walls(artist);
CREATE INDEX IF NOT EXISTS idx_walls_source ON walls(source);
`;

/** A HistoryDB wraps a bun:sqlite Database plus a light insert/list API. */
export class HistoryDB {
  readonly db: Database;

  constructor(readonly dbPath: string) {
    mkdirSync(dbPath.slice(0, Math.max(dbPath.lastIndexOf("/"), dbPath.lastIndexOf("\\")) || undefined) || ".", { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  count(): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM walls").get();
    if (row && typeof row === "object" && "c" in row && typeof row.c === "number") return row.c;
    return 0;
  }

  insert(w: WallInput): number {
    const tags = w.generalTags ? JSON.stringify(w.generalTags) : null;
    const filename = w.path.split(/[\\/]/).pop() ?? null;
    const info = {
      ts: w.ts ?? new Date().toISOString().replace("T", " ").slice(0, 19),
      source: w.source ?? "rotate",
      kind: (w.path.split(".").pop() ?? "wall").toLowerCase(),
      path: w.path,
      filename,
      artist: w.artist ?? null,
      score: w.score ?? null,
      rating: w.rating ?? null,
      post_id: w.postId ?? null,
      tags,
      sample_url: w.sampleUrl ?? null,
      full_url: w.fullUrl ?? null,
      bytes: (() => { try { return existsSync(w.path) ? statSync(w.path).size : null; } catch { return null; } })(),
    };
    const r = this.db.query(
      `INSERT INTO walls (ts,source,kind,path,filename,artist,score,rating,post_id,tags,sample_url,full_url,bytes)
       VALUES (@ts,@source,@kind,@path,@filename,@artist,@score,@rating,@post_id,@tags,@sample_url,@full_url,@bytes)`,
    ).run(info as never);
    return Number(r.lastInsertRowid);
  }

  list(limit = 50, offset = 0): WallRow[] {
    return this.db.query("SELECT * FROM walls ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset) as WallRow[];
  }

  get(id: number): WallRow | null {
    return this.db.query("SELECT * FROM walls WHERE id = ?").get(id) as WallRow | null;
  }

  /** Remove offline duplicates (same filename seen more than once keeps the newest). */
  pruneDuplicates() {
    this.db.exec(`
      DELETE FROM walls WHERE id NOT IN (
        SELECT MAX(id) FROM walls GROUP BY filename
      );
    `);
  }

  /** Ingest an existing archive folder so prior walls become history (restore-from-previous). */
  ingestArchive(archiveDir: string, source: HistorySource = "rotate") {
    if (!existsSync(archiveDir)) return 0;
    let added = 0;
    for (const f of readdirSync(archiveDir)) {
      const p = join(archiveDir, f);
      try { if (!statSync(p).isFile()) continue; } catch { continue; }
      const ts = f.match(/(\d{4}-\d{2}-\d{2}T[\d-]+)/)?.[1] ?? new Date().toISOString().replace("T", " ").slice(0, 19);
      const kind = f.match(/-(wall|saved|restore)\./)?.[1] ?? "wall";
      const inserted = this.insert({ path: p, ts: ts.replace(/([^\d]+)/g, (g) => (g.length > 1 ? " " : g)), source: kind === "save" ? "save" : "rotate" });
      if (inserted) added++;
    }
    this.pruneDuplicates();
    return added;
  }
}