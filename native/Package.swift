// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AgentCastKitCapture",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "agentcastkit-capture", targets: ["AgentCastKitCapture"]),
    ],
    targets: [
        .executableTarget(
            name: "AgentCastKitCapture",
            swiftSettings: [.unsafeFlags(["-parse-as-library"])]
        ),
    ]
)
