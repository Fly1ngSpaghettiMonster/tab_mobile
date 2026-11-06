package com.tab.gps

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.GnssStatus
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.google.android.gms.common.api.ResolvableApiException
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.Granularity
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.LocationSettingsRequest
import com.google.android.gms.location.Priority
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MissingLocationPermissionException :
  CodedException("ERR_LOCATION_PERMISSION", "Fine location permission has not been granted", null)

// Satellite counts older than this are treated as "no satellites": the GNSS engine stops
// reporting status when it has nothing to say, e.g. underground.
private const val GNSS_STATUS_MAX_AGE_MS = 5_000L
private const val SETTINGS_RESOLUTION_REQUEST_CODE = 4712

/**
 * Positions from Google's fused location provider at high-accuracy priority: GNSS whenever
 * satellites are available, Wi-Fi/cell positioning (plus motion sensors) when they are not,
 * e.g. in tunnels or underground. Satellite status is tracked separately and attached to every
 * fix, so each sample shows whether GNSS contributed to it.
 */
class TabGpsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val locationManager: LocationManager
    get() = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

  private val fusedClient: FusedLocationProviderClient by lazy {
    LocationServices.getFusedLocationProviderClient(context)
  }

  private val mainHandler = Handler(Looper.getMainLooper())

  // Latest satellite counts from GnssStatus, attached to every location event.
  @Volatile private var satellitesUsed = 0
  @Volatile private var satellitesInView = 0
  @Volatile private var gnssStatusAt = 0L

  private var listening = false

  private val locationCallback = object : LocationCallback() {
    override fun onLocationResult(result: LocationResult) {
      for (location in result.locations) sendEvent("onLocation", location.toEvent())
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
      gnssStatusAt = SystemClock.elapsedRealtime()
      sendEvent("onGnssStatus", mapOf("satellitesUsed" to used, "satellitesInView" to status.satelliteCount))
    }

    override fun onStopped() {
      satellitesUsed = 0
      satellitesInView = 0
    }
  }

  override fun definition() = ModuleDefinition {
    Name("TabGps")

    Events("onLocation", "onGnssStatus")

    // The system-wide location switch; with it off the fused provider delivers nothing.
    Function("isLocationEnabled") {
      LocationManagerCompat.isLocationEnabled(locationManager)
    }

    AsyncFunction("startUpdates") { intervalMs: Long ->
      startUpdates(intervalMs)
    }

    AsyncFunction("stopUpdates") {
      stopUpdates()
    }

    // Checks that the phone's settings allow the most accurate positioning (GNSS plus
    // Google Location Accuracy for Wi-Fi/cell). If not, shows Android's "turn on" dialog.
    // Resolves true when the settings were already fine.
    AsyncFunction("ensureLocationSettings") { intervalMs: Long, promise: Promise ->
      val request = LocationSettingsRequest.Builder()
        .addLocationRequest(buildRequest(intervalMs))
        .setAlwaysShow(true)
        .build()
      LocationServices.getSettingsClient(context)
        .checkLocationSettings(request)
        .addOnSuccessListener { promise.resolve(true) }
        .addOnFailureListener { e ->
          val activity = appContext.currentActivity
          if (e is ResolvableApiException && activity != null) {
            try {
              e.startResolutionForResult(activity, SETTINGS_RESOLUTION_REQUEST_CODE)
            } catch (_: Exception) {
            }
          }
          promise.resolve(false)
        }
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

  private fun buildRequest(intervalMs: Long): LocationRequest =
    LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
      .setMinUpdateIntervalMillis(intervalMs)
      .setMinUpdateDistanceMeters(0f)
      // Deliver every fix immediately instead of batching them.
      .setMaxUpdateDelayMillis(0)
      .setWaitForAccurateLocation(true)
      .setGranularity(Granularity.GRANULARITY_FINE)
      .build()

  @SuppressLint("MissingPermission")
  private fun startUpdates(intervalMs: Long) {
    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED
    if (!granted) throw MissingLocationPermissionException()

    mainHandler.post {
      if (listening) fusedClient.removeLocationUpdates(locationCallback)
      fusedClient.requestLocationUpdates(buildRequest(intervalMs), locationCallback, Looper.getMainLooper())
      locationManager.registerGnssStatusCallback(gnssCallback, mainHandler)
      listening = true
    }
  }

  private fun stopUpdates() {
    mainHandler.post {
      if (!listening) return@post
      fusedClient.removeLocationUpdates(locationCallback)
      locationManager.unregisterGnssStatusCallback(gnssCallback)
      listening = false
    }
  }

  private fun Location.toEvent(): Map<String, Any?> {
    val api26 = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
    val gnssFresh = SystemClock.elapsedRealtime() - gnssStatusAt <= GNSS_STATUS_MAX_AGE_MS
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
      "satellitesUsed" to if (gnssFresh) satellitesUsed else 0,
      "satellitesInView" to if (gnssFresh) satellitesInView else 0,
      "mocked" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) isMock else @Suppress("DEPRECATION") isFromMockProvider,
    )
  }
}
