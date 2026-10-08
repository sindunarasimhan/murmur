import Foundation
import Observation

@MainActor
@Observable
final class ConversationModel {
    enum Phase: String { case idle, connecting, listening, thinking, speaking, playing, paused, error }
    private(set) var phase: Phase = .idle
    private(set) var catalog: [Episode] = []
    private(set) var episode: Episode?
    private(set) var detailVisible = false
    private(set) var heard = ""
    private(set) var reply = ""
    private(set) var error: String?
    private(set) var microphone = false
    private(set) var speechLevel = 0.0
    private(set) var position = 0.0
    private(set) var playing = false
    private(set) var captions: CaptionTrack?
    private let api: ListeningService
    private let player: PodcastPlayback
    private let speech: AssistantSpeech
    private var session: ListeningSession?
    private var history: [String] = []
    private var work: Task<Void, Never>?
    private var silence: Task<Void, Never>?
    private var generation = 0
    private var foreground = true
    private var accepting = false
    private var interaction: (position: Double, playing: Bool)?
    private var consumed: Set<String> = []
    private var pendingReply: (String, String)?
    private var recentSpeech = ""
    private var recentSpeechUntil = Date.distantPast
    private var activation: Task<Void, Never>?
    private var microphoneGeneration = 0
    private struct PendingAdAcknowledgement {
        let session: ListeningSession
        let action: PlaybackAction
        let position: Double
        let generation: Int
    }
    private var pendingAdAcknowledgement: PendingAdAcknowledgement?
    private var adCommit: Task<ListeningSession, Error>?
    private var adCommitID: UUID?
    private var adPolicyGeneration = 0
    var startMicrophone: (() async throws -> Void)?
    var stopMicrophone: (() -> Void)?

    init(api: ListeningService, player: PodcastPlayback, speech: AssistantSpeech) {
        self.api = api; self.player = player; self.speech = speech
        player.onChange = { [weak self] in
            guard let self else { return }
            self.position = self.player.position
            self.playing = self.player.playing
            if self.playing, self.episode != nil { self.detailVisible = true }
        }
        speech.onLevel = { [weak self] value in self?.speechLevel = value }
    }

    var podcastCaption: String { captions?.text(at: position) ?? "" }
    var isListening: Bool { accepting && phase == .listening && microphone }

    func loadCatalog() async {
        do { catalog = try await api.catalog() }
        catch { self.error = error.localizedDescription }
    }

    func activate() async {
        guard foreground, !microphone else { return }
        if let activation { await activation.value; return }
        let epoch = microphoneGeneration
        let task = Task { [weak self] in
            guard let self else { return }
            self.phase = .connecting
            do {
                try await self.startMicrophone?()
                guard !Task.isCancelled, self.foreground, epoch == self.microphoneGeneration else { return }
                self.microphone = true
                self.setPlaybackPhase(); self.error = nil
            } catch {
                if epoch == self.microphoneGeneration, !Task.isCancelled { self.fail(error) }
            }
        }
        activation = task
        await task.value
        if epoch == microphoneGeneration { activation = nil }
    }

    func microphoneFailed(_ error: Error) {
        stopMicrophone?(); microphone = false
        self.error = error.localizedDescription
    }

    func tap() {
        guard foreground else { return }
        invalidate()
        beginInteraction()
        accepting = true; heard = ""; reply = ""; phase = .listening; error = nil
        if microphone { armSilence() }
        else {
            let epoch = generation
            work = Task { [weak self] in
                guard let self else { return }
                await self.activate()
                guard self.generation == epoch, self.microphone else { return }
                self.phase = .listening; self.armSilence()
            }
        }
    }

    private func beginInteraction() {
        if episode != nil, interaction == nil { interaction = (player.position, player.playing) }
        player.pause()
    }

    static func wakeRequest(_ text: String) -> String? {
        guard let range = text.range(of: #"\bhey[\s,]+(?:murmur|murmer|mur\s+mur)\b[\s,.:!?-]*"#, options: .regularExpression) else { return nil }
        return String(text[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalized(_ text: String) -> String {
        text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
    }

    func receive(_ text: String, item: String, final: Bool) {
        guard foreground, microphone, !consumed.contains(item) else { return }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { if final { consume(item) }; return }
        if Date() < recentSpeechUntil, Self.normalized(text) == Self.normalized(recentSpeech) {
            if final { consume(item) }; return
        }
        let request = Self.wakeRequest(text.lowercased())
        if phase == .speaking || phase == .thinking {
            if request == nil {
                if accepting { heard = text; if final { pendingReply = (text, item) } }
                return
            }
        }
        if !accepting {
            guard request != nil else { return }
            invalidate(); beginInteraction(); accepting = true; phase = .listening
        }
        heard = text
        if phase == .listening { armSilence() }
        guard final else { return }
        consume(item)
        if let request, request.isEmpty { invite() }
        else { submit(request ?? text) }
    }

    private func consume(_ id: String) {
        if consumed.count > 256 { consumed.removeAll() }
        consumed.insert(id)
    }

    private func invalidate() {
        generation += 1; work?.cancel(); silence?.cancel(); speech.stop(); pendingReply = nil
    }
    private func check(_ epoch: Int) throws {
        try Task.checkCancellation()
        guard foreground, generation == epoch else { throw CancellationError() }
    }

    private func invite() {
        if episode != nil { phase = .listening; armSilence(); return }
        run { epoch in
            self.accepting = true
            let message = try await self.api.invite(history: self.history)
            try self.check(epoch)
            self.remember("Hey Murmur", message)
            try await self.say(message, epoch: epoch)
            self.listenForReply()
        }
    }

    func submit(_ text: String) {
        guard foreground, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        beginInteraction()
        if heard.isEmpty { heard = text }
        run { epoch in
            let resolution = try await self.api.resolve(text, episodeID: self.episode?.id, history: self.history)
            try self.check(epoch)
            switch resolution.kind {
            case .play:
                guard let episode = resolution.episode else { throw MurmurError(message: "No episode was returned.") }
                try await self.startEpisode(episode, message: resolution.message, epoch: epoch)
            case .current:
                try await self.reconcileAdAcknowledgement()
                try self.check(epoch)
                guard let session = self.session else { throw MurmurError(message: "Choose an episode first.") }
                let snapshot = self.interaction ?? (self.player.position, self.player.playing)
                let current = try await self.api.observe(session, reason: "interrupt", position: snapshot.0)
                try self.check(epoch); self.session = current
                let turn = try await self.api.turn(current, text: text, position: snapshot.0, resume: snapshot.1)
                try self.check(epoch); self.session = turn.session
                if let action = turn.action {
                    if action.kind == .setAdSkipping {
                        guard let enabled = action.enabled, let plan = action.plan, let episode = self.episode,
                              plan.audioVersion == turn.session.audioVersion else {
                            throw MurmurError(message: "The ad-skip response was incomplete.")
                        }
                        try plan.validate(audioVersion: episode.audioVersion, duration: episode.durationSeconds)
                        guard !enabled || plan.status != .unavailable else { throw MurmurError(message: "Ad markers are unavailable for this episode.") }
                    }
                    try await self.say(self.confirmation(action), epoch: epoch)
                    let acknowledged: ListeningSession
                    if action.kind == .setAdSkipping {
                        acknowledged = try await self.commitAdPolicy(action, session: turn.session)
                    } else {
                        if action.kind != .pause { try await self.player.seek(action.positionSeconds); try self.check(epoch) }
                        acknowledged = try await self.api.acknowledge(turn.session, action: action, position: self.player.position)
                    }
                    try self.check(epoch); self.session = acknowledged
                    self.interaction = nil; self.accepting = false
                    if action.play { try await self.player.play(); try self.check(epoch) } else { self.player.pause() }
                    self.setPlaybackPhase()
                } else {
                    self.remember(text, turn.answer)
                    try await self.say(turn.answer, epoch: epoch)
                    try await self.restore(epoch)
                }
            case .home, .stop:
                try await self.say(resolution.message.isEmpty ? "Ending this episode." : resolution.message, epoch: epoch)
                self.abandonAdAcknowledgement()
                self.player.clear(); self.session = nil; self.episode = nil; self.detailVisible = false
                self.captions = nil; self.interaction = nil; self.history = []; self.accepting = false; self.phase = .idle
            case .cancel:
                try await self.restore(epoch)
            case .clarify:
                self.remember(text, resolution.message)
                try await self.say(resolution.message, epoch: epoch)
                self.listenForReply()
            }
        }
    }

    func choose(_ episode: Episode) {
        guard foreground else { return }
        beginInteraction()
        run { epoch in try await self.startEpisode(episode, message: "\(episode.showTitle). \(episode.guest ?? episode.title).", epoch: epoch) }
    }

    private func startEpisode(_ next: Episode, message: String, epoch: Int) async throws {
        try check(epoch)
        let opened = try await api.open(next)
        try check(epoch)
        if episode?.id == next.id {
            abandonAdAcknowledgement()
            try player.restoreAdSkipping(nil)
            session = opened
        }
        let saved = opened.bookmarkSeconds ?? opened.positionSeconds
        let position = saved >= next.durationSeconds - 1 ? 0 : saved
        let prepared = try await api.observe(opened, reason: "cancel", position: position)
        try check(epoch)
        let mediaURL = try api.mediaURL(next)
        abandonAdAcknowledgement()
        do { try await player.load(next, url: mediaURL, position: position) }
        catch {
            if generation == epoch {
                player.clear(); session = nil; episode = nil; captions = nil; detailVisible = false
                interaction = nil; history = []
            }
            throw error
        }
        try check(epoch)
        session = prepared; episode = next; captions = nil; history = []
        try await say(message, epoch: epoch)
        try await player.play(); try check(epoch)
        detailVisible = true; interaction = nil; accepting = false; phase = .playing; heard = ""
        session = try await api.observe(prepared, reason: "play", position: player.position)
        try check(epoch)
        do { let track = try await api.captions(next); try check(epoch); captions = track }
        catch is CancellationError { throw CancellationError() }
        catch { self.error = "Captions are unavailable; audio can continue." }
    }

    private func commitAdPolicy(_ action: PlaybackAction, session: ListeningSession) async throws -> ListeningSession {
        guard let enabled = action.enabled, let plan = action.plan else {
            throw MurmurError(message: "The ad-skip response was incomplete.")
        }
        let identifier = UUID()
        let policyEpoch = adPolicyGeneration
        let transaction = Task { @MainActor in
            guard self.adPolicyGeneration == policyEpoch else { throw CancellationError() }
            let previous = self.player.adSkippingPlan
            try self.player.setAdSkipping(enabled: enabled, plan: plan)
            do { try await self.player.seek(action.positionSeconds) }
            catch {
                if self.adPolicyGeneration == policyEpoch { try self.player.restoreAdSkipping(previous) }
                throw error
            }
            guard self.adPolicyGeneration == policyEpoch else { throw CancellationError() }
            if let interaction = self.interaction {
                self.interaction = (self.player.position, interaction.playing)
            }
            let pending = PendingAdAcknowledgement(session: session, action: action, position: self.player.position, generation: policyEpoch)
            self.pendingAdAcknowledgement = pending
            return try await self.sendAdAcknowledgement(pending)
        }
        adCommit = transaction; adCommitID = identifier
        defer { if adCommitID == identifier { adCommit = nil; adCommitID = nil } }
        return try await transaction.value
    }

    private func sendAdAcknowledgement(_ pending: PendingAdAcknowledgement) async throws -> ListeningSession {
        guard pending.generation == adPolicyGeneration else { throw CancellationError() }
        let acknowledged = try await api.acknowledge(pending.session, action: pending.action, position: pending.position)
        guard pending.generation == adPolicyGeneration else { throw CancellationError() }
        if pendingAdAcknowledgement?.action.id == pending.action.id { pendingAdAcknowledgement = nil }
        if session?.id == acknowledged.id { session = acknowledged }
        return acknowledged
    }

    private func abandonAdAcknowledgement() {
        adPolicyGeneration += 1
        adCommit?.cancel(); adCommit = nil; adCommitID = nil
        pendingAdAcknowledgement = nil
    }

    private func reconcileAdAcknowledgement() async throws {
        if let adCommit {
            do { _ = try await adCommit.value }
            catch { if pendingAdAcknowledgement == nil { throw error } }
        }
        if let pending = pendingAdAcknowledgement {
            _ = try await sendAdAcknowledgement(pending)
        }
    }

    private func run(_ operation: @escaping @MainActor (Int) async throws -> Void) {
        invalidate(); let epoch = generation; phase = .thinking; error = nil
        work = Task { [weak self] in
            guard let self else { return }
            do { try await operation(epoch) }
            catch is CancellationError { }
            catch { if self.generation == epoch { self.fail(error) } }
        }
    }

    private func say(_ text: String, epoch: Int) async throws {
        reply = text
        recentSpeech = text; recentSpeechUntil = .distantFuture
        defer { recentSpeechUntil = Date().addingTimeInterval(2) }
        let audio = try await api.speech(text); try check(epoch)
        phase = .speaking
        try await speech.say(audio); try check(epoch)
    }

    private func listenForReply() {
        accepting = true; phase = .listening; armSilence()
        if let pending = pendingReply {
            pendingReply = nil
            receive(pending.0, item: pending.1, final: true)
        }
    }

    private func remember(_ question: String, _ answer: String) {
        history = Array((history + [String(question.prefix(1000)), String(answer.prefix(1000))]).suffix(4))
    }

    private func confirmation(_ action: PlaybackAction) -> String {
        switch action.kind {
        case .pause: return "Pausing the podcast."
        case .skipAd: return action.play ? "Skipping the ad, then continuing." : "Skipping the ad and keeping it paused."
        case .skipIntro: return "Skipping the intro."
        case .setAdSkipping:
            return action.enabled == true ? "I'll skip the marked ads in this episode." : "Automatic ad skipping is off."
        case .seek: return "Moving to that point."
        case .play, .return: return "Resuming the podcast."
        }
    }

    private func restore(_ epoch: Int) async throws {
        let resume = interaction?.playing ?? false
        interaction = nil; accepting = false
        if resume { try await player.play(); try check(epoch) }
        setPlaybackPhase()
    }
    private func setPlaybackPhase() { phase = episode == nil ? .idle : player.playing ? .playing : .paused }
    private func fail(_ error: Error) {
        speech.stop(); accepting = false; phase = .error
        self.error = error.localizedDescription
    }
    private func armSilence() {
        silence?.cancel()
        guard episode != nil else { return }
        let epoch = generation
        silence = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(8))
                guard let self else { return }
                try self.check(epoch)
                try await self.restore(epoch)
            } catch { }
        }
    }
    func audioActivity() { if phase == .listening { armSilence() } }

    func background() {
        foreground = false; microphoneGeneration += 1; activation?.cancel(); activation = nil
        invalidate(); stopMicrophone?(); microphone = false; accepting = false
        let resume = interaction?.playing == true
        interaction = nil
        if resume {
            work = Task { [weak self] in
                guard let self else { return }
                do { try await self.player.play(); self.setPlaybackPhase() } catch { self.fail(error) }
            }
        } else { setPlaybackPhase() }
    }
    func foregrounded() async { foreground = true; await activate() }

    func remote(_ command: String, position: Double?) {
        invalidate(); interaction = nil; accepting = false
        work = Task { [weak self] in
            guard let self else { return }
            do {
                switch command {
                case "pause": self.player.pause()
                case "play": try await self.player.play()
                case "toggle": if self.player.playing { self.player.pause() } else { try await self.player.play() }
                case "forward": try await self.player.seek(self.player.position + 30)
                case "backward": try await self.player.seek(max(0, self.player.position - 15))
                case "seek": if let position { try await self.player.seek(position) }
                default: return
                }
                self.setPlaybackPhase()
            } catch is CancellationError { } catch { self.fail(error) }
        }
    }

    func waitForWork() async { await work?.value }
}
