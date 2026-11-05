import Foundation
import Testing
@testable import Replyback

private final class MemoryStorage: ReplybackStorage, @unchecked Sendable {
    var data: Data?
    func load() -> Data? { data }
    func save(_ data: Data) { self.data = data }
    func delete() { data = nil }
}

private final class Clock: @unchecked Sendable {
    var date = Date(timeIntervalSince1970: 1_800_000_000)
}

/// Worker falso. Datos inventados.
private final class FakeWorker: @unchecked Sendable {
    struct Call {
        let path: String
        let refs: [String]
        let token: String?
        let hasTokenKey: Bool
    }

    var calls: [Call] = []
    var repliesByRef: [String: [[String: Any]]] = [:]
    var status = 200
    var gate: (@Sendable () async -> Void)?

    lazy var transport: Transport = { [self] request in
        let body = try #require(try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])
        let refs = body["refs"] as? [String] ?? []
        calls.append(Call(path: request.url?.path ?? "", refs: refs, token: body["fcm_token"] as? String, hasTokenKey: body["fcm_token"] != nil))
        await gate?()
        let replies = refs.flatMap { repliesByRef[$0] ?? [] }
        let data = try JSONSerialization.data(withJSONObject: ["replies": replies])
        let url = try #require(request.url)
        return (data, try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)))
    }

    func reply(_ id: String, ref: String, text: String = "Respuesta", at: Int64 = 1_800_000_000_000) {
        repliesByRef[ref, default: []].append(["reply_id": id, "ref": ref, "text": text, "created_at": at])
    }
}

@MainActor
private struct Harness {
    let worker = FakeWorker()
    let storage = MemoryStorage()
    let clock = Clock()
    var hash: String? = "0123456789abcdef0123456789abcdef01234567"

    func client(build: String = "45") -> ReplybackClient {
        let clock = clock
        let hash = hash
        return ReplybackClient(
            configuration: ReplybackConfiguration(workerURL: URL(filePath: "/replyback-test"), minimumSyncInterval: 900),
            storage: storage,
            transport: worker.transport,
            now: { clock.date },
            deviceAppHash: { hash },
            appBuild: build
        )
    }
}

private func ref(in message: String) throws -> String {
    try #require(message.split(separator: "\n").last.map { String($0.dropFirst("ref:".count)) })
}

@MainActor
struct ReplybackClientTests {
    @Test func prepareCommentAñadeElRefComoUltimaLinea() throws {
        let client = Harness().client()
        let message = client.prepareComment("  Hola\nque tal \n")
        let ref = try ref(in: message)
        #expect(message == "Hola\nque tal\n\nref:\(ref)")
        #expect(ref == ref.lowercased())
        #expect(UUID(uuidString: ref) != nil)
    }

    @Test func sinComentariosNoConsulta() async {
        let harness = Harness()
        let client = harness.client()
        #expect(await client.syncIfNeeded(fcmToken: "t"))
        #expect(await client.sync(fcmToken: "t"))
        #expect(harness.worker.calls.isEmpty)
    }

    @Test func syncRegistraElTokenYRecogeLaRespuesta() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref, text: "Ya está")

        #expect(await client.sync(fcmToken: "token"))
        let call = try #require(harness.worker.calls.first)
        #expect(call.path == "/replyback-test/v1/sync")
        #expect(call.refs == [ref])
        #expect(call.token == "token")
        #expect(client.replies.map(\.text) == ["Ya está"])
        #expect(client.replies.first?.createdAt == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(client.unreadCount == 1)
    }

    @Test func noDuplicaNiPierdeElLeido() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref)
        await client.sync(fcmToken: nil)
        client.markRead(replyID: "r1")
        #expect(client.unreadCount == 0)

        await client.sync(fcmToken: nil)
        #expect(client.replies.count == 1)
        #expect(client.unreadCount == 0)
    }

    @Test func syncIfNeededRespetaElIntervalo() async throws {
        let harness = Harness()
        let client = harness.client()
        _ = client.prepareComment("Hola")

        await client.syncIfNeeded(fcmToken: nil)
        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.count == 1)

        harness.clock.date += 901
        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.count == 2)
    }

    @Test func syncIfNeededSoloPreguntaPorLosPendientes() async throws {
        let harness = Harness()
        let client = harness.client()
        let answered = try ref(in: client.prepareComment("Uno"))
        harness.worker.reply("r1", ref: answered)
        await client.sync(fcmToken: nil)

        harness.clock.date += 901
        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.count == 1, "sin pendientes no gasta peticiones")

        let pending = try ref(in: client.prepareComment("Dos"))
        harness.clock.date += 901
        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.last?.refs == [pending])
    }

    @Test func syncTrasElPushIncluyeLosRespondidos() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref)
        await client.sync(fcmToken: nil)

        harness.worker.reply("r2", ref: ref, text: "Otra respuesta", at: 1_800_000_001_000)
        await client.sync(fcmToken: nil)
        #expect(client.replies.map(\.id) == ["r2", "r1"], "la más reciente primero")
    }

    @Test func dividePorLotesDeVeinte() async {
        let harness = Harness()
        let client = harness.client()
        for index in 0..<45 { _ = client.prepareComment("Comentario \(index)") }
        #expect(await client.sync(fcmToken: nil))
        #expect(harness.worker.calls.map(\.refs.count) == [20, 20, 5])
    }

    @Test func unFalloNoPierdeNadaYSeReintenta() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.status = 500
        #expect(await client.sync(fcmToken: nil) == false)

        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.count == 2, "un fallo no activa el intervalo")

        harness.worker.status = 200
        harness.worker.reply("r1", ref: ref)
        #expect(await client.sync(fcmToken: nil))
        #expect(client.replies.count == 1)
    }

    @Test func conservaElEstadoEntreArranques() async throws {
        let harness = Harness()
        let first = harness.client()
        let ref = try ref(in: first.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref)
        await first.sync(fcmToken: nil)
        first.markRead(replyID: "r1")

        let second = harness.client()
        #expect(second.replies.map(\.id) == ["r1"])
        #expect(second.unreadCount == 0)
        await second.sync(fcmToken: nil)
        #expect(harness.worker.calls.last?.refs == [ref])
    }

    @Test func dejaDeConsultarLoCaducado() async throws {
        let harness = Harness()
        _ = harness.client().prepareComment("Pendiente")
        harness.clock.date += 181 * 24 * 3600
        let client = harness.client()
        await client.sync(fcmToken: nil)
        #expect(harness.worker.calls.isEmpty)
    }

    @Test func resetBorraTodo() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref)
        await client.sync(fcmToken: nil)

        client.reset()
        #expect(client.replies.isEmpty)
        #expect(harness.storage.data == nil)
        await client.sync(fcmToken: nil)
        #expect(harness.worker.calls.count == 1)
    }

    @Test func unaConsultaEnCursoNoReponeDatosTrasElReset() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref)

        let (stream, continuation) = AsyncStream.makeStream(of: Void.self)
        harness.worker.gate = { for await _ in stream { break } }
        let running = Task { await client.sync(fcmToken: nil) }
        while harness.worker.calls.isEmpty { await Task.yield() }

        client.reset()
        continuation.yield()
        #expect(await running.value == false)
        #expect(client.replies.isEmpty)
        #expect(harness.storage.data == nil)
    }

    @Test func comentariosAntiguosSinTokenYUnaVezPorVersion() async throws {
        let harness = Harness()
        let client = harness.client(build: "45")
        #expect(await client.checkLegacyReplies(userID: "user-1"))
        #expect(await client.checkLegacyReplies(userID: "user-1") == false)
        #expect(harness.worker.calls.count == 1)
        let call = try #require(harness.worker.calls.first)
        #expect(!call.hasTokenKey, "el Worker no debe guardar nada de quien no tenga respuesta")
        #expect(call.refs == [LegacyRef.ref(userID: "user-1", deviceAppHash: "0123456789abcdef0123456789abcdef01234567")])

        #expect(await client.checkLegacyReplies(userID: "user-2"))
        #expect(harness.worker.calls.count == 2)

        #expect(await harness.client(build: "46").checkLegacyReplies(userID: "user-1"))
        #expect(harness.worker.calls.count == 3)
    }

    @Test func comentariosAntiguosEntreganLaRespuesta() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = LegacyRef.ref(userID: "user-1", deviceAppHash: "0123456789abcdef0123456789abcdef01234567")
        harness.worker.reply("r1", ref: ref, text: "Antigua")
        await client.checkLegacyReplies(userID: "user-1")
        #expect(client.replies.map(\.text) == ["Antigua"])

        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.count == 1, "ya respondido: no sigue consultando")
    }

    @Test func comentariosAntiguosSeReintentanSiFalla() async {
        var harness = Harness()
        harness.worker.status = 500
        let failing = harness.client()
        #expect(await failing.checkLegacyReplies(userID: "user-1") == false)
        harness.worker.status = 200
        #expect(await failing.checkLegacyReplies(userID: "user-1"))

        harness = Harness()
        harness.hash = nil
        #expect(await harness.client().checkLegacyReplies(userID: "user-1") == false)
        #expect(harness.worker.calls.isEmpty, "sin identificador del dispositivo no hay consulta")
    }

    @Test func reconoceElPush() {
        #expect(ReplybackClient.isReplyNotification(["type": "replyback.reply"]))
        #expect(!ReplybackClient.isReplyNotification(["type": "otro"]))
        #expect(!ReplybackClient.isReplyNotification([:]))
    }
}

struct ReplybackFileStorageTests {
    @Test func guardaLeeYBorra() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = ReplybackFileStorage(directory: directory)
        #expect(storage.load() == nil)
        storage.save(Data("hola".utf8))
        #expect(storage.load() == Data("hola".utf8))
        let file = directory.appendingPathComponent("replyback/state.json")
        #expect(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        storage.delete()
        #expect(storage.load() == nil)
    }
}
