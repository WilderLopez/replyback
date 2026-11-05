import CryptoKit
import Foundation

#if canImport(UIKit)
import UIKit
#endif

/// `ref` de los comentarios enviados antes de integrar el SDK. Ver docs/diseno.md.
enum LegacyRef {
    /// Mismo cálculo que `device_app_hash` en sentry-cocoa.
    static func deviceAppHash(vendorID: UUID, machine: String, model: String, bundleID: String) -> String {
        var data = withUnsafeBytes(of: vendorID.uuid) { Data($0) }
        data.append(Data(machine.utf8))
        data.append(Data(model.utf8))
        data.append(Data(bundleID.utf8))
        return Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func ref(userID: String, deviceAppHash: String) -> String {
        hashAsUUID("replyback:\(userID):\(deviceAppHash)")
    }

    private static func hashAsUUID(_ input: String) -> String {
        let hex = SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
        let parts = [hex.prefix(8), hex.dropFirst(8).prefix(4), hex.dropFirst(12).prefix(4), hex.dropFirst(16).prefix(4), hex.dropFirst(20).prefix(12)]
        return parts.joined(separator: "-")
    }
}

/// `nil` si el sistema aún no da el identificador, como antes del primer desbloqueo.
@MainActor
func currentDeviceAppHash() -> String? {
    #if canImport(UIKit)
    guard let vendorID = UIDevice.current.identifierForVendor, let bundleID = Bundle.main.bundleIdentifier else { return nil }
    return LegacyRef.deviceAppHash(
        vendorID: vendorID,
        machine: sysctlString("hw.machine"),
        model: sysctlString("hw.model"),
        bundleID: bundleID
    )
    #else
    return nil
    #endif
}

#if canImport(UIKit)
private func sysctlString(_ name: String) -> String {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return "" }
    var buffer = [UInt8](repeating: 0, count: size)
    guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return "" }
    return String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
}
#endif
