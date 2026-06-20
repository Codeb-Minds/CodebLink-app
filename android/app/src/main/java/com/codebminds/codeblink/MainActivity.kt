package com.codebminds.codeblink
import expo.modules.splashscreen.SplashScreenManager

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Parcelable

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

data class SharePayload(
    val kind: String,
    val text: String? = null,
    val uri: String? = null,
    val name: String? = null,
    val mimeType: String? = null
)

class MainActivity : ReactActivity() {

  companion object {
    @Volatile
    var pendingSharePayload: SharePayload? = null
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    super.onCreate(null)
    handleShareIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleShareIntent(intent)
  }

  private fun handleShareIntent(intent: Intent?) {
    if (intent == null) return
    val action = intent.action ?: return
    val type = intent.type ?: return

    if (action == Intent.ACTION_SEND) {
      if (type.startsWith("text/")) {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        if (!text.isNullOrEmpty()) {
          pendingSharePayload = SharePayload(kind = "text", text = text)
        }
      } else {
        val uri: Uri? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
          @Suppress("DEPRECATION")
          intent.getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM) as? Uri
        }
        if (uri != null) {
          val name = getFileName(uri)
          pendingSharePayload = SharePayload(kind = "file", uri = uri.toString(), name = name, mimeType = type)
        }
      }
    } else if (action == Intent.ACTION_SEND_MULTIPLE) {
      val uris: ArrayList<Uri>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
      }
      val first = uris?.firstOrNull()
      if (first != null) {
        pendingSharePayload = SharePayload(kind = "file", uri = first.toString(), name = getFileName(first), mimeType = type)
      }
    }
  }

  private fun getFileName(uri: Uri): String {
    return try {
      contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        val idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
        if (cursor.moveToFirst() && idx >= 0) cursor.getString(idx) else null
      } ?: uri.lastPathSegment ?: "shared_file"
    } catch (_: Exception) { uri.lastPathSegment ?: "shared_file" }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
