import Testing
import Foundation
@testable import Murmur

@MainActor
struct VoiceRecoveryTests {
    @Test func transientDisconnectRecoversWithoutChangingPlayback() async throws {
        let player = TestPlayback()
        let model = ConversationModel(api: TestListeningService(), player: player, speech: TestSpeech())
        var starts = 0
        model.startMicrophone = { starts += 1 }
        await model.activate()
        model.submit("Play")
        await model.waitForWork()
        let position = player.position
        let loads = player.loaded.count
        model.microphoneFailed(URLError(.networkConnectionLost))
        try await Task.sleep(for: .seconds(2))
        #expect(starts == 2)
        #expect(model.microphone)
        #expect(player.playing && player.position == position)
        #expect(player.loaded.count == loads)
    }

    @Test func backgroundCancelsRecoveryAndDoesNotRestartMic() async throws {
        let model = ConversationModel(api: TestListeningService(), player: TestPlayback(), speech: TestSpeech())
        var starts = 0
        model.startMicrophone = { starts += 1 }
        await model.activate()
        model.microphoneFailed(URLError(.networkConnectionLost))
        model.background()
        try await Task.sleep(for: .seconds(2))
        #expect(starts == 1)
        #expect(!model.microphone)
    }

    @Test func permissionOrServiceErrorDoesNotRetry() async throws {
        let model = ConversationModel(api: TestListeningService(), player: TestPlayback(), speech: TestSpeech())
        var starts = 0
        model.startMicrophone = { starts += 1 }
        await model.activate()
        model.microphoneFailed(MurmurError(message: "Voice unavailable"))
        try await Task.sleep(for: .seconds(2))
        #expect(starts == 1)
        #expect(!model.microphone)
    }

    @Test func repeatedNetworkFailuresHaveBoundedRetries() async throws {
        let model = ConversationModel(api: TestListeningService(), player: TestPlayback(), speech: TestSpeech())
        model.startMicrophone = {}
        await model.activate()
        var attempts = 0
        model.startMicrophone = { attempts += 1; throw URLError(.cannotConnectToHost) }
        model.microphoneFailed(URLError(.networkConnectionLost))
        try await Task.sleep(for: .seconds(5))
        #expect(attempts == 3)
        #expect(!model.microphone && model.error != nil)
    }

    @Test func recoveryKeepsAnOpenUserTurnAndPausedPosition() async throws {
        let player = TestPlayback()
        let model = ConversationModel(api: TestListeningService(), player: player, speech: TestSpeech())
        model.startMicrophone = {}
        await model.activate()
        model.submit("Play"); await model.waitForWork()
        try await player.seek(250)
        model.tap()
        model.microphoneFailed(URLError(.networkConnectionLost))
        try await Task.sleep(for: .seconds(2))
        #expect(model.isListening && !player.playing && player.position == 250)
        model.receive("pause", item: "after-recovery", final: true)
        await model.waitForWork()
        #expect(!player.playing && player.position == 250)
    }

    @Test func lateRecoveryCannotReopenMicrophoneAfterBackgrounding() async throws {
        let model = ConversationModel(api: TestListeningService(), player: TestPlayback(), speech: TestSpeech())
        model.startMicrophone = {}
        await model.activate()
        var pending: CheckedContinuation<Void, Never>?
        model.startMicrophone = { await withCheckedContinuation { pending = $0 } }
        model.microphoneFailed(URLError(.networkConnectionLost))
        try await Task.sleep(for: .seconds(1))
        let completion = try #require(pending)
        model.background()
        completion.resume()
        await Task.yield()
        #expect(!model.microphone && !model.isListening)
    }

    @Test func interruptedInitialConnectionDoesNotRemainConnectingAfterRecovery() async throws {
        let model = ConversationModel(api: TestListeningService(), player: TestPlayback(), speech: TestSpeech())
        var attempts = 0
        model.startMicrophone = {
            attempts += 1
            if attempts == 1 {
                model.microphoneFailed(URLError(.networkConnectionLost))
                throw URLError(.networkConnectionLost)
            }
        }
        await model.activate()
        try await Task.sleep(for: .seconds(2))
        #expect(attempts == 2 && model.microphone)
        #expect(model.phase == .idle)
    }
}
