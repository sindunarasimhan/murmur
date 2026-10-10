import SwiftUI

@main
struct MurmurApp: App {
    var body: some Scene { WindowGroup { ContentView().preferredColorScheme(.light) } }
}

@MainActor
final class MurmurRuntime {
    let conversation: ConversationModel
    let voice: NativeVoice?
    let testing: Bool
    init() {
        #if DEBUG
        testing = ProcessInfo.processInfo.arguments.contains("--ui-testing")
        if testing {
            conversation = ConversationModel(api: TestListeningService(), player: TestPlayback(), speech: TestSpeech())
            conversation.startMicrophone = {}; voice = nil; return
        }
        #else
        testing = false
        #endif
        let hostedAddress = "https://murmur-api-yeshwenth.fly.dev"
        let savedAddress = UserDefaults.standard.string(forKey: "backendAddress")
        // Migrate only the former default; preserve explicitly configured servers.
        if savedAddress == "http://192.168.1.219:4545" {
            UserDefaults.standard.set(hostedAddress, forKey: "backendAddress")
        }
        let address = UserDefaults.standard.string(forKey: "backendAddress") ?? hostedAddress
        let api = ListeningAPI(baseURL: URL(string: address) ?? URL(string: hostedAddress)!)
        let player = PlaybackEngine()
        let microphone = NativeVoice(api: api)
        voice = microphone
        let model = ConversationModel(api: api, player: player, speech: NativeSpeech())
        conversation = model
        model.startMicrophone = { try await microphone.start() }
        model.stopMicrophone = { microphone.stop() }
        model.beginMicrophoneTurn = { microphone.beginTappedTurn() }
        microphone.onTranscript = { [weak model] text, id, final in model?.receive(text, item: id, final: final) }
        microphone.onError = { [weak model] error in model?.microphoneFailed(error) }
        player.onRemoteCommand = { [weak model] command, position in model?.remote(command, position: position) }
    }
}
