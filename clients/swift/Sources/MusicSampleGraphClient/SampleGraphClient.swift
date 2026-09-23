import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// The Music Sample Graph API: what a song samples, what samples it, and who
/// else built on the same sources.
///
/// Ids are Sinc's catalog canonical ids (`node_…`, `edge_…`), so an id from
/// the bundled catalog names the same recording here. Every response type is
/// generated from the server's OpenAPI document into `Components.Schemas`.
public struct SampleGraphClient: Sendable {
    private let client: Client

    /// - Parameters:
    ///   - serverURL: The API's origin, e.g. `http://localhost:4000`.
    ///   - transport: How requests are sent; URLSession unless a test supplies one.
    public init(serverURL: URL, transport: any ClientTransport = URLSessionTransport()) {
        client = Client(serverURL: serverURL, transport: transport)
    }

    /// The catalog recordings for a recognized song.
    ///
    /// An ISRC match wins; otherwise every recording with the same normalized
    /// title, artist, and kind matches. Pass an ISRC, or a title and an
    /// artist. An empty `tracks` means the catalog doesn't have the song.
    public func resolve(
        isrc: String? = nil,
        title: String? = nil,
        artist: String? = nil,
        kind: Components.Schemas.TrackKind = .song
    ) async throws -> Components.Schemas.Resolution {
        switch try await client.resolveTrack(query: .init(isrc: isrc, title: title, artist: artist, kind: kind)) {
        case .ok(let response): return try response.body.json
        case .badRequest(let response): throw SampleGraphError(400, try? response.body.json)
        case .notFound(let response): throw SampleGraphError(404, try? response.body.json)
        case .undocumented(let status, _): throw SampleGraphError(status, nil)
        }
    }

    /// A track, its credits, and the other recordings of its song.
    public func track(id: String) async throws -> Components.Schemas.TrackDetail {
        switch try await client.getTrack(path: .init(id: id)) {
        case .ok(let response): return try response.body.json
        case .badRequest(let response): throw SampleGraphError(400, try? response.body.json)
        case .notFound(let response): throw SampleGraphError(404, try? response.body.json)
        case .undocumented(let status, _): throw SampleGraphError(status, nil)
        }
    }

    /// What the song takes from (`sources`) and what takes from it (`derivatives`).
    /// - Parameter limit: Relationships per direction; the server defaults to 50.
    public func relationships(id: String, limit: Int? = nil) async throws -> Components.Schemas.Relationships {
        switch try await client.getRelationships(path: .init(id: id), query: .init(limit: limit)) {
        case .ok(let response): return try response.body.json
        case .badRequest(let response): throw SampleGraphError(400, try? response.body.json)
        case .notFound(let response): throw SampleGraphError(404, try? response.body.json)
        case .undocumented(let status, _): throw SampleGraphError(status, nil)
        }
    }

    /// The song's lineage, generation by generation. Rebuild it with ``Components/Schemas/Lineage/tree``.
    /// - Parameters:
    ///   - direction: `.sources` (the default) walks what it samples; `.derivatives` what samples it.
    ///   - depth: Generations below the root; the server defaults to 3.
    ///   - rootLimit: Children shown under the root; the server defaults to 10.
    ///   - childLimit: Children shown under any other node; the server defaults to 4.
    public func lineage(
        id: String,
        direction: Components.Schemas.Direction? = nil,
        depth: Int? = nil,
        rootLimit: Int? = nil,
        childLimit: Int? = nil
    ) async throws -> Components.Schemas.Lineage {
        let query = Operations.GetLineage.Input.Query(
            direction: direction, depth: depth, rootLimit: rootLimit, childLimit: childLimit
        )
        switch try await client.getLineage(path: .init(id: id), query: query) {
        case .ok(let response): return try response.body.json
        case .badRequest(let response): throw SampleGraphError(400, try? response.body.json)
        case .notFound(let response): throw SampleGraphError(404, try? response.body.json)
        case .undocumented(let status, _): throw SampleGraphError(status, nil)
        }
    }

    /// Other songs built from the sources this song uses, busiest source first.
    public func siblings(id: String, perSource: Int? = nil, sources: Int? = nil) async throws -> [Components.Schemas.SiblingGroup] {
        switch try await client.getSiblings(path: .init(id: id), query: .init(perSource: perSource, sources: sources)) {
        case .ok(let response): return try response.body.json.groups
        case .badRequest(let response): throw SampleGraphError(400, try? response.body.json)
        case .notFound(let response): throw SampleGraphError(404, try? response.body.json)
        case .undocumented(let status, _): throw SampleGraphError(status, nil)
        }
    }

    /// Songs whose title or artist contains every word of `query`, one recording per song.
    public func search(_ query: String, limit: Int? = nil) async throws -> [Components.Schemas.TrackSummary] {
        switch try await client.searchTracks(query: .init(q: query, limit: limit)) {
        case .ok(let response): return try response.body.json.tracks
        case .badRequest(let response): throw SampleGraphError(400, try? response.body.json)
        case .notFound(let response): throw SampleGraphError(404, try? response.body.json)
        case .undocumented(let status, _): throw SampleGraphError(status, nil)
        }
    }
}

/// A response the API answered with an error.
public struct SampleGraphError: Error, Equatable, Sendable {
    public let statusCode: Int
    /// The server's error code, e.g. `track_not_found` or `invalid_request`.
    public let code: String?
    public let message: String?

    init(_ statusCode: Int, _ body: Components.Schemas._Error?) {
        self.statusCode = statusCode
        code = body?.error.code
        message = body?.error.message
    }

    public var isNotFound: Bool { statusCode == 404 }
}

extension Components.Schemas.Lineage {
    /// A lineage node with its children, rebuilt from the depth-first `nodes`.
    public struct Tree: Identifiable, Sendable {
        public let node: Components.Schemas.LineageNode
        public let children: [Tree]
        public var id: String { node.id }
    }

    /// The lineage as a tree rooted at the song asked about.
    public var tree: Tree? {
        guard let root = nodes.first else { return nil }
        let childrenByParent = Dictionary(grouping: nodes.dropFirst()) { $0.parentId ?? "" }
        func build(_ node: Components.Schemas.LineageNode) -> Tree {
            Tree(node: node, children: (childrenByParent[node.id] ?? []).map(build))
        }
        return build(root)
    }
}

extension Components.Schemas.Segment {
    /// Seconds into the source recording, as Sinc's players take it.
    public var atInSource: TimeInterval? { atInSourceMs.map { TimeInterval($0) / 1000 } }
    /// Seconds into the recording that uses the source.
    public var atInDestination: TimeInterval? { atInDestinationMs.map { TimeInterval($0) / 1000 } }
    public var duration: TimeInterval? { durationMs.map { TimeInterval($0) / 1000 } }
}
