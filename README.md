# Music Sample Graph

A local graph catalog API for Sinc, the iOS app that identifies a
song and explores what it samples, what samples it, and its wider sound family.
The API is built with Fastify, Drizzle, and PostgreSQL. This repository also
contains the Swift client used by Sinc and a Next.js health-page scaffold.
There is no hosted API or complete web discovery UI yet.

The API serves **published** relationships only. Public track and edge IDs use
Sinc's canonical `node_…` and `edge_…` formats, so a track ID from the bundled
Sinc catalog can be used against the API. The catalog data is not stored in this
repository.

## Layout

| Path | Purpose |
| --- | --- |
| `backend/` | `/v1` API, PostgreSQL schema and migrations, Sinc catalog importer, tests |
| `clients/swift/` | Pre-generated Swift package and recorded-response tests |
| `frontend/` | Next.js scaffold with API and database health checks |
| `tools/sync-swift-client.mjs` | Regenerate the Swift client and mirror it into Sinc |

## Run locally

You need Node.js 22.13 or newer, npm, Docker (Colima works on macOS), and a
sibling Sinc checkout with its bundled schema-v6 catalog at
`../Sincapp/Sinc/Resources/samples.sqlite`. Sinc pins the current bundled
catalog in its own `catalog.lock.json`; use Sinc's documented catalog procedure
to obtain it. The current Generations parity fixture uses the bundled v16
catalog.

```sh
npm ci
cp backend/.env.example backend/.env
npm run db:up
npm run db:migrate
npm run import:sinc -- --replace
npm run dev -w backend
```

The API listens at `http://localhost:4000` by default. Open `/docs` for the API
reference, `/openapi.json` for its contract, and `/health` for service status.
Run `npm run dev` to start both the API and the frontend scaffold. Set
`SINC_CATALOG` or pass `--catalog <path>` to `npm run import:sinc -- --replace`
if the SQLite catalog is elsewhere. Import replaces the local catalog tables,
so check `backend/.env` before using it.

The main routes are `GET /v1/tracks/resolve`, `/v1/tracks/:id`,
`/v1/tracks/:id/relationships`, `/v1/tracks/:id/siblings`,
`/v1/tracks/:id/lineage`, `/v1/tracks/:id/generations`, and `/v1/search`.
The `resolve` endpoint checks a catalog id first, then the union of ISRC and
MusicBrainz recording ID matches, then normalized title and artist, as Sinc's
bundled lookup does. Known title/artist aliases are a last exact stage that only
the online catalog has; the app never reads its aliases. It returns every
matching recording at the first successful stage. Fuzzy matching remains
disabled: Sinc's fallback accepts only
whole-word artist variants and title differences made of version qualifiers
or years. `pg_trgm` thresholds need catalog-based tuning before enabling it;
the bundled catalog handles online misses in the meantime.

## Verify changes

With PostgreSQL running and the bundled Sinc v16 catalog present (and Swift 6
for the client tests):

```sh
npm run typecheck
npm run openapi:check
npm test
npm run lint
(cd clients/swift && swift test)
```

Database tests create or use only a database whose name ends in `_test`.
`TEST_DATABASE_URL` overrides the derived test URL, and the test setup refuses
any other database name. The Generations parity suite imports the bundled
catalog into its own `_test` database and compares server output with fixtures
from Sinc's Swift builder: every field of named cases (dated, same-year,
multi-cluster and shared-ISRC ones among them) and a digest of every family in
a sweep of catalog ids and multi-cluster songs. Set `SINC_CANDIDATE_CATALOG` to
the next release's `samples.sqlite` to run the same comparison on it, in
`music_sample_graph_parity_candidate_test`, against
`generations_vectors_candidate.json`. Normalization and SongIdentity tests also
compare their shared vectors with the sibling Sinc checkout.

Each fixture records the SHA-256 of the catalog it came from. Sinc's
`GenerationsParityFixtureTests` prints a fresh export when run with
`TEST_RUNNER_EXPORT_GENERATIONS_FIXTURE=1` (and
`TEST_RUNNER_GENERATIONS_CANDIDATE_CATALOG=<path>` for the candidate); when a
candidate becomes the bundled catalog, its fixture becomes
`generations_vectors.json`.

The standalone GitHub Actions job has no Sinc catalog. It sets
`SKIP_SINC_CATALOG_PARITY=1` to skip only that full-catalog parity suite, and
the cross-repository drift checks skip when Sinc is absent. It still runs
backend tests against a PostgreSQL `_test` database and checks OpenAPI drift.
Run the full suite locally with the bundled catalog before changing catalog
identity or Generations behavior. A separate macOS job runs `swift test` on
the pre-generated client.

After an API change, export the contract and recorded responses, then
regenerate and sync the Swift package:

```sh
npm run openapi
npm run openapi:fixtures
npm run swift:client:sync
npm run swift:client:check-generated
```

See [the Swift client README](clients/swift/README.md) for the generator
requirement and sync details. Sinc keeps its own copy at
`../Sincapp/Packages/MusicSampleGraphClient`; builds do not run a generator
plugin.

## Scope

This is a development stack. Authentication, rate limits, TLS deployment,
production database operations, and the public data-licensing review are still
open. Publishing the catalog or serving it publicly requires the owner's
separate decision.
