package com.codebminds.codeblink

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ClipboardManager
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import java.security.MessageDigest

/**
 * Keeps the app alive as an Accessibility Service so clipboard sync can
 * continue when the main UI is not in the foreground. The service itself
 * does not perform any UI interaction — it exists purely as a long-lived
 * process anchor that Android cannot kill aggressively.
 */
class ClipboardAccessibilityService : AccessibilityService() {
    private lateinit var clipboardManager: ClipboardManager
    private val handler = Handler(Looper.getMainLooper())
    private var serverIp = ""
    private var syncKey = ""
    private var lastSignalMs = 0L
    private var lastTrampolineMs = 0L
    @Volatile private var posting = false

    private val clipListener = ClipboardManager.OnPrimaryClipChangedListener {
        Log.w(ClipboardSyncService.TAG, "[A11Y] Clipboard callback fired")
        handler.postDelayed({ syncClipboardToPc("clipboard-listener") }, 120)
    }

    override fun onServiceConnected() {
        serviceInfo = serviceInfo.apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                    AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                    AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED
            packageNames = arrayOf("com.android.systemui")
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            notificationTimeout = 100
        }

        // Restart the clipboard sync foreground service if config is saved
        val prefs = getSharedPreferences("codeblink_prefs", MODE_PRIVATE)
        serverIp = prefs.getString("server_ip", "") ?: ""
        syncKey = prefs.getString("sync_key", "") ?: ""
        val ghostEnabled = prefs.getBoolean("ghost_service_enabled", true)

        clipboardManager = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        try { clipboardManager.removePrimaryClipChangedListener(clipListener) } catch (_: Exception) {}
        clipboardManager.addPrimaryClipChangedListener(clipListener)

        if (serverIp.isNotEmpty() && ghostEnabled) {
            val intent = Intent(this, ClipboardSyncService::class.java).apply {
                putExtra(ClipboardSyncService.EXTRA_IP, serverIp)
                putExtra(ClipboardSyncService.EXTRA_KEY, syncKey)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(intent)
                } else {
                    startService(intent)
                }
            } catch (e: Exception) {
                Log.e(ClipboardSyncService.TAG, "[A11Y] Failed to start foreground service: ${e.message}")
            }
        }

        Log.w(ClipboardSyncService.TAG, "[A11Y] Clipboard sync listener active")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        try {
            if (event == null) return
            val eventPackage = event.packageName?.toString() ?: return
            val className = event.className?.toString() ?: ""
            
            val isSystemUi = eventPackage == "com.android.systemui"
            val isToast = eventPackage == "android" && className.contains("Toast", ignoreCase = true)
            
            if (!isSystemUi && !isToast) return

            val eventType = event.eventType
            
            // Detect system clipboard UI overlay or toast notification containing copy keywords
            val eventTextList = event.text
            val textStr = if (eventTextList != null) eventTextList.joinToString(" ").lowercase() else ""
            val contentDesc = event.contentDescription?.toString()?.lowercase() ?: ""
            val classNameLower = className.lowercase()
            
            val hasClipboardKeywords = textStr.contains("copy") || textStr.contains("copied") || textStr.contains("clipboard") ||
                                       contentDesc.contains("copy") || contentDesc.contains("copied") || contentDesc.contains("clipboard") ||
                                       classNameLower.contains("clipboard") || classNameLower.contains("copy") || classNameLower.contains("overlay")

            val shouldTrigger = when (eventType) {
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> true
                AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED -> hasClipboardKeywords
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> hasClipboardKeywords
                else -> false
            }

            if (shouldTrigger) {
                val sourceInfo = "${eventPackage}:${eventType}:${if (hasClipboardKeywords) "keywords" else "state"}"
                val now = SystemClock.elapsedRealtime()
                if (now - lastSignalMs < 2500) return
                lastSignalMs = now
                handler.postDelayed({ syncClipboardToPc(sourceInfo) }, 260)
            }
        } catch (e: Exception) {
            Log.e(ClipboardSyncService.TAG, "[A11Y] Error handling accessibility event: ${e.message}", e)
        }
    }

    override fun onInterrupt() { /* required override */ }

    override fun onDestroy() {
        try {
            if (::clipboardManager.isInitialized) {
                clipboardManager.removePrimaryClipChangedListener(clipListener)
            }
        } catch (_: Exception) {}
        super.onDestroy()
    }

    private fun syncClipboardToPc(source: String) {
        refreshConfig()
        if (serverIp.isBlank()) return
        if (posting) return
        if (!::clipboardManager.isInitialized) return

        try {
            val text = ClipboardSyncService.readClipboardText(this, clipboardManager)
            if (text.isBlank()) {
                Log.w(ClipboardSyncService.TAG, "[A11Y] Direct clipboard read empty from $source; using trampoline")
                launchTrampoline(source)
                return
            }

            val fp = md5(text)
            val prefs = getSharedPreferences("codeblink_prefs", MODE_PRIVATE)
            val lastFp = prefs.getString("last_android_clipboard_fp", "") ?: ""
            if (fp == lastFp) return

            posting = true
            Thread {
                val ok = ClipboardSyncService.postClipboardToPc(serverIp, syncKey, text)
                if (ok) {
                    prefs.edit().putString("last_android_clipboard_fp", fp).apply()
                }
                Log.w(ClipboardSyncService.TAG, "[A11Y] Posted clipboard to PC from $source: $ok")
                posting = false
            }.start()
        } catch (e: Exception) {
            posting = false
            Log.w(ClipboardSyncService.TAG, "[A11Y] Failed to sync clipboard from $source: ${e.message}")
        }
    }

    private fun md5(value: String): String {
        if (value.isBlank()) return ""
        val digest = MessageDigest.getInstance("MD5")
            .digest(value.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun launchTrampoline(source: String) {
        refreshConfig()
        if (serverIp.isBlank()) return

        val now = SystemClock.elapsedRealtime()
        if (now - lastTrampolineMs < 3000) return
        lastTrampolineMs = now

        try {
            val intent = Intent(this, SyncTrampolineActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_NO_ANIMATION or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                putExtra("trigger_source", source)
            }
            startActivity(intent)
            Log.w(ClipboardSyncService.TAG, "[A11Y] Sync trampoline launched from $source")
        } catch (e: Exception) {
            Log.w(ClipboardSyncService.TAG, "[A11Y] Failed to launch sync trampoline: ${e.message}")
        }
    }

    private fun refreshConfig() {
        val prefs = getSharedPreferences("codeblink_prefs", MODE_PRIVATE)
        serverIp = prefs.getString("server_ip", "") ?: ""
        syncKey = prefs.getString("sync_key", "") ?: ""
    }
}
