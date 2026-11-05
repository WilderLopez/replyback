import Foundation
import Testing
@testable import Replyback

private final class Memory: ReplybackStorage, ReplybackRefStore, @unchecked Sendable {
    var data: Data?
    var refs: [String] = []
    func load(key: String) -> Data? { data }
    func save(_ data: Data, key: String) { self.data = data }
    func load(key: String) -> [String] { refs }
    func save(_ refs: [String], key: String) { self.refs = refs }
    func delete(key: String) {}
}

private let environment = ProcessInfo.processInfo.environment

/// Contra un Worker desplegado. Solo corre con REPLYBACK_E2E_URL y REPLYBACK_E2E_ADMIN_TOKEN, usa un
/// `ref` nuevo y no envía token, así que no sale ningún push.
@MainActor
@Test(.enabled(if: environment["REPLYBACK_E2E_URL"] != nil))
func elClienteEntiendeAlWorkerReal() async throws {
    let url = try #require(environment["REPLYBACK_E2E_URL"].flatMap(URL.init(string:)))
    let adminToken = try #require(environment["REPLYBACK_E2E_ADMIN_TOKEN"])
    let memory = Memory()
    let client = ReplybackClient(configuration: ReplybackConfiguration(workerURL: url), storage: memory, refStore: memory)
    client.setAccount(userID: UUID().uuidString)

    let message = client.prepareComment("Prueba E2E del SDK")
    let ref = try #require(message.split(separator: "\n").last?.dropFirst("ref:".count)).lowercased()
    #expect(await client.sync(fcmToken: nil))
    #expect(client.threads.first?.isAwaitingReply == true)

    var request = URLRequest(url: url.appendingPathComponent("v1/admin/replies"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(adminToken)", forHTTPHeaderField: "authorization")
    let body: [String: Any] = [
        "ref": ref,
        "reply_id": UUID().uuidString.lowercased(),
        "text": "Prueba E2E del SDK",
        "comment": "Prueba E2E del SDK",
        "comment_at": 1_700_000_000_000,
    ]
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    #expect((response as? HTTPURLResponse)?.statusCode == 200)

    #expect(await client.sync(fcmToken: nil))
    let thread = try #require(client.threads.first)
    #expect(thread.comment == "Prueba E2E del SDK")
    #expect(thread.replies.map(\.text) == ["Prueba E2E del SDK"])
    #expect(try #require(thread.replies.first).createdAt.timeIntervalSinceNow > -300)

    #expect(await client.deleteAllData())
    #expect(client.threads.isEmpty)
}
