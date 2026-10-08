import Foundation
import Testing
@testable import Murmur

struct AdPlanTests {
    let version = String(repeating: "a", count: 64)

    func plan(_ intervals: [AdPlan.Interval], version: String? = nil) -> AdPlan {
        AdPlan(audioVersion: version ?? self.version, revision: 1, status: .ready, intervals: intervals)
    }

    @Test func boundariesAreInclusiveAtStartExclusiveAtEndAndMergeAdjacentAds() throws {
        let value = plan([
            .init(id: "a", startSeconds: 30, endSeconds: 45),
            .init(id: "b", startSeconds: 45, endSeconds: 60),
            .init(id: "c", startSeconds: 100, endSeconds: 120),
        ])
        try value.validate(audioVersion: version, duration: 180)
        #expect(value.destination(at: 29) == nil)
        #expect(value.destination(at: 30) == 60)
        #expect(value.destination(at: 44) == 60)
        #expect(value.destination(at: 60) == nil)
        #expect(value.destination(at: 110) == 120)
        #expect(value.destination(at: 120) == nil)
    }

    @Test func rejectsWrongRecordingAndInvalidIntervals() {
        #expect(throws: MurmurError.self) { try plan([], version: "other").validate(audioVersion: version, duration: 180) }
        let invalid: [[AdPlan.Interval]] = [
            [.init(id: "a", startSeconds: -1, endSeconds: 10)],
            [.init(id: "a", startSeconds: 10, endSeconds: 10)],
            [.init(id: "a", startSeconds: 10, endSeconds: 181)],
            [.init(id: "a", startSeconds: 10, endSeconds: .infinity)],
            [.init(id: "a", startSeconds: 30, endSeconds: 50), .init(id: "b", startSeconds: 40, endSeconds: 60)],
            [.init(id: "a", startSeconds: 30, endSeconds: 50), .init(id: "a", startSeconds: 60, endSeconds: 80)],
        ]
        for intervals in invalid {
            #expect(throws: MurmurError.self) { try plan(intervals).validate(audioVersion: version, duration: 180) }
        }
    }

    @Test func legacyActionStillDecodes() throws {
        let data = Data(#"{"id":"a","kind":"pause","positionSeconds":120,"play":false}"#.utf8)
        let action = try JSONDecoder().decode(PlaybackAction.self, from: data)
        #expect(action.kind == .pause && action.enabled == nil && action.plan == nil)
    }
}

@MainActor
struct AdSkippingConversationTests {
    @Test(arguments: [true, false]) func failedDepartureRetainsAcknowledgementRecovery(failingHome: Bool) async {
        let api = TestListeningService(), player = TestPlayback(), speech = TestSpeech()
        let model = ConversationModel(api: api, player: player, speech: speech)
        model.submit("Play"); await model.waitForWork()
        api.nextAction = enablingAction()
        api.acknowledgementBarrier = { throw MurmurError(message: "Acknowledgement response lost") }
        model.submit("Remove ads"); await model.waitForWork()
        #expect(api.acknowledgements.count == 1 && player.adPlan != nil)
        api.nextResolution = failingHome
            ? CatalogResolution(kind: .home, episode: nil, message: "Ending this episode.")
            : CatalogResolution(kind: .play, episode: TestListeningService.episodes[1], message: "Starting Design.")
        api.speechFailure = failingHome
        api.openFailure = !failingHome
        model.submit(failingHome ? "Home" : "Play Design"); await model.waitForWork()
        #expect(model.error != nil && model.episode?.id == TestListeningService.episodes[0].id)
        #expect(player.loaded.count == 1 && player.adPlan != nil)
        api.speechFailure = false; api.openFailure = false; api.acknowledgementBarrier = nil
        api.nextResolution = CatalogResolution(kind: .current, episode: nil, message: "")
        api.nextAction = PlaybackAction(id: "pause", kind: .pause, positionSeconds: 180, play: false)
        model.submit("Pause"); await model.waitForWork()
        #expect(model.error == nil && !player.playing)
        #expect(api.acknowledgements.count == 3)
        #expect(api.acknowledgements[0].0 == api.acknowledgements[1].0)
        #expect(api.acknowledgements[0].1 == api.acknowledgements[1].1)
        #expect(api.observedAfterAcknowledgements.last == 2)
    }

    @Test(arguments: [true, false]) func failedAdAcknowledgementDoesNotBlockHomeOrAnotherEpisode(goHome: Bool) async {
        let api = TestListeningService(), player = TestPlayback(), speech = TestSpeech()
        let model = ConversationModel(api: api, player: player, speech: speech)
        model.submit("Play"); await model.waitForWork()
        api.nextAction = enablingAction()
        api.acknowledgementBarrier = { throw MurmurError(message: "Acknowledgement unavailable") }
        model.submit("Remove ads"); await model.waitForWork()
        #expect(model.error != nil && api.acknowledgements.count == 1)
        api.nextResolution = goHome
            ? CatalogResolution(kind: .home, episode: nil, message: "Ending this episode.")
            : CatalogResolution(kind: .play, episode: TestListeningService.episodes[1], message: "Starting Design.")
        model.submit(goHome ? "Go home" : "Play Design"); await model.waitForWork()
        #expect(model.error == nil && api.acknowledgements.count == 1)
        #expect(player.adPlan == nil)
        if goHome {
            #expect(model.episode == nil && !model.detailVisible && !player.playing)
        } else {
            #expect(model.episode?.id == TestListeningService.episodes[1].id && player.playing)
            #expect(player.loaded.count == 2)
        }
    }

    @Test func lateAcknowledgementCannotChangeReplacementEpisode() async {
        let api = TestListeningService(), player = TestPlayback(), speech = TestSpeech()
        let model = ConversationModel(api: api, player: player, speech: speech)
        model.submit("Play"); await model.waitForWork()
        api.nextAction = enablingAction()
        var finish: CheckedContinuation<Void, Never>?
        api.acknowledgementBarrier = { await withCheckedContinuation { finish = $0 } }
        model.submit("Remove ads")
        for _ in 0..<1000 { if finish != nil { break }; await Task.yield() }
        #expect(finish != nil)
        api.nextResolution = CatalogResolution(kind: .play, episode: TestListeningService.episodes[1], message: "Starting Design.")
        model.submit("Play Design"); await model.waitForWork()
        model.remote("pause", position: nil); await model.waitForWork()
        finish?.resume()
        for _ in 0..<20 { await Task.yield() }
        #expect(model.episode?.id == TestListeningService.episodes[1].id)
        #expect(player.adPlan == nil && player.position == 120 && !player.playing)
        #expect(model.error == nil)
    }

    @Test(arguments: [true, false]) func failedSeekRestoresPriorPolicyWithoutAcknowledging(previouslyEnabled: Bool) async throws {
        let api = TestListeningService(), player = TestPlayback(), speech = TestSpeech()
        let model = ConversationModel(api: api, player: player, speech: speech)
        model.submit("Play"); await model.waitForWork()
        let previous = AdPlan(audioVersion: TestListeningService.episodes[0].audioVersion, revision: 0, status: .ready,
                              intervals: [.init(id: "old", startSeconds: 300, endSeconds: 330)])
        if previouslyEnabled { try player.setAdSkipping(enabled: true, plan: previous) }
        api.nextAction = enablingAction(); player.failSeek = true
        model.submit("Remove all ads"); await model.waitForWork()
        #expect(model.error != nil)
        #expect(player.adPlan == (previouslyEnabled ? previous : nil))
        #expect(api.acknowledgements.isEmpty && player.position == 120)
    }

    private func enablingAction() -> PlaybackAction {
        PlaybackAction(id: "enable", kind: .setAdSkipping, positionSeconds: 180, play: true, enabled: true,
                       plan: AdPlan(audioVersion: TestListeningService.episodes[0].audioVersion, revision: 1, status: .ready,
                                    intervals: [.init(id: "ad", startSeconds: 110, endSeconds: 180)]))
    }

    @Test func backgroundDuringAcknowledgementDoesNotCancelCommitOrResumeAfterExplicitPause() async throws {
        let api = TestListeningService(), player = TestPlayback(), speech = TestSpeech()
        let model = ConversationModel(api: api, player: player, speech: speech)
        model.submit("Play"); await model.waitForWork()
        api.nextAction = enablingAction()
        var finish: CheckedContinuation<Void, Never>?
        api.acknowledgementBarrier = { await withCheckedContinuation { finish = $0 } }
        model.submit("Remove all ads")
        for _ in 0..<1000 { if finish != nil { break }; await Task.yield() }
        #expect(finish != nil && player.adPlan != nil)
        model.background(); await model.waitForWork()
        model.remote("pause", position: nil); await model.waitForWork()
        finish?.resume()
        for _ in 0..<20 { await Task.yield() }
        #expect(!player.playing)
        #expect(player.adPlan != nil && api.acknowledgements.count == 1)
    }

    @Test func failedAcknowledgementRetriesExactInputBeforeAnotherObservation() async {
        let api = TestListeningService(), player = TestPlayback(), speech = TestSpeech()
        let model = ConversationModel(api: api, player: player, speech: speech)
        model.submit("Play"); await model.waitForWork()
        api.nextAction = enablingAction()
        api.acknowledgementBarrier = { throw MurmurError(message: "Lost acknowledgement response") }
        model.submit("Remove all ads"); await model.waitForWork()
        #expect(model.error != nil && player.adPlan != nil)
        #expect(api.acknowledgements.count == 1)
        api.acknowledgementBarrier = nil
        api.nextAction = PlaybackAction(id: "pause", kind: .pause, positionSeconds: 180, play: false)
        model.submit("Pause"); await model.waitForWork()
        #expect(api.acknowledgements.count == 3)
        #expect(api.acknowledgements[0].0 == api.acknowledgements[1].0)
        #expect(api.acknowledgements[0].1 == api.acknowledgements[1].1)
        #expect(api.observedAfterAcknowledgements.last == 2)
        #expect(!player.playing && model.error == nil)
    }

    @Test func backgroundBeforeConfirmationInstallsNothing() async {
        let api = TestListeningService(), player = TestPlayback(), speech = TestSpeech()
        let model = ConversationModel(api: api, player: player, speech: speech)
        model.submit("Play"); await model.waitForWork()
        api.nextAction = enablingAction()
        var speaking = false
        speech.hold = { speaking = true; try await Task.sleep(for: .seconds(30)) }
        model.submit("Remove all ads")
        for _ in 0..<1000 { if speaking { break }; await Task.yield() }
        #expect(speaking)
        model.background(); await model.waitForWork()
        #expect(player.adPlan == nil && api.acknowledgements.isEmpty)
    }

    @Test(arguments: [true, false]) func enablingMidAdDoesNotReplaceMediaAndPreservesPlayback(wasPlaying: Bool) async throws {
        let api = TestListeningService(), player = TestPlayback(), speech = TestSpeech()
        let model = ConversationModel(api: api, player: player, speech: speech)
        model.startMicrophone = {}
        await model.activate()
        model.submit("Play a podcast"); await model.waitForWork()
        if !wasPlaying { player.pause() }
        let plan = AdPlan(audioVersion: TestListeningService.episodes[0].audioVersion, revision: 1, status: .ready,
                          intervals: [.init(id: "first", startSeconds: 110, endSeconds: 180), .init(id: "second", startSeconds: 300, endSeconds: 330)])
        api.nextAction = PlaybackAction(id: "enable", kind: .setAdSkipping, positionSeconds: 180, play: wasPlaying, enabled: true, plan: plan)
        model.tap(); model.receive("Remove all the ads", item: "enable", final: true); await model.waitForWork()
        #expect(player.loaded.count == 1)
        #expect(player.position == 180 && player.playing == wasPlaying)
        #expect(player.adPlan == plan)
        try await player.seek(310)
        #expect(player.position == 330)
        model.background(); await model.waitForWork()
        #expect(player.adPlan == plan && player.playing == wasPlaying)
        await model.foregrounded()
        api.nextAction = PlaybackAction(id: "disable", kind: .setAdSkipping, positionSeconds: 330, play: wasPlaying, enabled: false, plan: plan)
        model.tap(); model.receive("Leave the ads in", item: "disable", final: true); await model.waitForWork()
        #expect(player.adPlan == nil && player.loaded.count == 1)
        try await player.seek(310)
        #expect(player.position == 310)
    }

    @Test func stalePlanCannotBeInstalledOrConfirmed() async {
        let api = TestListeningService(), player = TestPlayback(), speech = TestSpeech()
        let model = ConversationModel(api: api, player: player, speech: speech)
        model.submit("Play"); await model.waitForWork()
        let before = speech.spoken.count
        api.nextAction = PlaybackAction(id: "stale", kind: .setAdSkipping, positionSeconds: 180, play: true, enabled: true,
                                       plan: AdPlan(audioVersion: "wrong", revision: 1, status: .ready, intervals: []))
        model.submit("Remove ads"); await model.waitForWork()
        #expect(player.adPlan == nil && player.loaded.count == 1)
        #expect(player.position == 120)
        #expect(speech.spoken.count == before && model.error != nil)
    }
}

@MainActor
@Suite(.serialized)
struct AdSkippingPlayerTests {
    private func fixture() throws -> (Episode, URL, AdPlan) {
        let sampleRate: UInt32 = 8000
        let byteCount: UInt32 = sampleRate * 4 * 2
        var wav = Data()
        func text(_ value: String) { wav.append(contentsOf: value.utf8) }
        func number<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { wav.append(contentsOf: $0) }
        }
        text("RIFF"); number(byteCount + 36); text("WAVEfmt "); number(UInt32(16))
        number(UInt16(1)); number(UInt16(1)); number(sampleRate); number(sampleRate * 2)
        number(UInt16(2)); number(UInt16(16)); text("data"); number(byteCount)
        wav.append(Data(count: Int(byteCount)))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ad-test-\(UUID().uuidString).wav")
        try wav.write(to: url)
        let episode = Episode(id: "local-ad-test", title: "Local test", showTitle: "Test", description: "", audioVersion: "fixture-version",
                              durationSeconds: 4, status: "ready", audioPath: url.absoluteString, transcriptReady: false, guest: nil, artworkUrl: nil)
        let plan = AdPlan(audioVersion: episode.audioVersion, revision: 1, status: .ready,
                          intervals: [.init(id: "first", startSeconds: 0.4, endSeconds: 1.5), .init(id: "second", startSeconds: 2, endSeconds: 3)])
        return (episode, url, plan)
    }

    @Test func nativeSeekAndDisableStayPausedAndReloadClearsPlan() async throws {
        let (episode, url, plan) = try fixture()
        defer { try? FileManager.default.removeItem(at: url) }
        let player = PlaybackEngine()
        defer { player.clear() }
        try await player.load(episode, url: url, position: 0)
        try player.setAdSkipping(enabled: true, plan: plan)
        try await player.seek(0.6)
        #expect(abs(player.position - 1.5) < 0.05 && !player.playing)
        try await player.seek(2.1)
        #expect(abs(player.position - 3) < 0.05 && !player.playing)
        try player.setAdSkipping(enabled: false, plan: plan)
        try await player.seek(0.6)
        #expect(abs(player.position - 0.6) < 0.05 && !player.playing)
        try player.setAdSkipping(enabled: true, plan: plan)
        try await player.load(episode, url: url, position: 0.6)
        #expect(abs(player.position - 0.6) < 0.05)
    }

    @Test func automaticBoundarySkipJumpsAcrossBothAdsWithoutConversation() async throws {
        let (episode, url, plan) = try fixture()
        defer { try? FileManager.default.removeItem(at: url) }
        let player = PlaybackEngine()
        defer { player.clear() }
        try await player.load(episode, url: url, position: 0)
        var samples: [Double] = [0]
        player.onChange = { samples.append(player.position) }
        try player.setAdSkipping(enabled: true, plan: plan)
        try await player.play()
        let deadline = Date().addingTimeInterval(5)
        while player.position < 3 && Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        #expect(player.position >= 3)
        let jumps = zip(samples, samples.dropFirst())
        #expect(jumps.contains { before, after in before < 0.8 && after >= 1.45 && after <= 1.7 })
        #expect(jumps.contains { before, after in before >= 1.5 && before < 2.3 && after >= 2.95 && after <= 3.2 })
        player.pause()
        let paused = player.position
        try await Task.sleep(for: .milliseconds(250))
        #expect(!player.playing && abs(player.position - paused) < 0.1)
    }
}
