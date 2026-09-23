import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/** Empties every catalog table and restarts their ids. Works inside a transaction. */
export async function truncateCatalog(db: Pick<Db, "execute">) {
  await db.execute(sql`
    TRUNCATE sample_assertions, sample_segments, samples,
      track_lineage_disclosures, track_works, work_identifiers,
      track_contributors, track_artists, track_name_aliases, track_aliases,
      track_identifiers, tracks, works, artists
    RESTART IDENTITY`);
}
