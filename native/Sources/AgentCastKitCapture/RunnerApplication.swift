import AppKit
import AVFoundation
import CoreGraphics
import Security
import SwiftUI

@MainActor
enum RunnerApplication {
    static func launch() {
        let application = NSApplication.shared
        let delegate = RunnerApplicationDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

@MainActor
private final class RunnerApplicationDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenu()

        let content = RunnerView()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "AgentCastKit Runner"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 720, height: 620)
        window.isReleasedWhenClosed = false
        window.contentViewController = NSHostingController(rootView: content)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        self.window = window
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func configureMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About AgentCastKit Runner", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit AgentCastKit Runner", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)
        NSApplication.shared.mainMenu = mainMenu
    }
}

private enum PermissionState: String {
    case granted = "Ready"
    case notDetermined = "Needs approval"
    case denied = "Open Settings"
    case restricted = "Restricted"

    var color: Color {
        switch self {
        case .granted: .green
        case .notDetermined: .orange
        case .denied, .restricted: .red
        }
    }
}

@MainActor
private final class RunnerViewModel: ObservableObject {
    @Published var screen: PermissionState = .notDetermined
    @Published var microphone: PermissionState = .notDetermined
    @Published var camera: PermissionState = .notDetermined
    @Published var activationCode = ""
    @Published var serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? "https://app.agentcastkit.com"
    @Published var activationMessage = ""
    @Published var isActivating = false
    @Published var copiedConfiguration = false

    var cuaDriverPath: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AgentCastKit/bin/cua-driver")
            .path
    }

    var automationReady: Bool { FileManager.default.isExecutableFile(atPath: cuaDriverPath) }

    var isActivated: Bool { KeychainStore.read(service: "com.agentcastkit.runner", account: "api-token") != nil }

    init() {
        refreshPermissions()
    }

    func refreshPermissions() {
        screen = CGPreflightScreenCaptureAccess() ? .granted : .notDetermined
        microphone = permissionState(AVCaptureDevice.authorizationStatus(for: .audio))
        camera = permissionState(AVCaptureDevice.authorizationStatus(for: .video))
        objectWillChange.send()
    }

    func requestScreen() {
        if screen == .granted { return }
        if CGRequestScreenCaptureAccess() {
            screen = .granted
        } else {
            openPrivacySettings("Privacy_ScreenCapture")
        }
    }

    func requestMicrophone() {
        Task {
            if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: .audio)
            } else if microphone != .granted {
                openPrivacySettings("Privacy_Microphone")
            }
            refreshPermissions()
        }
    }

    func requestCamera() {
        Task {
            if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: .video)
            } else if camera != .granted {
                openPrivacySettings("Privacy_Camera")
            }
            refreshPermissions()
        }
    }

    func activate() {
        let code = activationCode.trimmingCharacters(in: .whitespacesAndNewlines)
        let baseURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !code.isEmpty, let url = URL(string: "\(baseURL)/api/v1/activations/exchange") else {
            activationMessage = "Enter a valid server URL and activation key."
            return
        }

        isActivating = true
        activationMessage = "Connecting…"
        UserDefaults.standard.set(baseURL, forKey: "serverURL")

        Task {
            do {
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                request.httpBody = try JSONEncoder().encode(ActivationRequest(
                    code: code,
                    deviceName: Host.current().localizedName ?? "Mac",
                    platform: "macos",
                    architecture: Self.architecture,
                    appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.3.0"
                ))

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    let details = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                    let message = details?["message"] as? String ?? "Activation was rejected by the server."
                    throw ActivationError(message: message)
                }

                let envelope = try JSONDecoder().decode(ActivationEnvelope.self, from: data)
                try KeychainStore.save(Data(envelope.data.accessToken.utf8), service: "com.agentcastkit.runner", account: "api-token")
                try KeychainStore.save(Data(envelope.data.installation.id.utf8), service: "com.agentcastkit.runner", account: "installation-id")
                activationCode = ""
                activationMessage = "Connected. Your account's managed-service entitlements are available to agents."
            } catch {
                activationMessage = error.localizedDescription
            }
            isActivating = false
            objectWillChange.send()
        }
    }

    func copyMCPConfiguration() {
        let executable = Bundle.main.executableURL?.path ?? ""
        let server = Bundle.main.resourceURL?.appendingPathComponent("mcp/dist/src/server.js").path ?? ""
        var servers: [String: Any] = [
            "agentcastkit": [
                    "command": "/usr/bin/env",
                    "args": ["node", server],
                    "env": ["AGENTCASTKIT_CAPTURE_BIN": executable],
                ]
        ]
        if automationReady {
            servers["cua-driver"] = ["command": cuaDriverPath, "args": ["mcp"]]
        }
        let configuration: [String: Any] = ["mcpServers": servers]
        guard let data = try? JSONSerialization.data(withJSONObject: configuration, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copiedConfiguration = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copiedConfiguration = false
        }
    }

    func openAutomationPermissions() {
        guard automationReady else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cuaDriverPath)
        process.arguments = ["permissions", "grant"]
        try? process.run()
    }

    private func openPrivacySettings(_ pane: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
        NSWorkspace.shared.open(url)
    }

    private func permissionState(_ status: AVAuthorizationStatus) -> PermissionState {
        switch status {
        case .authorized: .granted
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .restricted: .restricted
        @unknown default: .restricted
        }
    }

    private static var architecture: String {
#if arch(arm64)
        "arm64"
#else
        "x86_64"
#endif
    }
}

private struct RunnerView: View {
    @StateObject private var model = RunnerViewModel()

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.045, green: 0.055, blue: 0.075), Color(red: 0.09, green: 0.07, blue: 0.13)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    permissionSection
                    activationSection
                    agentSection
                }
                .padding(34)
            }
        }
        .frame(minWidth: 700, minHeight: 560)
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 18)
                    .fill(LinearGradient(colors: [.purple, .pink], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 64, height: 64)
                Image(systemName: "sparkles.tv.fill")
                    .font(.system(size: 29, weight: .semibold))
                    .foregroundStyle(.white)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("AgentCastKit")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                Text("The local runner for agent-made product demos")
                    .foregroundStyle(.secondary)
                    .font(.system(size: 15))
            }
            Spacer()
            Text("RUNNER  0.3")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(.purple.opacity(0.9))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(.purple.opacity(0.12), in: Capsule())
        }
    }

    private var permissionSection: some View {
        section(title: "Recording permissions", subtitle: "Nothing is recorded until you or your agent explicitly starts a capture.") {
            HStack(spacing: 12) {
                permissionCard(title: "Screen", icon: "rectangle.dashed.badge.record", state: model.screen, action: model.requestScreen)
                permissionCard(title: "Microphone", icon: "mic.fill", state: model.microphone, action: model.requestMicrophone)
                permissionCard(title: "Camera", icon: "video.fill", state: model.camera, action: model.requestCamera)
            }
            Button("Refresh permissions", systemImage: "arrow.clockwise", action: model.refreshPermissions)
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
    }

    private var activationSection: some View {
        section(title: "Optional paid services", subtitle: "Activation covers managed TTS, premium or cloned voices, premium music, brand kits, hosted video, and teams. Local capture and computer control stay free.") {
            HStack(spacing: 10) {
                TextField("Server URL", text: $model.serverURL)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 245)
                SecureField("ACK-XXXX-XXXX-…", text: $model.activationCode)
                    .textFieldStyle(.roundedBorder)
                Button(model.isActivating ? "Connecting…" : "Activate") { model.activate() }
                    .buttonStyle(.borderedProminent)
                    .tint(.purple)
                    .disabled(model.isActivating || model.activationCode.isEmpty)
            }
            if model.isActivated || !model.activationMessage.isEmpty {
                Label(
                    model.activationMessage.isEmpty ? "This runner is connected." : model.activationMessage,
                    systemImage: model.isActivated ? "checkmark.seal.fill" : "info.circle"
                )
                .font(.system(size: 12))
                .foregroundStyle(model.isActivated ? .green : .secondary)
            }
        }
    }

    private var agentSection: some View {
        section(title: "Connect an agent", subtitle: "AgentCastKit records while the separately signed Cua Driver controls apps. The installer configures both MCPs and adds production guidance for Claude Code and Codex.") {
            VStack(spacing: 11) {
                HStack {
                Label("Local MCP runtime installed", systemImage: "terminal.fill")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.green)
                Spacer()
                Button(model.copiedConfiguration ? "Copied" : "Copy MCP configuration", systemImage: model.copiedConfiguration ? "checkmark" : "doc.on.doc") {
                    model.copyMCPConfiguration()
                }
                .buttonStyle(.bordered)
                }
                HStack {
                    Label(
                        model.automationReady ? "Cua Driver automation installed" : "Cua Driver automation not found",
                        systemImage: model.automationReady ? "cursorarrow.motionlines" : "exclamationmark.triangle"
                    )
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(model.automationReady ? .green : .orange)
                    Spacer()
                    if model.automationReady {
                        Button("Automation permissions", systemImage: "hand.raised") {
                            model.openAutomationPermissions()
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
    }

    private func permissionCard(title: String, icon: String, state: PermissionState, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Image(systemName: icon)
                        .font(.system(size: 17, weight: .semibold))
                    Spacer()
                    Circle().fill(state.color).frame(width: 8, height: 8)
                }
                Text(title).font(.system(size: 15, weight: .semibold))
                Text(state.rawValue)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(state.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.08)))
        }
        .buttonStyle(.plain)
    }

    private func section<Content: View>(title: String, subtitle: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 17, weight: .semibold))
                Text(subtitle).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            content()
        }
        .padding(20)
        .background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.07)))
    }
}

private struct ActivationRequest: Encodable {
    let code: String
    let deviceName: String
    let platform: String
    let architecture: String
    let appVersion: String

    enum CodingKeys: String, CodingKey {
        case code, platform, architecture
        case deviceName = "device_name"
        case appVersion = "app_version"
    }
}

private struct ActivationEnvelope: Decodable {
    let data: ActivationData
}

private struct ActivationData: Decodable {
    let accessToken: String
    let installation: InstallationData

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case installation
    }
}

private struct InstallationData: Decodable {
    let id: String
}

private struct ActivationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum KeychainStore {
    static func save(_ data: Data, service: String, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw ActivationError(message: "Could not store the runner credential (Keychain error \(status)).") }
    }

    static func read(service: String, account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }
}
