import Testing
import Foundation
@testable import Murmur

@MainActor
struct ConversationTests {
    private func setup() async -> (ConversationModel, TestListeningService, TestPlayback, TestSpeech) {
        let api = TestListeningService(), player = TestPlayback(), speech = TestSpeech()
        let model = ConversationModel(api: api, player: player, speech: speech)
        model.startMicrophone = {}
        await model.activate()
        return (model, api, player, speech)
    }

    @Test func wakeTranscriptPersistsAndEmptyFinalDoesNothing() async {
        let (model, api, _, _) = await setup()
        model.receive("Hey Murmur", item: "wake", final: true)
        await model.waitForWork()
        #expect(model.heard == "Hey Murmur")
        #expect(model.isListening)
        model.receive("", item: "empty", final: true)
        #expect(model.isListening)
        #expect(api.requests.isEmpty)
        model.receive("I'd like the astronomy episode", item: "reply", final: true)
        await model.waitForWork()
        #expect(model.detailVisible)
        #expect(model.playing)
    }

    @Test(arguments: 0..<3) func eachCatalogEpisodeUsesSamePath(index: Int) async {
        let (model, api, player, _) = await setup(); api.selected = index
        model.submit("A natural request")
        await model.waitForWork()
        #expect(model.episode?.id == TestListeningService.episodes[index].id)
        #expect(player.loaded == [TestListeningService.episodes[index].id])
        #expect(model.detailVisible && model.playing)
    }

    @Test func pauseThenResumeKeepsExactPosition() async {
        let (model, _, player, _) = await setup()
        model.submit("Play something"); await model.waitForWork()
        try? await player.seek(247)
        model.tap()
        #expect(!player.playing && model.isListening)
        model.receive("pause", item: "pause", final: true); await model.waitForWork()
        #expect(!player.playing && player.position == 247)
        model.tap(); model.receive("resume", item: "resume", final: true); await model.waitForWork()
        #expect(player.playing && player.position == 247)
        #expect(player.loaded.count == 1)
        #expect(!model.isListening)
    }

    @Test func onlyDetailTapStartsFreshCaptureAfterPausing() async {
        let (model, _, player, _) = await setup()
        var resets = 0
        model.beginMicrophoneTurn = {
            #expect(!player.playing)
            resets += 1
        }
        model.tap()
        #expect(resets == 0)
        model.submit("Play something"); await model.waitForWork()
        model.receive("Hey Murmur pause", item: "wake", final: true)
        await model.waitForWork()
        #expect(resets == 0)
        model.tap()
        #expect(resets == 1)
        #expect(model.isListening)
    }

    @Test(arguments: [true, false]) func skipPreservesPriorPlayback(playing: Bool) async {
        let (model, _, player, speech) = await setup()
        model.submit("Play"); await model.waitForWork()
        if !playing { player.pause() }
        model.tap(); model.receive("skip ad", item: "skip", final: true); await model.waitForWork()
        #expect(player.position == 180)
        #expect(player.playing == playing)
        #expect(speech.spoken.last?.contains("Skipping") == true)
    }

    @Test func questionRestoresPlaybackWithoutFollowupWindow() async {
        let (model, api, player, _) = await setup()
        model.submit("Play"); await model.waitForWork(); api.question = true
        model.tap(); model.receive("Explain that term", item: "question", final: true); await model.waitForWork()
        #expect(player.playing && player.position == 120)
        #expect(!model.isListening)
    }

    @Test func failedConfirmationCannotPretendPlaybackStarted() async {
        let (model, _, player, speech) = await setup(); speech.fail = true
        model.submit("Play"); await model.waitForWork()
        #expect(!model.detailVisible && !player.playing)
        #expect(model.error != nil)
    }

    @Test func failedLoadDoesNotShowDetail() async {
        let (model, _, player, _) = await setup(); player.failLoad = true
        model.submit("Play"); await model.waitForWork()
        #expect(!model.detailVisible && !player.playing)
    }

    @Test func backgroundCancelsPendingCommandAndRestoresPlayback() async {
        let (model, api, player, _) = await setup()
        model.submit("Play"); await model.waitForWork()
        api.resolveBarrier = { try await Task.sleep(for: .seconds(60)) }
        model.tap(); model.receive("pause", item: "pending", final: true)
        await Task.yield(); model.background(); await model.waitForWork()
        #expect(!model.microphone && player.playing)
        #expect(player.position == 120)
    }

    @Test func completedPauseRemainsPausedOnBackground() async {
        let (model, _, player, _) = await setup()
        model.submit("Play"); await model.waitForWork()
        model.tap(); model.receive("pause", item: "pause", final: true); await model.waitForWork()
        model.background(); await model.waitForWork()
        #expect(!player.playing && !model.microphone)
    }

    @Test func endReturnsHomeAndKeepsForegroundMic() async {
        let (model, _, player, _) = await setup()
        model.submit("Play"); await model.waitForWork()
        model.tap(); model.receive("end episode", item: "end", final: true); await model.waitForWork()
        #expect(!model.detailVisible && model.episode == nil && !player.playing)
        #expect(model.microphone)
    }

    @Test func duplicateFinalCannotExecuteTwice() async {
        let (model, api, _, _) = await setup()
        model.tap(); model.receive("play", item: "same", final: true); await model.waitForWork()
        model.receive("play", item: "same", final: true); await model.waitForWork()
        #expect(api.requests.count == 1)
    }

    @Test func podcastSpeechIsNotTreatedAsUserCommand() async {
        let (model, api, player, _) = await setup()
        model.submit("Play"); await model.waitForWork()
        model.receive("pause and think about product", item: "ambient", final: true)
        #expect(player.playing && api.requests.count == 1)
    }
}
