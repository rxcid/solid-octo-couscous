// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MusicSampleGraphClient",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "MusicSampleGraphClient", targets: ["MusicSampleGraphClient"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.12.1"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.3.1"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.0.0"),
    ],
    targets: [
        // Generated Swift sources are checked in and synced into Sinc.
        .target(
            name: "MusicSampleGraphClient",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ],
            exclude: ["openapi.json", "openapi-generator-config.yaml"]
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
