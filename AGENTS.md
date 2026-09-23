# music-sample-graph

The online Music DNA catalog for Sinc, the iOS app in `../Sincapp`. It includes a Fastify + Drizzle API on Postgres, a generated Swift client in `clients/swift`, and a Next.js scaffold in `frontend`.

**Read `HANDOFF.md` before doing anything.** It records the current state of this repo and of Sinc, including the uncommitted Sinc work, and what to do next.

## Rules

- Commit only when the user asks. Never push, publish, deploy, or create remote repositories without explicit approval.
- Ask before downloading anything, and state the filename, source and size.
- Keep parity with Sinc:
  - `normalize()` in `backend/src/catalog/identity.ts` must pass Sinc's `tools/data/normalization_vectors.json`.
  - Ids are Sinc's canonical ids (`node_…`, `edge_…`).
  - Only `published` relationships are served.
- After any API change, regenerate the Swift client's inputs and run every test. `backend/src/api/document.test.ts` fails until you do:
  `npm run openapi && npm run openapi:fixtures && (cd clients/swift && swift test) && npm test`
- Tests use a database whose name ends in `_test`, and they refuse any other.
- Write code that reads like its neighbours: plain names, comments that explain *why*, and commit messages written as imperative sentences.

## Everyday commands (repo root)

```bash
export PATH="$HOME/.local/bin:$PATH"; colima status || colima start
npm run db:up && npm run db:migrate
npm run import:sinc -- --replace          # load Sinc's catalog
npm run dev -w backend                    # API on http://localhost:4000, docs at /docs
npm run typecheck && npm test && npm run lint
```
