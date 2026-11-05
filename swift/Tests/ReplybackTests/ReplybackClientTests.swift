import Foundation
import Testing
@testable import Replyback

private final class MemoryStorage: ReplybackStorage, @unchecked Sendable {
    var files: [String: Data] = [:]
    func load(key: String) -> Data? { files[key] }
    func save(_ data: Data, key: String) { files[key] = data }
    func delete(key: String) { files[key] = nil }
}

private final class MemoryRefStore: ReplybackRefStore, @unchecked Sendable {
    var items: [String: [String]] = [:]
    func load(key: String) -> [String] { items[key] ?? [] }
    func save(_ refs: [String], key: String) { items[key] = refs }
    func delete(key: String) { items[key] = nil }
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
        let path = request.url?.path ?? ""
        calls.append(Call(path: path, refs: refs, token: body["fcm_token"] as? String, hasTokenKey: body["fcm_token"] != nil))
        await gate?()
        let payload: [String: Any]
        if path.hasSuffix("v1/delete") {
            if status == 200 { refs.forEach { repliesByRef[$0] = nil } }
            payload = ["status": "deleted"]
        } else {
            payload = ["replies": refs.flatMap { repliesByRef[$0] ?? [] }]
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        let url = try #require(request.url)
        return (data, try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)))
    }

    func reply(
        _ id: String,
        ref: String,
        text: String = "Respuesta",
        comment: String? = "Comentario",
        at: Int64 = 1_800_000_000_000,
        deliveredAt: Int64? = nil
    ) {
        repliesByRef[ref, default: []].append([
            "reply_id": id,
            "ref": ref,
            "text": text,
            "comment": comment as Any? ?? NSNull(),
            "comment_at": comment == nil ? NSNull() : 1_799_000_000_000 as Any,
            "created_at": at,
            "delivered_at": deliveredAt as Any? ?? NSNull(),
        ])
    }
}

private let hash = "0123456789abcdef0123456789abcdef01234567"

@MainActor
private struct Harness {
    let worker = FakeWorker()
    let storage = MemoryStorage()
    let refStore = MemoryRefStore()
    let clock = Clock()
    var deviceHash: String? = hash

    func client(account: String? = "user-1", build: String = "45", refStore: (any ReplybackRefStore)? = nil, storage: (any ReplybackStorage)? = nil) -> ReplybackClient {
        let clock = clock
        let deviceHash = deviceHash
        let client = ReplybackClient(
            configuration: ReplybackConfiguration(workerURL: URL(filePath: "/replyback-test"), minimumSyncInterval: 900),
            storage: storage ?? self.storage,
            refStore: refStore ?? self.refStore,
            transport: worker.transport,
            now: { clock.date },
            deviceAppHash: { deviceHash },
            appBuild: build
        )
        client.setAccount(userID: account)
        return client
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

    @Test func sinCuentaElMensajeSaleSinRef() async {
        let harness = Harness()
        let client = harness.client(account: nil)
        #expect(client.prepareComment(" Hola ") == "Hola")
        #expect(client.threads.isEmpty)
        #expect(await client.sync(fcmToken: "t"))
        #expect(await client.checkLegacyReplies() == false)
        #expect(await client.deleteAllData() == false)
        #expect(harness.worker.calls.isEmpty)
    }

    @Test func unComentarioEnviadoApareceEsperandoRespuesta() throws {
        let client = Harness().client()
        _ = client.prepareComment("Hola")
        let thread = try #require(client.threads.first)
        #expect(thread.comment == "Hola")
        #expect(thread.isAwaitingReply)
        #expect(!thread.hasUnread)
        #expect(thread.commentAt == Date(timeIntervalSince1970: 1_800_000_000))
    }

    @Test func sinComentariosNoConsulta() async {
        let harness = Harness()
        let client = harness.client()
        #expect(await client.syncIfNeeded(fcmToken: "t"))
        #expect(await client.sync(fcmToken: "t"))
        #expect(harness.worker.calls.isEmpty)
    }

    @Test func laRespuestaFormaUnHiloConElComentario() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref, text: "Ya está", comment: "Hola")

        #expect(await client.sync(fcmToken: "token"))
        let call = try #require(harness.worker.calls.first)
        #expect(call.path == "/replyback-test/v1/sync")
        #expect(call.refs == [ref])
        #expect(call.token == "token")

        #expect(client.threads.count == 1, "la copia local deja paso al hilo del Worker")
        let thread = try #require(client.threads.first)
        #expect(thread.comment == "Hola")
        #expect(thread.commentAt == Date(timeIntervalSince1970: 1_799_000_000))
        #expect(thread.replies.map(\.text) == ["Ya está"])
        #expect(thread.replies.first?.createdAt == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(!thread.isAwaitingReply)
        #expect(thread.hasUnread)
        #expect(client.unreadCount == 1)
    }

    @Test func variasRespuestasVanEnElMismoHiloDeAntiguaANueva() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r2", ref: ref, text: "Segunda", at: 1_800_000_001_000)
        harness.worker.reply("r1", ref: ref, text: "Primera", at: 1_800_000_000_000)
        await client.sync(fcmToken: nil)

        #expect(client.threads.count == 1)
        #expect(client.threads.first?.replies.map(\.text) == ["Primera", "Segunda"])
    }

    @Test func elHiloConActividadMasRecienteVaPrimero() async throws {
        let harness = Harness()
        let client = harness.client()
        let old = try ref(in: client.prepareComment("Antiguo"))
        let recent = try ref(in: client.prepareComment("Reciente"))
        harness.worker.reply("r1", ref: recent, comment: "Reciente", at: 1_800_000_000_000)
        harness.worker.reply("r2", ref: old, comment: "Antiguo", at: 1_800_000_009_000)
        await client.sync(fcmToken: nil)
        #expect(client.threads.map(\.comment) == ["Antiguo", "Reciente"])
    }

    @Test func comentariosConElMismoRefSonHilosDistintos() async throws {
        let harness = Harness()
        let client = harness.client()
        let legacy = LegacyRef.ref(userID: "user-1", deviceAppHash: hash)
        harness.worker.reply("r1", ref: legacy, comment: "Uno")
        harness.worker.reply("r2", ref: legacy, comment: "Dos")
        await client.checkLegacyReplies()
        #expect(Set(client.threads.map(\.comment)) == ["Uno", "Dos"])
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
        #expect(client.threads.first?.replies.count == 1)
        #expect(client.unreadCount == 0)
    }

    @Test func syncIfNeededRespetaElIntervaloYSoloPreguntaPorLosPendientes() async throws {
        let harness = Harness()
        let client = harness.client()
        let answered = try ref(in: client.prepareComment("Uno"))
        await client.syncIfNeeded(fcmToken: nil)
        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.count == 1)

        harness.worker.reply("r1", ref: answered)
        harness.clock.date += 901
        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.count == 2)

        harness.clock.date += 901
        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.count == 2, "sin pendientes no gasta peticiones")

        let pending = try ref(in: client.prepareComment("Dos"))
        harness.clock.date += 901
        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.last?.refs == [pending])
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
        #expect(client.threads.first?.replies.count == 1)
    }

    @Test func conservaElEstadoEntreArranques() async throws {
        let harness = Harness()
        let first = harness.client()
        let ref = try ref(in: first.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref)
        await first.sync(fcmToken: nil)
        first.markRead(replyID: "r1")

        let second = harness.client()
        #expect(second.threads.first?.comment == "Comentario")
        #expect(second.unreadCount == 0)
        await second.sync(fcmToken: nil)
        #expect(harness.worker.calls.last?.refs == [ref])
    }

    @Test func enOtroTelefonoRecuperaElHistoricoConLasLlaves() async throws {
        let harness = Harness()
        let oldPhone = harness.client()
        let ref = try ref(in: oldPhone.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref, text: "Respuesta", comment: "Hola")
        await oldPhone.sync(fcmToken: nil)
        let delivered = Int64((harness.clock.date.timeIntervalSince1970 - 3600) * 1000)
        harness.worker.repliesByRef[ref] = nil
        harness.worker.reply("r1", ref: ref, text: "Respuesta", comment: "Hola", deliveredAt: delivered)

        // Caché vacía, pero el Llavero sincronizado trae los `ref`.
        let newPhone = harness.client(storage: MemoryStorage())
        #expect(newPhone.threads.isEmpty)
        await newPhone.syncIfNeeded(fcmToken: "otro")
        #expect(newPhone.threads.first?.comment == "Hola")
        #expect(newPhone.threads.first?.replies.map(\.text) == ["Respuesta"])
        #expect(newPhone.unreadCount == 0, "ya se entregó en el teléfono anterior")
    }

    @Test func unaEntregaRecienteSigueSinLeer() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref, deliveredAt: Int64(harness.clock.date.timeIntervalSince1970 * 1000))
        await client.sync(fcmToken: nil)
        #expect(client.unreadCount == 1, "dos consultas a la vez no deben perder el punto")
    }

    @Test func cadaCuentaVeSoloLoSuyoYVuelveAlEntrar() async throws {
        let harness = Harness()
        let client = harness.client(account: "user-1")
        let ref = try ref(in: client.prepareComment("De la cuenta 1"))
        harness.worker.reply("r1", ref: ref, comment: "De la cuenta 1")
        await client.sync(fcmToken: nil)

        client.setAccount(userID: nil)
        #expect(client.threads.isEmpty)
        #expect(client.unreadCount == 0)

        client.setAccount(userID: "user-2")
        #expect(client.threads.isEmpty)
        await client.sync(fcmToken: nil)
        #expect(harness.worker.calls.count == 1, "la cuenta 2 no conoce los ref de la 1")

        client.setAccount(userID: "user-1")
        #expect(client.threads.first?.comment == "De la cuenta 1")
        #expect(client.unreadCount == 1)
    }

    @Test func unaConsultaEnCursoNoMezclaCuentas() async throws {
        let harness = Harness()
        let client = harness.client(account: "user-1")
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref)

        let (stream, continuation) = AsyncStream.makeStream(of: Void.self)
        harness.worker.gate = { for await _ in stream { break } }
        let running = Task { await client.sync(fcmToken: nil) }
        while harness.worker.calls.isEmpty { await Task.yield() }

        client.setAccount(userID: "user-2")
        continuation.yield()
        #expect(await running.value == false)
        #expect(client.threads.isEmpty)
    }

    @Test func deleteAllDataBorraEnElWorkerYEnElDispositivo() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref)
        await client.sync(fcmToken: nil)

        #expect(await client.deleteAllData())
        let call = try #require(harness.worker.calls.last)
        #expect(call.path == "/replyback-test/v1/delete")
        #expect(call.refs == [ref, LegacyRef.ref(userID: "user-1", deviceAppHash: hash)])
        #expect(client.threads.isEmpty)
        #expect(harness.storage.files.isEmpty)
        #expect(harness.refStore.items.isEmpty)
    }

    @Test func deleteAllDataConservaLasLlavesSiFalla() async throws {
        let harness = Harness()
        let client = harness.client()
        _ = client.prepareComment("Hola")
        harness.worker.status = 500
        #expect(await client.deleteAllData() == false)
        #expect(!harness.refStore.items.isEmpty)
        #expect(!client.threads.isEmpty)
    }

    @Test func comentariosAntiguosSinTokenYUnaVezPorCuentaYVersion() async throws {
        let harness = Harness()
        let client = harness.client(build: "45")
        #expect(await client.checkLegacyReplies())
        #expect(await client.checkLegacyReplies() == false)
        #expect(harness.worker.calls.count == 1)
        let call = try #require(harness.worker.calls.first)
        #expect(!call.hasTokenKey, "el Worker no debe guardar nada de quien no tenga respuesta")
        #expect(call.refs == [LegacyRef.ref(userID: "user-1", deviceAppHash: hash)])

        client.setAccount(userID: "user-2")
        #expect(await client.checkLegacyReplies())
        #expect(harness.worker.calls.count == 2)

        #expect(await harness.client(build: "46").checkLegacyReplies())
        #expect(harness.worker.calls.count == 3)
    }

    @Test func comentariosAntiguosEntreganElHiloYGuardanLaLlave() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = LegacyRef.ref(userID: "user-1", deviceAppHash: hash)
        harness.worker.reply("r1", ref: ref, text: "Antigua", comment: "Comentario antiguo")
        await client.checkLegacyReplies()
        #expect(client.threads.first?.comment == "Comentario antiguo")
        #expect(client.threads.first?.replies.map(\.text) == ["Antigua"])
        #expect(harness.refStore.items.values.first == [ref])

        await client.syncIfNeeded(fcmToken: nil)
        #expect(harness.worker.calls.count == 1, "ya respondido: no sigue consultando")
    }

    @Test func comentariosAntiguosSeReintentanSiFalla() async {
        var harness = Harness()
        harness.worker.status = 500
        let failing = harness.client()
        #expect(await failing.checkLegacyReplies() == false)
        harness.worker.status = 200
        #expect(await failing.checkLegacyReplies())

        harness = Harness()
        harness.deviceHash = nil
        #expect(await harness.client().checkLegacyReplies() == false)
        #expect(harness.worker.calls.isEmpty, "sin identificador del dispositivo no hay consulta")
    }

    @Test func aceptaRespuestasSinComentario() async throws {
        let harness = Harness()
        let client = harness.client()
        let ref = try ref(in: client.prepareComment("Hola"))
        harness.worker.reply("r1", ref: ref, comment: nil)
        await client.sync(fcmToken: nil)
        #expect(client.threads.first?.comment == nil)
        #expect(client.threads.first?.replies.count == 1)
    }

    @Test func reconoceElPush() {
        #expect(ReplybackClient.isReplyNotification(["type": "replyback.reply"]))
        #expect(!ReplybackClient.isReplyNotification(["type": "otro"]))
        #expect(!ReplybackClient.isReplyNotification([:]))
    }
}

struct ReplybackFileStorageTests {
    @Test func guardaLeeYBorraPorCuenta() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = ReplybackFileStorage(directory: directory)
        #expect(storage.load(key: "a") == nil)
        storage.save(Data("hola".utf8), key: "a")
        storage.save(Data("otra".utf8), key: "b")
        #expect(storage.load(key: "a") == Data("hola".utf8))
        let file = directory.appendingPathComponent("replyback/a.json")
        #expect(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        storage.delete(key: "a")
        #expect(storage.load(key: "a") == nil)
        #expect(storage.load(key: "b") == Data("otra".utf8))
    }
}
