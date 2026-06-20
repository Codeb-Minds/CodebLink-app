package com.codebminds.codeblink

import android.app.Activity
import android.content.ClipboardManager
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.WindowManager

class SyncTrampolineActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private var done = false
    private var triggerSource = "unknown"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        overridePendingTransition(0, 0)

        // Pass-through touches — this window must NEVER block user input
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)

        // 1x1 fully transparent window — invisible and minimal footprint
        try {
            val lp = window.attributes
            lp.width = 1
            lp.height = 1
            lp.alpha = 0.0f
            window.attributes = lp
        } catch (e: Exception) {
            Log.w(ClipboardSyncService.TAG, "[TRAMPOLINE] Failed to set 1x1 dimensions: ${e.message}")
        }

        val dummyView = View(this).apply { setBackgroundColor(Color.TRANSPARENT) }
        setContentView(dummyView)

        triggerSource = intent?.getStringExtra("trigger_source") ?: "unknown"
        Log.w(ClipboardSyncService.TAG, "[TRAMPOLINE] Started from $triggerSource")

        // Run once after a short settle, then finish — no retrying, no waiting for focus
        handler.postDelayed({ trySync() }, 80)
    }

    // Still allow focus-triggered sync as a bonus path, but only if not already done
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) trySync()
    }

    private fun trySync() {
        if (done) return
        done = true  // Mark done immediately — we run exactly once, no retry loops

        val action = intent?.getStringExtra("action") ?: "read"

        if (action == "write") {
            val textToWrite = intent?.getStringExtra("text") ?: ""
            if (textToWrite.isNotEmpty()) {
                val prefs = getSharedPreferences("codeblink_prefs", MODE_PRIVATE)
                val fp = md5(textToWrite)
                try {
                    val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                    val clip = android.content.ClipData.newPlainText("codeblink", textToWrite)
                    clipboard.setPrimaryClip(clip)
                    prefs.edit().putString("last_android_clipboard_fp", fp).apply()
                    Log.w(ClipboardSyncService.TAG, "[TRAMPOLINE] Wrote clipboard to phone from PC sync: size=${textToWrite.length}")
                } catch (e: Exception) {
                    Log.w(ClipboardSyncService.TAG, "[TRAMPOLINE] Failed to set primary clip: ${e.message}")
                }
            }
            finishNow()
            return
        }

        // action == "read": read clipboard and post to PC
        val prefs = getSharedPreferences("codeblink_prefs", MODE_PRIVATE)
        val ip = prefs.getString("server_ip", "") ?: ""
        val key = prefs.getString("sync_key", "") ?: ""
        if (ip.isBlank()) {
            Log.w(ClipboardSyncService.TAG, "[TRAMPOLINE] No saved IP, cannot sync")
            finishNow()
            return
        }

        try {
            val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            val text = ClipboardSyncService.readClipboardText(this, clipboard)
            val lastFp = prefs.getString("last_android_clipboard_fp", "") ?: ""
            val fp = md5(text)

            if (text.isBlank() || fp == lastFp) {
                Log.w(ClipboardSyncService.TAG, "[TRAMPOLINE] Nothing new to sync (blank=${text.isBlank()}, duplicate=${fp == lastFp})")
                finishNow()
                return
            }

            Thread {
                val ok = ClipboardSyncService.postClipboardToPc(ip, key, text)
                if (ok) prefs.edit().putString("last_android_clipboard_fp", fp).apply()
                Log.w(ClipboardSyncService.TAG, "[TRAMPOLINE] Posted clipboard to PC from $triggerSource: $ok")
                runOnUiThread { finishNow() }
            }.start()
        } catch (e: Exception) {
            Log.e(ClipboardSyncService.TAG, "[TRAMPOLINE] Failed to sync clipboard on read: ${e.message}")
            finishNow()
        }
    }

    private fun finishNow() {
        done = true
        finish()
        overridePendingTransition(0, 0)
    }

    private fun md5(value: String): String {
        if (value.isBlank()) return ""
        val digest = java.security.MessageDigest.getInstance("MD5")
            .digest(value.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
