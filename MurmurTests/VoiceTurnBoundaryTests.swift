import Testing
@testable import Murmur

struct VoiceTurnBoundaryTests {
    @Test func delayedOldCompletionCannotBecomeTappedRequest() {
        var boundary = VoiceTurnBoundary()
        boundary.committed("podcast")
        boundary.begin(at: 10)
        boundary.cleared()
        let old = boundary.accepts("podcast", final: true)
        let partial = boundary.accepts("user", final: false)
        let final = boundary.accepts("user", final: true)
        #expect(!old && partial && final)
    }

    @Test func commitAcknowledgedDuringClearIsStillOldAudio() {
        var boundary = VoiceTurnBoundary()
        boundary.begin(at: 10)
        boundary.committed("late-commit")
        boundary.cleared()
        let old = boundary.accepts("late-commit", final: true)
        #expect(!old)
    }

    @Test func streamingUncommittedAudioIsRetiredWithoutDiscardingNextTurn() {
        var boundary = VoiceTurnBoundary()
        let beforeTap = boundary.accepts("old-partial", final: false)
        #expect(beforeTap)
        boundary.begin(at: 10)
        let inFlight = boundary.accepts("in-flight", final: false)
        #expect(!inFlight)
        boundary.cleared()
        let old = boundary.accepts("old-partial", final: true)
        let late = boundary.accepts("in-flight", final: true)
        let fresh = boundary.accepts("new-partial", final: false)
        #expect(!old && !late && fresh)
        #expect(boundary.captureStart == 10)
    }

    @Test func repeatedTapsWaitForEachClearAndWakeOnlyPathRemainsUnchanged() {
        var boundary = VoiceTurnBoundary()
        let wakePartial = boundary.accepts("wake-and-command", final: false)
        let wakeFinal = boundary.accepts("wake-and-command", final: true)
        #expect(wakePartial && wakeFinal)
        boundary.begin(at: 10); boundary.begin(at: 11)
        boundary.cleared()
        #expect(boundary.clearing)
        let between = boundary.accepts("between-clears", final: true)
        #expect(!between)
        boundary.cleared()
        #expect(!boundary.clearing)
        let fresh = boundary.accepts("fresh", final: true)
        #expect(fresh)
    }
}
