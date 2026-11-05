import Foundation
import Observation

/// Enlaza los comentarios del usuario con las respuestas de soporte.
///
/// - El SDK no presenta interfaz ni depende de Sentry: la app envía el mensaje de `prepareComment`
///   por su canal y pinta `replies` donde quiera.
/// - Los fallos de red no se propagan como errores: se reintenta en la siguiente consulta.
@MainActor
@Observable
public final class ReplybackClient {
    public private(set) var replies: [ReplybackReply]

    public var unreadCount: Int { replies.count { !$0.isRead } }

    @ObservationIgnored private var state: ReplybackState
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let configuration: ReplybackConfiguration
    @ObservationIgnored private let storage: any ReplybackStorage
    @ObservationIgnored private let transport: Transport
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let deviceAppHash: @MainActor () -> String?
    @ObservationIgnored private let appBuild: String

    private static let maxRefsPerRequest = 20
    private static let answeredRetention: TimeInterval = 30 * 24 * 3600
    private static let pendingRetention: TimeInterval = 180 * 24 * 3600

    public convenience init(configuration: ReplybackConfiguration, storage: any ReplybackStorage = ReplybackFileStorage()) {
        self.init(
            configuration: configuration,
            storage: storage,
            transport: { try await URLSession.shared.data(for: $0) },
            now: { Date() },
            deviceAppHash: { currentDeviceAppHash() },
            appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        )
    }

    init(
        configuration: ReplybackConfiguration,
        storage: any ReplybackStorage,
        transport: @escaping Transport,
        now: @escaping @Sendable () -> Date,
        deviceAppHash: @escaping @MainActor () -> String?,
        appBuild: String
    ) {
        self.configuration = configuration
        self.storage = storage
        self.transport = transport
        self.now = now
        self.deviceAppHash = deviceAppHash
        self.appBuild = appBuild
        let loaded = storage.load().flatMap { try? JSONDecoder().decode(ReplybackState.self, from: $0) }
        state = loaded ?? ReplybackState()
        replies = state.replies
        prune()
    }

    /// Crea el `ref` del comentario y devuelve el mensaje que la app debe enviar. Llama después a
    /// `sync(fcmToken:)` para registrar el token.
    public func prepareComment(_ message: String) -> String {
        let ref = UUID().uuidString.lowercased()
        state.refs.append(TrackedRef(id: ref, createdAt: now()))
        persist()
        return "\(message.trimmingCharacters(in: .whitespacesAndNewlines))\n\nref:\(ref)"
    }

    /// Para abrir la app o volver a primer plano: solo consulta si hay comentarios sin responder, y
    /// no más de una vez por `minimumSyncInterval`.
    @discardableResult
    public func syncIfNeeded(fcmToken: String?) async -> Bool {
        let pending = state.refs.filter { $0.answeredAt == nil }.map(\.id)
        guard !pending.isEmpty else { return true }
        if let last = state.lastSyncAt, now().timeIntervalSince(last) < configuration.minimumSyncInterval { return true }
        return await fetch(refs: pending, fcmToken: fcmToken)
    }

    /// Para después de enviar un comentario o de recibir el push. Incluye los ya respondidos, porque
    /// soporte puede volver a responder.
    @discardableResult
    public func sync(fcmToken: String?) async -> Bool {
        await fetch(refs: state.refs.map(\.id), fcmToken: fcmToken)
    }

    /// Busca respuestas a comentarios anteriores al SDK, una vez por cuenta y versión. No envía token,
    /// así que el Worker no guarda nada de quien no tenga respuesta.
    @discardableResult
    public func checkLegacyReplies(userID: String) async -> Bool {
        let key = "\(userID)#\(appBuild)"
        guard !state.legacyChecks.contains(key), let hash = deviceAppHash() else { return false }
        let ref = LegacyRef.ref(userID: userID, deviceAppHash: hash)

        let startedIn = generation
        guard let received = try? await post(refs: [ref], fcmToken: nil), startedIn == generation else { return false }
        state.legacyChecks.insert(key)
        if !received.isEmpty, !state.refs.contains(where: { $0.id == ref }) {
            state.refs.append(TrackedRef(id: ref, createdAt: now()))
        }
        merge(received)
        return true
    }

    public func markRead(replyID: String) {
        guard let index = state.replies.firstIndex(where: { $0.id == replyID }), !state.replies[index].isRead else { return }
        state.replies[index].isRead = true
        replies = state.replies
        persist()
    }

    /// Borra los datos locales, por ejemplo al cerrar sesión. Una consulta en curso ya no los repone.
    public func reset() {
        generation += 1
        state = ReplybackState()
        replies = []
        storage.delete()
    }

    /// `true` si el push es un aviso de respuesta.
    public nonisolated static func isReplyNotification(_ userInfo: [AnyHashable: Any]) -> Bool {
        userInfo["type"] as? String == "replyback.reply"
    }

    private func fetch(refs: [String], fcmToken: String?) async -> Bool {
        guard !refs.isEmpty else { return true }
        let startedIn = generation
        var received: [WireReply] = []
        do {
            for start in stride(from: 0, to: refs.count, by: Self.maxRefsPerRequest) {
                let batch = Array(refs[start..<min(start + Self.maxRefsPerRequest, refs.count)])
                received += try await post(refs: batch, fcmToken: fcmToken)
            }
        } catch {
            return false
        }
        guard startedIn == generation else { return false }
        state.lastSyncAt = now()
        merge(received)
        return true
    }

    private func post(refs: [String], fcmToken: String?) async throws -> [WireReply] {
        var request = URLRequest(url: configuration.workerURL.appendingPathComponent("v1/sync"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(SyncRequest(refs: refs, fcm_token: fcmToken))
        let (data, response) = try await transport(request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(SyncResponse.self, from: data).replies
    }

    private func merge(_ received: [WireReply]) {
        let known = Set(state.replies.map(\.id))
        for wire in received where !known.contains(wire.reply_id) {
            state.replies.append(ReplybackReply(
                id: wire.reply_id,
                text: wire.text,
                createdAt: Date(timeIntervalSince1970: TimeInterval(wire.created_at) / 1000),
                isRead: false
            ))
        }
        let answered = Set(received.map(\.ref))
        for index in state.refs.indices where state.refs[index].answeredAt == nil && answered.contains(state.refs[index].id) {
            state.refs[index].answeredAt = now()
        }
        state.replies.sort { $0.createdAt > $1.createdAt }
        replies = state.replies
        persist()
    }

    /// El Worker borra lo entregado y lo que nadie recogió, así que consultar más allá no sirve de nada.
    private func prune() {
        let date = now()
        let kept = state.refs.filter { ref in
            if let answeredAt = ref.answeredAt { return date.timeIntervalSince(answeredAt) < Self.answeredRetention }
            return date.timeIntervalSince(ref.createdAt) < Self.pendingRetention
        }
        guard kept != state.refs else { return }
        state.refs = kept
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(state) else { return }
        storage.save(data)
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

struct WireReply: Decodable, Sendable {
    let reply_id: String
    let ref: String
    let text: String
    let created_at: Int64
}
