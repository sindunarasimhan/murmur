import Foundation

struct VoiceTurnBoundary {
    private var active: Set<String> = []
    private var retired: Set<String> = []
    private var pendingClears = 0
    private(set) var captureStart = -Double.infinity

    mutating func begin(at time: TimeInterval) {
        captureStart = time
        retired.formUnion(active)
        pendingClears += 1
    }

    mutating func committed(_ item: String) {
        active.insert(item)
        if pendingClears > 0 { retired.insert(item) }
    }

    mutating func cleared() { pendingClears = max(0, pendingClears - 1) }
    var clearing: Bool { pendingClears > 0 }

    mutating func accepts(_ item: String, final: Bool) -> Bool {
        if pendingClears > 0 { retired.insert(item) }
        let accepted = !retired.contains(item)
        if final { active.remove(item) }
        else { active.insert(item) }
        return accepted
    }
}
