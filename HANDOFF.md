# Handoff to Codex: music-sample-graph × Sinc online catalog

Claude Code wrote this on 2026-09-23 at about 19:30 America/New_York, at the end of a long session. Unless a fact is marked otherwise, it was checked against the working trees, the databases and the tools just before writing.

Two repositories are involved:

| Repo | Path | Role |
|---|---|---|
| **music-sample-graph** | `/Users/rxcid/xprojects/music-sample-graph` | New in this session. The online "Music DNA" backend (Fastify + Drizzle + Postgres), a generated Swift client, and a Next.js scaffold. |
| **Sinc** (`Sincapp`) | `/Users/rxcid/xprojects/Sincapp` | The user's existing iOS app, which recognizes a song and shows its samples. It is SwiftUI with XcodeGen, and its bundled SQLite catalog is built by Python tools. The user wants it to become an **online-focused product**. |

A third folder, **`/Users/rxcid/xprojects/codex-handoff/`**, holds backups made for this handoff (see §0.2 and §0.5).

---

## 0. Read this first: five things that will bite you

### 0.1 Sinc's local branch is stale, and upstream deleted the screen the new online code uses

- Local branch `sinc` is at `67d3cfd` (2026-09-14).
- `origin/sinc` is at `b2e8f86` (2026-09-15), which is **8 commits ahead and 0 behind**. `git ls-remote` confirmed that the remote-tracking refs match GitHub, so no fetch is needed to see this.
- Those 8 commits replace the lineage tree with **"Generations"**. They delete:
  - `Sinc/Lineage.swift`, which held `LineageNode` and `LineageBuilder` (`LineageTrack` survives);
  - `Sinc/Views/LineageGraphView.swift` and `Sinc/Views/LineageShareCard.swift`;
  - `SampleDatabase.lineage(title:artist:year:kind:)` in `Models.swift`;
  - `SincTests/LineageBuilderTests.swift` and `SincTests/SiblingsTests.swift`.
- They add:
  - `Sinc/Generations.swift`, `Sinc/SongIdentity.swift`, `Sinc/Views/GenerationsView.swift` and `Sinc/Views/GenerationsShareCard.swift`;
  - `tools/identity_review.py`, `tools/mb_canonical.py`, `tools/mb_extract.py` and `tools/data/song_identity_vectors.json`;
  - more besides; see §7.
- The uncommitted `Sinc/OnlineCatalog.swift` and `SincTests/OnlineCatalogTests.swift` use `LineageNode` and `SampleDatabase.lineage(...)`. **They will not compile once the branch is updated to `origin/sinc`.** The online wiring must be ported to Generations; §7 is the step-by-step plan.
- This was found only while writing this handoff. All Sinc build, test and simulator results in this document were produced on the stale `67d3cfd`.

### 0.2 All Sinc work is uncommitted, and it's the user's call to commit it

- The working tree of `/Users/rxcid/xprojects/Sincapp` on branch `sinc` has 6 modified files and 3 untracked ones (§5).
- The user has **not** asked for the Sinc changes to be committed. Ask before committing, and never push without explicit approval.
- Two patch backups sit in `/Users/rxcid/xprojects/codex-handoff/`. Both were verified with `git apply --check --reverse` against the live working tree, and their base is `67d3cfd`, recorded in `PATCH_BASE.txt`:
  - `sinc-derivative-identity.patch`: `tools/build_db.py` and `tools/tests/test_derivative_identity.py`.
  - `sinc-online-catalog.patch`: the app-side online catalog wiring (7 files).
- Don't run `git checkout -- .`, `git reset --hard`, `git clean`, or a pull that would overwrite these files, until the work is committed on a branch or you've confirmed the patches.

### 0.3 The user approves commits, pushes, publishes and downloads

- music-sample-graph was committed only when the user said "commit". It has **no git remote**; nothing has ever been pushed from it.
- Publishing a Sinc catalog release (GitHub release on `rxcid/sinc-catalog`), pushing to `git@github.com:rxcid/sinc.git`, creating GitHub repos, and deploying anything are all outward-facing. Get explicit approval each time.
- Before any download, ask the user and state the filename, source and size. Homebrew and Colima were approved once, in this session, for the Docker runtime.

### 0.4 `project.yml` points at the Swift client by local path

- The path is `packages: MusicSampleGraphClient: path: ../music-sample-graph/clients/swift`.
- Xcode Cloud runs `ci_scripts/ci_post_clone.sh`, which does `xcodegen generate`, then builds. It has no sibling checkout, so package resolution will fail. **Don't push this `project.yml` to any branch Xcode Cloud builds.**
- SwiftPM can't depend **by URL** on a package that lives in a subdirectory of a repo; `Package.swift` must be at the repo root. So just hosting music-sample-graph on GitHub is not enough. See §8 P1-1 for the options.
- GitHub Actions CI (`.github/workflows/ci.yml`) only runs the Python tests and the catalog audit on Ubuntu, so this change doesn't affect it.

### 0.5 The local Postgres holds an unpublished catalog revision

- It was imported from an **identity-v2 rebuild**, revision `catalog_cf3513f1adfb5596522dcb504ac74ce2db5bbf6124a9013c8019a80d0a9ba2e5`. The rebuild was made with Sinc's uncommitted `build_db.py`.
- The app bundles the published **v16**, revision `catalog_48b1c9cd85d6004f1409048dbf42353a0d463fd043fd1c482ac56bc4e92c44b3`. Its sha256 is `ccf422e1…`, which matches `catalog.lock.json`.
- A copy of the rebuild is at `/Users/rxcid/xprojects/codex-handoff/samples-identity-v2-rebuild.sqlite` (sha256 `f93aee2a892d7547062fdb9d8e59cb2b0ee39bbfe432bf4d0a215f136571c9f9`, 94.9 MB). The original sat in a session scratchpad that may disappear.
- Rebuild vs v16:
  - nodes: 34,304 vs 34,302 (the two remixes are now nodes of their own);
  - edges: 26,404 vs 26,404;
  - self-loops: 0 vs 2;
  - revisions in `catalog_revisions`: 3.
- **Don't use this file as catalog v17.** Build v17 from updated sources after the upstream merge (§8 P1-4).

---

## 1. What the user asked for, in order

1. **Original request, paraphrased closely:** build "music-sample-graph", an interactive Music Discovery & Sampling Engine.
   - A monorepo with `backend` (Node.js + Fastify + TypeScript) and `frontend` (Next.js App Router + Tailwind + TypeScript).
   - `docker-compose.yml` with PostgreSQL.
   - Prisma or Drizzle, with a schema for Artists, Tracks and a self-referential **Samples** join table: `parent_track_id`, `child_track_id`, a `sample_type` enum, `timestamp_parent` and `timestamp_child`.
   - Aligned `.gitignore`, tsconfig and package.json scripts.
   - Then guidance on starting Docker and running the first migration, "step by step, starting with the file structures."
2. "move it /Users/rxcid/xprojects/ I want to eventually get to a point where this will work with my app that I am developing." The app is Sinc.
3. "yes, reshape it to match Sinc. I eventually want to make Sinc an online focused product."
4. "Address and resolve everything", with pasted text from an earlier assistant message:
   - Fix Sinc's two self-referencing remix edges: *Survivalism* (Nine Inch Nails) and *State of Independence* (Donna Summer). Sinc's `normalize()` drops bracketed text, so "Song (Remix)" collapses into "Song".
   - Port Sinc's `normalize()` to TypeScript so it passes `normalization_vectors.json`.
   - Step 2: install Docker, create `backend/.env`, run `npm run db:up`, `db:generate` and `db:migrate`.
   - Build a real `npm run import:sinc`.
   - A decision the user accepted: *"Left out on purpose: Sinc's older songs/samples tables, its catalog version history, review-case status and graph cluster IDs. Those belong to how the phone catalog is built and updated; we'll design their online versions along with the API."*
5. Asked which Docker runtime to use, the user chose **Colima**.
6. "yes, init git and commit, then start the API"
7. "commit it, then build lineage and the Swift client"
8. "yes, commit it and wire it into Sinc". Here "commit it" meant the music-sample-graph lineage and Swift client work, which was committed. The Sinc wiring was done and verified, and left uncommitted.
9. The current request: this handoff, "as detailed as possible", so Codex can continue exactly where Claude stopped.

**Schema note:** the original spec put `sample_type`, `timestamp_parent` and `timestamp_child` on the samples join table. After "reshape it to match Sinc", they live in **`sample_segments`**, because one relationship can have several segments. `samples` keeps the edge itself: `parent_track_id` is the source (original) and `child_track_id` is the destination (the song that uses it). It also holds `relationship_type`, `status`, `confidence` and `notes`.

---

## 2. State at a glance

| Area | State |
|---|---|
| music-sample-graph repo | Branch `main`, clean tree, **no remote**. It has 4 code commits (§4.1), then a 5th that adds `HANDOFF.md` (this file) and `AGENTS.md`. |
| Postgres (Docker via Colima) | Running and healthy: container `music-sample-graph-postgres-1`, `127.0.0.1:5432`. DBs `music_sample_graph` (full catalog) and `music_sample_graph_test`. |
| Catalog in Postgres | 34,304 tracks; 26,404 samples, all `published` (25,638 sampled, 599 interpolated, 144 covered, 23 remixed); 1,726 segments; 26,579 assertions; 14,477 artists; 17,081 works; 55,320 identifiers. |
| API server | **Stopped.** Start it with `npm run dev -w backend` from the repo root (it listens on `http://localhost:4000`). |
| Backend tests | **33/33 pass** (9 suites), re-run while writing this. `npm run typecheck` and `npm run lint` are clean. |
| Swift client tests | **8 pass, 1 skipped** (the live-server test, which needs `SAMPLE_GRAPH_URL`), re-run while writing this. |
| Frontend | Scaffold only: one page that checks `/health`. None of the "interactive discovery" UI has been built. |
| Sinc: derivative identity fix | Done, **uncommitted**. Python suite **293/293 pass**, re-run while writing this. The strict catalog audit passed on the rebuild during the session. |
| Sinc: online catalog wiring | Done and verified on the stale base (137/137 XCTests, simulator end to end), **uncommitted**. **Must be ported to Generations** (§7). |
| Sinc catalog v17 | Not built from final sources and not published; that's the user's job (§9). |
| Hosting (API, repo, DB) | Nothing hosted. |

---

## 3. Machine and toolchain

- **Hardware and OS:** Intel Mac (x86_64), macOS 26.7 (build 25G229), Darwin 25.6.0. Shell is zsh.
- **JavaScript:** Node v26.0.0, npm 11.12.1. The repo says `engines.node >=22.13`, because the importer uses `node:sqlite` and `process.loadEnvFile`.
- **Apple toolchain:** Swift 6.3.2, Xcode 26.5 (17F42), xcodegen at `/usr/local/bin/xcodegen`.
- **Docker:**
  - Colima 0.10.3 at `/usr/local/bin/colima`, installed with Homebrew. It was started with `colima start --vm-type vz --cpu 2 --memory 4 --disk 30`: runtime docker, virtiofs mounts, socket `~/.colima/default/docker.sock`.
  - The Docker CLI 29.8.1 is a static binary at `~/.local/bin/docker`, with Compose v5.5.1 at `~/.docker/cli-plugins/docker-compose`. `~/.zshrc` line 1 adds `~/.local/bin` to `PATH`; non-login shells may need `export PATH="$HOME/.local/bin:$PATH"`.
  - `~/.docker/config.json` has `currentContext: colima`.
  - If Docker commands fail after a reboot, run `colima start` first.
- **Simulators:** iPhone Air `C78D4611-DAFD-4AF4-A937-61C8280F5CF4` (used for verification) and iPhone 17 `455F2402-7FAA-40C8-9286-4C51F16E2FA7` are booted. Sinc's own picker is `python3 ci_scripts/select_simulator.py`.
- **Sinc's pinned catalog:** `Sincapp/Sinc/Resources/samples.sqlite` is gitignored and pinned by `catalog.lock.json` (v16, `https://github.com/rxcid/sinc-catalog/releases/download/catalog-v16/samples.sqlite`). It's fetched with `python3 tools/fetch_catalog.py`.

---

## 4. music-sample-graph in depth

### 4.1 Commits (branch `main`)

| Commit | When (-0400) | Message | Contents |
|---|---|---|---|
| `c6a8e0d` | 18:20 | Scaffold the Music DNA store for Sinc | Monorepo, Compose, Drizzle schema and migration, `identity.ts` with the normalization port and vectors, `import-sinc.ts`, frontend scaffold |
| `45257de` | 18:36 | Add the v1 catalog API | resolve, track, relationships, siblings, search; TypeBox schemas; OpenAPI; the test DB and fixtures; route tests |
| `c5ef9cf` | 18:57 | Add lineage and a generated Swift client | `/lineage`, OpenAPI post-processing, `clients/swift` (generator plugin, wrapper, recorded fixtures), the export scripts |
| `72ddc2c` | 19:14 | Let the Swift client take a URLSession | `SampleGraphClient.init(serverURL:session:)`, which Sinc needed for short timeouts |
| (next) | ~19:35 | Add a handoff for continuing this work in Codex | `HANDOFF.md`, `AGENTS.md`; documentation only |

### 4.2 Layout

```
music-sample-graph/
├── package.json              npm workspaces [backend, frontend]; root scripts (§12)
├── package-lock.json
├── tsconfig.base.json        strict, isolatedModules, resolveJsonModule, skipLibCheck
├── docker-compose.yml        postgres:17-alpine, 127.0.0.1:${POSTGRES_PORT:-5432}, volume pgdata, pg_isready healthcheck
├── .gitignore                node_modules, dist, .next, .env/.env.* (!.env.example), .build/, .swiftpm/ …
├── backend/
│   ├── package.json          "type": "module"; scripts in §12
│   ├── tsconfig.json         ES2024, NodeNext, verbatimModuleSyntax, noEmit
│   ├── tsconfig.build.json   emits dist/, excludes *.test.ts and src/test
│   ├── drizzle.config.ts     loads .env itself; schema ./src/db/schema.ts; out ./drizzle; strict
│   ├── drizzle/0000_futuristic_logan.sql   THE ONLY migration (+ meta/_journal.json, 0000_snapshot.json)
│   ├── .env.example          (.env exists locally, gitignored)
│   └── src/
│       ├── server.ts         createDb(env) → buildApp → listen(HOST, PORT); closes the pool on close; SIGINT/SIGTERM
│       ├── app.ts            buildApp({db, corsOrigin, logger}): cors, swagger 3.1, /docs, /openapi.json, /health, error shape, /v1
│       ├── env.ts            loads .env; DATABASE_URL required; HOST=localhost, PORT=4000, CORS_ORIGIN=http://localhost:3000
│       ├── db/client.ts      createDb(url) → { db: drizzle(pool, {schema}), pool }; type Db
│       ├── db/schema.ts      14 tables, 7 enums, relations (§4.4)
│       ├── db/maintenance.ts truncateCatalog(db): TRUNCATE all 14 tables RESTART IDENTITY
│       ├── catalog/identity.ts             normalize() port and id helpers (§4.5)
│       ├── catalog/identity.test.ts
│       ├── catalog/__fixtures__/normalization_vectors.json   copy of Sinc's tools/data/normalization_vectors.json
│       ├── catalog/repository.ts           every read query behind the API (§4.7)
│       ├── api/schemas.ts    TypeBox schemas; a `title` names a component (§4.6)
│       ├── api/v1.ts         the six routes (§4.6)
│       ├── api/v1.test.ts    route tests on the seeded test DB
│       ├── api/openapi.ts    withNamedSchemas, withOptionalDefaults, publicDocument, forSwiftGenerator
│       ├── api/document.ts   SWIFT_CLIENT_SPEC path; openApiDocument() builds the app with a dummy db
│       ├── api/document.test.ts   drift test: the committed Swift openapi.json must equal the generated one
│       ├── scripts/import-sinc.ts            (§4.8)
│       ├── scripts/export-openapi.ts         writes clients/swift/Sources/MusicSampleGraphClient/openapi.json
│       ├── scripts/export-swift-fixtures.ts  records 9 real responses into the Swift test fixtures
│       ├── test/database.ts  setupTestDb(): <db>_test (auto-created, must end in _test), runs migrations
│       └── test/fixtures.ts  seedCatalog(db): a small hand-built graph (§4.9)
├── clients/swift/            SwiftPM package "MusicSampleGraphClient" (§4.10)
└── frontend/                 Next.js 16.3.6 + React 19.2.8 + Tailwind v4 scaffold (§4.11)
```

### 4.3 Environment files

- `backend/.env` exists locally and is gitignored. It contains:
  ```
  DATABASE_URL=postgres://msg:msg@127.0.0.1:5432/music_sample_graph
  HOST=localhost
  PORT=4000
  CORS_ORIGIN=http://localhost:3000
  ```
  `backend/.env.example` is the same, plus a commented-out `SINC_CATALOG=/path/to/samples.sqlite`.
- `frontend/.env.example` has `API_URL=http://localhost:4000`. `frontend/.env.local` does **not** exist; the code falls back to the same default.
- The test DB URL is `TEST_DATABASE_URL`, or `DATABASE_URL` with `_test` appended. Tests refuse to run unless the DB name ends in `_test`, because they truncate tables.
- For a **physical iPhone** to reach the API, set `HOST=0.0.0.0` in `backend/.env`. That exposes the API on the LAN, so do it deliberately.

### 4.4 Database schema (`backend/src/db/schema.ts` is the source of truth)

**Mapping from Sinc's SQLite catalog (schema v6)**, as documented at the top of `schema.ts`:

| Sinc table | Postgres table |
|---|---|
| `graph_nodes` + `recording_metadata` | `tracks` |
| `node_identifiers` | `track_identifiers` |
| `node_aliases` | `track_aliases` |
| `recording_aliases` | `track_name_aliases` |
| `recording_artists` | `track_artists` |
| `recording_contributors` | `track_contributors` |
| `recording_lineage_disclosures` | `track_lineage_disclosures` |
| `artists`, `works`, `work_identifiers`, `recording_works` | `artists`, `works`, `work_identifiers`, `track_works` |
| `graph_edges` (source → parent, destination → child) | `samples` |
| `relationship_details` | `samples.notes` + `sample_segments` |
| `relationship_assertions` | `sample_assertions` |

**Deliberately not imported**, a decision the user accepted: Sinc's legacy `songs`/`samples` tables, `catalog_revisions` and the edge change history, review-case status, and `graph_nodes.cluster_id`. §7 explains why `cluster_id` now matters again.

**Enums:**

| Enum | Values |
|---|---|
| `track_kind` | song, film, tv, comedy, speech |
| `relationship_type` | sampled, interpolated, covered, remixed (mirrors `MusicDNARelationshipType`) |
| `sample_type` | direct, looped, chopped, pitch_shifted, time_stretched, filtered, layered (how the audio was treated) |
| `sample_status` | observed, candidate, reviewed, verified, **published**, rejected, disputed. Only `published` is ever served. |
| `assertion_status` | imported, inferred, community_submitted, reviewed, corroborated, verified, disputed |
| `identifier_namespace` | musicbrainz_recording, isrc, iswc, apple_music, spotify, acrcloud, audd, acoustid |
| `lineage_classification` | human, ai_assisted, ai_generated, unknown |

**Tables.** Integer identity PKs are for joins only. `canonical_id` is the public id and uses Sinc's own format, so ids from the bundled catalog work against the API unchanged.

- **`tracks`**
  - Columns: id, canonical_id (unique), identity_key (unique), kind (default song), title, artist_credit, norm_title, norm_artist, release_year (smallint), duration_ms (check > 0), disambiguation, is_video, created_at, updated_at.
  - Index `tracks_norm_idx (norm_title, norm_artist, kind)`.
- **`track_identifiers`**
  - Columns: track_id, namespace, identifier, source.
  - Unique on (track_id, namespace, identifier); lookup index on (namespace, identifier).
  - A partial unique index makes a MusicBrainz recording id belong to exactly one track. ISRCs are *not* unique across tracks.
- **`track_aliases`**
  - Columns: track_id, title, artist_credit, norm_title, norm_artist, source.
  - Unique on (track_id, norm_title, norm_artist); index on (norm_title, norm_artist).
- **`track_name_aliases`**: track_id, name, locale, alias_type, is_primary, source.
- **`track_artists`**: track_id, artist_id, position, credited_name, join_phrase.
- **`track_contributors`**: track_id, contributor_name, artist_id (nullable), role, credited_name, position, source, source_url, confidence.
- **`track_works`**: track_id, work_id, relationship_type (text, default "performance"), source.
- **`work_identifiers`**: work_id, namespace, identifier, source.
- **`track_lineage_disclosures`**: track_id, classification, source, source_url, evidence_text, confidence.
- **`artists`**: canonical_id, musicbrainz_artist_id (unique), name, sort_name.
- **`works`**: canonical_id, musicbrainz_work_id (unique), title, work_type, disambiguation.
- **`samples`** (the edge)
  - Columns: id, canonical_id (unique, `edge_…`), parent_track_id (source), child_track_id (destination), relationship_type, status (default candidate), confidence (0..1), notes.
  - Unique on (parent, child, relationship_type), plus a **check that parent ≠ child**.
  - Index on (child_track_id, relationship_type) and index on status.
- **`sample_segments`**
  - Columns: sample_id, element, timestamp_parent (**ms**), timestamp_child (**ms**), duration_ms, sample_type, pitch_shift_semitones, tempo_ratio, is_reversed, is_looped.
  - Unique with NULLS NOT DISTINCT; checks: duration > 0, tempo_ratio > 0.
  - Sinc stores seconds; the importer multiplies by 1000.
- **`sample_assertions`**: sample_id, source_name, source_kind, source_record_id (default ''), source_url, evidence_text, verification_status, confidence. One row per source claim.

**Migrations:** only `0000_futuristic_logan.sql`. A `0001` migration that created a `track_versions` view was made during the session, then **deleted** along with its applied row in `drizzle.__drizzle_migrations` (§10). `drizzle.__drizzle_migrations` now has exactly one row, hash `6f59401c…`.

### 4.5 Identity and normalization (`backend/src/catalog/identity.ts`)

- `NORMALIZATION_VERSION = "2"`. The importer refuses a catalog whose `catalog_metadata.normalization_version` differs.
- `normalize(input)` is a **byte-for-byte parity port** of Sinc's Python `normalize()` in `tools/build_db.py`, which also has a Swift twin in the app:
  - lowercase using `toLowerCase`, which handles Final_Sigma like Python;
  - drop bracketed segments;
  - keep `\p{L}\p{N}` alphanumerics and treat Python's whitespace set as separators;
  - fall back to symbols when nothing alphanumeric is left;
  - Python-compatible combining-mark handling, via NFD reordering checks against U+0334 and U+0308.
- **Never paste raw U+2028, U+2029, U+0308 or U+0334 characters into this file.** Write them as escapes; raw ones broke the regex once already.
- Other exports:
  - `normalizeIdentifier(value)` is for ISRCs and similar ids;
  - `versionKey(title)` is `normalize()` without dropping brackets;
  - `canonicalId(prefix, ...parts)` is `${prefix}_${sha256(parts.join("\x1f"))}`;
  - `type TrackKind`;
  - `textIdentity(kind, title, artist, version?)` returns `text:<kind>:<norm_title>:<norm_artist>[:version:<v>]`.
- Identity keys come in two forms: `mb:recording:<mbid>` (canonical id `node_mb_<mbid>`) and `text:…` (canonical id `node_<sha256>`). Edge ids are `edge_…` and artist ids `artist_mb_…`.
- Tests in `identity.test.ts`:
  - every vector in `__fixtures__/normalization_vectors.json` must pass;
  - a **drift check** requires the fixture to equal `$SINC_DIR/tools/data/normalization_vectors.json`, where `SINC_DIR` defaults to `../Sincapp`. It is skipped when there's no Sinc checkout.
  - node and edge ids must reproduce values that Sinc's Python wrote, including a versioned derivative.

### 4.6 The API: `/v1`, OpenAPI 3.1

App-level behaviour (`app.ts`):

- `GET /health` returns `{status:"ok", database:"up"}`. When the database is down it returns 503 with `{status:"degraded", database:"down"}`.
- `GET /docs` serves Swagger UI and `GET /openapi.json` serves the public document; both are passed through `publicDocument()`.
- CORS origin is `env.CORS_ORIGIN`.
- **Every error has one shape:** `{ "error": { "code": string, "message": string } }`. The codes are:
  - `invalid_request` (400): schema validation, or resolve called without the right params;
  - `track_not_found` (404);
  - `not_found` (404): unknown route;
  - `request_failed`: other 4xx;
  - `internal_error` (500), which is logged.
- `operationId`s are **stable names** for the generated clients; don't rename them.

The routes, all under `/v1`. `:id` is a track `canonical_id`, such as `node_…` or `node_mb_<mbid>`.

| operationId | Route | Query (defaults) | Returns |
|---|---|---|---|
| `resolveTrack` | `GET /tracks/resolve` | `isrc?`, `title?`, `artist?`, `kind?` (default `song`). Needs `isrc`, or both `title` and `artist`, else 400. | `Resolution { matchedBy: "isrc" \| "title_artist" \| null, tracks: TrackSummary[] }` |
| `getTrack` | `GET /tracks/:id` | — | `TrackDetail`: summary plus identifiers, artists (`ArtistCredit`), contributors, works (with ISWCs), lineage disclosures, versions (other recordings of the song) |
| `getRelationships` | `GET /tracks/:id/relationships` | `limit` 1–200 (50), per direction | `Relationships { sources: RelationshipPage, derivatives: RelationshipPage }`, where a page is `{ total, items: Relationship[] }` |
| `getLineage` | `GET /tracks/:id/lineage` | `direction` `sources`\|`derivatives` (sources), `depth` 1–5 (3), `rootLimit` 1–50 (10), `childLimit` 1–20 (4). `maxNodes` is fixed at 500. | `Lineage { direction, truncated, nodes: LineageNode[] }` |
| `getSiblings` | `GET /tracks/:id/siblings` | `perSource` 1–100 (12), `sources` 1–20 (4) | `Siblings { groups: SiblingGroup[] }`, where a group is `{ source, total, tracks }` |
| `searchTracks` | `GET /search` | `q` (1–200 chars), `limit` 1–100 (24) | `SearchResults { tracks: TrackSummary[] }` |

The main schemas, from `api/schemas.ts`:

- **`TrackSummary`**: `id`, `kind`, `title`, `artistCredit`, `releaseYear?`, `isrc?` (the first one), `musicbrainzRecordingId?`.
- **`Relationship`**: `id` (`edge_…`), `relationshipType`, `source` (the original), `destination` (the song that uses it), `notes?`, `segments[]`, `provenance`.
  - The field is `relationshipType`, not `type`: the Swift generator turned `type` into `_type`.
- **`Segment`**: `element?`, `atInSourceMs?`, `atInDestinationMs?`, `durationMs?`, `sampleType?`, `pitchShiftSemitones?`, `tempoRatio?`, `isReversed?`, `isLooped?`.
- **`Provenance`**: `sources[]`, `sourceKinds[]`, `assertionCount`, `isVerified`, `isInference`, `confidence?`, `evidenceExcerpt?`, `evidenceUrl?`.
- **`LineageNode`**: `id` ("0" is the root, "0.2" is the root's third child), `parentId?`, `depth`, `track`, `relationship?` (the edge to the parent), `hiddenChildCount`, `isCycle`. **Nodes come depth-first, and every node follows its parent.**

The OpenAPI pipeline, in `api/openapi.ts`:

- **`withNamedSchemas`** hoists every schema that has a string `title` under `paths` into `components.schemas` and leaves a `$ref` in its place. It **throws** if two different schemas share a title.
  - @fastify/swagger rewrites `examples` to `example` everywhere except inside `anyOf`. A `TrackId` with `examples` once produced two different "TrackSummary" schemas, so **don't add `examples` to shared schemas.**
- **`withOptionalDefaults`**: query params that have a `default` become `required: false`. Without it, the Swift client required them.
- **`publicDocument`** applies both of the above and is what the server serves.
- **`forSwiftGenerator`** turns `anyOf: [T, {type:"null"}]` properties into optional `T`. Without it, swift-openapi-generator reports "Schema null is not supported" and **drops those properties**. The wire format doesn't change, because Codable decodes an explicit null to nil.
- **`StringEnum`** in `schemas.ts` is `Type.Enum(values, {...opts, type:"string"})`. Without `type`, Swift generated `OpenAPIValueContainer` instead of a Swift enum.

### 4.7 Query semantics (`backend/src/catalog/repository.ts`)

Each query mirrors a `SampleDatabase` query in Sinc's (pre-Generations) `Models.swift`.

- **The "song" rule.** A song is every recording with the same `(norm_title, norm_artist, kind)`, plus every recording that shares an ISRC with one of them. `songRoots(db, Map<key, trackIds>)` runs this in a batch with one SQL statement (`unnest` → `same_isrc` → a join on the norm keys); `songRoot(db, ids)` is the single-root form.
  - An earlier hypothesis was that Sinc's `cluster_id` (versions grouped by shared work, artist and title) adds something. On catalog v16 it **only ever grouped recordings that already share a name**, so the name rule subsumes it. That was measured, not assumed; see §10.
  - Upstream Generations is now built on clusters again (§7).
- **`resolveTracks`** matches only an ISRC or an exact normalized title and artist:
  - an ISRC match (after `normalizeIdentifier`) wins outright;
  - otherwise it matches on exact `norm_title` + `norm_artist` + `kind`;
  - otherwise it returns `matchedBy: null` with no tracks.
  - It does **no fuzzy matching, no alias lookup and no MBID lookup**; see §8.
- **`findTrackId`** looks up the canonical_id and returns the internal id or null.
- **`chooseRelated(db, roots, directions, limit)`** (internal) picks the relationships to show for each keyed root and direction:
  - only `status = 'published'` edges;
  - edges between two recordings of the same root are hidden, because they're the song related to itself;
  - it keeps **one edge per (key, direction, relationship_type, other song's norm_title, norm_artist and kind)**;
  - the kept edge is the one with a segment that has an `element`, then one with `notes`, then the lowest id;
  - it orders by `lower(other.title), other.id`, reports `total` before the limit, and returns rows up to `limit`.
- **`loadRelationships(db, edgeIds)`** fetches both tracks' summaries, the segments, and provenance aggregated from assertions (via LATERAL).
- **`relationships(db, rootIds, limit)`** combines both directions for the whole song root.
- **`lineage(db, trackId, {direction, maxDepth, rootLimit, childLimit, maxNodes})`** mirrors Sinc's old `LineageBuilder`:
  - It's a breadth-first walk, one generation per loop iteration. Each generation makes one `songRoots` call and one `chooseRelated` call.
  - Only `kind = 'song'` nodes are expanded; film, TV, comedy and speech are leaves.
  - Each node carries its **path set**, which holds every recording of every song root on the way back to the root. A child already in the path becomes a leaf with `isCycle`.
  - The root shows up to `rootLimit` children, other nodes up to `childLimit`. The rest are counted in `hiddenChildCount`.
  - At `depth == maxDepth`, a node's `hiddenChildCount` is its total number of relationships.
  - `maxNodes` (500) caps the tree. Children cut by that cap are counted as hidden, and `truncated = true`.
  - The output is flattened depth-first.
  - Additions beyond Sinc's builder: the `derivatives` direction, the node cap and `truncated`.
- **`siblings(db, rootIds, {perSource, sources})`** finds other songs built from the same sources:
  - it keeps one recording per song (`DISTINCT ON` the name key);
  - it groups them by shared source, busiest first (`dense_rank` by total);
  - `total` is counted before trimming.
- **`search(db, q, limit)`**:
  - it normalizes `q` and splits it into up to 8 tokens; **each token must appear** (`strpos`) in `norm_title` or `norm_artist`;
  - it only returns `kind = 'song'`, one recording per (norm_title, norm_artist), preferring the shortest title;
  - results are ranked by exact title, then title prefix, exact artist, newest release year, title, artist, id.
  - It does sequential scans with no trigram index; that's fine at 34k rows.

### 4.8 The importer: `npm run import:sinc [-- --catalog <path>] [-- --replace]`

- **Source:** `--catalog`, else the `SINC_CATALOG` env var, else `../Sincapp/Sinc/Resources/samples.sqlite`, resolved relative to `backend/src/scripts`. It's read with `node:sqlite` `DatabaseSync` in read-only mode.
- **Checks before reading:**
  - `PRAGMA user_version` must be **6** (`SUPPORTED_SCHEMA_VERSION`);
  - `catalog_metadata.normalization_version` must equal `NORMALIZATION_VERSION` ("2").
- **The load is one Postgres transaction:**
  - Without `--replace`, it refuses to run if `tracks` is non-empty. With `--replace`, it truncates all 14 tables first (`truncateCatalog(tx)`).
  - It copies tables in chunks of 2,000, with an `IdMap` per entity. A reference to an id that wasn't imported throws `ImportError`.
  - It validates every enum value with `member()`; an unknown value fails loudly and names the column.
  - It **skips self-loop edges**: on v16 that's `graph_edges` where source = destination (2 edges), which it reports by canonical id, type and title. It also skips their details and assertions.
  - It **checks the row count of every table** against what it read before committing.
  - After loading, it checks alias normalization drift: every `node_aliases` norm column must equal the TypeScript `normalize()` of its text.
- **Mapping details:**
  - `tracks.artist_credit` comes from `graph_nodes.artist`;
  - duration, disambiguation and is_video come from `recording_metadata`;
  - seconds become ms with `Math.round(s*1000)`.
- **Runtime:** about **32–33 s** on this machine. With `--replace`, TRUNCATE holds an ACCESS EXCLUSIVE lock until commit, so **API reads block for the length of the import.** That's fine locally; see §8 before doing it in production.
- **Last run:** `--replace --catalog <the identity-v2 rebuild>` imported 34,304 tracks, 26,404 samples and 0 self-links.

### 4.9 Tests (`npm test` from the root runs the backend suite)

- The runner is `tsx --test --test-concurrency=1 "src/**/*.test.ts"`. Concurrency is 1 because the suites share the `_test` database.
- There are 33 tests in 9 suites:
  - identity and normalization;
  - the OpenAPI drift test (`document.test.ts`), which fails if `clients/swift/.../openapi.json` wasn't regenerated after an API change;
  - the OpenAPI named-schema test;
  - route tests in `v1.test.ts`: resolve, track, relationships, lineage outline and options, the budget and truncation, cycles, siblings, search and errors.
- `test/fixtures.ts` `seedCatalog()` builds a small graph:
  - *Funky Break* and *Funky Break Pt. 1*, which share an ISRC and so form one song;
  - *City Anthem* and its *Radio Edit*;
  - *Night Drive*;
  - *Late Echo*;
  - an *Unreviewed Claim* edge with `candidate` status, which must never appear;
  - *Famous Speech*, a speech-kind leaf;
  - *Loop One* ↔ *Loop Two*, a cycle.

### 4.10 The Swift client (`clients/swift`)

- **`Package.swift`:**
  - swift-tools 6.0; platforms iOS 17 and macOS 14; library `MusicSampleGraphClient`.
  - Dependencies: swift-openapi-generator ≥ 1.13.1 (as a **build plugin**), swift-openapi-runtime ≥ 1.12.1, swift-openapi-urlsession ≥ 1.3.1, and swift-http-types ≥ 1.0.0 (tests only, for `HTTPTypes`).
  - `Package.resolved` is committed.
- **Generator config** (`Sources/MusicSampleGraphClient/openapi-generator-config.yaml`): `generate: [types, client]`, `accessModifier: public`, `namingStrategy: idiomatic`.
- **`Sources/MusicSampleGraphClient/openapi.json`** is generated by `npm run openapi`, which outputs `forSwiftGenerator(publicDocument(spec))`. **Never hand-edit it.**
- **Wrapper** (`SampleGraphClient.swift`):
  - `SampleGraphClient` has `init(serverURL:transport:)` and `init(serverURL:session:)`.
  - Its methods are `resolve(isrc:title:artist:kind:)`, `track(id:)`, `relationships(id:limit:)`, `lineage(id:direction:depth:rootLimit:childLimit:)`, `siblings(id:perSource:sources:)` and `search(_:limit:)`.
  - Error statuses map to `SampleGraphError { statusCode, code, message; isNotFound }`. The generated error body type is `Components.Schemas._Error`.
  - Helpers:
    - `Components.Schemas.Lineage.tree` rebuilds a `Tree { node, children }` from the flat depth-first nodes.
    - `Segment.atInSource`, `atInDestination` and `duration` convert ms to `TimeInterval` seconds.
- **Tests** (Swift Testing):
  - `RecordedTransport` replays a fixture and `#expect`s that the request path equals the recorded URL.
  - `SampleGraphClientTests` has 8 tests.
  - `LiveServerTests` runs only when `SAMPLE_GRAPH_URL` is set. It passed against the real catalog during the session.
- **Fixtures** (`Tests/MusicSampleGraphClientTests/Fixtures/*.json`, 9 files) are real responses recorded by `npm run openapi:fixtures`: resolve, resolve-invalid, track, track-not-found, relationships, lineage, lineage-derivatives, siblings and search. Each holds url, status and body.
- **Workflow when the API changes:** run `npm run openapi`, then `npm run openapi:fixtures` (needs the DB), then `cd clients/swift && swift test`, then `npm test`, whose drift test must pass.
- **Plugin trust:** Xcode asks once to trust the generator plugin. Command-line builds need `-skipPackagePluginValidation`. Xcode Cloud needs `defaults write com.apple.dt.Xcode IDESkipPackagePluginFingerprintValidatation -bool YES` (Apple's misspelling) in `ci_post_clone.sh`. **That line has not been added to Sinc yet.**

### 4.11 The frontend (`frontend/`)

- It's Next.js 16.3.6 with the App Router, React 19.2.8, Tailwind v4 and eslint-config-next.
- `src/app/page.tsx` is a server component that calls `connection()` and fetches `${API_URL}/health` with a 2 s timeout. It shows API and database status dots. **That's the whole UI.**
- `frontend/AGENTS.md` and `CLAUDE.md` were written by `next dev`. They warn that Next 16 has breaking changes and point to `node_modules/next/dist/docs/`. Read those before writing frontend code.

---

## 5. The Sinc changes in depth (all uncommitted, on branch `sinc` at `67d3cfd`)

```
 M Sinc/DemoConfiguration.swift      (+2)
 M Sinc/Info.plist                   (+5)   regenerated by xcodegen from project.yml
 M Sinc/Views/BetaLabView.swift      (+30)
 M Sinc/Views/LineageGraphView.swift (+1 −6)
 M project.yml                       (+11)
 M tools/build_db.py                 (+85 −11)
?? Sinc/OnlineCatalog.swift          (new, 155 lines)
?? SincTests/OnlineCatalogTests.swift (new, 135 lines)
?? tools/tests/test_derivative_identity.py (new)
```

`Sinc.xcodeproj` was regenerated by `xcodegen generate`; it's gitignored. `.build/DerivedData` is the derived-data path used for command-line builds.

The files form **two logical changes**, which should become two separate commits.

### 5.A Derivative identity fix: `tools/build_db.py` and `tools/tests/test_derivative_identity.py`

- **The problem.** `normalize()` drops bracketed text, so two curated remixes collapsed into their own originals. The results were self-referencing `remixed` edges:
  - "Survivalism (deadmau5 remix)" → "Survivalism" (Nine Inch Nails);
  - "State of Independence (1996 remix)" → "State of Independence (1982 recording)" (Donna Summer).
- **The fix leaves `normalize()` alone:**
  - `IDENTITY_VERSION = 2` is new. It's added to the `catalog_revision_id` material as `identity:2` and written to `catalog_metadata.identity_version`. The same inputs now produce a **new revision** because the node and edge rules changed.
  - `version_key(title)` is `normalize()` with brackets turned into spaces, so the qualifiers are kept.
  - `derivative_version(entry)` returns the entry's version key **only** when the entry derives from a recording it would otherwise merge with and the two version keys differ. Only the derivative is versioned. The original keeps its plain text identity, canonical id and edges.
  - `insert_node(..., version=None)`: a versioned node gets identity key `text:<kind>:<nt>:<na>:version:<v>` and canonical id `canonical_id("node", kind, nt, na, v)`.
  - The MusicBrainz "claim an unclaimed text node" query now matches `node.identity_key = ?`, the exact text identity, instead of the norm columns. That keeps an MBID from moving between an original and its versioned derivative.
  - The destination node is inserted with `version=derivative_version(e)`.
  - There's a **self-loop guard**. If a source and destination still resolve to one node (identical titles), the edge is skipped, recorded in `self_references`, and printed to stderr as `skipped self-referencing relationship: …`.
- **The test file has 7 tests:**
  - `test_version_key_keeps_what_normalize_drops`;
  - `test_only_a_derivative_of_a_merged_recording_is_versioned`;
  - `test_identity_rules_are_part_of_the_revision`;
  - `test_remix_of_its_own_original_is_a_separate_node`;
  - `test_the_original_keeps_its_canonical_id`;
  - `test_a_musicbrainz_id_for_the_original_claims_the_original`;
  - `test_an_indistinguishable_self_reference_is_skipped_and_reported`.

  They build small fixture catalogs, so they hold before and after the next release.
- **Verification:** `python3 -m unittest discover -s tools/tests` ran **293 tests, OK**, re-run while writing this. During the session, `python3 tools/catalog_audit.py <rebuild> --strict` exited 0. The rebuild changed **only the 2 remix nodes and their 2 edges** compared with v16; all other history is identical.
- **How the rebuild was made.** `build_db.main()` appends a revision to an existing DB's history, so the pinned catalog is copied first:
  ```bash
  cp Sinc/Resources/samples.sqlite /tmp/sinc-rebuild/samples.sqlite
  python3 - /tmp/sinc-rebuild/samples.sqlite <<'EOF'
  import sys; from pathlib import Path
  sys.path.insert(0, "tools"); import build_db
  build_db.OUT = Path(sys.argv[1]); sys.exit(build_db.main())
  EOF
  python3 tools/catalog_audit.py /tmp/sinc-rebuild/samples.sqlite --strict
  ```
  Run it from `/Users/rxcid/xprojects/Sincapp`. Prefer `docs/CATALOG_OPERATIONS.md`'s official procedure when making a real release.
- **Upstream conflict risk:** none. `origin/sinc` doesn't touch `build_db.py` or this test. The ideas overlap with upstream's `tools/identity_review.py` ("Keep remixes apart from their originals in the identity review") and with `SongIdentity.isRemix`; reconcile them conceptually (§7.4).

### 5.B Online catalog wiring, on the pre-Generations lineage screen

- **`Sinc/OnlineCatalog.swift`** (new):
  - `enum OnlineCatalog`:
    - `Keys.enabled = "SincOnlineCatalogEnabled"` and `Keys.serverURL = "SincOnlineCatalogServerURL"`, both in UserDefaults;
    - `defaultServerURL = "http://localhost:4000"`;
    - `isEnabled` is `DemoConfiguration.usesOnlineCatalog || (PrivateBetaProgram.isAvailable && UserDefaults.bool(enabled))`, so **App Store builds can never turn it on**. `PrivateBetaProgram.isAvailable` means a DEBUG build or a sandbox receipt, such as TestFlight.
    - `serverURL` is the stored value, or the default when empty;
    - `lineageSource` is nil unless enabled;
    - `lineage(for: LineageTrack, online:) async -> LineageNode` tries online first. **On an error or a nil result**, it falls back to `SampleDatabase.shared.lineage(title:artist:year:kind:)` and logs through `Logger(subsystem: "com.robduckett.sinc", category: "OnlineCatalog")`.
  - `protocol OnlineLineageSource: Sendable { func lineage(for:) async throws -> LineageNode? }`.
  - `struct SampleGraphLineageSource`:
    - it uses a `URLSession` with `timeoutIntervalForRequest = 5` and `timeoutIntervalForResource = 10`;
    - it uses `track.catalogRecordingID` directly if it's there, otherwise `api.resolve(isrc:title:artist:kind:)` and the first match (nil if none);
    - then it calls `api.lineage(id:)`, then `.tree.map(LineageNode.init(online:))`.
  - Mapping extensions:
    - `LineageNode(online:)`, with ids `"online:<node.id>"`;
    - `LineageTrack(online:)`, where `catalogRecordingID = track.id`;
    - `SampleSource(online:)`, which prefers the segment with an `element`, converts times to seconds, and reads the relationship from the destination's point of view (source = original).
- **`Sinc/Views/LineageGraphView.swift`:** `.task(id: track.id)` now does `graph = await OnlineCatalog.lineage(for: track)`. **Upstream deletes this file.**
- **`Sinc/DemoConfiguration.swift`:** adds `static let usesOnlineCatalog = flag("--online-catalog")`. Upstream edits the neighbouring line (`opensLineage` becomes `opensGenerations`), so expect a small textual conflict.
- **`Sinc/Views/BetaLabView.swift`:**
  - a new "Catalog" section with an "Online catalog" toggle (`@AppStorage(Keys.enabled)`);
  - when the toggle is on, a monospaced "Server" `TextField` (`@AppStorage(Keys.serverURL)`);
  - a footer explaining the fallback, and that a phone needs the Mac's LAN address.
- **`project.yml`:**
  - a `packages:` block with the local-path `MusicSampleGraphClient` and a warning comment about Xcode Cloud;
  - the `Sinc` target depends on `- package: MusicSampleGraphClient`;
  - Info adds `NSAppTransportSecurity: { NSAllowsLocalNetworking: true }`, which allows plain HTTP to local hosts only.
- **`Sinc/Info.plist`:** the generated ATS dictionary.
- **`SincTests/OnlineCatalogTests.swift`** (XCTest, 5 tests):
  1. mapping of an API lineage (Late Echo ← Funky Break (+2 hidden) ← Late Echo as a cycle, with a drums segment preferred);
  2. the online answer is preferred;
  3. fallback on a server error (`URLError(.cannotConnectToHost)`);
  4. fallback when the server doesn't know the song (nil);
  5. off until switched on in the Beta Lab.

  The fallback tests use the demo song "Power Trip" by "Lecrae feat. PRo, Sho Baraka & Andy Mineo".
- **Verification, on the stale base:**
  - `xcodegen generate`;
  - `xcodebuild test -project Sinc.xcodeproj -scheme Sinc -destination "id=$(python3 ci_scripts/select_simulator.py)" -skipPackagePluginValidation -derivedDataPath .build/DerivedData` executed **137 tests, 0 failures**, including the 5 new ones;
  - simulator end to end, on the iPhone Air, with `xcrun simctl launch --terminate-running-process <SIM> com.robduckett.sinc --lineage-demo --open-lineage --online-catalog` and the API running:
    - the app called `GET /v1/tracks/resolve?…Power Trip…` (93 ms), then `GET /v1/tracks/node_mb_fbfd690d-7b9d-43ce-bd5d-a2cf1e5ad948/lineage` (446 ms), and drew **7 links across 2 generations**;
    - tapping *Juicy* made **one** lineage request by catalog id (`node_a445b808dcac9e05bec13590d1f93af1ddebf0622af168b50aeab60f25e2e286`), with no resolve;
    - with the API **stopped**, the app logged "Online lineage failed; using the bundled catalog" and drew the same 7 links from the bundled catalog.
- **Cosmetic differences between online and offline:**
  - child order: the API sorts by `lower(title), id`, which Sinc's builder didn't do;
  - some artist credits: one side showed "Dexter Wansel" and the other "Dexter Wansel & H. Smith". The API uses `graph_nodes.artist`, while the offline lineage uses the sample row's `originalArtist`.

---

## 6. Verification record

| Check | Result | When |
|---|---|---|
| `npm run typecheck` (both workspaces) | clean | re-run at handoff |
| `npm run lint` (frontend eslint) | clean | re-run at handoff |
| `npm test` (backend) | 33 pass, 0 fail, 9 suites, ~4.4 s | re-run at handoff |
| `swift test` in `clients/swift` | 8 pass, 1 skipped (live) | re-run at handoff |
| Live Swift test against the real catalog | pass | during the session |
| Sinc `python3 -m unittest discover -s tools/tests` | 293 OK | re-run at handoff |
| Sinc `catalog_audit.py --strict` on the rebuild | exit 0 | during the session |
| Sinc `xcodebuild test` (full suite) | 137 tests, 0 failures | during the session, on `67d3cfd` plus the uncommitted work; the tree hasn't changed since |
| Simulator end to end, online and fallback | pass | during the session, on `67d3cfd` |
| Patch backups match the working tree | `git apply --check --reverse` OK | at handoff |

---

## 7. P0: reconcile Sinc with `origin/sinc` and port the online path to Generations

### 7.1 What upstream changed (`git diff --stat 67d3cfd origin/sinc`: 43 files, +6645 −1531)

The 8 commits, oldest first:

| Commit | Message |
|---|---|
| `22e1d5e` | Show every scanned song's Music DNA and stop overstating the catalog |
| `ead5038` | Record the Music DNA trust pass and the empty-DNA known issue |
| `c3c2dcf` | Correct the duplicate-identity count in the roadmap |
| `4df86e7` | Date the catalog by first release and queue identity work for review |
| `1315a56` | Key identity review items by rebuild-stable catalog ids |
| `d3e8dc5` | Show MusicBrainz canonical grouping as evidence in the identity review |
| `2db07df` | Keep remixes apart from their originals in the identity review |
| `b2e8f86` | Replace the ancestry tree with Generations |

What these commits mean for this work:

- **Generations model** (`Sinc/Generations.swift`):
  - `GenerationsRecording {nodeID, clusterID, canonicalID, title, artist, year, kind, isrc, musicBrainzRecordingID; var track: LineageTrack}`;
  - `GenerationsHandoff {source/destination nodeID and clusterID, type}`. The handoff types are **sampled, interpolated and remixed**; covers are not handoffs.
  - `protocol GenerationsCatalog { handoffs(into: clusterID), handoffs(outOf: clusterID), recordings(inClusters:) }`;
  - `GenerationsRecord {id, track, earliestYear, handoffTypes, connectedTitles, alsoFromTitles}`;
  - `Generation {role: .before | .thisSong | .sameGeneration | .after, offset (-1 = what it was built from, +2 = two handoffs after, 0 = the same generation), records, gapFromPrevious}`;
  - `GenerationsFamily {root, generations, hasMoreBefore, hasMoreAfter, …, story}`;
  - `GenerationsBuilder {catalog; maxClusters = 1_500; build(rootRecordings:)}`. It walks before (-1) and after (+1), places the same generation (other destinations of the first "before" level), and composes records with a `RecordComposer`.
- **The catalog side** is in `Models.swift` on `origin/sinc`:
  - `SampleDatabase.generations(for: LineageTrack) -> GenerationsFamily?` resolves its roots in this order: canonical id, then ISRC or MusicBrainz id, then title and artist. All title matches are kept.
  - `extension SampleDatabase: GenerationsCatalog` uses **`COALESCE(n.cluster_id, -n.id)`** as the cluster, so an unclustered node stands for itself by its negated id.
- **The UI:** `GenerationsView.swift` has `enum GenerationsLoader { static func family(for:) async -> GenerationsFamily? }`, which runs on `Task.detached`. `MatchResultView` also calls `GenerationsLoader.family(for: rootTrack)`.
- **`Sinc/SongIdentity.swift`:**
  - `SongIdentity.identity(of: title)` treats version and remix suffix words as a title identity;
  - `SongIdentity.isRemix(_:)`;
  - parity vectors are in `tools/data/song_identity_vectors.json`, with parity tests in Swift and Python.
- `DemoConfiguration.opensGenerations = flag("--open-generations") || flag("--open-lineage")`.
- `project.yml` adds `tools/data/song_identity_vectors.json` as a SincTests resource.

### 7.2 Mechanical reconciliation (ask the user before each commit)

1. In `/Users/rxcid/xprojects/Sincapp`, create a branch from the current HEAD and commit the two logical changes separately:
   ```bash
   git switch -c online-catalog            # name is a suggestion; ask the user
   git add tools/build_db.py tools/tests/test_derivative_identity.py
   git commit -m "Give remixes that normalize like their originals their own nodes"
   git add Sinc/OnlineCatalog.swift SincTests/OnlineCatalogTests.swift Sinc/DemoConfiguration.swift \
           Sinc/Views/BetaLabView.swift Sinc/Views/LineageGraphView.swift project.yml Sinc/Info.plist
   git commit -m "Try the online catalog for lineage behind a Beta Lab switch"
   ```
   End commit messages with the co-author trailer the user's tooling expects. Claude Code used `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; use whatever attribution applies to Codex.
2. Fast-forward local `sinc` with `git switch sinc && git merge --ff-only origin/sinc`. It's safe because the branch is 0 ahead.
3. Rebase with `git switch online-catalog && git rebase sinc`. Expected results:
   - `tools/build_db.py` and the test: clean.
   - `project.yml`: probably an automatic merge. Upstream added a resources entry under SincTests; ours touches `packages:`, the Sinc target dependencies and Info.
   - `Sinc/DemoConfiguration.swift`: a conflict on adjacent lines. Keep upstream's `opensGenerations` line and add `usesOnlineCatalog`.
   - `Sinc/Views/LineageGraphView.swift`: a **modify/delete conflict**. Resolve it with `git rm Sinc/Views/LineageGraphView.swift`.
   - `Sinc/Info.plist`: regenerate with `xcodegen generate` rather than hand-merging.
4. After the rebase, `OnlineCatalog.swift` and `OnlineCatalogTests.swift` won't compile. Port them as in §7.3, then run `xcodegen generate` and the full `xcodebuild test`.

### 7.3 Porting the online path: recommended design

The API's `/lineage` endpoint answers the question the **old** screen asked. The screen that exists now is Generations, so the API needs a **Generations endpoint** that returns what `GenerationsBuilder` returns.

**Recommended: build the family on the server.**

1. **Get clusters into Postgres.**
   - Add a nullable `cluster_id` column to `tracks`, or a `track_clusters` table, through a new Drizzle migration: edit `schema.ts`, then run `npm run db:generate`, then `npm run db:migrate`.
   - Import it from `graph_nodes.cluster_id` in `import-sinc.ts`. Treat a null cluster as the node standing for itself, as Sinc does with `-id`.
   - This reverses the earlier "left out on purpose" decision for `cluster_id`. Tell the user why: Generations is defined over version clusters.
2. **Port `SongIdentity` to TypeScript** (`backend/src/catalog/song-identity.ts`), with a parity test against `tools/data/song_identity_vectors.json`. Copy the file into `__fixtures__` and add a drift check against the Sinc checkout, as `identity.test.ts` does. The record composer needs it to decide which recordings in a cluster are one record and which are remixes.
3. **Port `GenerationsBuilder` to TypeScript**, including `Placement`, `walk(sign:)`, `RecordComposer`, the gaps and `maxClusters = 1500`.
   - Back it with SQL implementations of `handoffs(into)`, `handoffs(outOf)` and `recordings(inClusters)`.
   - Only `published` edges of type sampled, interpolated or remixed count.
   - Batch the queries per level, like `lineage()` does, rather than making one query per cluster.
   - Upstream loads a whole-catalog handoff index once (`loadGenerationsIndex()`). On the server, either do the same (about 26k edges fit in memory easily; cache it and invalidate it on import) or use per-level SQL.
4. **Add `GET /v1/tracks/{id}/generations`** (operationId `getGenerations`), plus a `resolve`-style variant or reuse of resolve.
   - Its response schema should mirror `GenerationsFamily`. Give every nested schema a `title` so it's hoisted.
   - Compute `story`/`summaryLine` on the client (they're presentation), or return structured data plus the story text. Pick one and keep Swift parity tests.
5. Regenerate: `npm run openapi && npm run openapi:fixtures && (cd clients/swift && swift test) && npm test`.
6. **In Sinc,** replace the lineage parts of `OnlineCatalog`:
   - `OnlineGenerationsSource.family(for: LineageTrack) async throws -> GenerationsFamily?`;
   - `OnlineCatalog.family(for:)`, which tries online first and falls back to `SampleDatabase.shared.generations(for:)`;
   - call it from `GenerationsLoader.family(for:)`, so `GenerationsView` and `MatchResultView` both get it;
   - map API types to `GenerationsFamily`;
   - rewrite `OnlineCatalogTests` around the Generations types, keeping the same four behaviours: mapping, online preferred, fallback on error, fallback on nil. Also keep the switch test.
   - Keep the Beta Lab switch, the `--online-catalog` flag, ATS and the timeouts as they are.

**Alternative:** make an API-backed `GenerationsCatalog` and reuse Sinc's builder unchanged. It's simpler, but the protocol is synchronous and needs a round trip per cluster, so it isn't recommended.

**Keep `/v1/tracks/{id}/lineage`.** It's tested, the web frontend can use it, and removing it isn't needed.

### 7.4 Identity rules to reconcile

The two sides have diverged:

- Sinc upstream: `SongIdentity`, the identity-review tooling, "keep remixes apart", and MusicBrainz canonical grouping.
- This work: `IDENTITY_VERSION = 2` derivative versioning in `build_db.py`, and the API's name-plus-ISRC song rule.

Before the next catalog release, check that versioned derivative nodes (`:version:` identity keys) behave correctly in upstream's `identity_review.py` and `catalog_audit.py`, then run the full Python suite on the merged branch.

---

## 8. Backlog, by priority

### P0

1. **§7.2 reconciliation**, with the user's approval for each commit.
2. **§7.3 port to Generations.** Until that's done, the online catalog does nothing in current Sinc.

### P1

1. **Make the Swift client resolvable outside this Mac.** Pick one option with the user:
   - **(a) A separate public or private repo holding only the client**, for example `rxcid/music-sample-graph-swift`, created with `git subtree split --prefix clients/swift`, with version tags. `project.yml` then uses `url: … from: x.y.z`. Xcode Cloud needs repo access (a GitHub app or SSH key) if the repo is private.
   - **(b) Vendor the client into the Sinc repo** (for example `Sincapp/Packages/MusicSampleGraphClient`), with a sync script in music-sample-graph. It's the fastest route and has no hosting dependency.
   - **(c) Move `Package.swift` to the music-sample-graph repo root**, with `path:` pointing into `clients/swift`. It works, but Xcode then clones the whole JS monorepo.
   - With any option, consider **pre-generating** the Swift sources with the `swift-openapi-generator generate` CLI and committing them, which drops the build plugin. That removes the plugin-trust step and the `defaults write` line, and speeds up builds. If you keep the plugin, add `defaults write com.apple.dt.Xcode IDESkipPackagePluginFingerprintValidatation -bool YES` to `ci_scripts/ci_post_clone.sh` before `xcodegen generate`.
2. **Host the music-sample-graph repo** on GitHub or elsewhere. It has no remote yet. The user decides the name, visibility and license. Add a `README.md` (none exists) and CI (a GitHub Action with a Postgres service that runs typecheck, tests and the OpenAPI drift test; plus `swift test` on macOS).
3. **Improve `resolve`** to match Sinc's order: canonical id, then ISRC or **MusicBrainz recording id** (add an `mbid` query param), then title and artist, then **aliases** (`track_aliases` norm columns). Then consider **fuzzy matching**: `pg_trgm` on `norm_title`/`norm_artist`, with thresholds tuned against the bundled catalog's fuzzy behaviour. Until then, the offline fallback covers the misses.
4. **Catalog v17:** rebuild from the merged branch's sources (upstream changed release-year dating and identity tooling), run the strict audit, **then the user publishes it** (§9). Re-import into Postgres afterwards with `npm run import:sinc -- --replace`, pointing at the local rebuild if it isn't bundled yet.

### P2: productionizing the "online-focused" direction

1. **Deploy the API and Postgres.** Needs:
   - managed Postgres, and `npm run build` plus `node dist/server.js`;
   - running `drizzle-kit migrate` on deploy;
   - TLS (ATS in Sinc only allows plain HTTP to local hosts);
   - `HOST=0.0.0.0` behind a proxy, and restricting `CORS_ORIGIN`.
2. **Auth and abuse control:**
   - an app-scoped key or **App Attest / DeviceCheck** for the iOS client;
   - `@fastify/rate-limit`;
   - request size limits.
3. **Caching:** the catalog changes only on import, so send an `ETag` or `Cache-Control` keyed by the catalog revision id (store it in a `catalog_imports` table at import time).
4. **Zero-downtime import:** import into a staging schema or database and swap, or use `--replace` without TRUNCATE (delete and insert inside the transaction, which is MVCC-friendly). The current TRUNCATE blocks reads for about 33 s.
5. **A Music DNA graph endpoint** for `MusicDNAGraphView`, which fetches one node at a time today. It needs a neighbourhood or batch endpoint.
6. **Frontend:** build the actual discovery UI (search → song → relationships, lineage and generations graph) against `/v1`. Read Next 16's docs in `node_modules/next/dist/docs/` first.
7. **Update Sinc's `ROADMAP.md`.** It still says: *"Architecture decision: stay embedded/offline at the current scale. Revisit a hosted graph service only when…"*. The user now says Sinc should become online-focused, but let the user word the new decision.
8. **Data licensing review before serving the catalog publicly.** `ROADMAP.md` forbids unlicensed live MusicBrainz API use in the commercial client, and some notes and evidence come from Wikipedia text. Confirm attribution and licensing before a public API. **This is the user's decision.**
9. **Before device testing,** consider adding `NSLocalNetworkUsageDescription` to `project.yml` so the local-network permission prompt reads well.

### P3

- Show `truncated` in the UI; add pagination for relationships (the `total` is already returned).
- A trigram index for search if the catalog grows well beyond 34k tracks.
- Artist credit consistency between the API and offline (§5.B).

---

## 9. What only the user can do

1. **Approve the Sinc commits** (§7.2) and choose a branch name. Decide whether and when to push to `git@github.com:rxcid/sinc.git`.
2. **Choose how the Swift client is distributed** (§8 P1-1). If it's a new GitHub repo, create it or authorize creating it, and give Xcode Cloud access if it's private.
3. **Choose hosting for music-sample-graph,** covering the repo, API and database: provider, costs, domain and TLS. Everything deployed or published needs explicit approval.
4. **Publish catalog v17** (a GitHub release on `rxcid/sinc-catalog`, with `samples.sqlite` and `.deflate`), then update `catalog.lock.json` (version, url, sha256, deflateUrl, deflateSha256, deflateBytes). This is outward-facing and irreversible for users.
5. **Make the data licensing and attribution call** before any public API (§8 P2-8).
6. **Update the roadmap's architecture decision** to reflect the online direction (§8 P2-7).
7. For on-device testing: accept the local-network prompt, and allow LAN exposure (`HOST=0.0.0.0`).
8. Keep Colima running (`colima start` after a reboot) whenever the local DB is needed.

---

## 10. Decisions and dead ends: don't redo these

- **Drizzle, not Prisma.** It's SQL-first, schema-in-TS and fits a node:test setup.
- **TypeBox 1.x** comes from the `typebox` package, not `@sinclair/typebox`, and is used with `@fastify/type-provider-typebox` 6.1.
- **Postgres stores ms; Sinc stores seconds.** The API returns ms (`…Ms`), and the Swift helpers convert to seconds.
- **The song rule replaced `cluster_id`.** It was measured on v16: grouping by work, artist and title never linked recordings that the name rule didn't already link. A `track_versions` view and migration 0001 were built, found to be a strict subset, and **removed**, along with the view, the migration files and the `__drizzle_migrations` row. Upstream Generations reintroduces clusters, so revisit this as §7.3 describes rather than resurrecting the view.
- **Self-loops are fixed at the source** (`build_db.py`), not by changing `normalize()`. Changing normalization would break parity for every lookup key, and the app relies on bracket-dropping to find lineage for any pressing.
- **The importer skips self-loops** instead of failing, so the published v16 still imports; it reports them. The DB check constraint forbids them.
- **Only `published` edges are served.** Candidates must never become facts silently.
- **API field `relationshipType`,** not `type`: Swift made the latter `_type`.
- **No `examples` on shared TypeBox schemas** (the hoisting conflict in §4.6).
- **`forSwiftGenerator` is applied only to the Swift copy.** The served `/openapi.json` keeps the precise `anyOf [T, null]` form.
- **The Sinc switch is off by default and gated by `PrivateBetaProgram.isAvailable`,** so production users are never affected. It always falls back to the bundled catalog, so turning it on can only add answers.
- **Short client timeouts** (5 s per request, 10 s per resource) let a slow server hand over to the offline path while the screen still reads as loading.
- **The Next 16 agent-rules block** in `frontend/AGENTS.md` is regenerated by `next dev`. Keep it committed.

---

## 11. Known gaps and caveats

- There are no request logs or metrics beyond Fastify's pino logger, and no auth, rate limiting or caching (§8 P2).
- `resolve` has no fuzzy, alias or MBID matching (§8 P1-3).
- `search` does sequential scans with `strpos`, which is fine at the current size.
- `--replace` blocks readers for about 33 s.
- The frontend is only a health page.
- music-sample-graph has no README, LICENSE or CI.
- There's a local-path SwiftPM dependency in Sinc (§0.4).
- ATS only allows local HTTP. A hosted API must use HTTPS.
- The Sinc XCTest and simulator verification were done on the pre-Generations base (§0.1).
- The session's scratchpad (`/private/tmp/claude-501/…/scratchpad`) may be deleted. Everything worth keeping was copied to `/Users/rxcid/xprojects/codex-handoff/`.

---

## 12. Command cheat sheet

The first block runs from `/Users/rxcid/xprojects/music-sample-graph`.

```bash
export PATH="$HOME/.local/bin:$PATH"   # docker CLI lives here
colima status || colima start          # Docker runtime
npm install                            # if node_modules is missing
npm run db:up                          # docker compose up -d --wait
npm run db:migrate                     # drizzle-kit migrate (db:generate after editing schema.ts)
npm run import:sinc -- --replace       # published v16 from ../Sincapp (skips 2 self-loops)
npm run import:sinc -- --replace --catalog /Users/rxcid/xprojects/codex-handoff/samples-identity-v2-rebuild.sqlite
npm run dev -w backend                 # API on http://localhost:4000 (docs at /docs)
npm run dev                            # API + Next.js (http://localhost:3000) together
npm run typecheck && npm test && npm run lint
npm run openapi && npm run openapi:fixtures
(cd clients/swift && swift test)
(cd clients/swift && SAMPLE_GRAPH_URL=http://localhost:4000 swift test)   # adds the live test
npm run db:studio                      # Drizzle Studio
docker exec -it music-sample-graph-postgres-1 psql -U msg -d music_sample_graph
curl -s 'http://localhost:4000/v1/tracks/resolve?title=Juicy&artist=The%20Notorious%20B.I.G.' | jq
```

The next block runs from `/Users/rxcid/xprojects/Sincapp`.

```bash
python3 -m unittest discover -s tools/tests          # 293 tests
python3 tools/catalog_audit.py <catalog.sqlite> --strict
xcodegen generate
SIM=$(python3 ci_scripts/select_simulator.py)
xcodebuild test -project Sinc.xcodeproj -scheme Sinc -destination "id=$SIM" \
  -skipPackagePluginValidation -derivedDataPath .build/DerivedData
xcodebuild build -project Sinc.xcodeproj -scheme Sinc -destination "id=$SIM" \
  -skipPackagePluginValidation -derivedDataPath .build/DerivedData
xcrun simctl install "$SIM" .build/DerivedData/Build/Products/Debug-iphonesimulator/Sinc.app
xcrun simctl launch --terminate-running-process "$SIM" com.robduckett.sinc --lineage-demo --open-lineage --online-catalog
# after the upstream merge, the flag is --open-generations (--open-lineage still works as an alias)
xcrun simctl spawn "$SIM" log show --last 1m --predicate 'subsystem == "com.robduckett.sinc" AND category == "OnlineCatalog"' --style compact
```

---

## 13. Rules of engagement (from the user and this session)

- **Commit only when the user asks. Never push, publish, deploy, or create remote repos without explicit approval.**
- Ask before downloads, stating the filename, source and size.
- Match the surrounding code: plain names, comments that say *why*, and commit messages written as imperative sentences (look at `git log` in both repos). Don't add abstractions that aren't needed.
- Keep **parity** with Sinc: `normalize()` and `SongIdentity` against the shared vector files, canonical id formats, and the "only published" rule. When Sinc changes one of these, port it and add or refresh the drift test.
- After any API change: regenerate `openapi.json` and the fixtures, run `swift test`, and run `npm test`. The drift test enforces this.
- Never point tests at a DB whose name doesn't end in `_test`.
- Sinc builds from the command line need `-skipPackagePluginValidation`, because of the OpenAPI generator plugin.
- Report outcomes honestly. If something was verified on a stale base, say so.

---

## 14. File index (the fastest way in)

| Want to… | Open |
|---|---|
| Understand a query | `backend/src/catalog/repository.ts` |
| Add or modify an endpoint | `backend/src/api/v1.ts`, `backend/src/api/schemas.ts`, `backend/src/api/v1.test.ts` |
| Change the schema | `backend/src/db/schema.ts`, then `npm run db:generate` (new file in `backend/drizzle/`) |
| Change the import | `backend/src/scripts/import-sinc.ts` |
| Change normalization or ids | `backend/src/catalog/identity.ts` (+ Sinc's `tools/build_db.py` and Swift twin) |
| Adjust the OpenAPI output | `backend/src/api/openapi.ts`, `backend/src/api/document.ts` |
| Use or extend the Swift client | `clients/swift/Sources/MusicSampleGraphClient/SampleGraphClient.swift`, `clients/swift/README.md` |
| See the Sinc wiring | `Sincapp/Sinc/OnlineCatalog.swift`, `Sincapp/SincTests/OnlineCatalogTests.swift`, `Sincapp/project.yml` |
| See the Generations model upstream | `git -C /Users/rxcid/xprojects/Sincapp show origin/sinc:Sinc/Generations.swift`, `…:Sinc/Models.swift` (search `generations`), `…:Sinc/Views/GenerationsView.swift`, `…:Sinc/SongIdentity.swift` |
| Sinc's data contract and catalog procedure | `Sincapp/docs/DATA_PLATFORM.md`, `Sincapp/docs/CATALOG_OPERATIONS.md`, `Sincapp/docs/PRIVATE_BETA.md` |
| Backups | `/Users/rxcid/xprojects/codex-handoff/` (`sinc-derivative-identity.patch`, `sinc-online-catalog.patch`, `PATCH_BASE.txt`, `samples-identity-v2-rebuild.sqlite`) |
