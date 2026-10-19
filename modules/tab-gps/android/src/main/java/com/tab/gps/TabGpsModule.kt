package com.tab.gps

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MissingLocationPermissionException :
  CodedException("ERR_LOCATION_PERMISSION", "Fine location permission has not been granted", null)

/**
 * Reads positions straight from Android's satellite-only GPS provider (not Google's
 * fused provider), so every sample is a real GNSS fix and can carry satellite counts.
 */
class TabGpsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val locationManager: LocationManager
    get() = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

  private val mainHandler = Handler(Looper.getMainLooper())

  // Latest satellite counts from GnssStatus, attached to every location event.
  @Volatile private var satellitesUsed = 0
  @Volatile private var satellitesInView = 0

  private var listening = false

  private val locationListener = object : LocationListener {
    override fun onLocationChanged(location: Location) {
      sendEvent("onLocation", location.toEvent())
    }

    override fun onProviderEnabled(provider: String) {
      sendEvent("onProviderStatus", mapOf("enabled" to true))
    }

    override fun onProviderDisabled(provider: String) {
      sendEvent("onProviderStatus", mapOf("enabled" to false))
    }
  }

  private val gnssCallback = object : GnssStatus.Callback() {
    override fun onSatelliteStatusChanged(status: GnssStatus) {
      var used = 0
      for (i in 0 until status.satelliteCount) {
        if (status.usedInFix(i)) used++
      }
      satellitesUsed = used
      satellitesInView = status.satelliteCount
      sendEvent("onGnssStatus", mapOf("satellitesUsed" to used, "satellitesInView" to status.satelliteCount))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("TabGps")

    Events("onLocation", "onGnssStatus", "onProviderStatus")

    Function("isGpsEnabled") {
      locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)
    }

    AsyncFunction("startUpdates") { intervalMs: Long ->
      startUpdates(intervalMs)
    }

    AsyncFunction("stopUpdates") {
      stopUpdates()
    }

    AsyncFunction("startForegroundService") { title: String, body: String ->
      val intent = Intent(context, RecordingService::class.java)
        .putExtra(RecordingService.EXTRA_TITLE, title)
        .putExtra(RecordingService.EXTRA_BODY, body)
      ContextCompat.startForegroundService(context, intent)
    }

    AsyncFunction("stopForegroundService") {
      context.stopService(Intent(context, RecordingService::class.java))
    }

    OnDestroy {
      stopUpdates()
    }
  }

  @SuppressLint("MissingPermission")
  private fun startUpdates(intervalMs: Long) {
    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED
    if (!granted) throw MissingLocationPermissionException()

    mainHandler.post {
      if (listening) locationManager.removeUpdates(locationListener)
      locationManager.requestLocationUpdates(
        LocationManager.GPS_PROVIDER,
        intervalMs,
        0f,
        locationListener,
        Looper.getMainLooper(),
      )
      locationManager.registerGnssStatusCallback(gnssCallback, mainHandler)
      listening = true
    }
  }

  private fun stopUpdates() {
    mainHandler.post {
      if (!listening) return@post
      locationManager.removeUpdates(locationListener)
      locationManager.unregisterGnssStatusCallback(gnssCallback)
      listening = false
    }
  }

  private fun Location.toEvent(): Map<String, Any?> {
    val api26 = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
    return mapOf(
      "provider" to provider,
      "timestamp" to time.toDouble(),
      "latitude" to latitude,
      "longitude" to longitude,
      "accuracy" to if (hasAccuracy()) accuracy.toDouble() else null,
      "altitude" to if (hasAltitude()) altitude else null,
      "speed" to if (hasSpeed()) speed.toDouble() else null,
      "speedAccuracy" to if (api26 && hasSpeedAccuracy()) speedAccuracyMetersPerSecond.toDouble() else null,
      "bearing" to if (hasBearing()) bearing.toDouble() else null,
      "bearingAccuracy" to if (api26 && hasBearingAccuracy()) bearingAccuracyDegrees.toDouble() else null,
      "satellitesUsed" to satellitesUsed,
      "satellitesInView" to satellitesInView,
      "mocked" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) isMock else @Suppress("DEPRECATION") isFromMockProvider,
    )
  }
}
