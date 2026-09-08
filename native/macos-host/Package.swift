// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LnwjudMacHost",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "lnwjud-macos-host", targets: ["LnwjudMacHost"]),
    ],
    targets: [
        .executableTarget(name: "LnwjudMacHost"),
        .testTarget(name: "LnwjudMacHostTests", dependencies: ["LnwjudMacHost"]),
    ]
)
