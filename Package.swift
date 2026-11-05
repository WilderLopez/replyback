// swift-tools-version: 6.0
import PackageDescription

// En la raíz del repo para que SPM lo resuelva por URL. El código vive en swift/.
let package = Package(
    name: "Replyback",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "Replyback", targets: ["Replyback"]),
    ],
    targets: [
        .target(name: "Replyback", path: "swift/Sources/Replyback"),
        .testTarget(
            name: "ReplybackTests",
            dependencies: ["Replyback"],
            path: "swift/Tests/ReplybackTests"
        ),
    ]
)
