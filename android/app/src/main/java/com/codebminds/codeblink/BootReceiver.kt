package com.codebminds.codeblink

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
            intent.action != "android.intent.action.QUICKBOOT_POWERON") return

        val prefs = context.getSharedPreferences("codeblink_prefs", Context.MODE_PRIVATE)
        val ip = prefs.getString("server_ip", "") ?: ""
        val key = prefs.getString("sync_key", "") ?: ""
        val ghostEnabled = prefs.getBoolean("ghost_service_enabled", true)

        if (ip.isNotEmpty() && ghostEnabled) {
            val serviceIntent = Intent(context, ClipboardSyncService::class.java).apply {
                putExtra(ClipboardSyncService.EXTRA_IP, ip)
                putExtra(ClipboardSyncService.EXTRA_KEY, key)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
            } catch (e: Exception) {
                android.util.Log.e("CodebLink", "[Boot] Failed to start foreground service on boot: ${e.message}")
            }
        }
    }
}
