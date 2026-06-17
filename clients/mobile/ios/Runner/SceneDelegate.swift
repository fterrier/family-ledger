import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {
    private var channel: FlutterMethodChannel?
    private var pendingFilePath: String?
    private var pendingMimeType: String?
    private var dartReady = false

    override func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        super.scene(scene, willConnectTo: session, options: connectionOptions)

        if let controller = window?.rootViewController as? FlutterViewController {
            channel = FlutterMethodChannel(
                name: "com.familyledger/share",
                binaryMessenger: controller.binaryMessenger
            )
            channel?.setMethodCallHandler { [weak self] call, result in
                guard let self else { return }
                if call.method == "getInitialFile" {
                    self.dartReady = true
                    if let path = self.pendingFilePath {
                        var args: [String: Any] = ["path": path]
                        if let mimeType = self.pendingMimeType { args["mimeType"] = mimeType }
                        result(args)
                        self.pendingFilePath = nil
                        self.pendingMimeType = nil
                    } else {
                        result(nil)
                    }
                } else {
                    result(FlutterMethodNotImplemented)
                }
            }
        }

        if let context = connectionOptions.urlContexts.first {
            handleURL(context.url)
        }
    }

    override func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let context = URLContexts.first {
            handleURL(context.url)
        }
    }

    private func handleURL(_ url: URL) {
        _ = url.startAccessingSecurityScopedResource()
        defer { url.stopAccessingSecurityScopedResource() }

        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent(url.lastPathComponent)
        do {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.copyItem(at: url, to: dest)
        } catch {
            return
        }

        let mimeType = url.mimeType

        if dartReady, let channel {
            var args: [String: Any] = ["path": dest.path]
            if let mimeType { args["mimeType"] = mimeType }
            channel.invokeMethod("receiveFile", arguments: args)
        } else {
            pendingFilePath = dest.path
            pendingMimeType = mimeType
        }
    }
}

private extension URL {
    var mimeType: String? {
        let ext = pathExtension.lowercased()
        switch ext {
        case "pdf": return "application/pdf"
        case "csv": return "text/csv"
        case "xml": return "application/xml"
        case "sta", "mt940": return "application/octet-stream"
        default: return nil
        }
    }
}
