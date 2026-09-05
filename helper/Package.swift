// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "iai-capture",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "iai-capture",
            path: "Sources/iai-capture"
        )
    ]
)
