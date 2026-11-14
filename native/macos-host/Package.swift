// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LnwjudMacHost",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "lnwjud-macos-host", targets: ["LnwjudMacHost"]),
    ],
    targets: [
        .target(name: "MacProcessOwnerSupport", cSettings: [.unsafeFlags(["-fblocks"])], linkerSettings: [.linkedFramework("EndpointSecurity"), .linkedFramework("Security"), .linkedLibrary("bsm")]),
        .executableTarget(name: "LnwjudMacHost", dependencies: ["MacProcessOwnerSupport"]),
        .testTarget(name: "LnwjudMacHostTests", dependencies: ["LnwjudMacHost", "MacProcessOwnerSupport"]),
    ]
)
