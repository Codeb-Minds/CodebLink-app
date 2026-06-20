package com.codebminds.codeblink

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.*
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.*
import android.provider.Settings
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.io.*
import java.net.HttpURLConnection
import java.net.URL

@ReactModule(name = ClipboardModule.NAME)
class ClipboardModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "ClipboardSync"
        private const val PREFS = "codeblink_prefs"
    }

    override fun getName() = NAME

    private var udpSocket: java.net.DatagramSocket? = null
    private var isUdpRunning = false
    private var udpListenThread: Thread? = null
    private var udpBroadcastThread: Thread? = null

    private fun sendEvent(eventName: String, params: Any?) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun startUdpDiscovery(hostname: String, machineId: String) {
        if (isUdpRunning) return
        isUdpRunning = true

        udpListenThread = Thread {
            try {
                udpSocket = java.net.DatagramSocket(43222).apply {
                    reuseAddress = true
                    broadcast = true
                }
                val buffer = ByteArray(2048)
                while (isUdpRunning) {
                    val packet = java.net.DatagramPacket(buffer, buffer.size)
                    udpSocket?.receive(packet)
                    val message = String(packet.data, 0, packet.length, Charsets.UTF_8)
                    try {
                        val json = JSONObject(message)
                        if (json.optString("type") == "codeb-link-action" && json.optString("action") == "connect-to-pc") {
                            val serverIp = json.optString("serverIp")
                            if (!serverIp.isNullOrBlank()) {
                                sendEvent("onConnectCommand", serverIp)
                            }
                        }
                    } catch (e: Exception) {}
                }
            } catch (e: Exception) {
                e.printStackTrace()
            } finally {
                try {
                    udpSocket?.close()
                } catch (e: Exception) {}
            }
        }.apply { start() }

        udpBroadcastThread = Thread {
            try {
                val socket = java.net.DatagramSocket()
                socket.broadcast = true
                val json = JSONObject().apply {
                    put("type", "codeb-link-node")
                    put("hostname", hostname)
                    put("machineId", machineId)
                    put("device", "android")
                    put("port", 4321)
                }
                val data = json.toString().toByteArray()
                while (isUdpRunning) {
                    val packet = java.net.DatagramPacket(
                        data,
                        data.size,
                        java.net.InetAddress.getByName("255.255.255.255"),
                        43222
                    )
                    socket.send(packet)
                    Thread.sleep(4000)
                }
                socket.close()
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }.apply { start() }
    }

    @ReactMethod
    fun stopUdpDiscovery() {
        isUdpRunning = false
        try {
            udpSocket?.close()
        } catch (e: Exception) {}
        udpListenThread?.interrupt()
        udpBroadcastThread?.interrupt()
        udpListenThread = null
        udpBroadcastThread = null
    }

    // ─── Service ─────────────────────────────────────────────────────────────

    @ReactMethod
    fun startService(ip: String, key: String) {
        val intent = Intent(reactContext, ClipboardSyncService::class.java).apply {
            putExtra(ClipboardSyncService.EXTRA_IP, ip)
            putExtra(ClipboardSyncService.EXTRA_KEY, key)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(intent)
        } else {
            reactContext.startService(intent)
        }
    }

    @ReactMethod
    fun stopService() {
        reactContext.startService(
            Intent(reactContext, ClipboardSyncService::class.java).apply {
                action = ClipboardSyncService.ACTION_STOP
            }
        )
    }

    // ─── Config persistence ───────────────────────────────────────────────────

    @ReactMethod
    fun saveConfig(ip: String, key: String) {
        prefs().edit().putString("server_ip", ip).putString("sync_key", key).apply()
    }

    @ReactMethod
    fun getSavedConfig(promise: Promise) {
        val p = prefs()
        val map = Arguments.createMap()
        map.putString("ip", p.getString("server_ip", "") ?: "")
        map.putString("key", p.getString("sync_key", "") ?: "")
        promise.resolve(map)
    }

    @ReactMethod
    fun getLocalIp(promise: Promise) {
        try {
            val interfaces = java.net.NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val iface = interfaces.nextElement()
                if (iface.isLoopback || !iface.isUp) continue
                val addresses = iface.inetAddresses
                while (addresses.hasMoreElements()) {
                    val addr = addresses.nextElement()
                    if (addr is java.net.Inet4Address) {
                        val ip = addr.hostAddress
                        if (ip != null && !ip.startsWith("127.")) {
                            promise.resolve(ip)
                            return
                        }
                    }
                }
            }
            promise.resolve("127.0.0.1")
        } catch (e: Exception) {
            promise.reject("IP_ERROR", e.message)
        }
    }

    // ─── Settings (generic boolean/string) ───────────────────────────────────

    @ReactMethod
    fun getSetting(key: String, defaultValue: Dynamic, promise: Promise) {
        val p = prefs()
        when {
            defaultValue.type == ReadableType.Boolean -> promise.resolve(p.getBoolean(key, defaultValue.asBoolean()))
            defaultValue.type == ReadableType.String -> promise.resolve(p.getString(key, defaultValue.asString()))
            else -> promise.resolve(p.getBoolean(key, true))
        }
    }

    @ReactMethod
    fun saveSetting(key: String, value: Dynamic) {
        val edit = prefs().edit()
        when {
            value.type == ReadableType.Boolean -> edit.putBoolean(key, value.asBoolean())
            value.type == ReadableType.String -> edit.putString(key, value.asString())
            else -> edit.putBoolean(key, value.asBoolean())
        }
        edit.apply()
    }

    // ─── Clipboard ────────────────────────────────────────────────────────────

    @ReactMethod
    fun readClipboard(promise: Promise) {
        val handler = Handler(Looper.getMainLooper())
        handler.post {
            try {
                val cm = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                val text = cm.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
                promise.resolve(text)
            } catch (e: Exception) {
                promise.reject("CLIPBOARD_ERROR", e.message)
            }
        }
    }

    // ─── System status checks ─────────────────────────────────────────────────

    @ReactMethod
    fun isAccessibilityServiceEnabled(promise: Promise) {
        try {
            val serviceName = "${reactContext.packageName}/${ClipboardAccessibilityService::class.java.canonicalName}"
            val enabled = Settings.Secure.getString(
                reactContext.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            )?.contains(serviceName) == true
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun isBatteryOptimizationIgnored(promise: Promise) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = reactContext.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            promise.resolve(!pm.isIgnoringBatteryOptimizations(reactContext.packageName))
        } else {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun isNotificationsEnabled(promise: Promise) {
        promise.resolve(NotificationManagerCompat.from(reactContext).areNotificationsEnabled())
    }

    @ReactMethod
    fun openAccessibilitySettings() {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        reactContext.startActivity(intent)
    }

    // ─── File operations ──────────────────────────────────────────────────────

    @ReactMethod
    fun readUriAsBase64(uriString: String, promise: Promise) {
        Thread {
            try {
                val uri = Uri.parse(uriString)
                val bytes = reactContext.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: throw IOException("Cannot open URI")
                promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP))
            } catch (e: Exception) {
                promise.reject("READ_URI_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun saveIncomingFileToDownloads(name: String, mime: String, base64Data: String, promise: Promise) {
        Thread {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val savedUri = saveToDownloads(name, mime, bytes)
                promise.resolve(savedUri)
            } catch (e: Exception) {
                promise.reject("SAVE_FILE_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun downloadFileFromUrl(url: String, name: String, mime: String, promise: Promise) {
        Thread {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 15000
                conn.readTimeout = 60000
                val bytes = conn.inputStream.use { it.readBytes() }
                conn.disconnect()
                val savedUri = saveToDownloads(name, mime, bytes)
                promise.resolve(savedUri)
            } catch (e: Exception) {
                promise.reject("DOWNLOAD_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun notifyUploadDone(name: String, success: Boolean) {
        val channelId = "codeblink_upload_channel"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = android.app.NotificationChannel(channelId, "Codeb Link Uploads", NotificationManager.IMPORTANCE_DEFAULT)
            reactContext.getSystemService(NotificationManager::class.java)?.createNotificationChannel(ch)
        }
        val msg = if (success) "\"$name\" sent to PC" else "Failed to send \"$name\""
        val notif = NotificationCompat.Builder(reactContext, channelId)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Codeb Link")
            .setContentText(msg)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(reactContext).notify(System.currentTimeMillis().toInt(), notif)
    }

    // ─── Share intent payload ─────────────────────────────────────────────────

    @ReactMethod
    fun consumeSharePayload(promise: Promise) {
        val payload = MainActivity.pendingSharePayload
        if (payload == null) {
            promise.resolve(null)
            return
        }
        MainActivity.pendingSharePayload = null
        val map = Arguments.createMap()
        map.putString("kind", payload.kind)
        payload.text?.let { map.putString("text", it) }
        payload.uri?.let { map.putString("uri", it) }
        payload.name?.let { map.putString("name", it) }
        payload.mimeType?.let { map.putString("mimeType", it) }
        promise.resolve(map)
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private fun prefs() = reactContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun saveToDownloads(name: String, mime: String, bytes: ByteArray): String {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name)
                put(android.provider.MediaStore.Downloads.MIME_TYPE, mime)
                put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = reactContext.contentResolver.insert(
                android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values
            ) ?: throw IOException("Cannot create MediaStore entry")
            reactContext.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            values.clear()
            values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
            reactContext.contentResolver.update(uri, values, null, null)
            uri.toString()
        } else {
            val downloadsDir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)
            downloadsDir.mkdirs()
            val file = File(downloadsDir, name)
            file.writeBytes(bytes)
            file.absolutePath
        }
    }

    @ReactMethod
    fun addListener(eventName: String) { /* required for RN event emitter */ }

    @ReactMethod
    fun removeListeners(count: Int) { /* required for RN event emitter */ }
}
