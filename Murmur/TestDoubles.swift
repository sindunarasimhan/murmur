#if DEBUG
import Foundation

@MainActor
final class TestPlayback: PodcastPlayback {
    var position = 0.0
    var playing = false
    var onChange: (() -> Void)?
    var loaded: [String] = []
    var failLoad = false
    var adPlan: AdPlan?
    var adSkippingPlan: AdPlan? { adPlan }
    var failSeek = false
    var currentEpisode: Episode?
    func load(_ episode: Episode, url: URL, position: Double) async throws {
        if failLoad { throw MurmurError(message: "Test loading failure") }
        adPlan = nil; currentEpisode = episode
        loaded.append(episode.id); self.position = position; playing = false; onChange?()
    }
    func play() async throws { try Task.checkCancellation(); playing = true; onChange?() }
    func pause() { playing = false; onChange?() }
    func seek(_ seconds: Double) async throws {
        if failSeek { throw MurmurError(message: "Test seek failure") }
        position = adPlan?.destination(at: seconds) ?? seconds; onChange?()
    }
    func setAdSkipping(enabled: Bool, plan: AdPlan) throws {
        guard let currentEpisode else { throw MurmurError(message: "No episode") }
        try plan.validate(audioVersion: currentEpisode.audioVersion, duration: currentEpisode.durationSeconds)
        adPlan = enabled ? plan : nil
    }
    func restoreAdSkipping(_ plan: AdPlan?) throws { adPlan = plan }
    func clear() { adPlan = nil; currentEpisode = nil; position = 0; playing = false; onChange?() }
}

@MainActor
final class TestSpeech: AssistantSpeech {
    var onLevel: ((Double) -> Void)?
    var fail = false
    var hold: (() async throws -> Void)?
    var spoken: [String] = []
    func say(_ data: Data) async throws {
        if fail { throw MurmurError(message: "Test speech failure") }
        spoken.append(String(decoding: data, as: UTF8.self))
        try await hold?()
    }
    func stop() { onLevel?(0) }
}

@MainActor
final class TestListeningService: ListeningService {
    static let episodes = ["Astronomy", "Design", "Biology"].enumerated().map { index, title in
        Episode(id: "fixture-\(index)", title: title, showTitle: "Test podcast", description: title,
                audioVersion: String(repeating: "a", count: 64), durationSeconds: 3600, status: "ready",
                audioPath: "https://example.com/fixture.mp3", transcriptReady: true, guest: title, artworkUrl: nil)
    }
    var selected = 0
    var savedPosition = 120.0
    var nextResolution: CatalogResolution?
    var nextAction: PlaybackAction?
    var question = false
    var requests: [String] = []
    var resolveBarrier: (() async throws -> Void)?
    var speechFailure = false
    var openFailure = false
    var acknowledgementBarrier: (() async throws -> Void)?
    var acknowledgements: [(String, Double)] = []
    var observedAfterAcknowledgements: [Int] = []
    var observations: [(reason: String, position: Double)] = []
    var voiceURL: URL { URL(string: "wss://example.com")! }
    func catalog() async throws -> [Episode] { Self.episodes }
    func invite(history: [String]) async throws -> String { "What would you like to hear?" }
    func resolve(_ text: String, episodeID: String?, history: [String]) async throws -> CatalogResolution {
        requests.append(text); try await resolveBarrier?()
        if let nextResolution { return nextResolution }
        if text.lowercased().contains("end") { return CatalogResolution(kind: .home, episode: nil, message: "Ending this episode.") }
        if episodeID != nil { return CatalogResolution(kind: .current, episode: nil, message: "") }
        return CatalogResolution(kind: .play, episode: Self.episodes[selected], message: "Starting \(Self.episodes[selected].title).")
    }
    func open(_ episode: Episode) async throws -> ListeningSession {
        if openFailure { throw MurmurError(message: "Episode could not open") }
        return ListeningSession(id: UUID().uuidString, episodeId: episode.id, audioVersion: episode.audioVersion, revision: 0,
                         positionSeconds: savedPosition, bookmarkSeconds: nil, phase: "paused", pendingAction: nil)
    }
    func observe(_ session: ListeningSession, reason: String, position: Double) async throws -> ListeningSession {
        observations.append((reason, position))
        observedAfterAcknowledgements.append(acknowledgements.count)
        return session
    }
    func turn(_ session: ListeningSession, text: String, position: Double, resume: Bool) async throws -> TurnResult {
        let pause = text.lowercased().contains("pause")
        let skip = text.lowercased().contains("skip")
        let action = question ? nil : nextAction ?? PlaybackAction(id: UUID().uuidString, kind: pause ? .pause : skip ? .skipAd : .play,
                                                                   positionSeconds: skip ? 180 : position, play: pause ? false : skip ? resume : true)
        return TurnResult(requestId: UUID().uuidString, session: session, answer: "A grounded test answer.", decision: "code", action: action, followUp: true)
    }
    func acknowledge(_ session: ListeningSession, action: PlaybackAction, position: Double) async throws -> ListeningSession {
        acknowledgements.append((action.id, position))
        try await acknowledgementBarrier?()
        return session
    }
    func captions(_ episode: Episode) async throws -> CaptionTrack { CaptionTrack(audioVersion: episode.audioVersion, cues: [.init(startSeconds: 0, endSeconds: 3600, text: "Test episode captions.")]) }
    func speech(_ text: String) async throws -> Data { if speechFailure { throw MurmurError(message: "Speech service unavailable") }; return Data(text.utf8) }
    func ticket() async throws -> VoiceTicket { VoiceTicket(token: "test", leaseMilliseconds: 60000) }
    func mediaURL(_ episode: Episode) throws -> URL { URL(string: episode.audioPath!)! }
}
#endif
