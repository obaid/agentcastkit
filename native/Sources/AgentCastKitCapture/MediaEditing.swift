import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation

struct MediaVideoPayload: Encodable {
    let width: Int
    let height: Int
    let nominalFramesPerSecond: Double
}

struct MediaInspectionPayload: Encodable {
    let path: String
    let durationSeconds: Double
    let bytes: Int64
    let video: MediaVideoPayload?
    let audioTrackCount: Int
}

struct ActivitySamplePayload: Encodable {
    let timeSeconds: Double
    let differenceScore: Double
}

struct MediaAnalysisPayload: Encodable {
    let path: String
    let durationSeconds: Double
    let bytes: Int64
    let video: MediaVideoPayload?
    let audioTrackCount: Int
    let sampleFramesPerSecond: Double
    let samples: [ActivitySamplePayload]
}

struct NativeEditSegment: Decodable {
    let id: String
    let sourceStartSeconds: Double
    let sourceEndSeconds: Double
    let playbackRate: Double
}

struct NativeEditRequest: Decodable {
    let segments: [NativeEditSegment]
}

struct RenderPayload: Encodable {
    let path: String
    let durationSeconds: Double
    let bytes: Int64
    let segmentCount: Int
}

enum MediaEditing {
    static func inspect(path: String) async throws -> MediaInspectionPayload {
        let url = try readableFileURL(path)
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0 else {
            throw Failure(code: "media_duration_invalid", message: "The source video has no usable duration.")
        }
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        let video: MediaVideoPayload?
        if let track = videoTracks.first {
            let naturalSize = try await track.load(.naturalSize)
            let transform = try await track.load(.preferredTransform)
            let displaySize = naturalSize.applying(transform)
            let frameRate = try await track.load(.nominalFrameRate)
            video = MediaVideoPayload(
                width: max(1, Int(abs(displaySize.width).rounded())),
                height: max(1, Int(abs(displaySize.height).rounded())),
                nominalFramesPerSecond: Double(frameRate)
            )
        } else {
            video = nil
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let bytes = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        return MediaInspectionPayload(
            path: url.path,
            durationSeconds: rounded(duration),
            bytes: bytes,
            video: video,
            audioTrackCount: audioTracks.count
        )
    }

    static func analyze(path: String, requestedSampleFPS: Double) async throws -> MediaAnalysisPayload {
        let inspection = try await inspect(path: path)
        guard inspection.video != nil else {
            throw Failure(code: "media_video_missing", message: "The source artifact has no video track.")
        }
        let asset = AVURLAsset(url: URL(fileURLWithPath: inspection.path))
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 192, height: 108)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.08, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.08, preferredTimescale: 600)

        let sampleFPS = min(requestedSampleFPS, max(0.5, 2_000 / inspection.durationSeconds))
        let step = 1 / sampleFPS
        let finalSampleTime = max(0, inspection.durationSeconds - 0.02)
        var time = 0.0
        var previous: [UInt8]?
        var samples: [ActivitySamplePayload] = []

        while time <= finalSampleTime + 0.0001 {
            let requestedTime = CMTime(seconds: min(time, finalSampleTime), preferredTimescale: 600)
            let (image, _) = try await generator.image(at: requestedTime)
            let current = grayscaleFingerprint(image)
            let score = previous.map { difference($0, current) } ?? 0
            samples.append(ActivitySamplePayload(timeSeconds: rounded(min(time, finalSampleTime)), differenceScore: rounded(score, places: 6)))
            previous = current
            time += step
        }

        return MediaAnalysisPayload(
            path: inspection.path,
            durationSeconds: inspection.durationSeconds,
            bytes: inspection.bytes,
            video: inspection.video,
            audioTrackCount: inspection.audioTrackCount,
            sampleFramesPerSecond: rounded(sampleFPS),
            samples: samples
        )
    }

    static func render(inputPath: String, outputPath: String, request: NativeEditRequest) async throws -> RenderPayload {
        let inputURL = try readableFileURL(inputPath)
        let outputURL = URL(fileURLWithPath: outputPath).standardizedFileURL
        guard outputURL.pathExtension.lowercased() == "mp4" else {
            throw Failure(code: "render_output_invalid", message: "The render output must use the .mp4 extension.")
        }
        guard !FileManager.default.fileExists(atPath: outputURL.path) else {
            throw Failure(code: "output_exists", message: "Refusing to overwrite \(outputURL.path)")
        }
        try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        let asset = AVURLAsset(url: inputURL)
        let assetDuration = try await asset.load(.duration).seconds
        let sourceVideoTracks = try await asset.loadTracks(withMediaType: .video)
        guard let sourceVideo = sourceVideoTracks.first else {
            throw Failure(code: "media_video_missing", message: "The source artifact has no video track.")
        }
        let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first
        let segments = try validated(request.segments, duration: assetDuration)

        let composition = AVMutableComposition()
        guard let destinationVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw Failure(code: "render_track_failed", message: "Could not create the destination video track.")
        }
        destinationVideo.preferredTransform = try await sourceVideo.load(.preferredTransform)
        let destinationAudio = sourceAudio.flatMap { _ in
            composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        }

        var cursor = CMTime.zero
        for item in segments {
            let sourceStart = CMTime(seconds: item.sourceStartSeconds, preferredTimescale: 600)
            let sourceDuration = CMTime(seconds: item.sourceEndSeconds - item.sourceStartSeconds, preferredTimescale: 600)
            let sourceRange = CMTimeRange(start: sourceStart, duration: sourceDuration)
            try destinationVideo.insertTimeRange(sourceRange, of: sourceVideo, at: cursor)
            if let sourceAudio, let destinationAudio {
                try destinationAudio.insertTimeRange(sourceRange, of: sourceAudio, at: cursor)
            }
            let destinationDuration = CMTimeMultiplyByFloat64(sourceDuration, multiplier: 1 / item.playbackRate)
            if abs(item.playbackRate - 1) > 0.0001 {
                composition.scaleTimeRange(CMTimeRange(start: cursor, duration: sourceDuration), toDuration: destinationDuration)
            }
            cursor = CMTimeAdd(cursor, destinationDuration)
        }

        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
            throw Failure(code: "render_export_unavailable", message: "macOS could not create an MP4 export session.")
        }
        exporter.shouldOptimizeForNetworkUse = false
        try await exporter.export(to: outputURL, as: .mp4)

        let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        let bytes = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        return RenderPayload(
            path: outputURL.path,
            durationSeconds: rounded(cursor.seconds),
            bytes: bytes,
            segmentCount: segments.count
        )
    }

    private static func readableFileURL(_ path: String) throws -> URL {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        guard url.isFileURL, FileManager.default.isReadableFile(atPath: url.path) else {
            throw Failure(code: "media_not_found", message: "The local media artifact is not readable: \(url.path)")
        }
        return url
    }

    private static func validated(_ segments: [NativeEditSegment], duration: Double) throws -> [NativeEditSegment] {
        guard !segments.isEmpty, segments.count <= 500 else {
            throw Failure(code: "edit_plan_invalid", message: "An edit plan must contain between 1 and 500 segments.")
        }
        var priorEnd = 0.0
        for item in segments {
            guard item.sourceStartSeconds >= priorEnd - 0.001,
                  item.sourceEndSeconds - item.sourceStartSeconds >= 0.1,
                  item.sourceEndSeconds <= duration + 0.001,
                  (0.25...8).contains(item.playbackRate) else {
                throw Failure(code: "edit_plan_invalid", message: "Edit segments must be ordered, non-overlapping, in range, and use a playback rate from 0.25x to 8x.")
            }
            priorEnd = item.sourceEndSeconds
        }
        return segments
    }

    private static func grayscaleFingerprint(_ image: CGImage) -> [UInt8] {
        let width = 32
        let height = 18
        var pixels = [UInt8](repeating: 0, count: width * height)
        pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        return pixels
    }

    private static func difference(_ left: [UInt8], _ right: [UInt8]) -> Double {
        guard left.count == right.count, !left.isEmpty else { return 0 }
        let total = zip(left, right).reduce(0.0) { partial, values in
            partial + Double(abs(Int(values.0) - Int(values.1)))
        }
        return total / Double(left.count) / 255
    }

    private static func rounded(_ value: Double, places: Int = 3) -> Double {
        let factor = pow(10, Double(places))
        return (value * factor).rounded() / factor
    }
}
