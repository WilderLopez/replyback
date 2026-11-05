import Foundation

public struct ReplybackConfiguration: Sendable {
    public let workerURL: URL
    /// Separación mínima entre consultas de `syncIfNeeded`.
    public let minimumSyncInterval: TimeInterval

    public init(workerURL: URL, minimumSyncInterval: TimeInterval = 15 * 60) {
        self.workerURL = workerURL
        self.minimumSyncInterval = minimumSyncInterval
    }
}

/// Respuesta de soporte a un comentario del usuario.
public struct ReplybackReply: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let createdAt: Date
    public internal(set) var isRead: Bool
}

/// Lo que la app guarda de un comentario. El `id` da acceso a sus respuestas: no debe salir del
/// dispositivo salvo en el comentario y en las consultas al Worker.
struct TrackedRef: Codable, Equatable {
    let id: String
    let createdAt: Date
    var answeredAt: Date?
}

struct ReplybackState: Codable, Equatable {
    var refs: [TrackedRef] = []
    var replies: [ReplybackReply] = []
    var legacyChecks: Set<String> = []
    var lastSyncAt: Date?
}
