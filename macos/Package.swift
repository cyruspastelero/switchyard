// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Switchyard",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Switchyard", path: "Sources/Switchyard"),
        .testTarget(name: "SwitchyardTests", dependencies: ["Switchyard"], path: "Tests/SwitchyardTests"),
    ]
)
