import Foundation

struct Episode: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let showTitle: String
    let description: String
    let audioVersion: String
    let durationSeconds: Double
    let status: String
    let audioPath: String?
    let transcriptReady: Bool
    let guest: String?
    let artworkUrl: String?
}

struct PlaybackAction: Codable, Equatable, Sendable {
    enum Kind: String, Codable { case play, pause, seek, `return`; case skipAd = "skip-ad", skipIntro = "skip-intro", setAdSkipping = "set-ad-skipping" }
    let id: String
    let kind: Kind
    let positionSeconds: Double
    let play: Bool
    var enabled: Bool? = nil
    var plan: AdPlan? = nil
}

struct ListeningSession: Codable, Sendable {
    let id: String
    let episodeId: String
    let audioVersion: String
    let revision: Int
    let positionSeconds: Double
    let bookmarkSeconds: Double?
    let phase: String
    let pendingAction: PlaybackAction?
    var adSkipping: Bool? = nil
}

struct AdPlan: Codable, Equatable, Sendable {
    enum Status: String, Codable { case ready, partial, unavailable }
    struct Interval: Codable, Equatable, Sendable {
        let id: String
        let startSeconds: Double
        let endSeconds: Double
    }
    let audioVersion: String
    let revision: Int
    let status: Status
    let intervals: [Interval]

    func validate(audioVersion: String, duration: Double) throws {
        guard self.audioVersion == audioVersion, !audioVersion.isEmpty, revision >= 0,
              duration.isFinite, duration > 0,
              status != .unavailable || intervals.isEmpty else {
            throw MurmurError(message: "The ad markers do not match this recording.")
        }
        var end = 0.0
        var ids = Set<String>()
        for interval in intervals {
            guard !interval.id.isEmpty, ids.insert(interval.id).inserted,
                  interval.startSeconds.isFinite, interval.endSeconds.isFinite,
                  interval.startSeconds >= end, interval.endSeconds > interval.startSeconds,
                  interval.endSeconds <= duration else {
                throw MurmurError(message: "The ad markers contain invalid playback positions.")
            }
            end = interval.endSeconds
        }
    }

    func destination(at position: Double) -> Double? {
        guard position.isFinite else { return nil }
        var target = position
        for interval in intervals where target >= interval.startSeconds && target < interval.endSeconds {
            target = interval.endSeconds
        }
        return target > position ? target : nil
    }
}

struct CatalogResolution: Codable, Sendable {
    enum Kind: String, Codable { case play, current, clarify, stop, home, cancel }
    let kind: Kind
    let episode: Episode?
    let message: String
}

struct TurnResult: Codable, Sendable {
    let requestId: String
    let session: ListeningSession
    let answer: String
    let decision: String
    let action: PlaybackAction?
    let followUp: Bool?
}

struct CaptionTrack: Codable, Sendable {
    struct Cue: Codable, Sendable {
        let startSeconds: Double
        let endSeconds: Double
        let text: String
    }
    let audioVersion: String
    let cues: [Cue]

    func text(at seconds: Double) -> String {
        cues.first { seconds >= $0.startSeconds && seconds < $0.endSeconds }?.text ?? ""
    }
}

struct VoiceTicket: Codable, Sendable { let token: String; let leaseMilliseconds: Double }

struct MurmurError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
protocol ListeningService {
    func catalog() async throws -> [Episode]
    func invite(history: [String]) async throws -> String
    func resolve(_ text: String, episodeID: String?, history: [String]) async throws -> CatalogResolution
    func open(_ episode: Episode) async throws -> ListeningSession
    func observe(_ session: ListeningSession, reason: String, position: Double) async throws -> ListeningSession
    func turn(_ session: ListeningSession, text: String, position: Double, resume: Bool) async throws -> TurnResult
    func acknowledge(_ session: ListeningSession, action: PlaybackAction, position: Double) async throws -> ListeningSession
    func captions(_ episode: Episode) async throws -> CaptionTrack
    func speech(_ text: String) async throws -> Data
    func ticket() async throws -> VoiceTicket
    func mediaURL(_ episode: Episode) throws -> URL
    var voiceURL: URL { get }
}
