import AppKit
import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

struct Failure: Error {
    let code: String
    let message: String
}

struct ErrorPayload: Encodable {
    let code: String
    let message: String
}

struct Envelope<T: Encodable>: Encodable {
    let ok: Bool
    let data: T?
    let error: ErrorPayload?

    static func success(_ data: T) -> Self { .init(ok: true, data: data, error: nil) }
    static func failure(code: String, message: String) -> Self { .init(ok: false, data: nil, error: .init(code: code, message: message)) }
}

struct Empty: Encodable {}

struct PermissionPayload: Encodable {
    let screen: String
    let microphone: String
    let camera: String
}

struct SourcePayload: Encodable {
    let id: String
    let kind: String
    let name: String
    let application: String?
    let width: Int
    let height: Int
    let x: Int
    let y: Int
    let scale: Double?
}

struct RecordingPayload: Encodable {
    let path: String
    let durationSeconds: Double
    let bytes: Int64
}

final class RecordingDelegate: NSObject, SCRecordingOutputDelegate, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var failure: Error?

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: any Error) {
        lock.lock()
        failure = error
        lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        lock.lock()
        failure = error
        lock.unlock()
    }

    func capturedFailure() -> Error? {
        lock.lock()
        defer { lock.unlock() }
        return failure
    }
}

@main
struct AgentCastKitCapture {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.isEmpty {
            await MainActor.run {
                RunnerApplication.launch()
            }
            return
        }

        do {
            try await run(arguments)
        } catch let failure as Failure {
            emit(Envelope<Empty>.failure(code: failure.code, message: failure.message))
            Foundation.exit(1)
        } catch {
            emit(Envelope<Empty>.failure(code: "native_error", message: error.localizedDescription))
            Foundation.exit(1)
        }
    }

    static func run(_ arguments: [String]) async throws {
        guard let command = arguments.first else {
            throw Failure(code: "usage", message: "Expected describe, permissions, sources, record, or cloud.")
        }
        switch command {
        case "describe":
            emit(Envelope.success(["name": "agentcastkit-capture", "version": "0.3.0", "platform": "macOS 15+"]))
        case "permissions":
            try await permissions(Array(arguments.dropFirst()))
        case "sources":
            try await sources(Array(arguments.dropFirst()))
        case "record":
            try await record(Array(arguments.dropFirst()))
        case "cloud":
            try await cloud(Array(arguments.dropFirst()))
        default:
            throw Failure(code: "usage", message: "Unknown command: \(command)")
        }
    }

    static func cloud(_ arguments: [String]) async throws {
        guard let command = arguments.first else {
            throw Failure(code: "usage", message: "Expected cloud voice-library or cloud synthesize.")
        }
        let options = try parseOptions(Array(arguments.dropFirst()))

        switch command {
        case "voice-library":
            let page = try integerOption("page", options: options, default: 1, range: 1...100_000)
            let pageSize = try integerOption("page-size", options: options, default: 1_000, range: 10...1_000)
            let scope = options["scope"] ?? "marketplace"
            guard ["marketplace", "available"].contains(scope) else {
                throw Failure(code: "usage", message: "--scope must be marketplace or available.")
            }
            let includePreviews = boolOption("include-previews", options: options, default: false)
            emit(Envelope.success(try await CloudBroker.voices(
                page: page,
                pageSize: pageSize,
                scope: scope,
                includePreviews: includePreviews
            )))
        case "synthesize":
            guard let output = options["output"] else {
                throw Failure(code: "usage", message: "cloud synthesize requires --output.")
            }
            let inputData = FileHandle.standardInput.readDataToEndOfFile()
            let input: CloudSynthesisInput
            do {
                input = try JSONDecoder().decode(CloudSynthesisInput.self, from: inputData)
            } catch {
                throw Failure(code: "usage", message: "cloud synthesize expects a JSON request on stdin.")
            }
            emit(Envelope.success(try await CloudBroker.synthesize(input: input, outputPath: output)))
        default:
            throw Failure(code: "usage", message: "Unknown cloud command: \(command)")
        }
    }

    static func permissions(_ arguments: [String]) async throws {
        switch arguments.first {
        case "status":
            emit(Envelope.success(permissionPayload()))
        case "request":
            guard let permission = arguments.dropFirst().first else {
                throw Failure(code: "usage", message: "Expected screen, microphone, or camera.")
            }
            switch permission {
            case "screen":
                _ = CGRequestScreenCaptureAccess()
            case "microphone":
                _ = await AVCaptureDevice.requestAccess(for: .audio)
            case "camera":
                _ = await AVCaptureDevice.requestAccess(for: .video)
            default:
                throw Failure(code: "usage", message: "Unknown permission: \(permission)")
            }
            emit(Envelope.success(permissionPayload()))
        default:
            throw Failure(code: "usage", message: "Expected permissions status or permissions request.")
        }
    }

    static func sources(_ arguments: [String]) async throws {
        guard arguments.first == "list" else {
            throw Failure(code: "usage", message: "Expected sources list.")
        }
        guard CGPreflightScreenCaptureAccess() else {
            throw Failure(code: "screen_permission_required", message: "Grant Screen Recording permission before listing sources.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        var payloads = content.displays.map { display in
            SourcePayload(
                id: "display:\(display.displayID)",
                kind: "display",
                name: "Display \(display.displayID)",
                application: nil,
                width: display.width,
                height: display.height,
                x: Int(display.frame.origin.x),
                y: Int(display.frame.origin.y),
                scale: Double(display.width) / max(display.frame.width, 1)
            )
        }
        payloads.append(contentsOf: content.windows.compactMap { window -> SourcePayload? in
            guard window.isOnScreen, window.frame.width >= 80, window.frame.height >= 60 else { return nil }
            let application = window.owningApplication?.applicationName
            let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            return SourcePayload(
                id: "window:\(window.windowID)",
                kind: "window",
                name: [application, title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " — "),
                application: application,
                width: Int(window.frame.width),
                height: Int(window.frame.height),
                x: Int(window.frame.origin.x),
                y: Int(window.frame.origin.y),
                scale: nil
            )
        })
        emit(Envelope.success(payloads))
    }

    static func record(_ arguments: [String]) async throws {
        let options = try parseOptions(arguments)
        guard let sourceID = options["source"], let output = options["output"] else {
            throw Failure(code: "usage", message: "record requires --source and --output.")
        }
        guard CGPreflightScreenCaptureAccess() else {
            throw Failure(code: "screen_permission_required", message: "Grant Screen Recording permission before recording.")
        }
        let duration = try doubleOption("duration", options: options, default: 15, range: 1...3_600)
        let fps = try doubleOption("fps", options: options, default: 60, range: 1...120)
        let systemAudio = boolOption("system-audio", options: options, default: true)
        let cursor = boolOption("cursor", options: options, default: true)
        let outputURL = URL(fileURLWithPath: output).standardizedFileURL
        try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: outputURL.path) {
            throw Failure(code: "output_exists", message: "Refusing to overwrite \(outputURL.path)")
        }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        let width: Int
        let height: Int
        var sourceRect: CGRect?
        if sourceID.hasPrefix("display:"), let rawID = UInt32(sourceID.dropFirst("display:".count)),
           let display = content.displays.first(where: { $0.displayID == rawID }) {
            filter = SCContentFilter(display: display, excludingWindows: [])
            width = display.width
            height = display.height
        } else if sourceID.hasPrefix("window:"), let rawID = UInt32(sourceID.dropFirst("window:".count)),
                  let window = content.windows.first(where: { $0.windowID == rawID }) {
            guard let geometry = CaptureGeometry.window(window.frame, on: content.displays.map(\.frame)) else {
                throw Failure(code: "window_not_on_display", message: "The selected window does not intersect a recordable display.")
            }
            let display = content.displays[geometry.displayIndex]
            filter = SCContentFilter(display: display, including: [window])
            sourceRect = geometry.sourceRect
            let pixelScale = max(Double(filter.pointPixelScale), 1)
            width = Int((geometry.sourceRect.width * pixelScale).rounded(.up))
            height = Int((geometry.sourceRect.height * pixelScale).rounded(.up))
        } else {
            throw Failure(code: "source_not_found", message: "Source is no longer available: \(sourceID)")
        }

        let configuration = SCStreamConfiguration()
        configuration.width = even(width)
        configuration.height = even(height)
        if let sourceRect {
            configuration.sourceRect = sourceRect
            configuration.scalesToFit = true
        }
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.queueDepth = 8
        configuration.showsCursor = cursor
        configuration.capturesAudio = systemAudio
        configuration.excludesCurrentProcessAudio = true

        let recordingConfiguration = SCRecordingOutputConfiguration()
        recordingConfiguration.outputURL = outputURL
        recordingConfiguration.videoCodecType = .h264
        recordingConfiguration.outputFileType = .mp4
        let delegate = RecordingDelegate()
        let recordingOutput = SCRecordingOutput(configuration: recordingConfiguration, delegate: delegate)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: delegate)
        try stream.addRecordingOutput(recordingOutput)

        try await stream.startCapture()
        try await Task.sleep(for: .seconds(duration))
        try await stream.stopCapture()
        try await Task.sleep(for: .milliseconds(250))
        if let failure = delegate.capturedFailure() { throw failure }

        let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        let bytes = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        emit(Envelope.success(RecordingPayload(path: outputURL.path, durationSeconds: duration, bytes: bytes)))
    }

    static func permissionPayload() -> PermissionPayload {
        .init(
            screen: CGPreflightScreenCaptureAccess() ? "granted" : "not_granted",
            microphone: authorizationName(AVCaptureDevice.authorizationStatus(for: .audio)),
            camera: authorizationName(AVCaptureDevice.authorizationStatus(for: .video))
        )
    }

    static func authorizationName(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: "granted"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "not_determined"
        @unknown default: "unknown"
        }
    }

    static func parseOptions(_ arguments: [String]) throws -> [String: String] {
        var result: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let flag = arguments[index]
            guard flag.hasPrefix("--"), index + 1 < arguments.count else {
                throw Failure(code: "usage", message: "Expected --name value options.")
            }
            result[String(flag.dropFirst(2))] = arguments[index + 1]
            index += 2
        }
        return result
    }

    static func doubleOption(_ name: String, options: [String: String], default defaultValue: Double, range: ClosedRange<Double>) throws -> Double {
        let value = options[name].flatMap(Double.init) ?? defaultValue
        guard range.contains(value) else { throw Failure(code: "usage", message: "--\(name) must be in \(range).") }
        return value
    }

    static func integerOption(_ name: String, options: [String: String], default defaultValue: Int, range: ClosedRange<Int>) throws -> Int {
        let value = options[name].flatMap(Int.init) ?? defaultValue
        guard range.contains(value) else { throw Failure(code: "usage", message: "--\(name) must be in \(range).") }
        return value
    }

    static func boolOption(_ name: String, options: [String: String], default defaultValue: Bool) -> Bool {
        guard let value = options[name] else { return defaultValue }
        return value == "true" || value == "1"
    }

    static func even(_ value: Int) -> Int { max(2, value - (value % 2)) }

    static func emit<T: Encodable>(_ value: T) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try! encoder.encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
