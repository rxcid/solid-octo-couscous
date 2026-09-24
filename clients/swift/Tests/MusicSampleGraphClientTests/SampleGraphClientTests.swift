import Foundation
import MusicSampleGraphClient
import Testing

/// A client whose every request is answered by the named recording.
private func client(_ recording: String) throws -> SampleGraphClient {
    SampleGraphClient(serverURL: URL(string: "https://api.example")!, transport: try RecordedTransport(recording))
}

@Suite struct SampleGraphClientTests {
    @Test func resolvesAnISRCToEveryRecordingSharingIt() async throws {
        let resolution = try await client("resolve").resolve(isrc: "USAAA6900001")
        #expect(resolution.matchedBy == .isrc)
        #expect(resolution.tracks.map(\.title) == ["Funky Break", "Funky Break Pt. 1"])
        #expect(resolution.tracks[0].releaseYear == 1969)
        #expect(resolution.tracks[0].musicbrainzRecordingId == "00000000-0000-4000-8000-00000000000a")
        #expect(resolution.tracks[1].musicbrainzRecordingId == nil)
    }

    @Test func resolvesAMusicBrainzRecordingID() async throws {
        let resolution = try await client("resolve-mbid").resolve(mbid: "00000000-0000-4000-8000-00000000000c")
        #expect(resolution.matchedBy == .mbid)
        #expect(resolution.tracks.map(\.title) == ["City Anthem (Radio Edit)"])
    }

    @Test func decodesATrackWithItsCreditsAndVersions() async throws {
        let track = try await client("track").track(id: "node_mb_00000000-0000-4000-8000-00000000000a")
        #expect(track.kind == .song)
        #expect(track.identifiers.map(\.namespace) == [.musicbrainzRecording, .isrc])
        #expect(track.artists.map(\.name) == ["The Originals"])
        #expect(track.contributors.first?.role == "producer")
        #expect(track.works.first?.iswcs == ["T-000.000.001-0"])
        #expect(track.lineageDisclosure?.classification == .human)
        #expect(track.versions.map(\.title) == ["Funky Break Pt. 1"])
    }

    @Test func decodesRelationshipsWithSegmentsAndProvenance() async throws {
        let relationships = try await client("relationships")
            .relationships(id: "node_mb_00000000-0000-4000-8000-00000000000a")
        #expect(relationships.sources.total == 0)
        #expect(relationships.derivatives.total == 3)
        let anthem = try #require(relationships.derivatives.items.first)
        #expect(anthem.relationshipType == .sampled)
        #expect(anthem.destination.title == "City Anthem")
        let segment = try #require(anthem.segments.first)
        #expect(segment.element == "drums (drum set)")
        #expect(segment.sampleType == .looped)
        #expect(segment.atInSource == 85)
        #expect(segment.duration == 4)
        #expect(segment.pitchShiftSemitones == nil)
        #expect(anthem.provenance.isVerified)
        #expect(anthem.provenance.sources == ["curated", "musicbrainz"])
        #expect(anthem.provenance.evidenceUrl == "https://example.org/liner-notes")
    }

    @Test func rebuildsTheLineageTree() async throws {
        let lineage = try await client("lineage").lineage(id: try recordedTrackID("lineage"))
        #expect(lineage.direction == .sources)
        let root = try #require(lineage.tree)
        #expect(root.node.track.title == "Late Echo")
        #expect(root.node.relationship == nil)
        #expect(root.children.map(\.node.track.title) == ["City Anthem (Radio Edit)", "Funky Break Pt. 1"])
        #expect(root.children[0].node.relationship?.relationshipType == .interpolated)
        #expect(root.children[0].children.map(\.node.track.title) == ["Funky Break"])
        #expect(root.children[1].children.isEmpty)
    }

    @Test func sendsLineageOptions() async throws {
        let lineage = try await client("lineage-derivatives").lineage(
            id: "node_mb_00000000-0000-4000-8000-00000000000a", direction: .derivatives, depth: 2
        )
        let root = try #require(lineage.tree)
        #expect(root.children.map(\.node.track.title) == ["City Anthem", "Late Echo", "Night Drive"])
    }

    @Test func decodesGenerationsFromTheRecordedAPI() async throws {
        let family = try await client("generations").generations(id: try recordedTrackID("generations"))
        #expect(family.root.track.title == "Funky Break")
        #expect(family.generations.first?.role == .thisSong)
        #expect(family.generations.contains { $0.role == .after })
    }

    @Test func decodesSiblingsAndSearch() async throws {
        let groups = try await client("siblings").siblings(id: try recordedTrackID("siblings"))
        #expect(groups.map(\.source.title) == ["Funky Break"])
        #expect(groups.first?.total == 1)
        let results = try await client("search").search("funky")
        #expect(results.map(\.title) == ["Funky Break", "Funky Break Pt. 1"])
    }

    @Test func reportsAnUnknownTrack() async throws {
        do {
            _ = try await client("track-not-found").track(id: "node_unknown")
            Issue.record("Expected an error")
        } catch let error as SampleGraphError {
            #expect(error.isNotFound)
            #expect(error.code == "track_not_found")
            #expect(error.message == "No track with id node_unknown")
        }
    }

    @Test func reportsAnInvalidRequest() async throws {
        do {
            _ = try await client("resolve-invalid").resolve(title: "Night Drive")
            Issue.record("Expected an error")
        } catch let error as SampleGraphError {
            #expect(error.statusCode == 400)
            #expect(error.code == "invalid_request")
        }
    }

    /// The id a recording was requested with, from its URL.
    private func recordedTrackID(_ recording: String) throws -> String {
        let url = try RecordedTransport(recording).url
        return try #require(url.split(separator: "/").dropFirst(2).first.map(String.init))
    }
}

/// Runs against a live server when SAMPLE_GRAPH_URL is set, e.g.
/// `SAMPLE_GRAPH_URL=http://localhost:4000 swift test` with Sinc's catalog imported.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["SAMPLE_GRAPH_URL"] != nil))
struct LiveServerTests {
    let client = SampleGraphClient(serverURL: URL(string: ProcessInfo.processInfo.environment["SAMPLE_GRAPH_URL"] ?? "")!)

    @Test func walksFromAScanToItsLineage() async throws {
        let resolution = try await client.resolve(title: "Straight Outta Compton", artist: "N.W.A")
        let song = try #require(resolution.tracks.first)
        let relationships = try await client.relationships(id: song.id)
        #expect(relationships.sources.items.contains { $0.source.title == "Amen, Brother" })
        let lineage = try await client.lineage(id: song.id)
        #expect(try #require(lineage.tree).children.count == relationships.sources.total)
        #expect(try await client.search("straight outta compton").contains { $0.id == song.id })
    }
}
