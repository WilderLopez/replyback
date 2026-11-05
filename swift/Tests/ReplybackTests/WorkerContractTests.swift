import Foundation
import Testing
@testable import Replyback

private final class Memory: ReplybackStorage, @unchecked Sendable {
    var data: Data?
    func load() -> Data? { data }
    func save(_ data: Data) { self.data = data }
    func delete() { data = nil }
}

private let environment = ProcessInfo.processInfo.environment

/// Contra un Worker desplegado. Solo corre con REPLYBACK_E2E_URL y REPLYBACK_E2E_ADMIN_TOKEN, usa un
/// `ref` nuevo y no envía token, así que no sale ningún push.
@MainActor
@Test(.enabled(if: environment["REPLYBACK_E2E_URL"] != nil))
func elClienteEntiendeAlWorkerReal() async throws {
    let url = try #require(environment["REPLYBACK_E2E_URL"].flatMap(URL.init(string:)))
    let adminToken = try #require(environment["REPLYBACK_E2E_ADMIN_TOKEN"])
    let client = ReplybackClient(configuration: ReplybackConfiguration(workerURL: url), storage: Memory())

    let message = client.prepareComment("Prueba E2E del SDK")
    let ref = try #require(message.split(separator: "\n").last?.dropFirst("ref:".count)).lowercased()
    #expect(await client.sync(fcmToken: nil))
    #expect(client.replies.isEmpty)

    var request = URLRequest(url: url.appendingPathComponent("v1/admin/replies"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(adminToken)", forHTTPHeaderField: "authorization")
    request.httpBody = try JSONEncoder().encode([
        "ref": ref,
        "reply_id": UUID().uuidString.lowercased(),
        "text": "Prueba E2E del SDK",
    ])
    let (_, response) = try await URLSession.shared.data(for: request)
    #expect((response as? HTTPURLResponse)?.statusCode == 200)

    #expect(await client.sync(fcmToken: nil))
    #expect(client.replies.map(\.text) == ["Prueba E2E del SDK"])
    #expect(try #require(client.replies.first).createdAt.timeIntervalSinceNow > -300)
}
