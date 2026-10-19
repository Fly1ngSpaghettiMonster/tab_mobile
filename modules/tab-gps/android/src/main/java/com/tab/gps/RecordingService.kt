package com.tab.gps

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service shown while a trip is being recorded. It does no work itself:
 * its presence keeps the app process in the foreground state, so the GPS listener
 * registered by [TabGpsModule] keeps receiving fixes when the app is in the
 * background or the screen is locked.
 */
class RecordingService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Recording trip"
    val body = intent?.getStringExtra(EXTRA_BODY) ?: ""

    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Trip recording", NotificationManager.IMPORTANCE_LOW),
      )
    }

    // Tapping the notification brings the app back to the front.
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .build()

    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // The app was swiped away: the JS side that stores samples is gone, so stop too.
    // The unfinished trip is closed from its saved samples on the next launch.
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    private const val CHANNEL_ID = "recording"
    private const val NOTIFICATION_ID = 4711
  }
}
