import CryptoKit
import Foundation
import Observation

/// Enlaza los comentarios del usuario con las respuestas de soporte.
///
/// - La fuente de verdad es el Worker. El dispositivo guarda los `ref` en el Llavero y una caché.
/// - El SDK no presenta interfaz ni depende de Sentry: la app envía el mensaje de `prepareComment`
///   por su canal y pinta `threads` donde quiera.
/// - Los fallos de red no se propagan como errores: se reintenta en la siguiente consulta.
@MainActor
@Observable
public final class ReplybackClient {
    public private(set) var threads: [ReplybackThread] = []
    public private(set) var unreadCount = 0

    @ObservationIgnored private var userID: String?
    @ObservationIgnored private var state = AccountState()
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let configuration: ReplybackConfiguration
    @ObservationIgnored private let storage: any ReplybackStorage
    @ObservationIgnored private let refStore: any ReplybackRefStore
    @ObservationIgnored private let transport: Transport
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let deviceAppHash: @MainActor () -> String?
    @ObservationIgnored private let appBuild: String

    private static let maxRefsPerRequest = 20
    /// Una respuesta entregada hace rato la recogió otra instalación, y ahí ya se pudo leer.
    private static let readOnArrivalAge: TimeInterval = 60

    public convenience init(
        configuration: ReplybackConfiguration,
        storage: any ReplybackStorage = ReplybackFileStorage(),
        refStore: any ReplybackRefStore = ReplybackKeychainRefStore()
    ) {
        self.init(
            configuration: configuration,
            storage: storage,
            refStore: refStore,
            transport: { try await URLSession.shared.data(for: $0) },
            now: { Date() },
            deviceAppHash: { currentDeviceAppHash() },
            appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        )
    }

    init(
        configuration: ReplybackConfiguration,
        storage: any ReplybackStorage,
        refStore: any ReplybackRefStore,
        transport: @escaping Transport,
        now: @escaping @Sendable () -> Date,
        deviceAppHash: @escaping @MainActor () -> String?,
        appBuild: String
    ) {
        self.configuration = configuration
        self.storage = storage
        self.refStore = refStore
        self.transport = transport
        self.now = now
        self.deviceAppHash = deviceAppHash
        self.appBuild = appBuild
    }

    /// Cuenta activa, o `nil` al cerrar sesión. Sus datos se ocultan pero no se borran, y vuelven cuando
    /// esa cuenta entra de nuevo. Una consulta en curso de la cuenta anterior ya no los repone.
    public func setAccount(userID newUserID: String?) {
        guard newUserID != userID else { return }
        generation += 1
        userID = newUserID
        state = AccountState()
        if let key = accountKey {
            state = storage.load(key: key).flatMap { try? JSONDecoder().decode(AccountState.self, from: $0) } ?? AccountState()
            let known = Set(state.refs)
            state.refs += refStore.load(key: key).filter { !known.contains($0) }
        }
        publish()
    }

    /// Crea el `ref` del comentario y devuelve el mensaje que la app debe enviar. Llama después a
    /// `sync(fcmToken:)` para registrar el token. Sin cuenta activa no se podrá enlazar la respuesta,
    /// así que el mensaje sale sin `ref`.
    public func prepareComment(_ message: String) -> String {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard userID != nil else { return text }
        let ref = UUID().uuidString.lowercased()
        state.refs.append(ref)
        state.pending.append(PendingComment(ref: ref, text: text, createdAt: now()))
        saveRefs()
        commit()
        return "\(text)\n\nref:\(ref)"
    }

    /// Para abrir la app o volver a primer plano: solo consulta si hay comentarios sin responder, y
    /// no más de una vez por `minimumSyncInterval`.
    @discardableResult
    public func syncIfNeeded(fcmToken: String?) async -> Bool {
        let answered = Set(state.replies.map(\.ref))
        let pending = state.refs.filter { !answered.contains($0) }
        guard !pending.isEmpty else { return true }
        if let last = state.lastSyncAt, now().timeIntervalSince(last) < configuration.minimumSyncInterval { return true }
        return await fetch(refs: pending, fcmToken: fcmToken)
    }

    /// Para después de enviar un comentario, recibir el push o abrir la pantalla de comentarios.
    /// Incluye los ya respondidos, porque soporte puede volver a responder.
    @discardableResult
    public func sync(fcmToken: String?) async -> Bool {
        await fetch(refs: state.refs, fcmToken: fcmToken)
    }

    /// Busca respuestas a comentarios anteriores al SDK, una vez por cuenta y versión. No envía token,
    /// así que el Worker no guarda nada de quien no tenga respuesta.
    @discardableResult
    public func checkLegacyReplies() async -> Bool {
        guard let userID, let ref = legacyRef(userID: userID) else { return false }
        let key = "\(appBuild)"
        guard !state.legacyChecks.contains(key) else { return false }

        let startedIn = generation
        guard let received = try? await post(path: "v1/sync", body: SyncRequest(refs: [ref], fcm_token: nil), as: SyncResponse.self).replies,
              startedIn == generation else { return false }
        state.legacyChecks.insert(key)
        if !received.isEmpty, !state.refs.contains(ref) {
            state.refs.append(ref)
            saveRefs()
        }
        merge(received)
        return true
    }

    public func markRead(replyID: String) {
        guard let index = state.replies.firstIndex(where: { $0.id == replyID }), !state.replies[index].isRead else { return }
        state.replies[index].isRead = true
        commit()
    }

    /// Borra en el Worker y en este dispositivo todo lo de la cuenta activa, por ejemplo al eliminarla.
    /// Si falla, conserva las llaves para poder reintentar.
    @discardableResult
    public func deleteAllData() async -> Bool {
        guard let userID, let key = accountKey else { return false }
        var refs = state.refs
        if let legacy = legacyRef(userID: userID), !refs.contains(legacy) { refs.append(legacy) }

        let startedIn = generation
        do {
            for start in stride(from: 0, to: refs.count, by: Self.maxRefsPerRequest) {
                let batch = Array(refs[start..<min(start + Self.maxRefsPerRequest, refs.count)])
                _ = try await post(path: "v1/delete", body: SyncRequest(refs: batch, fcm_token: nil), as: EmptyResponse.self)
            }
        } catch {
            return false
        }
        storage.delete(key: key)
        refStore.delete(key: key)
        guard startedIn == generation else { return true }
        state = AccountState()
        publish()
        return true
    }

    /// `true` si el push es un aviso de respuesta.
    public nonisolated static func isReplyNotification(_ userInfo: [AnyHashable: Any]) -> Bool {
        userInfo["type"] as? String == "replyback.reply"
    }

    private var accountKey: String? {
        userID.map { id in SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined() }
    }

    private func legacyRef(userID: String) -> String? {
        deviceAppHash().map { LegacyRef.ref(userID: userID, deviceAppHash: $0) }
    }

    private func fetch(refs: [String], fcmToken: String?) async -> Bool {
        guard !refs.isEmpty else { return true }
        let startedIn = generation
        var received: [WireReply] = []
        do {
            for start in stride(from: 0, to: refs.count, by: Self.maxRefsPerRequest) {
                let batch = Array(refs[start..<min(start + Self.maxRefsPerRequest, refs.count)])
                received += try await post(path: "v1/sync", body: SyncRequest(refs: batch, fcm_token: fcmToken), as: SyncResponse.self).replies
            }
        } catch {
            return false
        }
        guard startedIn == generation else { return false }
        state.lastSyncAt = now()
        merge(received)
        return true
    }

    private func post<Body: Encodable, Response: Decodable>(path: String, body: Body, as type: Response.Type) async throws -> Response {
        var request = URLRequest(url: configuration.workerURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await transport(request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(type, from: data)
    }

    private func merge(_ received: [WireReply]) {
        let known = Set(state.replies.map(\.id))
        let date = now()
        for wire in received where !known.contains(wire.reply_id) {
            let readElsewhere = wire.delivered_at.map { date.timeIntervalSince(Self.date($0)) > Self.readOnArrivalAge } ?? false
            state.replies.append(StoredReply(
                id: wire.reply_id,
                ref: wire.ref,
                text: wire.text,
                comment: wire.comment,
                commentAt: wire.comment_at.map(Self.date),
                createdAt: Self.date(wire.created_at),
                isRead: readElsewhere
            ))
        }
        let answered = Set(state.replies.map(\.ref))
        state.pending.removeAll { answered.contains($0.ref) }
        commit()
    }

    private static func date(_ milliseconds: Int64) -> Date {
        Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
    }

    private func saveRefs() {
        guard let key = accountKey else { return }
        refStore.save(state.refs, key: key)
    }

    private func commit() {
        if let key = accountKey, let data = try? JSONEncoder().encode(state) {
            storage.save(data, key: key)
        }
        publish()
    }

    private func publish() {
        let answered = Dictionary(grouping: state.replies) { "\($0.ref)\n\($0.comment ?? "")" }.map { id, replies in
            let sorted = replies.sorted { $0.createdAt < $1.createdAt }
            return ReplybackThread(
                id: id,
                comment: sorted.first?.comment,
                commentAt: sorted.first?.commentAt,
                replies: sorted.map { ReplybackReply(id: $0.id, text: $0.text, createdAt: $0.createdAt, isRead: $0.isRead) }
            )
        }
        let waiting = state.pending.map {
            ReplybackThread(id: $0.ref, comment: $0.text, commentAt: $0.createdAt, replies: [])
        }
        threads = (answered + waiting).sorted { $0.lastActivity > $1.lastActivity }
        unreadCount = state.replies.count { !$0.isRead }
    }
}

typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

private struct SyncRequest: Encodable {
    let refs: [String]
    let fcm_token: String?
}

private struct SyncResponse: Decodable {
    let replies: [WireReply]
}

private struct EmptyResponse: Decodable {}

struct WireReply: Decodable, Sendable {
    let reply_id: String
    let ref: String
    let text: String
    let comment: String?
    let comment_at: Int64?
    let created_at: Int64
    let delivered_at: Int64?
}
