import SwiftUI

struct MascotView: View {
    let phase: ConversationModel.Phase
    let level: Double
    let listening: Bool
    let tapped: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @State private var jiggle = 0

    var body: some View {
        Button { jiggle += 1; tapped() } label: {
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reducedMotion)) { timeline in
                GeometryReader { geometry in
                    let size = geometry.size.width
                    let time = timeline.date.timeIntervalSinceReferenceDate
                    let breath = reducedMotion ? 0 : sin(time * 0.95)
                    let blink = reducedMotion ? 1.0 : (time.truncatingRemainder(dividingBy: 5.3) < 0.13 ? 0.15 : 1.0)
                    ZStack {
                        Circle().fill(Color(red: 0.72, green: 0.79, blue: 0.64)).blur(radius: 24)
                            .scaleEffect(0.76 + breath * 0.02).opacity(listening ? 0.38 : 0.08)
                        ZStack(alignment: .topLeading) {
                            Image("Mascot").resizable().scaledToFit()
                            eye(size: size, blink: blink).frame(width: size * 0.12, height: size * 0.13).offset(x: size * 0.35, y: size * 0.47)
                            eye(size: size, blink: blink).frame(width: size * 0.10, height: size * 0.12).offset(x: size * 0.65, y: size * 0.42)
                            Capsule().fill(Color.brown.opacity(0.85)).frame(width: size * 0.08, height: size * 0.02).rotationEffect(.degrees(-24)).offset(x: size * 0.33, y: size * 0.39)
                            Capsule().fill(Color.brown.opacity(0.85)).frame(width: size * 0.07, height: size * 0.02).rotationEffect(.degrees(listening ? 3 : 18)).offset(x: size * 0.65, y: size * 0.35)
                            Capsule().fill(Color(red: 0.29, green: 0.22, blue: 0.18))
                                .frame(width: size * 0.10, height: size * (0.012 + min(1, level) * 0.025))
                                .rotationEffect(.degrees(-12)).offset(x: size * 0.53, y: size * 0.61)
                                .animation(reducedMotion ? nil : .easeOut(duration: 0.12), value: level)
                        }.offset(y: breath * 4).rotationEffect(.degrees(breath * 0.6 + (listening ? -2 : 0)))
                    }
                }
            }
        }.buttonStyle(.plain).sensoryFeedback(.selection, trigger: jiggle)
        .keyframeAnimator(initialValue: 0.0, trigger: reducedMotion ? 0 : jiggle) { content, rotation in
            content.rotationEffect(.degrees(rotation))
        } keyframes: { _ in
            CubicKeyframe(-3, duration: 0.12)
            SpringKeyframe(0, duration: 0.55, spring: .bouncy)
        }
        .accessibilityLabel("Talk to Murmur").accessibilityValue(listening ? "Listening" : phase.rawValue).accessibilityIdentifier("mascot")
    }
    private func eye(size: Double, blink: Double) -> some View {
        ZStack(alignment: .topTrailing) {
            Ellipse().fill(Color(red: 1, green: 0.97, blue: 0.92))
            Ellipse().fill(Color(red: 0.22, green: 0.18, blue: 0.15)).padding(.leading, size * 0.035).padding(.bottom, size * 0.013)
            Ellipse().fill(.white).frame(width: size * 0.018, height: size * 0.024).padding(size * 0.018)
        }.scaleEffect(x: 1, y: blink).rotationEffect(.degrees(-15))
    }
}
