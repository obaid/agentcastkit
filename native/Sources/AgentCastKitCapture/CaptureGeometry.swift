import CoreGraphics

struct WindowCaptureGeometry: Equatable {
    let displayIndex: Int
    let sourceRect: CGRect
}

enum CaptureGeometry {
    static func window(_ windowFrame: CGRect, on displayFrames: [CGRect]) -> WindowCaptureGeometry? {
        guard windowFrame.isUsableCaptureRect else { return nil }

        var best: (index: Int, intersection: CGRect, area: CGFloat)?

        for (index, displayFrame) in displayFrames.enumerated() where displayFrame.isUsableCaptureRect {
            let intersection = windowFrame.intersection(displayFrame)
            guard intersection.isUsableCaptureRect else { continue }

            let area = intersection.width * intersection.height
            if best == nil || area > best!.area {
                best = (index, intersection, area)
            }
        }

        guard let best else { return nil }
        let displayFrame = displayFrames[best.index]

        return WindowCaptureGeometry(
            displayIndex: best.index,
            sourceRect: CGRect(
                x: best.intersection.minX - displayFrame.minX,
                y: best.intersection.minY - displayFrame.minY,
                width: best.intersection.width,
                height: best.intersection.height
            )
        )
    }
}

private extension CGRect {
    var isUsableCaptureRect: Bool {
        !isNull && !isInfinite && !isEmpty
            && minX.isFinite && minY.isFinite
            && width.isFinite && height.isFinite
            && width > 0 && height > 0
    }
}
