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
public struct ReplybackReply: Identifiable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let createdAt: Date
    public let isRead: Bool
}

/// Un comentario del usuario y sus respuestas, de la más antigua a la más reciente.
public struct ReplybackThread: Identifiable, Equatable, Sendable {
    public let id: String
    /// `nil` solo en respuestas guardadas sin el comentario original.
    public let comment: String?
    public let commentAt: Date?
    public let replies: [ReplybackReply]

    /// Enviado desde este dispositivo y todavía sin respuesta.
    public var isAwaitingReply: Bool { replies.isEmpty }
    public var hasUnread: Bool { replies.contains { !$0.isRead } }
    var lastActivity: Date { replies.last?.createdAt ?? commentAt ?? .distantPast }
}

struct StoredReply: Codable, Equatable {
    let id: String
    let ref: String
    let text: String
    let comment: String?
    let commentAt: Date?
    let createdAt: Date
    var isRead: Bool
}

/// Copia local de lo enviado, solo para mostrar "esperando respuesta". El comentario llega al Worker
/// con la respuesta, y entonces esta copia ya no hace falta.
struct PendingComment: Codable, Equatable {
    let ref: String
    let text: String
    let createdAt: Date
}

/// Caché de una cuenta en este dispositivo. La fuente de verdad es el Worker: con los `ref` se
/// reconstruye todo lo demás.
struct AccountState: Codable, Equatable {
    var refs: [String] = []
    var pending: [PendingComment] = []
    var replies: [StoredReply] = []
    var legacyChecks: Set<String> = []
    var lastSyncAt: Date?
}
