import SwiftUI

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @State private var runtime = MurmurRuntime()
    @State private var library = false
    @State private var settings = false
    @State private var testInput = ""
    @FocusState private var testFocused: Bool
    private var model: ConversationModel { runtime.conversation }
    private let ink = Color(red: 0.27, green: 0.23, blue: 0.18)

    var body: some View {
        ZStack {
            Color(red: 0.96, green: 0.93, blue: 0.87).ignoresSafeArea()
            GeometryReader { geometry in
                ForEach(Array(model.catalog.prefix(5).enumerated()), id: \.element.id) { index, episode in
                    artwork(episode).frame(width: 100, height: 100)
                        .rotationEffect(.degrees(Double(index * 13 - 22))).opacity(0.08).blur(radius: 2)
                        .position(x: index.isMultiple(of: 2) ? 28 : geometry.size.width - 25, y: CGFloat(index) * 135 + 100)
                }
            }.allowsHitTesting(false)
            VStack(spacing: 12) {
                HStack {
                    Text("murmur").font(.system(.title2, design: .serif).weight(.semibold))
                    Spacer()
                    Button { library = true } label: { Image(systemName: "rectangle.stack") }
                        .accessibilityLabel("Choose a podcast").accessibilityIdentifier("library")
                    Button { settings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Connection settings")
                }.font(.title3).padding(.horizontal, 26)
                if runtime.testing {
                    HStack {
                        TextField("Test utterance", text: $testInput).focused($testFocused).autocorrectionDisabled().textInputAutocapitalization(.never).accessibilityIdentifier("test-input")
                            .submitLabel(.send).onSubmit {
                                let text = testInput; testFocused = false; testInput = ""
                                model.receive(text, item: UUID().uuidString, final: true)
                            }
                        Button("Send") {
                            let text = testInput
                            testFocused = false; testInput = ""
                            model.receive(text, item: UUID().uuidString, final: true)
                        }.accessibilityIdentifier("test-send")
                    }.padding().background(.white.opacity(0.6))
                }
                Spacer(minLength: 0)
                if model.detailVisible, let episode = model.episode {
                    VStack(spacing: 10) {
                        artwork(episode).frame(width: 160, height: 160).shadow(color: ink.opacity(0.12), radius: 18, y: 8)
                        Text(episode.guest ?? episode.title).font(.system(.title2, design: .serif)).multilineTextAlignment(.center)
                        Text(episode.showTitle).font(.caption)
                        ProgressView(value: min(model.position, episode.durationSeconds), total: max(1, episode.durationSeconds)).tint(ink.opacity(0.45))
                        HStack {
                            Text(model.position.formattedTime).accessibilityIdentifier("position")
                            Spacer()
                            Text(model.playing ? "Playing" : "Paused").accessibilityIdentifier("playback-state")
                            Spacer(); Text(episode.durationSeconds.formattedTime)
                        }.font(.caption.monospacedDigit())
                    }.padding(.horizontal, 38)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                } else {
                    Text("What would you\nlike to hear?").font(.system(size: 36, weight: .regular, design: .serif))
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("home-title")
                }
                Text(transcript).font(.body).multilineTextAlignment(.center).lineLimit(2)
                    .frame(height: 54).padding(.horizontal, 28).accessibilityIdentifier("transcript")
                MascotView(phase: model.phase, level: model.speechLevel, listening: model.isListening) { model.tap() }
                    .frame(width: model.detailVisible ? 250 : 300, height: model.detailVisible ? 250 : 300)
                HStack(spacing: 7) {
                    Circle().fill(model.isListening ? Color.green.opacity(0.65) : ink.opacity(0.25)).frame(width: 6, height: 6)
                    Text(status).font(.subheadline)
                }.accessibilityIdentifier("voice-status")
                if let error = model.error {
                    Text(error).font(.caption).multilineTextAlignment(.center).foregroundStyle(.red).padding(.horizontal, 28).accessibilityIdentifier("error-message")
                }
                Spacer(minLength: 0)
                Text("AI-generated voice").font(.caption2).foregroundStyle(ink.opacity(0.45))
            }.padding(.vertical, 12)
        }.foregroundStyle(ink).ignoresSafeArea(.keyboard)
        .animation(reducedMotion ? nil : .spring(response: 0.65, dampingFraction: 0.86), value: model.detailVisible)
        .sheet(isPresented: $library) {
            NavigationStack {
                List(model.catalog) { episode in
                    Button { library = false; model.choose(episode) } label: {
                        HStack {
                            artwork(episode).frame(width: 54, height: 54)
                            VStack(alignment: .leading) { Text(episode.guest ?? episode.title).font(.headline); Text(episode.title).font(.caption).lineLimit(2) }
                        }
                    }.accessibilityIdentifier("episode-" + episode.id)
                }.navigationTitle("Your podcasts")
            }
        }
        .sheet(isPresented: $settings) { ConnectionSettings() }
        .task { await model.loadCatalog(); await model.activate() }
        .onChange(of: scenePhase) { _, value in
            if value == .background { model.background() }
            else if value == .active { Task { await model.foregrounded() } }
        }
    }
    private var transcript: String {
        if [.listening, .thinking, .speaking, .error].contains(model.phase) { return model.heard.isEmpty ? model.reply : model.heard }
        return model.detailVisible ? model.podcastCaption : model.heard
    }
    private var status: String {
        switch model.phase {
        case .connecting: "Connecting…"
        case .listening: model.microphone ? "Listening" : "Microphone unavailable"
        case .thinking: "Thinking…"
        case .speaking: "Murmur is speaking"
        case .error: "Tap Murmur to try again"
        default: model.microphone ? "Tap Murmur or say “Hey Murmur”" : "Tap Murmur to talk"
        }
    }
    private func artwork(_ episode: Episode) -> some View {
        AsyncImage(url: episode.artworkUrl.flatMap(URL.init(string:))) { image in image.resizable().scaledToFill() }
        placeholder: { RoundedRectangle(cornerRadius: 18).fill(ink.opacity(0.1)).overlay(Image(systemName: "waveform")) }
        .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}

private struct ConnectionSettings: View {
    @AppStorage("backendAddress") private var address = "https://murmur-api-yeshwenth.fly.dev"
    var body: some View {
        NavigationStack {
            Form {
                TextField("Backend address", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled()
                Text("For local testing, use your Mac’s address on the same Wi-Fi. Restart Murmur after changing it. No Expo server is needed.")
            }.navigationTitle("Connection")
        }
    }
}
private extension Double {
    var formattedTime: String { let total = max(0, Int(isFinite ? self : 0)); return String(format: "%d:%02d", total / 60, total % 60) }
}
