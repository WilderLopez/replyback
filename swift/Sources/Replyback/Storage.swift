import Foundation

public protocol ReplybackStorage: Sendable {
    func load() -> Data?
    func save(_ data: Data)
    func delete()
}

/// Fichero en Application Support, fuera de las copias de seguridad: los `ref` son de este dispositivo.
public struct ReplybackFileStorage: ReplybackStorage {
    private let url: URL

    public init(directory: URL = .applicationSupportDirectory) {
        url = directory.appendingPathComponent("replyback/state.json", isDirectory: false)
    }

    public func load() -> Data? {
        try? Data(contentsOf: url)
    }

    public func save(_ data: Data) {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            #if os(iOS)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: url, options: .atomic)
            #endif
            var resource = url
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try resource.setResourceValues(values)
        } catch {
            // Sin disco no se puede hacer nada: el estado sigue en memoria y se reintenta al cambiar.
        }
    }

    public func delete() {
        try? FileManager.default.removeItem(at: url)
    }
}
