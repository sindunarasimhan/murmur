import Foundation
import Security

@MainActor
final class ListeningAPI: ListeningService {
    let baseURL: URL
    private var token: String?
    private var identified = false
    private var identityTask: Task<Void, Error>?
    private let transport: URLSession

    init(baseURL: URL, transport: URLSession = .shared) {
        self.baseURL = baseURL
        self.transport = transport
        token = IdentityStore.read(service: baseURL.absoluteString)
    }

    var voiceURL: URL {
        var parts = URLComponents(url: baseURL.appendingPathComponent("v2/live-voice"), resolvingAgainstBaseURL: false)!
        parts.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        return parts.url!
    }

    private func identity() async throws {
        if identified { return }
        if let task = identityTask { return try await task.value }
        let task = Task { @MainActor in
            struct Identity: Decodable { let token: String? }
            let data = try await raw("identity", body: [:])
            let identity = try JSONDecoder().decode(Identity.self, from: data)
            if let value = identity.token {
                try IdentityStore.save(value, service: baseURL.absoluteString)
                token = value
            }
            identified = true
        }
        identityTask = task
        defer { identityTask = nil }
        try await task.value
    }

    private func raw(_ path: String, body: [String: Any]? = nil) async throws -> Data {
        guard let url = URL(string: "v2/" + path, relativeTo: baseURL.appendingPathComponent("/"))?.absoluteURL else {
            throw MurmurError(message: "The server address is invalid.")
        }
        var request = URLRequest(url: url, timeoutInterval: 35)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue("v2", forHTTPHeaderField: "X-Murmur-Client")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw MurmurError(message: "The server did not respond.") }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { identified = false }
            struct Failure: Decodable { struct Detail: Decodable { let message: String }; let error: Detail }
            throw MurmurError(message: (try? JSONDecoder().decode(Failure.self, from: data).error.message) ?? "The listening service is unavailable.")
        }
        return data
    }

    private func json<T: Decodable>(_ path: String, body: [String: Any]? = nil) async throws -> T {
        try await identity()
        return try JSONDecoder().decode(T.self, from: await raw(path, body: body))
    }

    func catalog() async throws -> [Episode] { try await json("catalog") }
    func invite(history: [String]) async throws -> String {
        struct Invitation: Decodable { let message: String }
        let value: Invitation = try await json("catalog/invite", body: ["history": Array(history.suffix(4))])
        return value.message
    }
    func resolve(_ text: String, episodeID: String?, history: [String]) async throws -> CatalogResolution {
        var body: [String: Any] = ["utterance": String(text.prefix(1000)), "history": Array(history.suffix(4))]
        if let episodeID { body["currentEpisodeId"] = episodeID }
        return try await json("catalog/resolve", body: body)
    }
    func open(_ episode: Episode) async throws -> ListeningSession { try await json("sessions", body: ["episodeId": episode.id]) }
    private func snapshot(_ session: ListeningSession, position: Double) -> [String: Any] {
        ["revision": session.revision, "audioVersion": session.audioVersion, "positionSeconds": max(0, min(86400, position.isFinite ? position : 0))]
    }
    func observe(_ session: ListeningSession, reason: String, position: Double) async throws -> ListeningSession {
        let fresh: ListeningSession = try await json("sessions/\(session.id)")
        var body = snapshot(fresh, position: position); body["reason"] = reason
        return try await json("sessions/\(session.id)/observations", body: body)
    }
    func turn(_ session: ListeningSession, text: String, position: Double, resume: Bool) async throws -> TurnResult {
        var body = snapshot(session, position: position)
        body["utterance"] = String(text.prefix(1000)); body["requestId"] = UUID().uuidString
        body["resumeAfterAction"] = resume
        return try await json("sessions/\(session.id)/turns", body: body)
    }
    func acknowledge(_ session: ListeningSession, action: PlaybackAction, position: Double) async throws -> ListeningSession {
        var body = snapshot(session, position: position); body["actionId"] = action.id
        return try await json("sessions/\(session.id)/acknowledgements", body: body)
    }
    func captions(_ episode: Episode) async throws -> CaptionTrack {
        let id = episode.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? episode.id
        return try await json("catalog/\(id)/captions?audioVersion=\(episode.audioVersion)")
    }
    func speech(_ text: String) async throws -> Data { try await identity(); return try await raw("speech", body: ["text": text]) }
    func ticket() async throws -> VoiceTicket { try await json("live-voice-ticket", body: [:]) }
    func mediaURL(_ episode: Episode) throws -> URL {
        guard let path = episode.audioPath,
              let url = URL(string: path.hasPrefix("/") ? "v2" + path : path, relativeTo: baseURL.appendingPathComponent("/"))?.absoluteURL,
              ["https", "http"].contains(url.scheme) else { throw MurmurError(message: "This episode has no playable audio.") }
        return url
    }
}

private enum IdentityStore {
    static func query(service: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Murmur." + service, kSecAttrAccount as String: "listener"]
    }
    static func read(service: String) -> String? {
        var query = query(service: service)
        query[kSecReturnData as String] = true
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ token: String, service: String) throws {
        let key = query(service: service)
        let attributes = [kSecValueData as String: Data(token.utf8)]
        let status = SecItemUpdate(key as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = key.merging(attributes) { _, new in new }
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw MurmurError(message: "Could not save the listening identity securely.") }
        } else if status != errSecSuccess { throw MurmurError(message: "Could not update the listening identity.") }
    }
}
