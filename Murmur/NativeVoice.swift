import AVFoundation
import Foundation

@MainActor
final class NativeVoice {
    private let api: ListeningService
    private let engine = AVAudioEngine()
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var renewal: Task<Void, Never>?
    private var readiness: CheckedContinuation<Void, Error>?
    private var deadline: Task<Void, Never>?
    private var generation = 0
    private var ready = false
    private var capturing = true
    private var tapped = false
    private var texts: [String: String] = [:]
    private var sendQueue: Task<Void, Never>?
    private var boundary = VoiceTurnBoundary()
    private var supportsAudioClear = false
    private var clearDeadline: Task<Void, Never>?
    var onTranscript: ((String, String, Bool) -> Void)?
    var onError: ((Error) -> Void)?

    init(api: ListeningService) { self.api = api }

    func start() async throws { try await connect(capture: true) }

    private func connect(capture: Bool) async throws {
        stop()
        capturing = capture
        let epoch = generation
        if capture {
            let granted = await AVAudioApplication.requestRecordPermission()
            guard epoch == generation else { throw CancellationError() }
            guard granted else { throw MurmurError(message: "Allow microphone access for Murmur in Settings to use voice.") }
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
        }
        let ticket = try await api.ticket()
        guard epoch == generation else { throw CancellationError() }
        let connection = URLSession.shared.webSocketTask(with: api.voiceURL, protocols: ["murmur-ticket." + ticket.token, "murmur-semantic-v1"])
        socket = connection
        connection.resume()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await connection.receive()
                    guard let self, self.generation == epoch else { return }
                    try self.handle(message)
                } catch {
                    guard let self, self.generation == epoch else { return }
                    self.failed(error); return
                }
            }
        }
        try await withCheckedThrowingContinuation { continuation in
            if ready { continuation.resume(); return }
            readiness = continuation
            deadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled, let self, self.generation == epoch, !self.ready else { return }
                self.failed(MurmurError(message: "The voice connection took too long to open."))
            }
        }
        guard epoch == generation else { throw CancellationError() }
        do { if capture { try startCapture(epoch: epoch) } }
        catch { stop(); throw error }
        scheduleRenewal(after: .milliseconds(max(1000, ticket.leaseMilliseconds - 10000)), capture: capture, epoch: epoch)
    }

    private func scheduleRenewal(after delay: Duration, capture: Bool, epoch: Int) {
        renewal?.cancel()
        renewal = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            guard !Task.isCancelled, let self, self.generation == epoch else { return }
            self.renewal = nil
            do { try await self.connect(capture: capture) }
            catch is CancellationError { }
            catch { if !Task.isCancelled { self.onError?(error) } }
        }
    }

    private func startCapture(epoch: Int) throws {
        let input = engine.inputNode
        #if !targetEnvironment(simulator)
        try input.setVoiceProcessingEnabled(true)
        #endif
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw MurmurError(message: "No microphone input is available.")
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            let capturedAt = ProcessInfo.processInfo.systemUptime
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 24000 / inputFormat.sampleRate) + 16)
            guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
            var delivered = false
            var conversionError: NSError?
            converter.convert(to: output, error: &conversionError) { _, status in
                if delivered { status.pointee = .noDataNow; return nil }
                delivered = true; status.pointee = .haveData; return buffer
            }
            guard conversionError == nil, output.frameLength > 0, let samples = output.int16ChannelData?[0] else { return }
            let count = Int(output.frameLength)
            let data = Data(bytes: samples, count: count * 2)
            Task { @MainActor in
                guard let self, self.generation == epoch, capturedAt >= self.boundary.captureStart else { return }
                self.append(data)
            }
        }
        tapped = true
        engine.prepare()
        try engine.start()
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) throws {
        let data: Data
        switch message { case .string(let text): data = Data(text.utf8); case .data(let bytes): data = bytes; @unknown default: return }
        guard let event = try JSONSerialization.jsonObject(with: data) as? [String: Any], let type = event["type"] as? String else { return }
        if type == "ready" {
            guard event["turnDetection"] as? String == "semantic" else {
                throw MurmurError(message: "Update the Murmur backend to enable natural turn detection.")
            }
            supportsAudioClear = event["supportsAudioClear"] as? Bool == true
            ready = true; deadline?.cancel(); readiness?.resume(); readiness = nil
        }
        else if type == "input_audio_buffer.cleared" {
            boundary.cleared()
            if !boundary.clearing { clearDeadline?.cancel() }
        }
        else if type == "error" { throw MurmurError(message: event["message"] as? String ?? "The voice service is unavailable.") }
        else if type == "renew" {
            scheduleRenewal(after: .zero, capture: capturing, epoch: generation)
        } else if let id = event["item_id"] as? String {
            if type == "input_audio_buffer.speech_started" { boundary.committed(id); return }
            if type == "input_audio_buffer.speech_stopped" { return }
            if type == "input_audio_buffer.committed" { boundary.committed(id); return }
            let final = type.hasSuffix(".completed")
            guard boundary.accepts(id, final: final) else { texts.removeValue(forKey: id); return }
            if type.hasSuffix(".delta"), let delta = event["delta"] as? String {
                let text = String(((texts[id] ?? "") + delta).suffix(6000))
                texts[id] = text; onTranscript?(text, id, false)
            } else if type.hasSuffix(".completed"), let text = event["transcript"] as? String {
                #if DEBUG
                completedTestTurns += 1
                #endif
                texts.removeValue(forKey: id); onTranscript?(text, id, true)
            }
        }
    }

    func beginTappedTurn() {
        guard ready, supportsAudioClear else { return }
        boundary.begin(at: ProcessInfo.processInfo.systemUptime)
        texts.removeAll()
        send(["type": "input_audio_buffer.clear"])
        clearDeadline?.cancel()
        let epoch = generation
        clearDeadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            guard let self, self.generation == epoch, self.boundary.clearing else { return }
            self.failed(URLError(.timedOut))
        }
    }

    private func append(_ data: Data) {
        guard ready else { return }
        send(["type": "input_audio_buffer.append", "audio": data.base64EncodedString()])
    }
    private func send(_ body: [String: String]) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: body), let text = String(data: data, encoding: .utf8) else { return }
        let epoch = generation; let previous = sendQueue
        sendQueue = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled, let self, self.generation == epoch else { return }
            do { try await socket.send(.string(text)) }
            catch { if self.generation == epoch { self.failed(error) } }
        }
    }
    #if DEBUG
    private var completedTestTurns = 0
    func startRecordedAudioTest() async throws { try await connect(capture: false) }
    func renewRecordedAudioTest() async throws {
        scheduleRenewal(after: .zero, capture: false, epoch: generation)
        await renewal?.value
        guard ready else { throw MurmurError(message: "Renewed voice connection is not ready.") }
    }
    func sendRecordedPCM(_ data: Data, finishWithSilence: Bool = true) async throws {
        guard ready else { throw MurmurError(message: "Test voice connection is not ready.") }
        let epoch = generation
        let startingTurns = completedTestTurns
        for start in stride(from: 0, to: data.count, by: 4800) {
            try Task.checkCancellation()
            guard epoch == generation else { throw CancellationError() }
            let chunk = data.subdata(in: start..<min(start + 4800, data.count))
            send(["type": "input_audio_buffer.append", "audio": chunk.base64EncodedString()])
            try await Task.sleep(for: .milliseconds(100))
        }
        if finishWithSilence {
            for _ in 0..<120 {
                try Task.checkCancellation()
                guard epoch == generation else { throw CancellationError() }
                if completedTestTurns != startingTurns { break }
                send(["type": "input_audio_buffer.append", "audio": Data(count: 4800).base64EncodedString()])
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        await sendQueue?.value
    }
    #endif
    private func failed(_ error: Error) {
        readiness?.resume(throwing: error); readiness = nil
        stop(); onError?(error)
    }
    func stop() {
        generation += 1; ready = false
        renewal?.cancel(); deadline?.cancel(); receiveTask?.cancel(); sendQueue?.cancel(); clearDeadline?.cancel()
        readiness?.resume(throwing: CancellationError()); readiness = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        engine.stop()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        texts.removeAll()
        boundary = VoiceTurnBoundary(); supportsAudioClear = false
        let session = AVAudioSession.sharedInstance()
        do { try session.setCategory(.playback, mode: .spokenAudio); try session.setActive(true) }
        catch { NSLog("Murmur: could not restore playback audio session: %@", error.localizedDescription) }
    }
}
