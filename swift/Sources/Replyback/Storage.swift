import Foundation
import Security

/// Caché local por cuenta.
public protocol ReplybackStorage: Sendable {
    func load(key: String) -> Data?
    func save(_ data: Data, key: String)
    func delete(key: String)
}

/// Dónde viven los `ref`. Son la llave de los datos del Worker: lo que no sobreviva aquí no se recupera.
public protocol ReplybackRefStore: Sendable {
    func load(key: String) -> [String]
    func save(_ refs: [String], key: String)
    func delete(key: String)
}

/// Fichero en Application Support, fuera de las copias de seguridad: es una caché.
public struct ReplybackFileStorage: ReplybackStorage {
    private let directory: URL

    public init(directory: URL = .applicationSupportDirectory) {
        self.directory = directory.appendingPathComponent("replyback", isDirectory: true)
    }

    private func url(_ key: String) -> URL {
        directory.appendingPathComponent("\(key).json", isDirectory: false)
    }

    public func load(key: String) -> Data? {
        try? Data(contentsOf: url(key))
    }

    public func save(_ data: Data, key: String) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var file = url(key)
            #if os(iOS)
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: file, options: .atomic)
            #endif
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try file.setResourceValues(values)
        } catch {
            // Sin disco no se puede hacer nada: el estado sigue en memoria y se reintenta al cambiar.
        }
    }

    public func delete(key: String) {
        try? FileManager.default.removeItem(at: url(key))
    }
}

/// Llavero con sincronización de iCloud: los `ref` sobreviven a reinstalar y pasan a otro iPhone con el
/// mismo Apple ID, si el usuario tiene activado el Llavero de iCloud.
public struct ReplybackKeychainRefStore: ReplybackRefStore {
    private let service: String

    public init(service: String = "replyback.refs") {
        self.service = service
    }

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: kCFBooleanTrue as Any,
        ]
    }

    public func load(key: String) -> [String] {
        var attributes = query(key)
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(attributes as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
            return []
        }
        return (try? JSONDecoder().decode([String].self, from: data)) ?? []
    }

    public func save(_ refs: [String], key: String) {
        guard let data = try? JSONEncoder().encode(refs) else { return }
        let status = SecItemUpdate(query(key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard status == errSecItemNotFound else { return }
        var attributes = query(key)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attributes as CFDictionary, nil)
    }

    public func delete(key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }
}
