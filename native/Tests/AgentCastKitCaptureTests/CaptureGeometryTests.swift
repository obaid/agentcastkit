import CoreGraphics
import XCTest
@testable import AgentCastKitCapture

final class CaptureGeometryTests: XCTestCase {
    func testWindowInsideDisplayUsesDisplayRelativeCoordinates() {
        let result = CaptureGeometry.window(
            CGRect(x: 100, y: 40, width: 800, height: 600),
            on: [CGRect(x: 0, y: 0, width: 1920, height: 1080)]
        )

        XCTAssertEqual(result, WindowCaptureGeometry(
            displayIndex: 0,
            sourceRect: CGRect(x: 100, y: 40, width: 800, height: 600)
        ))
    }

    func testWindowUsesDisplayWithLargestIntersection() {
        let result = CaptureGeometry.window(
            CGRect(x: 1500, y: 100, width: 900, height: 700),
            on: [
                CGRect(x: 0, y: 0, width: 1920, height: 1080),
                CGRect(x: 1920, y: 0, width: 1920, height: 1080),
            ]
        )

        XCTAssertEqual(result, WindowCaptureGeometry(
            displayIndex: 1,
            sourceRect: CGRect(x: 0, y: 100, width: 480, height: 700)
        ))
    }

    func testWindowOnNegativeOriginDisplayUsesLocalCoordinates() {
        let result = CaptureGeometry.window(
            CGRect(x: -1200, y: 120, width: 800, height: 600),
            on: [
                CGRect(x: -1440, y: 0, width: 1440, height: 900),
                CGRect(x: 0, y: 0, width: 1920, height: 1080),
            ]
        )

        XCTAssertEqual(result, WindowCaptureGeometry(
            displayIndex: 0,
            sourceRect: CGRect(x: 240, y: 120, width: 800, height: 600)
        ))
    }

    func testWindowOutsideDisplaysIsRejected() {
        XCTAssertNil(CaptureGeometry.window(
            CGRect(x: 2500, y: 100, width: 400, height: 300),
            on: [CGRect(x: 0, y: 0, width: 1920, height: 1080)]
        ))
    }

    func testInvalidWindowGeometryIsRejected() {
        XCTAssertNil(CaptureGeometry.window(
            CGRect(x: CGFloat.nan, y: 0, width: 400, height: 300),
            on: [CGRect(x: 0, y: 0, width: 1920, height: 1080)]
        ))
        XCTAssertNil(CaptureGeometry.window(
            CGRect(x: 0, y: 0, width: 0, height: 300),
            on: [CGRect(x: 0, y: 0, width: 1920, height: 1080)]
        ))
    }
}
