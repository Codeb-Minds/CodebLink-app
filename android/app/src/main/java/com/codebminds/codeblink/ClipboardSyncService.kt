package com.codebminds.codeblink

import android.app.*
import android.content.*
import android.util.Log
import android.os.*
import android.util.Base64
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

class ClipboardSyncService : Service() {

    companion object {
        const val CHANNEL_ID = "codeblink_sync_channel"
        const val NOTIF_ID = 1001
        const val ACTION_STOP = "com.codebminds.codeblink.STOP_SERVICE"
        const val EXTRA_IP = "extra_ip"
        const val EXTRA_KEY = "extra_key"
        const val TAG = "CodebLink"

        // Called from ClipboardModule to share AES helpers without duplicating code
        fun encryptAes(plaintext: String, password: String): String {
            return try {
                val salt = ByteArray(8).also { SecureRandom().nextBytes(it) }
                val (key, iv) = evpBytesToKey(password.toByteArray(Charsets.UTF_8), salt)
                val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
                cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
                val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
                val combined = "Salted__".toByteArray(Charsets.US_ASCII) + salt + encrypted
                Base64.encodeToString(combined, Base64.NO_WRAP)
            } catch (_: Exception) { "" }
        }

        fun decryptAes(ciphertext: String, password: String): String {
            return try {
                val raw = Base64.decode(ciphertext, Base64.DEFAULT)
                if (raw.size < 16) return ""
                val prefix = raw.copyOfRange(0, 8)
                if (!prefix.contentEquals("Salted__".toByteArray(Charsets.US_ASCII))) return ""
                val salt = raw.copyOfRange(8, 16)
                val encrypted = raw.copyOfRange(16, raw.size)
                val (key, iv) = evpBytesToKey(password.toByteArray(Charsets.UTF_8), salt)
                val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
                String(cipher.doFinal(encrypted), Charsets.UTF_8)
            } catch (_: Exception) { "" }
        }

        private fun evpBytesToKey(password: ByteArray, salt: ByteArray): Pair<ByteArray, ByteArray> {
            val key = ByteArray(32)
            val iv = ByteArray(16)
            val md = MessageDigest.getInstance("MD5")
            var prev = ByteArray(0)
            var keyOffset = 0
            var ivOffset = 0
            while (keyOffset < 32 || ivOffset < 16) {
                md.reset()
                md.update(prev)
                md.update(password)
                md.update(salt)
                prev = md.digest()
                var i = 0
                while (i < prev.size && keyOffset < 32) { key[keyOffset++] = prev[i++] }
                while (i < prev.size && ivOffset < 16) { iv[ivOffset++] = prev[i++] }
            }
            return Pair(key, iv)
        }

        fun readClipboardText(
            context: Context,
            clipManager: android.content.ClipboardManager
        ): String {
            return try {
                val clip = clipManager.primaryClip ?: return ""
                if (clip.itemCount <= 0) return ""
                val item = clip.getItemAt(0)
                item.text?.toString()
                    ?: item.htmlText
                    ?: item.uri?.toString()
                    ?: item.intent?.toUri(Intent.URI_INTENT_SCHEME)
                    ?: item.coerceToText(context)?.toString()
                    ?: ""
            } catch (e: Exception) {
                Log.w(TAG, "[BG] Clipboard read failed: ${e.message}")
                ""
            }.trim()
        }

        fun postClipboardToPc(ip: String, key: String, text: String): Boolean {
            if (ip.isBlank() || key.isBlank() || text.isBlank()) return false
            return try {
                val encrypted = encryptAes(text, key)
                if (encrypted.isBlank()) return false
                val body = JSONObject().put("data", encrypted).toString()
                val conn = URL("http://$ip:4321/api/clipboard").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                conn.outputStream.use { it.write(body.toByteArray()) }
                val ok = conn.responseCode in 200..299
                conn.disconnect()
                ok
            } catch (e: Exception) {
                Log.w(TAG, "[BG] Clipboard post failed: ${e.message}")
                false
            }
        }
    }

    private var pollThread: Thread? = null
    @Volatile private var running = false
    private var serverIp = ""
    private var syncKey = ""
    @Volatile private var lastClipText = ""
    private lateinit var clipManager: android.content.ClipboardManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private val clipListener = android.content.ClipboardManager.OnPrimaryClipChangedListener {
        val text = readClipboardText(this, clipManager)
        if (text.isNotEmpty() && text != lastClipText) {
            lastClipText = text
            Thread {
                val ok = postClipboardToPc(serverIp, syncKey, text)
                Log.d(TAG, "[FGS] Clipboard listener posted to PC: $ok")
            }.start()
        }
    }

    override fun onCreate() {
        super.onCreate()
        clipManager = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val ip = intent?.getStringExtra(EXTRA_IP) ?: ""
        val key = intent?.getStringExtra(EXTRA_KEY) ?: ""
        if (ip.isEmpty()) { stopSelf(); return START_NOT_STICKY }

        serverIp = ip
        syncKey = key

        startForeground(NOTIF_ID, buildNotification())

        if (!running) {
            running = true
            startPolling()
            try { mainHandler.post { clipManager.removePrimaryClipChangedListener(clipListener) } } catch (_: Exception) {}
            mainHandler.post { clipManager.addPrimaryClipChangedListener(clipListener) }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        pollThread?.interrupt()
        pollThread = null
        try { mainHandler.post { clipManager.removePrimaryClipChangedListener(clipListener) } } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startPolling() {
        pollThread?.interrupt()
        pollThread = Thread {
            while (running && !Thread.currentThread().isInterrupted) {
                try {
                    val conn = URL("http://$serverIp:4321/api/clipboard/poll").openConnection() as HttpURLConnection
                    conn.requestMethod = "GET"
                    conn.connectTimeout = 8000
                    conn.readTimeout = 30000
                    val code = conn.responseCode
                    if (code == 200) {
                        val body = conn.inputStream.bufferedReader().readText()
                        conn.disconnect()
                        try {
                            val json = JSONObject(body)
                            val decrypted = decryptAes(json.getString("data"), syncKey)
                            if (decrypted.isNotEmpty() && decrypted != lastClipText) {
                                lastClipText = decrypted
                                mainHandler.post {
                                    try {
                                        val intent = Intent(this@ClipboardSyncService, SyncTrampolineActivity::class.java).apply {
                                            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                                                    Intent.FLAG_ACTIVITY_NO_ANIMATION or
                                                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                                            putExtra("action", "write")
                                            putExtra("text", decrypted)
                                            putExtra("trigger_source", "bg-pull-write")
                                        }
                                        startActivity(intent)
                                    } catch (e: Exception) {
                                        Log.w(TAG, "[FGS] Failed to launch trampoline activity for write: ${e.message}")
                                    }
                                }
                            }
                        } catch (_: Exception) {}
                    } else {
                        conn.disconnect()
                        if (running) Thread.sleep(1000)
                    }
                } catch (_: InterruptedException) {
                    break
                } catch (_: Exception) {
                    if (running) Thread.sleep(3000)
                }
            }
        }.also { it.isDaemon = true; it.start() }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Codeb Link Sync", NotificationManager.IMPORTANCE_LOW)
            ch.description = "Background clipboard sync"
            ch.setShowBadge(false)
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val stopPi = PendingIntent.getService(
            this, 0,
            Intent(this, ClipboardSyncService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val openPi = PendingIntent.getActivity(
            this, 1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Codeb Link")
            .setContentText("Clipboard sync active")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setContentIntent(openPi)
            .addAction(0, "Stop", stopPi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
