// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MusicSampleGraphClient",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "MusicSampleGraphClient", targets: ["MusicSampleGraphClient"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.13.1"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.12.1"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.3.1"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.0.0"),
    ],
    targets: [
        // Types and the raw client are generated at build time from
        // openapi.json, which `npm run openapi` exports from the server.
        .target(
            name: "MusicSampleGraphClient",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ],
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator"),
            ]
        ),
        .testTarget(
            name: "MusicSampleGraphClientTests",
            dependencies: [
                "MusicSampleGraphClient",
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ],
            resources: [.copy("Fixtures")]
        ),
    ]
)
