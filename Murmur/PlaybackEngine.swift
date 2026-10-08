import AVFoundation
import MediaPlayer
import Observation

@MainActor
protocol PodcastPlayback: AnyObject {
    var position: Double { get }
    var playing: Bool { get }
    var adSkippingPlan: AdPlan? { get }
    var onChange: (() -> Void)? { get set }
    func load(_ episode: Episode, url: URL, position: Double) async throws
    func play() async throws
    func pause()
    func seek(_ seconds: Double) async throws
    func setAdSkipping(enabled: Bool, plan: AdPlan) throws
    func restoreAdSkipping(_ plan: AdPlan?) throws
    func clear()
}

@MainActor
@Observable
final class PlaybackEngine: PodcastPlayback {
    private let player = AVPlayer()
    private var episode: Episode?
    private var clock: Any?
    private var observation: NSKeyValueObservation?
    private var adBoundary: Any?
    private var adPlan: AdPlan?
    private var autoSkip: Task<Void, Never>?
    private var autoSkipID: UUID?
    private var itemGeneration = 0
    private var seekGeneration = 0
    private var failedAdTarget: Double?
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    var onChange: (() -> Void)?
    var onRemoteCommand: ((String, Double?) -> Void)?
    private(set) var position = 0.0
    private(set) var playing = false
    var adSkippingPlan: AdPlan? { adPlan }

    init() {
        clock = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.2, preferredTimescale: 600), queue: .main) { [weak self] time in
            guard let self else { return }
            Task { @MainActor in
                self.position = time.seconds.isFinite ? time.seconds : 0
                self.publish()
                self.catchUpAds()
            }
        }
        observation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            guard let self else { return }
            Task { @MainActor in self.publish() }
        }
        let center = MPRemoteCommandCenter.shared()
        bind(center.playCommand, "play")
        bind(center.pauseCommand, "pause")
        bind(center.togglePlayPauseCommand, "toggle")
        center.skipForwardCommand.preferredIntervals = [30]
        center.skipBackwardCommand.preferredIntervals = [15]
        bind(center.skipForwardCommand, "forward")
        bind(center.skipBackwardCommand, "backward")
        let target = center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            Task { @MainActor in self?.onRemoteCommand?("seek", event.positionTime) }
            return .success
        }
        remoteTargets.append((center.changePlaybackPositionCommand, target))
    }

    private func bind(_ command: MPRemoteCommand, _ action: String) {
        let target = command.addTarget { [weak self] _ in
            Task { @MainActor in self?.onRemoteCommand?(action, nil) }
            return .success
        }
        remoteTargets.append((command, target))
    }

    private func publish() {
        playing = player.timeControlStatus == .playing
        if let episode, playing || MPNowPlayingInfoCenter.default().nowPlayingInfo != nil {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = [
                MPMediaItemPropertyTitle: episode.title,
                MPMediaItemPropertyArtist: episode.showTitle,
                MPMediaItemPropertyPlaybackDuration: episode.durationSeconds,
                MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
                MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
            ]
        }
        onChange?()
    }

    func load(_ episode: Episode, url: URL, position: Double) async throws {
        pause()
        resetAds()
        itemGeneration += 1
        self.episode = episode
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)
        let deadline = Date().addingTimeInterval(25)
        while item.status != .readyToPlay {
            try Task.checkCancellation()
            guard item === player.currentItem else { throw CancellationError() }
            if item.status == .failed { throw item.error ?? MurmurError(message: "The episode could not load.") }
            if Date() > deadline { throw MurmurError(message: "The episode took too long to load. Try again.") }
            try await Task.sleep(for: .milliseconds(50))
        }
        try await seek(position)
    }

    func play() async throws {
        guard player.currentItem != nil else { throw MurmurError(message: "Choose an episode first.") }
        if let target = adPlan?.destination(at: position) { try await seek(target) }
        try AVAudioSession.sharedInstance().setActive(true)
        player.play()
        let deadline = Date().addingTimeInterval(15)
        while player.timeControlStatus != .playing {
            try Task.checkCancellation()
            if let error = player.currentItem?.error { throw error }
            if Date() > deadline { player.pause(); throw MurmurError(message: "The episode loaded but playback did not start.") }
            try await Task.sleep(for: .milliseconds(50))
        }
        publish()
    }

    func pause() { player.pause(); publish() }
    func seek(_ seconds: Double) async throws {
        cancelAutoSkip()
        let bounded = max(0, min(seconds, episode?.durationSeconds ?? seconds))
        let target = adPlan?.destination(at: bounded) ?? bounded
        failedAdTarget = nil
        try await performSeek(target)
    }

    private func performSeek(_ target: Double) async throws {
        guard target.isFinite else { throw MurmurError(message: "That playback position is invalid.") }
        let item = player.currentItem
        let epoch = itemGeneration
        seekGeneration += 1
        let seekEpoch = seekGeneration
        let completed = await player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        try Task.checkCancellation()
        guard epoch == itemGeneration, item === player.currentItem, seekEpoch == seekGeneration else { throw CancellationError() }
        guard completed else { throw MurmurError(message: "Could not move to that point.") }
        position = player.currentTime().seconds
        publish()
    }

    func setAdSkipping(enabled: Bool, plan: AdPlan) throws {
        guard let episode else { throw MurmurError(message: "Choose an episode first.") }
        try plan.validate(audioVersion: episode.audioVersion, duration: episode.durationSeconds)
        if let current = adPlan, plan.revision < current.revision {
            throw MurmurError(message: "The ad markers have been superseded.")
        }
        guard !enabled || plan.status != .unavailable else { throw MurmurError(message: "Ad markers are unavailable for this episode.") }
        if enabled, adPlan == plan { return }
        resetAds()
        guard enabled else { return }
        adPlan = plan
        let epoch = itemGeneration
        let times = plan.intervals.map { NSValue(time: CMTime(seconds: $0.startSeconds, preferredTimescale: 600)) }
        if !times.isEmpty {
            adBoundary = player.addBoundaryTimeObserver(forTimes: times, queue: .main) { [weak self] in
                guard let self else { return }
                Task { @MainActor in
                    guard self.itemGeneration == epoch else { return }
                    self.catchUpAds()
                }
            }
        }
    }

    func restoreAdSkipping(_ plan: AdPlan?) throws {
        if let plan {
            guard let episode else { throw MurmurError(message: "Choose an episode first.") }
            try plan.validate(audioVersion: episode.audioVersion, duration: episode.durationSeconds)
        }
        resetAds()
        if let plan { try setAdSkipping(enabled: true, plan: plan) }
    }

    private func catchUpAds() {
        guard player.rate > 0, autoSkip == nil,
              let target = adPlan?.destination(at: player.currentTime().seconds),
              target != failedAdTarget else { return }
        let epoch = itemGeneration
        let token = UUID()
        autoSkipID = token
        autoSkip = Task { [weak self] in
            guard let self else { return }
            defer { if self.autoSkipID == token { self.autoSkip = nil; self.autoSkipID = nil } }
            do { try await self.performSeek(target) }
            catch is CancellationError { }
            catch { if epoch == self.itemGeneration { self.failedAdTarget = target } }
        }
    }

    private func cancelAutoSkip() {
        if autoSkip != nil { player.currentItem?.cancelPendingSeeks() }
        autoSkip?.cancel(); autoSkip = nil; autoSkipID = nil
        seekGeneration += 1
    }

    private func resetAds() {
        cancelAutoSkip()
        if let adBoundary { player.removeTimeObserver(adBoundary) }
        adBoundary = nil; adPlan = nil; failedAdTarget = nil
    }

    func clear() { pause(); resetAds(); itemGeneration += 1; player.replaceCurrentItem(with: nil); episode = nil; position = 0; MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; onChange?() }
}

@MainActor
protocol AssistantSpeech: AnyObject {
    var onLevel: ((Double) -> Void)? { get set }
    func say(_ data: Data) async throws
    func stop()
}

@MainActor
final class NativeSpeech: AssistantSpeech {
    private var player: AVAudioPlayer?
    var onLevel: ((Double) -> Void)?
    func say(_ data: Data) async throws {
        stop()
        let audio = try AVAudioPlayer(data: data)
        player = audio
        audio.isMeteringEnabled = true
        guard audio.prepareToPlay(), audio.play() else { throw MurmurError(message: "The spoken response could not start.") }
        defer { if player === audio { stop() } }
        while audio.isPlaying {
            try Task.checkCancellation()
            audio.updateMeters()
            onLevel?(min(1, max(0, pow(10, Double(audio.averagePower(forChannel: 0)) / 25))))
            try await Task.sleep(for: .milliseconds(50))
        }
        try Task.checkCancellation()
    }
    func stop() { player?.stop(); player = nil; onLevel?(0) }
}
