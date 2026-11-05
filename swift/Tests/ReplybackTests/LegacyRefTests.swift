import Foundation
import Testing
@testable import Replyback

private func vectors<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("spec/\(name)")
    return try JSONDecoder().decode(type, from: Data(contentsOf: url))
}

private struct HashVector: Decodable {
    let vendor_id: String
    let machine: String
    let model: String
    let bundle_id: String
    let device_app_hash: String
}

private struct RefVector: Decodable {
    let user_id: String
    let device_app_hash: String
    let ref: String
}

@Test func deviceAppHashCoincideConLosVectores() throws {
    let all = try vectors("device-app-hash-vectors.json", as: [HashVector].self)
    #expect(!all.isEmpty)
    for vector in all {
        let vendorID = try #require(UUID(uuidString: vector.vendor_id))
        let hash = LegacyRef.deviceAppHash(vendorID: vendorID, machine: vector.machine, model: vector.model, bundleID: vector.bundle_id)
        #expect(hash == vector.device_app_hash)
    }
}

@Test func refCoincideConLaCLI() throws {
    let all = try vectors("legacy-ref-vectors.json", as: [RefVector].self)
    #expect(!all.isEmpty)
    for vector in all {
        #expect(LegacyRef.ref(userID: vector.user_id, deviceAppHash: vector.device_app_hash) == vector.ref)
    }
}
