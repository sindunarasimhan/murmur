import Testing
import Foundation
import AVFoundation
@testable import Murmur

@MainActor
struct LiveVoiceTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["MURMUR_LIVE_TESTS"] == "1"), .timeLimit(.minutes(5)))
    func recordedSpeechToRealTranscriptionAndNativePlayback() async throws {
        let api = ListeningAPI(baseURL: URL(string: "http://127.0.0.1:4545")!)
        let catalog = try await api.catalog()
        #expect(catalog.count > 1)
        let player = PlaybackEngine()
        let model = ConversationModel(api: api, player: player, speech: NativeSpeech())
        model.startMicrophone = {}
        await model.activate()
        let voice = NativeVoice(api: api)
        model.beginMicrophoneTurn = { voice.beginTappedTurn() }
        var finalText: String?
        var voiceError: Error?
        voice.onTranscript = { text, item, final in
            model.receive(text, item: item, final: final)
            if final { finalText = text }
        }
        voice.onError = { voiceError = $0 }
        try await voice.startRecordedAudioTest()
        defer { voice.stop(); player.clear() }
        try await voice.renewRecordedAudioTest()

        func speak(_ words: String) async throws {
            finalText = nil
            let recording = try await api.speech(words)
            let pcm = try Self.pcm(recording)
            try await voice.sendRecordedPCM(pcm)
            let deadline = Date().addingTimeInterval(25)
            while finalText == nil, voiceError == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
            if let voiceError { throw voiceError }
            let transcript = try #require(finalText)
            #expect(!transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            print("Recorded voice recognized: \(transcript)")
            await model.waitForWork()
            #expect(model.error == nil, Comment(rawValue: model.error ?? ""))
        }

        for guest in ["Brian Halligan", "Benedict Evans"] {
            let episode = try #require(catalog.first { $0.guest?.localizedCaseInsensitiveContains(guest) == true })
            try await speak("Hey Murmur")
            #expect(model.isListening)
            try await speak("Please play Lenny's podcast with \(guest).")
            #expect(model.episode?.id == episode.id)
            #expect(model.detailVisible && player.playing)
            try await player.seek(90)
            let podcastTail = try await api.speech("The teams are learning to build products together.")
            try await voice.sendRecordedPCM(Self.pcm(podcastTail), commit: false)
            model.tap()
            try await speak("Play from the beginning.")
            #expect(player.playing && player.position < 5)
            try await player.seek(90)
            model.tap()
            let stopped = player.position
            try await speak("Pause the podcast.")
            #expect(!player.playing)
            #expect(abs(player.position - stopped) < 0.25)
            model.tap()
            try await speak("Resume playback.")
            #expect(player.playing)
            #expect(player.position >= stopped && player.position < stopped + 5)
            model.tap()
            try await speak("End this episode and return to the main screen.")
            #expect(!model.detailVisible && model.episode == nil)
        }
    }

    private static func pcm(_ audio: Data) throws -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp3")
        try audio.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let file = try AVAudioFile(forReading: url)
        let source = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: source)
        let format = try #require(AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true))
        let converter = try #require(AVAudioConverter(from: source.format, to: format))
        let capacity = AVAudioFrameCount(ceil(Double(source.frameLength) * 24000 / source.format.sampleRate) + 1024)
        let output = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity))
        var delivered = false; var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if delivered { status.pointee = .endOfStream; return nil }
            delivered = true; status.pointee = .haveData; return source
        }
        if let error { throw error }
        let samples = try #require(output.int16ChannelData?[0])
        return Data(bytes: samples, count: Int(output.frameLength) * 2)
    }
}
