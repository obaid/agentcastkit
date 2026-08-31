import Foundation

struct CloudVoice: Codable {
    let id: String
    let name: String
    let status: String
    let defaultLanguage: String?
    let supportedLanguages: [String]
    let source: String?
    let previewURL: String?
    let capabilities: [String: Bool]

    enum CodingKeys: String, CodingKey {
        case id, name, status, source, capabilities
        case defaultLanguage = "default_language"
        case supportedLanguages = "supported_languages"
        case previewURL = "preview_url"
    }
}

struct CloudVoiceLibraryPayload: Encodable {
    let voices: [CloudVoice]
    let page: Int
    let pageSize: Int
    let total: Int?
    let pages: Int?
    let hasMore: Bool
}

struct CloudTimingCue: Codable {
    let value: String
    let startSeconds: Double
    let endSeconds: Double

    enum CodingKeys: String, CodingKey {
        case value
        case startSeconds = "start_seconds"
        case endSeconds = "end_seconds"
    }
}

struct CloudSynthesisInput: Decodable {
    let voiceID: String
    let text: String
    let outputFormat: String
    let quality: String
    let idempotencyKey: String

    enum CodingKeys: String, CodingKey {
        case text, quality
        case voiceID = "voiceId"
        case outputFormat = "outputFormat"
        case idempotencyKey = "idempotencyKey"
    }
}

struct CloudSpeechArtifact: Encodable {
    let id: String
    let path: String
    let bytes: Int64
    let voiceID: String
    let characters: Int
    let outputFormat: String
    let quality: String
    let sampleRate: Int?
    let durationSeconds: Double?
    let timing: [CloudTimingCue]
    let issues: [String]
}

private struct VoiceLibraryEnvelope: Decodable {
    let data: [CloudVoice]
    let meta: VoiceLibraryMeta
}

private struct VoiceLibraryMeta: Decodable {
    let page: Int
    let pageSize: Int
    let total: Int?
    let pages: Int?
    let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case page, total, pages
        case pageSize = "page_size"
        case hasMore = "has_more"
    }
}

private struct SpeechGenerationEnvelope: Decodable {
    let data: SpeechGenerationData
}

private struct SpeechGenerationData: Decodable {
    let id: String
    let voiceID: String
    let characters: Int
    let outputFormat: String
    let quality: String
    let sampleRate: Int?
    let durationSeconds: Double?
    let timing: [CloudTimingCue]
    let issues: [String]
    let audioPath: String

    enum CodingKeys: String, CodingKey {
        case id, characters, quality, timing, issues
        case voiceID = "voice_id"
        case outputFormat = "output_format"
        case sampleRate = "sample_rate"
        case durationSeconds = "duration_seconds"
        case audioPath = "audio_path"
    }
}

private struct SpeechGenerationRequest: Encodable {
    let installationID: String
    let voiceID: String
    let text: String
    let outputFormat: String
    let quality: String
    let idempotencyKey: String

    enum CodingKeys: String, CodingKey {
        case text, quality
        case installationID = "installation_id"
        case voiceID = "voice_id"
        case outputFormat = "output_format"
        case idempotencyKey = "idempotency_key"
    }
}

private struct CloudAPIErrorEnvelope: Decodable {
    let message: String?
    let error: CloudAPIError?
}

private struct CloudAPIError: Decodable {
    let code: String?
    let message: String?
}

private struct RunnerCredential {
    let serverURL: URL
    let token: String
    let installationID: String
}

enum CloudBroker {
    static func voices(
        page: Int,
        pageSize: Int,
        scope: String,
        includePreviews: Bool
    ) async throws -> CloudVoiceLibraryPayload {
        let credential = try credential()
        var components = URLComponents(url: credential.serverURL.appendingPathComponent("api/v1/voice-library"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "installation_id", value: credential.installationID),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "page_size", value: String(pageSize)),
            URLQueryItem(name: "include_previews", value: includePreviews ? "1" : "0"),
        ]
        guard let url = components?.url else {
            throw Failure(code: "cloud_url_invalid", message: "Could not build the AgentCastKit voice-library URL.")
        }

        let (data, response) = try await send(url: url, method: "GET", token: credential.token)
        try validate(response: response, data: data)

        do {
            let envelope = try JSONDecoder().decode(VoiceLibraryEnvelope.self, from: data)
            return CloudVoiceLibraryPayload(
                voices: envelope.data,
                page: envelope.meta.page,
                pageSize: envelope.meta.pageSize,
                total: envelope.meta.total,
                pages: envelope.meta.pages,
                hasMore: envelope.meta.hasMore
            )
        } catch {
            throw Failure(code: "cloud_protocol_error", message: "The AgentCastKit voice library returned an invalid response.")
        }
    }

    static func synthesize(input: CloudSynthesisInput, outputPath: String) async throws -> CloudSpeechArtifact {
        let credential = try credential()
        let requestURL = credential.serverURL.appendingPathComponent("api/v1/speech-generations")
        let body = try JSONEncoder().encode(SpeechGenerationRequest(
            installationID: credential.installationID,
            voiceID: input.voiceID,
            text: input.text,
            outputFormat: input.outputFormat,
            quality: input.quality,
            idempotencyKey: input.idempotencyKey
        ))
        let (generationData, generationResponse) = try await send(
            url: requestURL,
            method: "POST",
            token: credential.token,
            body: body
        )
        try validate(response: generationResponse, data: generationData)

        let generation: SpeechGenerationData
        do {
            generation = try JSONDecoder().decode(SpeechGenerationEnvelope.self, from: generationData).data
        } catch {
            throw Failure(code: "cloud_protocol_error", message: "The AgentCastKit voice service returned an invalid generation response.")
        }

        guard let audioURL = URL(string: generation.audioPath, relativeTo: credential.serverURL)?.absoluteURL else {
            throw Failure(code: "cloud_protocol_error", message: "The AgentCastKit voice service returned an invalid audio path.")
        }
        let (audio, audioResponse) = try await send(url: audioURL, method: "GET", token: credential.token)
        try validate(response: audioResponse, data: audio)

        let outputURL = URL(fileURLWithPath: outputPath).standardizedFileURL
        try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard !FileManager.default.fileExists(atPath: outputURL.path) else {
            throw Failure(code: "output_exists", message: "Refusing to overwrite \(outputURL.path)")
        }
        try audio.write(to: outputURL, options: [.atomic])

        return CloudSpeechArtifact(
            id: generation.id,
            path: outputURL.path,
            bytes: Int64(audio.count),
            voiceID: generation.voiceID,
            characters: generation.characters,
            outputFormat: generation.outputFormat,
            quality: generation.quality,
            sampleRate: generation.sampleRate,
            durationSeconds: generation.durationSeconds,
            timing: generation.timing,
            issues: generation.issues
        )
    }

    private static func credential() throws -> RunnerCredential {
        guard let tokenData = KeychainStore.read(service: "com.agentcastkit.runner", account: "api-token"),
              let token = String(data: tokenData, encoding: .utf8), !token.isEmpty,
              let installationData = KeychainStore.read(service: "com.agentcastkit.runner", account: "installation-id"),
              let installationID = String(data: installationData, encoding: .utf8), !installationID.isEmpty else {
            throw Failure(code: "activation_required", message: "Activate AgentCastKit Runner before using managed voice services.")
        }

        let rawServerURL = ProcessInfo.processInfo.environment["AGENTCASTKIT_SERVER_URL"]
            ?? UserDefaults.standard.string(forKey: "serverURL")
            ?? "https://app.agentcastkit.com"
        guard let serverURL = URL(string: rawServerURL), ["http", "https"].contains(serverURL.scheme?.lowercased() ?? "") else {
            throw Failure(code: "cloud_url_invalid", message: "The Runner's AgentCastKit server URL is invalid.")
        }

        return RunnerCredential(serverURL: serverURL, token: token, installationID: installationID)
    }

    private static func send(url: URL, method: String, token: String, body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 120
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw Failure(code: "cloud_protocol_error", message: "The AgentCastKit server returned a non-HTTP response.")
            }
            return (data, http)
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure(code: "cloud_unreachable", message: "Could not reach the AgentCastKit server: \(error.localizedDescription)")
        }
    }

    private static func validate(response: HTTPURLResponse, data: Data) throws {
        guard !(200...299).contains(response.statusCode) else { return }

        let envelope = try? JSONDecoder().decode(CloudAPIErrorEnvelope.self, from: data)
        let code = envelope?.error?.code ?? "cloud_http_\(response.statusCode)"
        let message = envelope?.error?.message ?? envelope?.message ?? "The AgentCastKit server rejected the request."
        throw Failure(code: code, message: message)
    }
}
