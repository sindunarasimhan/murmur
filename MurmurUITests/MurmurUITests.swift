import XCTest

final class MurmurUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["mascot"].waitForExistence(timeout: 15))
        return app
    }

    @MainActor
    private func say(_ text: String, in app: XCUIApplication) {
        let input = app.textFields["test-input"]
        input.tap()
        input.typeText(text + "\n")
    }

    @MainActor
    private func expect(_ label: String, at element: XCUIElement) {
        let matches = NSPredicate(format: "label == %@", label)
        expectation(for: matches, evaluatedWith: element)
        waitForExpectations(timeout: 10)
    }

    @MainActor
    func testHomeGreetingEpisodePauseResumeAndEnd() {
        let app = launch()
        XCTAssertTrue(app.staticTexts["home-title"].exists)
        say("Hey Murmur", in: app)
        expect("Hey Murmur", at: app.staticTexts["transcript"])
        say("Play astronomy", in: app)
        expect("Playing", at: app.staticTexts["playback-state"])
        XCTAssertFalse(app.staticTexts["home-title"].exists)
        app.buttons["mascot"].tap()
        expect("Paused", at: app.staticTexts["playback-state"])
        say("pause", in: app)
        expect("Paused", at: app.staticTexts["playback-state"])
        app.buttons["mascot"].tap()
        say("resume", in: app)
        expect("Playing", at: app.staticTexts["playback-state"])
        expect("2:00", at: app.staticTexts["position"])
        app.buttons["mascot"].tap()
        say("end episode", in: app)
        XCTAssertTrue(app.staticTexts["home-title"].waitForExistence(timeout: 10))
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "Returned home"; image.lifetime = .keepAlways; add(image)
    }

    @MainActor
    func testLibrarySelectionAndSkipAd() {
        let app = launch()
        app.buttons["library"].tap()
        let episode = app.buttons["episode-fixture-2"]
        XCTAssertTrue(episode.waitForExistence(timeout: 5))
        episode.tap()
        expect("Playing", at: app.staticTexts["playback-state"])
        app.buttons["mascot"].tap()
        say("skip ad", in: app)
        expect("Playing", at: app.staticTexts["playback-state"])
        expect("3:00", at: app.staticTexts["position"])
    }

    @MainActor
    func testBackgroundAndReopenDoesNotRestartEpisode() {
        let app = launch()
        say("Hey Murmur play", in: app)
        expect("Playing", at: app.staticTexts["playback-state"])
        XCUIDevice.shared.press(.home)
        app.activate()
        expect("Playing", at: app.staticTexts["playback-state"])
        expect("2:00", at: app.staticTexts["position"])
    }
}
