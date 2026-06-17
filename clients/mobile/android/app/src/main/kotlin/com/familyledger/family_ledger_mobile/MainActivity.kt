package com.familyledger.family_ledger_mobile

import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    private val channelName = "com.familyledger/share"
    private var channel: MethodChannel? = null
    private var pendingFilePath: String? = null
    private var pendingMimeType: String? = null
    private var dartReady = false

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
        channel?.setMethodCallHandler { call, result ->
            if (call.method == "getInitialFile") {
                dartReady = true
                val path = pendingFilePath
                if (path != null) {
                    val args = mutableMapOf<String, Any>("path" to path)
                    pendingMimeType?.let { args["mimeType"] = it }
                    result.success(args)
                    pendingFilePath = null
                    pendingMimeType = null
                } else {
                    result.success(null)
                }
            } else {
                result.notImplemented()
            }
        }
        handleShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShareIntent(intent)
    }

    private fun handleShareIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: return
        val mimeType = intent.type

        // Copy to a stable cache file Flutter can read (content URIs may expire).
        val fileName = resolveFileName(uri) ?: "shared_file"
        val dest = File(cacheDir, fileName)
        try {
            contentResolver.openInputStream(uri)?.use { input ->
                dest.outputStream().use { output -> input.copyTo(output) }
            }
        } catch (_: Exception) {
            return
        }

        if (dartReady) {
            val args = mutableMapOf<String, Any>("path" to dest.absolutePath)
            mimeType?.let { args["mimeType"] = it }
            channel?.invokeMethod("receiveFile", args)
        } else {
            pendingFilePath = dest.absolutePath
            pendingMimeType = mimeType
        }
    }

    private fun resolveFileName(uri: Uri): String? {
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val col = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (col >= 0 && cursor.moveToFirst()) return cursor.getString(col)
        }
        return uri.lastPathSegment
    }
}
