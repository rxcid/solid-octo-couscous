import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

/// Answers with one response recorded from the real server (see
/// backend/src/scripts/export-swift-fixtures.ts), and records a test issue if
/// the client asks for a different URL than the recording was made from.
struct RecordedTransport: ClientTransport {
    let url: String
    let status: Int
    let body: Data

    init(_ name: String) throws {
        let file = try #require(
            Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"),
            "No recording named \(name)"
        )
        let recording = try #require(
            try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        )
        url = try #require(recording["url"] as? String)
        status = try #require(recording["status"] as? Int)
        body = try JSONSerialization.data(withJSONObject: try #require(recording["body"]))
    }

    func send(
        _ request: HTTPRequest,
        body _: HTTPBody?,
        baseURL _: URL,
        operationID _: String
    ) async throws -> (HTTPResponse, HTTPBody?) {
        #expect(request.method == .get)
        #expect(request.path == url, "The client asked for a different URL than was recorded")
        let response = HTTPResponse(status: .init(code: status), headerFields: [.contentType: "application/json"])
        return (response, HTTPBody(body))
    }
}
