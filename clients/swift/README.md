# MusicSampleGraphClient

A Swift client for the Music Sample Graph API, used by Sinc. The public types
and raw `Client` are pre-generated from
[`openapi.json`](Sources/MusicSampleGraphClient/openapi.json) with
swift-openapi-generator 1.13.1. `SampleGraphClient` wraps them in one method per
endpoint. The generated Swift files are checked in; builds do not run a package
plugin.

```swift
import MusicSampleGraphClient

let api = SampleGraphClient(serverURL: URL(string: "http://localhost:4000")!)

let match = try await api.resolve(isrc: item.isrc, title: item.title, artist: item.artist)
guard let song = match.tracks.first else { return }

let dna = try await api.relationships(id: song.id)
let crowd = try await api.siblings(id: song.id)
let family = try await api.generations(id: song.id)
let tree = try await api.lineage(id: song.id).tree
```

Ids are Sinc catalog canonical ids, so a bundled `node_…` id works unchanged.
Segment times come in milliseconds; `atInSource`, `atInDestination`, and
`duration` are exposed as `TimeInterval` seconds. API errors arrive as
`SampleGraphError` with `statusCode`, `code`, and `message`.

Sinc depends on its own checked-in copy at `Packages/MusicSampleGraphClient`,
which makes an Xcode Cloud checkout self-contained. The sync command mirrors
this package's manifest, sources, tests, and fixtures. A backend test fails if
the Sinc copy drifts from this one when both repositories are checked out.

## When the API changes

From the repository root:

```sh
npm run openapi                 # export the API document (requires Postgres)
npm run openapi:fixtures        # re-record the Swift client's response fixtures
npm run swift:client:sync       # generate Swift and update Sinc's vendored copy
npm run swift:client:check      # check the vendored copy without generating
npm run swift:client:check-generated # also verify Swift matches openapi.json
cd clients/swift && swift test
```

The sync command requires a **locally available**
`swift-openapi-generator-tool` version 1.13.1. It uses the binary in this
package's existing `.build` directory if present; otherwise set
`SWIFT_OPENAPI_GENERATOR` to its path. It never downloads a tool. A normal
sync accepts a copy that matches the current or last committed graph sources,
and refuses independent changes in Sinc. Inspect those changes first, then pass
`-- --force` to overwrite known package files. The script never deletes
unexpected files. Set `SINC_DIR` if the Sinc checkout is not the repository's
sibling directory.

The Swift tests replay recorded server responses and check request URLs. To run
them against a live server with Sinc's catalog imported, set
`SAMPLE_GRAPH_URL=http://localhost:4000`.
