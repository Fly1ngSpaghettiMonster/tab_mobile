# TAB mobile app: technical description

This document explains how the Android app works inside:
- how GPS data is collected,
- what is stored and what is sent,
- how the route and statistics are calculated,
- how live sharing works,
- what happens when GPS or the network is lost,
- where to find each part in the code.

For setup, building and running, see [README.md](README.md).

## Contents

1. [Overview](#1-overview)
2. [Code layout: where to find what](#2-code-layout-where-to-find-what)
3. [Screens](#3-screens)
4. [Collecting GPS data](#4-collecting-gps-data)
5. [From a fix to the database](#5-from-a-fix-to-the-database)
6. [Turning raw fixes into a track](#6-turning-raw-fixes-into-a-track)
7. [Statistics](#7-statistics)
8. [GPS gaps: finding them and filling them](#8-gps-gaps-finding-them-and-filling-them)
9. [Drawing the map](#9-drawing-the-map)
10. [Live sharing](#10-live-sharing)
11. [Failure handling and edge cases](#11-failure-handling-and-edge-cases)
12. [Tuning constants](#12-tuning-constants)

## 1. Overview

TAB records a trip's GPS data on the phone and stores it locally, so that the route and statistics can be reviewed later. Statistics are distance, duration, average, moving average and maximum speed. Optionally, a trip can be shared live through the TAB backend (`tab_service`) with viewers in a browser (`tab_web`).

| Part | Technology |
| --- | --- |
| App | React Native 0.88 (New Architecture, Hermes), Expo SDK 58 development build, TypeScript, expo-router |
| Map | MapLibre React Native 11, OpenFreeMap vector tiles (Positron style) |
| Storage | SQLite (expo-sqlite), on the phone only |
| Positioning | Local native Expo module `modules/tab-gps` (Kotlin): Google fused location provider, GNSS satellite status, foreground service |
| Live sharing | SignalR client (`@microsoft/signalr`) over WebSockets to `tab_service` |
| Platform | Android only |

**Core principle: raw data is stored, everything else is derived.**
- Every GPS fix received during a recording is saved unchanged. Nothing is filtered before it is stored.
- When sharing is on, these raw samples are also exactly what is uploaded.
- The route, the distance and the speeds are recalculated from the raw samples whenever needed, by the code in `src/geo/`.
- The browser viewer contains a copy of the same code, so the phone and the browser derive the same route and numbers from the same data (see §2.3).

## 2. Code layout: where to find what

### 2.1 Directory structure

```
app/                              Screens (expo-router: the file path is the route)
  _layout.tsx                     Root: startup recovery, theme, RecordingProvider, navigation stack
  (tabs)/_layout.tsx              Bottom tab bar: Map, Trips, Logs
  (tabs)/index.tsx                Map tab: live map, Record/Stop, live stats, share panel
  (tabs)/trips.tsx                Trips tab: list of saved trips
  (tabs)/logs.tsx                 Logs tab: raw GPS fixes as they arrive
  trip/[id].tsx                   Trip detail: speed-coloured route, legend, statistics

src/
  recording/RecordingContext.tsx  App-wide recording state: GPS listener, start/stop, sample
                                  storage, live position, log buffer, share control
  recording/gapProcessing.ts      After-trip gap filling job (one at a time per trip)
  db/database.ts                  SQLite schema, migrations, write queue, all queries
  geo/track.ts                    Track filter: acceptance rules, Kalman filter, standing-still
                                  detection, backward smoothing
  geo/stats.ts                    Trip statistics (+ re-exports of track.ts), number formatting
  geo/gaps.ts                     Finding GPS gaps (also at the start/end of a trip), dotted lines
  geo/gapFill.ts                  Matching gaps to roads / rail lines from vector tiles
  geo/spline.ts                   Smooth curve through the track points (drawing only)
  geo/playback.ts                 Live playback: the car's pose between fixes, slightly in the past
  geo/speedColors.ts              Per-trip speed colour scale
  share/config.ts                 Backend URL and API key (from .env.local)
  share/api.ts                    REST calls: create / close a share session, leftover cleanup
  share/ShareClient.ts            SignalR upload client: resume, batches, acknowledgements
  components/TripMap.tsx          The map component used by the Map tab and the trip detail
  components/StatTile.tsx         Small statistic tile
  theme.ts                        Colours, map style URL

modules/tab-gps/                  Local native module (autolinked from ./modules)
  index.ts                        TypeScript API of the module
  android/.../TabGpsModule.kt     Fused location updates, GNSS status, settings check
  android/.../RecordingService.kt Foreground service with the "recording" notification
  android/src/main/AndroidManifest.xml  Permissions and the service declaration

plugins/withAndroidCmakeVersion.js  Expo config plugin: pins CMake 3.31.6 (Windows long paths)
app.json                            App name, package (com.tab.mobile), permissions, plugins
```

### 2.2 Layers

```
 Screens (app/)                    Map tab · Trips · Logs · Trip detail
   │ useRecording()                    │ database queries        │ processJourneyGaps()
   ▼                                   ▼                         ▼
 RecordingContext ──────────────► database.ts ◄────────── gapProcessing.ts
   │ native events     │ notify()                                │
   ▼                   ▼                                         ▼
 modules/tab-gps     ShareClient ──SignalR──► tab_service      gapFill.ts ──HTTPS──► OpenFreeMap tiles
 (Kotlin)            share/api.ts ──REST───►                     │
                                                                 ▼
 geo/ (pure TypeScript, no React, no I/O except gapFill's tile download):
   track.ts → stats.ts, gaps.ts, spline.ts, playback.ts, speedColors.ts
```

- `src/geo/` holds pure functions and classes. It is used both by the screens (drawing) and by the database layer (statistics). Apart from the tile download in `gapFill.ts`, it does no I/O.
- `RecordingContext` is the only place that talks to the native GPS module during runtime. Screens read its state through the `useRecording()` hook.
- All database writes go through one serial queue in `database.ts` (§5.3).

### 2.3 Code shared with the browser viewer

`tab_web/src/geo/` contains copies of these files:

| File | Contains |
| --- | --- |
| `track.ts` | Kalman filter, standing-still detection, backward smoothing |
| `stats.ts` | Trip statistics |
| `gaps.ts` | Finding GPS gaps, dotted lines |
| `spline.ts` | Smooth route curve |
| `playback.ts` | Live playback: the moving car between fixes |
| `speedColors.ts` | Per-trip speed colour scale |

Each copy starts with a "COPY of … keep in sync" comment. Whenever one of these files changes here, copy it to the viewer as well. Otherwise the browser shows a different route or different numbers than the phone.

## 3. Screens

| Screen | File | What it shows and does |
| --- | --- | --- |
| **Map** (tab) | `app/(tabs)/index.tsx` | Heading-up map that follows the current position, with a recenter button (◎) after panning. Live route while recording (navy curve, plus dotted grey lines where there is no GPS). Speed, distance and time tiles. GPS status line ("GPS ±4 m" or "Wi-Fi/cell ±30 m", satellites used/in view, sample count). **Record / Stop** button. While recording: **Share live**, then **Send link** / **Stop sharing**, with the sharing status. |
| **Trips** (tab) | `app/(tabs)/trips.tsx` | Saved trips, newest first, reloaded whenever the tab gets focus. Tap a trip to open it; long-press to delete it (after confirmation). |
| **Logs** (tab) | `app/(tabs)/logs.tsx` | The last 500 raw fixes, newest first. Columns: time, latitude, longitude, km/h, ±m, satellites used/in view, source (`gnss` = satellite fix, `net` = Wi-Fi/cell, shown in red) and sequence number (#) when recording. Rows worse than ±25 m are shaded: they are left out of the route. The header shows the location request settings. **Clear** empties the list. |
| **Trip detail** | `app/trip/[id].tsx` | The route coloured by speed relative to this trip, with a grey base line under it. Gaps filled along roads or rails are drawn dashed blue; unfilled gaps dotted grey. Start (green) and end (navy) markers. A speed legend showing this trip's km/h values. A gap status line. Statistic tiles: distance, duration, average, moving average, max speed, GPS samples. Opening it starts gap filling if that is not done yet (§8.3). |

Navigation: `app/_layout.tsx` is a stack containing the tab group `(tabs)` and `trip/[id]`. After **Stop**, the app navigates to the new trip's detail page.

## 4. Collecting GPS data

### 4.1 Native module (`modules/tab-gps`)

The JS API (`modules/tab-gps/index.ts`):

| Function / event | Purpose |
| --- | --- |
| `isLocationEnabled()` | Whether the system-wide location switch is on |
| `ensureLocationSettings(intervalMs)` | Checks the phone settings needed for the best positioning (GNSS plus Google Location Accuracy). If they're off, it shows Android's "turn on" dialog. Resolves `true` when they were already fine. |
| `startUpdates(intervalMs)` / `stopUpdates()` | Start / stop location updates and the GNSS status listener |
| `startForegroundService(title, body)` / `stopForegroundService()` | The recording notification (§4.3) |
| event `onLocation` | One `GpsFix` per location update |
| event `onGnssStatus` | Satellites used / in view, about once a second |

**Location request.** Google's `FusedLocationProviderClient`:

| Setting | Value | Why |
| --- | --- | --- |
| Priority | `PRIORITY_HIGH_ACCURACY` | GNSS whenever available |
| Interval / min interval | 1000 ms | One fix per second |
| Min update distance | 0 m | Fixes keep coming while standing still; this is what the standing-still detection uses |
| Max update delay | 0 | No batching: each fix is delivered immediately |
| `waitForAccurateLocation` | `true` | Don't start with a stale or very coarse fix |
| Granularity | `GRANULARITY_FINE` | Precise location |

With satellites in view, fused location delivers GNSS fixes. Without satellites (tunnel, underground, deep indoors) it falls back to Wi-Fi/cell positions and keeps delivering fixes, typically with an accuracy of tens to hundreds of metres.

**What a fix contains** (`GpsFix`):
- provider
- timestamp (ms)
- latitude, longitude
- accuracy (m)
- altitude
- speed (m/s): the GNSS **Doppler speed** when from satellites
- speed accuracy
- bearing (degrees from north), bearing accuracy
- satellites used / in view
- whether the fix is mocked (sent with the fix, but not stored)

**Satellite counts.** The latest `GnssStatus` is attached to every fix. Counts older than 5 s are reported as 0, because the GNSS engine stops reporting when it has nothing to say (for example underground). `fixSource()` in `RecordingContext` calls a fix `gnss` when at least 4 satellites were used, and `net` otherwise.

### 4.2 When GPS runs (`RecordingContext`)

- **Permission.** On start the app asks for `ACCESS_FINE_LOCATION`. If it is denied, the Map tab shows a "Grant permission" button instead of the map.
- **Starting.** Once permission is granted, `ensureLocationSettings` runs once (it may show the settings dialog), then `startUpdates(1000)`.
- **App in the foreground, not recording.** Updates run, so the map shows the current position.
- **App goes to the background, not recording.** Updates stop, to save battery.
- **App comes back to the foreground.** Updates restart, and the location switch is read again.
- **Recording.** Updates keep running in the background and with the screen locked. The foreground service keeps the process alive (§4.3).

### 4.3 Recording in the background (`RecordingService.kt`)

Android stops delivering location to background apps unless they run a foreground service of type `location`. `RecordingService` does no work itself; its job is to exist while recording:
- it shows the ongoing notification "TAB is recording your trip"; tapping it opens the app,
- this keeps the process in the foreground state, so the JS `onLocation` listener keeps receiving fixes.

Behaviour:
- **Start / stop.** The service is started by **Record** and stopped by **Stop**.
- **Notification permission.** On Android 13+ the app asks for `POST_NOTIFICATIONS` first. Without it, recording still works, but the notification is hidden.
- **Swiping the app away from recent apps.** `onTaskRemoved` stops the service. The JS code that stores samples is gone at that point, so recording ends. The trip is closed on the next launch (§11.3).
- **Restarts.** `START_NOT_STICKY`: Android does not restart the service by itself.

## 5. From a fix to the database

### 5.1 The path of one fix

`handleFix(fix)` in `RecordingContext` runs for every `onLocation` event:

```
GpsFix
 ├─ lastFix, location-enabled flag, bearing (only when moving ≥ 1 m/s)
 ├─ build a GpsSample (raw values + sequence number if recording)
 ├─ display filter (TrackFilter.push) → position for the map arrow       (§6.6)
 ├─ log entry → ring buffer of the last 500 fixes (Logs tab)
 └─ if recording:
     ├─ append to the in-memory sample list (samplesRef + React state)
     ├─ insertSample → SQLite (serial write queue)                        (§5.3)
     └─ ShareClient.notify() if sharing → upload                          (§10)
```

### 5.2 Which data points are stored and sent

- **Every fix received while recording is stored unchanged**, whatever its accuracy, including coarse Wi-Fi/cell fixes and fixes that the track filter later rejects. Filtering happens only when the track is derived (§6). This means:
  - the raw data can be re-analysed with better algorithms later. For example, stored trips were re-processed when the filter changed (§7.2);
  - the coarse fixes recorded underground are available for gap handling (§8).
- **Fixes received while not recording are not stored.** They only update the map arrow and the Logs tab.
- **Sequence numbers.** Each recorded sample gets a sequence number: 0, 1, 2, … per trip. `(journey_id, sequence)` is the primary key. The sequence is also the sample's identity in sharing (acknowledgements, de-duplication).
- **Timestamp.** The fix's own time (`Location.time`, UTC), not the time it arrived in JS.
- **Sent when sharing:** exactly the stored raw samples (§10.3), in the same form, without the journey id.

### 5.3 Database (`src/db/database.ts`)

SQLite file `tab.db` in WAL mode, with foreign keys on. Tables:

| Table | Content |
| --- | --- |
| `journeys` | One row per trip: `started_at_utc`, `ended_at_utc` (NULL while recording), stored statistics (`distance_m`, `duration_s`, `avg_speed_mps`, `moving_avg_speed_mps`, `max_speed_mps`), `stats_version`, `gaps_checked`, `location_source` (the request settings, e.g. `fused high-accuracy 1000ms`), `name` |
| `gps_samples` | Raw samples: `journey_id`, `sequence`, `timestamp_utc`, latitude, longitude, `speed_mps`, `accuracy_m`, `altitude_m`, `heading`, `provider`, `satellites_used`, `satellites_in_view`, `speed_accuracy_mps`, `bearing_accuracy_deg` |
| `gap_fills` | Gap paths found after a trip: `journey_id`, `from_sequence`, `to_sequence`, `path` (JSON `[lon, lat][]`), `length_m`, `tunnel`, `mode` (`road` / `rail`) |
| `share_sessions` | Live shares: `session_id`, `journey_id`, `owner_token`, `viewer_url`, `last_acked_sequence`, `status` (`open` / `closing` / `closed`), `created_at_utc` |

**Migrations.** The schema version is kept in `PRAGMA user_version`, currently 6. `migrate()` applies the missing steps in order:

| Version | Change |
| --- | --- |
| v2 | Fix source and quality columns |
| v3 | `gap_fills` table and `gaps_checked` |
| v4 | `stats_version` |
| v5 | `share_sessions` table |
| v6 | `gap_fills.mode`, and resets `gaps_checked` so every trip is checked again with the new gap logic |

**Write queue.** `enqueueWrite()` chains every write onto one promise, so writes never overlap and always run in order. In particular, `finishJourney` runs only after the last `insertSample` of the trip has been written.

**Deleting a trip.** Its samples, gap fills and share rows go too (`ON DELETE CASCADE`).

### 5.4 Start and stop of a recording

**Record** (`start()`):
1. Request the notification permission (Android 13+).
2. Create the journey row.
3. Reset the sequence and the sample buffer.
4. Start the foreground service.

**Stop** (`stop()`):
1. End sharing, if active. This waits up to 3 s for the last samples to upload.
2. Stop the foreground service.
3. If no sample was recorded, delete the journey; the screen shows "Nothing recorded".
4. Otherwise `finishJourney`: set `ended_at_utc` to the time Stop was pressed, and store the statistics.
5. Start `processJourneyGaps` in the background (§8.3). The trip detail screen opens straight away.

## 6. Turning raw fixes into a track

The code is in `src/geo/track.ts`. `processTrack(samples)` turns the raw samples into a list of `TrackPoint`s, each with:
- the filtered position,
- the speed,
- the distance added by this point (`segmentMeters`),
- a `stationary` flag.

The same `TrackFilter` class is used for stored trips, the live route, the map arrow and the browser viewer.

### 6.1 Acceptance rules

A raw sample is skipped (it stays in the database and in the log) when:

| Rule | Threshold | Why |
| --- | --- | --- |
| Accuracy worse than | 25 m | Wi-Fi/cell fixes are too coarse for a route. They are used for gaps instead (§8). |
| Implied speed from the previous accepted fix above | 470 km/h | A glitch jumping hundreds of metres in a second. 470 km/h is roughly the top speed of the fastest production cars, so no real trip is cut. |
| Timestamp not after the previous accepted fix | dt ≤ 0 | Duplicate or out-of-order fix |
| Speed outside 0…470 km/h | (the speed only) | The position is still used; the speed counts as missing. |

### 6.2 Kalman filter (constant velocity)

**State.** Positions are converted to metres in a local flat projection around the trip's first accepted fix. The state per axis (east, north) is position and velocity. Both axes get the same model and measurement accuracies, so they share one 2×2 covariance matrix.

**Predict.** Over the time `dt` since the previous accepted fix, assuming constant velocity plus random acceleration σₐ:
- σₐ = 3 m/s² while moving, roughly a car's acceleration and braking;
- σₐ = 0.3 m/s² while standing still.

**Update with the position.** The measurement variance is accuracy². A ±4 m fix counts much more than a ±20 m fix.

**Update with the Doppler velocity**, when the fix has a speed:
- With speed ≥ 0.5 m/s and a bearing, the measurement is (speed·sin bearing, speed·cos bearing). Its variance is speedAccuracy² + (speed·bearingAccuracy)². When the fix doesn't report them, 1 m/s and 30° are assumed.
- With speed < 0.5 m/s, the bearing is meaningless, so the measurement is "velocity ≈ 0". Its variance is speedAccuracy² + speed².

Using velocity measurements is what keeps the filtered line from lagging behind a fast car, and from cutting corners.

**Restart.** When more than 5 s passed since the previous accepted fix (a tunnel, for example), the filter starts again at the new fix instead of extrapolating the old velocity across the gap. The smoothing pass (§6.4) treats each restart as a new stretch.

### 6.3 Standing-still detection

The speed in a GNSS fix is measured from the Doppler shift of the satellite signals, not from consecutive positions. While standing still it stays at 0.1–0.3 m/s (0.3–1 km/h), even when the positions jump around by several metres. The filter uses this to detect stops:

| Transition | Condition |
| --- | --- |
| moving → **standing still** | speed < 0.5 m/s (1.8 km/h) on **3 fixes in a row** |
| moving → standing still, fixes without a speed | all fixes stay within 1.5 × max(accuracy, 5 m) of each other for **5 s** |
| standing still → **moving** | speed ≥ 1 m/s (3.6 km/h) on **2 fixes in a row**, or ≥ 2.5 m/s (9 km/h) **once** |
| standing still → moving, fallback | a fix is more than max(2 × accuracy, 15 m) away from the held position on **2 fixes in a row** |
| first fix of a trip or after a restart | standing still if its speed is < 0.5 m/s |

While standing still:
- the velocity is fixed at 0, with a "zero velocity" measurement of ±0.05 m/s;
- the position is held. New fixes count 25 times less than usual (their accuracy is multiplied by 5), so the parked position slowly averages out instead of wandering;
- `segmentMeters` is 0, so no distance is added;
- the point keeps the held position, so the drawn line collapses into a single point instead of a zigzag.

On moving again, the position and velocity uncertainty are widened, so the filter follows the new fixes immediately.

With ±4 m jitter, the tests measured 0 m of added distance over 120 s and a held point that moved by 3 cm. A start at walking speed is detected within about 2 fixes.

### 6.4 Backward smoothing (Rauch–Tung–Striebel)

`processTrack(samples)` smooths by default. The filter keeps each step's predicted and filtered state and covariance. A backward pass then corrects every point with the information from the fixes after it:

```
C_k  = P_k|k · Fᵀ · (P_k+1|k)⁻¹
x_k  = x_k|k + C_k · (x_k+1 (smoothed) − x_k+1|k)
```

This removes most of the remaining wobble and the filter's lag. On a simulated roundabout with ±3 m noise, the root-mean-square deviation from the true path was:
- 3.15 m for the raw fixes,
- 1.17 m after the forward filter,
- 0.73 m after smoothing.

Afterwards, `segmentMeters` is recalculated from the smoothed positions. Speeds are recalculated too, for points without a Doppler speed.

During a live recording, the whole trip is re-processed whenever a sample arrives, so the recent past keeps being refined.

### 6.5 Speed of a point

| Situation | Speed used |
| --- | --- |
| Standing still | 0 |
| The fix has a valid Doppler speed | That speed |
| Otherwise | The magnitude of the filter's (smoothed) velocity |

### 6.6 Position of the map arrow

While recording, the arrow is placed by the live playback (§9.3): it moves along the drawn route, about 2.25 s behind the newest fix.

When there is no track to play back, `RecordingContext`'s own `TrackFilter` places it. This covers the map before recording, before the first accurate fix, and a GPS gap in progress. That filter runs forward only, on **every** fix, recording or not:
- If the fix is accepted, the arrow shows the filtered position. While standing still, the previous position object is kept, so React does not re-render and the camera does not move at all.
- If the fix is rejected (coarse Wi-Fi/cell), the arrow shows the raw fix with its large accuracy circle.

The arrow's direction is the last GNSS bearing at a speed of at least 1 m/s. It is kept while standing still, because the bearing is meaningless at low speed.

## 7. Statistics

### 7.1 Formulas (`computeStats` in `src/geo/stats.ts`)

| Value | Definition |
| --- | --- |
| Distance | Sum of `segmentMeters` of the smoothed track. A gap that was filled (§8) counts with the path's length instead of the straight line. A stretch without GPS at the start or end counts with its filled path, or its straight line when not filled (only if it passed the edge-gap test, §8.1). |
| Duration | From the first sample to the end time: the moment **Stop** was pressed, or the last sample for a recovered trip. |
| Average speed | Distance / duration (stops included) |
| Moving average | Distance / moving time. A step between two points counts as moving if the point's speed is ≥ 1 km/h, or the distance covered over the step implies ≥ 1 km/h. The second condition matters after a long gap, where the speed at its end can be zero. Edge gaps count as moving time. |
| Max speed | Highest point speed whose reported speed accuracy is at most 3 m/s (or not reported) |

During recording, `liveStats` is recalculated on every sample and feeds the Distance tile. The Speed tile shows the latest raw fix's speed.

### 7.2 Recalculating stored trips

The stored statistics carry `stats_version`. When the formulas or the filter change, `STATS_VERSION` in `stats.ts` is increased (currently 3). On the next start, `refreshOutdatedStats()` recalculates every stored trip from its raw samples and gap fills. This is possible because raw samples are never altered.

## 8. GPS gaps: finding them and filling them

### 8.1 Finding gaps (`src/geo/gaps.ts`)

**Gaps between two accepted fixes.** Two consecutive accepted points are a gap when they are at least **8 s** and **120 m** apart.

**Edge gaps.** These are the stretches before the first accepted fix and after the last one, for example when recording starts in the metro.
- **Anchor.** The edge gap starts (or ends) at an anchor, estimated from the coarse fixes (accuracy ≤ 1000 m) at that edge:
  - position: the accuracy-weighted mean of the coarse fixes within **15 s** of the edge;
  - uncertainty σ: the best accuracy among them;
  - key: the anchor uses the first (or last) coarse sample's sequence number.
- **When it counts.** An edge gap only counts when it is at least 8 s long and at least max(120 m, 2 × the sum of its ends' σ) long. This way, waiting on a platform before the train leaves does not invent distance.
- **No accurate fix at all** (a whole metro ride): there is one edge gap, from the first coarse position to the last.

Each gap records:
- its two ends,
- the raw samples inside it,
- whether it is an edge gap,
- how far from a road or rail line each end may be snapped:
  - 40 m for an end at an accurate fix,
  - clamp(σ, 40 m, 300 m) for an end at an anchor.

**Dotted approximate line.** `approximatePath` builds the dotted line for unmatched gaps. It is a line through the coarse fixes with accuracy ≤ 300 m, smoothed by a simple filter (random walk at 20 m/s, weighted by accuracy), so single bad cell fixes do not dominate.

`liveCoarseLines` builds the same kind of dotted lines during recording, for:
- the stretch before the first accurate fix,
- the gaps so far,
- a gap still in progress.

### 8.2 Filling gaps along roads and rail lines (`src/geo/gapFill.ts`)

This runs on the phone and needs no server of its own. It only downloads the same vector tiles the map uses.

1. **Tiles.** Download the zoom-14 OpenFreeMap tiles in a strip around the gap's straight line. The tile URL comes from the TileJSON at `https://tiles.openfreemap.org/planet`. A gap needing more than 60 tiles is skipped. Each tile is downloaded once per gap and decoded with `@mapbox/vector-tile` and `pbf`.
2. **Networks.** From the `transportation` layer, two graphs are built:
   - **road**: classes motorway, trunk, primary, secondary, tertiary, minor and service. One-way roads are directed.
   - **rail**: classes `rail` and `transit` (metro, light rail, tram).
   Each line also carries the tile's tunnel flag (`brunnel = tunnel`).
3. **Graph.** Vertices closer than 0.1 m are merged; vertices repeat across tile borders. Loose line ends are joined to a line within 8 m, because tile clipping leaves small breaks. A 50 m grid speeds up nearest-segment search.
4. **Snapping.** Each gap end is snapped onto the nearest segment within its snap distance (§8.1). For rail this is at least 150 m, because station exits can be far from the track.
5. **Shortest path.** Dijkstra with a binary heap. The tunnel length along the path is recorded too.
6. **Corridor.** The search starts with a 400 m strip. If that finds no connection, it is retried with a strip of 15% of the gap length, because long tunnels can curve far from the straight line.
7. **Plausibility.** A path is accepted only if all of these hold:
   - it is at most max(2.5 × the straight line, the straight line + 500 m) long,
   - it implies no more than 470 km/h over the gap's duration,
   - at least 70% of the gap's coarse fixes (accuracy ≤ 1000 m) lie within max(1.5 × their accuracy, 150 m) of it.
8. **Road or rail.** Both networks are tried. If both give a plausible path, and at least half of the fixes inside the gap saw no satellites at all (underground), the path with the larger tunnel share wins. That is usually the metro line rather than the street above it. Otherwise the road wins.

Accepted paths are stored in `gap_fills`, used for the distance (§7.1) and drawn dashed. Gaps without an accepted path are drawn as a dotted grey line through the coarse fixes.

### 8.3 When gap filling runs (`src/recording/gapProcessing.ts`)

`processJourneyGaps(journeyId)` runs in the background right after **Stop**, and whenever a trip detail screen is opened.
- **One run per trip at a time.** Running jobs are shared through a map keyed by the journey.
- **Already checked trips** (`gaps_checked = 1`) only return the stored fills.
- **Otherwise:**
  1. find the gaps,
  2. try to fill each one,
  3. recalculate the statistics with the fills,
  4. save everything in one transaction, and set `gaps_checked = 1`.
- **If a tile download fails** (offline), the job returns `null` and leaves `gaps_checked = 0`. The trip shows "GPS gaps not checked yet (no internet)", and the check runs again the next time the trip is opened.

## 9. Drawing the map

The code is in `src/components/TripMap.tsx`. The same component works in two modes:

| | Live mode (Map tab, `position` given) | Review mode (trip detail, `colorBySpeed`) |
| --- | --- | --- |
| Route | Navy curve of the recorded track | Speed-coloured curve over a grey base line |
| Gaps | Dotted grey through coarse fixes (`liveCoarseLines`) | Filled: dashed blue along the road or rail path. Unfilled: dotted grey through the coarse fixes. |
| Camera | Follows the position, heading-up | Fitted to the whole trip, including gap paths |
| Markers | Position arrow and accuracy circle | Start (green) and end (navy). At the coarse anchor if the trip started or ended without GPS. |

### 9.1 Smooth curve (`src/geo/spline.ts`)

The track is split at gaps. Each continuous piece is drawn as a **centripetal Catmull-Rom spline** (α = 0.5). This curve passes through every point and, unlike the standard variant, never overshoots or loops between unevenly spaced points.
- **Merging.** Points closer than 0.5 m are merged first; this collapses standing-still points into one.
- **Where points are added.** Intermediate points are added only on segments longer than 3 m where the line turns by more than 8° at either end: every 5 m, at most 8 per segment. Straight stretches add nothing, which keeps the map data small.
- **Index.** `smoothLine` returns, for each input point, its index in the curve. This lets the speed-coloured runs, and the web viewer's timeline, cut the curve exactly at a track point.

The curve is for drawing only; distances use the smoothed track points (§6.4).

### 9.2 Speed colours (`src/geo/speedColors.ts`)

The colour scale is relative to the trip itself, so slow and fast stretches stand out on both city and motorway trips:

| Speed | Colour |
| --- | --- |
| 0 | red |
| ½ × moving average | yellow |
| moving average | green |
| halfway to max | light blue |
| max | deep blue |

Colours blend linearly between these stops, using a MapLibre `interpolate` expression on each feature's `kmh` property.

The route is drawn as runs of consecutive segments in the same 1/40 speed bucket, not one feature per GPS sample. MapLibre drops sub-pixel features when zoomed out, which used to make a route made of tiny segments disappear. The grey base line under the whole trip keeps the route visible at every zoom level. All review sources use `tolerance = 0` (no simplification).

### 9.3 Live playback: following camera, arrow and route end (`src/geo/playback.ts`)

Fixes arrive about once a second. Moving the arrow to each new fix makes it stop and go. Drawing the line to each new fix also makes the line run ahead of the arrow. So while recording, the live map **plays the track back slightly in the past**: the newest fix is always about 2.25 s ahead of what is shown. The next fix is therefore already known, and the arrow can move continuously along the route.

- **The playback clock** (`PlaybackClock`) is a track time that advances with the wall clock, aiming to stay `PLAYBACK_DELAY_MS` = 1500 ms behind the newest track point. That is one fix interval plus 0.5 s for fixes that arrive late.
  - The offset between track time and wall clock is averaged over the last ~5 fixes (weight 0.2 per fix). One early or late fix therefore barely moves it.
  - The clock runs at most 10% faster or slower to correct its error (100% per 4 s of error). Arrival jitter therefore cannot make the arrow speed up and slow down.
  - It never passes the newest point. When fixes stop (a GPS gap), the arrow waits at the last point.
  - When it is more than 5 s off (first fix, the end of a gap, a big change in the offset), it jumps.
- **The pose** (`poseAt`) is a point on the drawn spline, at a distance along the line computed in two steps:
  1. Between two fixes, the distance follows a monotone cubic (Hermite) curve whose slopes are the speeds at the two fixes. The speed changes smoothly across a fix instead of jumping, and never goes backwards.
  2. That distance is averaged over the last 1.5 s of track time (triangular weights, 9 samples). Every fix carries a little along-track noise, so passing each fix exactly on time would change the speed at every fix. The average spreads that out, while the arrow stays exactly on the line. Only the past is used, so new fixes never change it. The cost is 0.75 s of extra delay, so the total is about 2.25 s.

  Across a GPS gap the arrow stays at the last fix before it.
- **Forward filter only.** The live map uses `processTrack(samples, { smooth: false })`. The backward smoother would shift the last points by up to ~0.5 m on each new fix, under the moving arrow. The trip detail screen and the statistics still use the smoothed track.
- **Calm bearing.** The map is heading-up, so any wobble in the bearing rotates the whole map around the arrow. A 2° wobble moves the edge of the screen by about 17 px, at every zoom level. The shown bearing is therefore:
  - taken from the route itself: the direction from the arrow to the point 2 s (at least 5 m) further along the line. The noisy per-fix GPS headings are only used before there is any course. Below 3 m ahead (standing still) the bearing is kept;
  - turned towards that course smoothly, with a time constant of 0.7 s (`BearingSmoother`);
  - **only turned when the course differs by more than a dead band that depends on the zoom**: 2° at zoom 16 and closer, rising linearly to 10° at zoom 12 and further out. Once turning, it keeps turning until within 0.5°. Zoomed out, small wiggles never rotate the map, while real turns still do.

  In a simulation (±2° heading noise, ±3 m position noise, ±300 ms arrival jitter at 22 m/s), the results were:
  - the speed on screen stays within 21.1–23.6 m/s;
  - on a straight road the map turns 0.28°/s at zoom 16, and not at all at zoom 12;
  - a 90° turn is followed about 1.5 s after it ends.
- **One pose for everything.** Every animation frame (`LiveRoute` in `TripMap.tsx`, its own component so only it re-renders):
  - the camera is moved to the pose with `jumpTo` (centre and bearing), so the centred arrow is the pose;
  - the line is drawn exactly up to the pose. `routeUpTo` gives the passed part, re-sent only when the arrow passes a fix. The pose's short `head` (the curve from the last passed fix to the arrow) is updated every frame. The line therefore never runs ahead of the arrow and appears to be drawn by it.
  - While standing still the pose does not change, and nothing is sent.
- **When playback is off.** It is not used when there are no track points (not recording, or before the first accurate fix). It is also off while the newest sample is more than 3 s newer than the last track point (a GPS gap in progress, shown with the coarse fix). The camera then glides to each new position in 900 ms, and the whole route is drawn.
- **The arrow while following** is a plain view fixed at the centre of the map, with an accuracy circle sized from the current zoom: metres per pixel = 40 075 016.686 × cos(latitude) / (512 × 2^zoom). While not following, it is a regular map marker at the pose.
- **Gestures** are read from the touches on the map's container (`onTouchStart` / `Move` / `End`), not from the map's region events. The playback moves the camera every frame, and the map reports those moves much like the user's. The rules:
  - while a finger is down, the camera is not moved;
  - one finger moving more than 12 px is a pan: it stops following and shows the recenter button ◎;
  - anything else (tap, pinch, double-tap zoom) keeps following and recenters when the fingers are lifted.
- **Map style.** OpenFreeMap Positron (light and low-detail). Compass, rotation gestures and tilt are off in live mode.

## 10. Live sharing

### 10.1 Configuration

`src/share/config.ts` reads `EXPO_PUBLIC_TAB_API_URL` (default `https://tab.aabder.xyz`) and `EXPO_PUBLIC_TAB_API_KEY` from `.env.local`. Expo copies these values into the code when the app is bundled, so Metro must be restarted after changing them, and a release build contains them. Without an API key, **Share live** shows an error.

### 10.2 Starting a share

**Share live** is only available while recording. `startSharing()`:
1. `POST /api/sessions` with header `X-Api-Key`, body `{ clientTripId, startedAtUtc, locationSource }`. It returns `sessionId`, `ownerToken` (the phone's secret for this session) and `viewerUrl` (the link to share).
2. If recording stopped or another share started while the request was in flight, the new session is closed immediately.
3. The session is saved in `share_sessions` with `last_acked_sequence = -1` and status `open`.
4. A `ShareClient` is created and started.

**Send link** opens the Android share sheet with "Follow my trip live: `<viewerUrl>`".

### 10.3 Upload protocol (`src/share/ShareClient.ts`)

The client connects to the SignalR hub `${TAB_API_URL}/hubs/trip`:
- **Transport.** WebSockets only, with no negotiate request, so a single upgraded HTTPS request goes through the proxy.
- **Authentication.** The owner token is passed as a method argument, never in the URL, so it doesn't appear in proxy logs.

```
Phone                                         tab_service
  ── start connection ─────────────────────────►
  ── Resume(sessionId, ownerToken) ────────────►   checks token, session open
  ◄──────────────────── highest stored sequence ──  e.g. -1 for a new share
  ── PublishSamples(id, token, [≤200 samples]) ►   validates, stores new ones (duplicates
  ◄─────────────────── highest sequence stored ───  ignored), forwards new ones to viewers
  ── PublishSamples(...) …                          (repeated while samples are pending)
```

- **Source of truth.** The server's acknowledged sequence (`acked`) decides what is still pending. Every recorded sample with `sequence > acked` is pending.
- **What is sent.** All samples of the trip, from sequence 0. Viewers see the whole trip even when sharing started mid-way. The samples are raw, not filtered (§5.2).
- **Flush.** `notify()` is called for every new sample and starts a flush. A flush sends batches of up to 200 pending samples, oldest first, until nothing is pending. Only one flush runs at a time; a call during a flush schedules another round.
- **After each batch:**
  - the new `acked` value is saved to `share_sessions.last_acked_sequence`, for information and the next resume;
  - the status shown on the Map tab is updated: Live, plus "N samples waiting" when more than one is pending.
- **Server side.** The server de-duplicates by sequence, and acknowledges a whole batch even if it drops invalid samples, so the phone never retries them forever. Re-sending is therefore always safe.

### 10.4 Stopping a share

| Trigger | What happens |
| --- | --- |
| **Stop sharing** (recording continues) | Reason `revoked`: stop the client, then close the session on the server. The link stops working at once. |
| **Stop** recording | Reason `ended`: first wait up to **3 s** for pending samples to upload (`drain`), then stop the client and close the session. |
| Server refuses (`session-closed`, `unauthorized`) | The session was closed elsewhere, expired or deleted. The client stops, the share is cleared on the Map tab, and the local status becomes `closed`. |

Closing (`closeAndRecord` in `src/share/api.ts`):
1. Mark the session `closing` locally.
2. Send `POST /api/sessions/{id}/close` with `Authorization: Bearer <ownerToken>` and the reason. A `401` counts as already closed.
3. On success, mark it `closed`.
4. On failure (offline), it stays `closing` and is retried at the next app start (§11.3).

The close request runs in the background, so **Stop** never waits for the network apart from the 3 s drain.

## 11. Failure handling and edge cases

### 11.1 Losing GPS

| Situation | Behaviour |
| --- | --- |
| **Tunnel or underground mid-trip** | Fused location keeps delivering Wi-Fi/cell fixes, typically at ±50–1500 m. They are stored and logged, but rejected by the track filter (> 25 m). The live map draws a dotted grey line through them from the last accurate point. When GNSS returns after more than 5 s, the filter restarts at the first good fix. After the trip, the gap is matched to a road or the metro line (§8). |
| **Recording starts underground** | No accurate fix yet. The arrow shows the coarse fix with its large circle, and the live map draws a dotted line through the coarse fixes. After the trip, the start becomes an edge gap from the coarse anchor to the first accurate fix, matched to the metro line or road and counted in the distance (§8.1). |
| **Recording ends underground** | Mirror image: a trailing edge gap from the last accurate fix to the coarse anchor at the end |
| **No accurate fix at all during the trip** | One gap from the first coarse position to the last, if it passes the edge-gap test; otherwise the trip has no route |
| **No fix at all** (location off, deep indoors) | Nothing is recorded. Stopping a trip without samples deletes it and shows "Nothing recorded". |
| **System location switch turned off** | The status line says "Location is turned off in system settings". The flag is read again when the app comes to the foreground, and set to on again as soon as a fix arrives. |
| **Google Location Accuracy / Wi-Fi scanning off** | `ensureLocationSettings` shows Android's dialog. Without these settings the fallback to Wi-Fi/cell fixes underground does not work. |
| **GPS glitch** (a jump of hundreds of metres) | Rejected by the 470 km/h rule (§6.1) |
| **Jitter while standing still** | Absorbed by the standing-still detection (§6.3): no zigzag, no distance |
| **Duplicate or out-of-order timestamps** | Skipped by the filter (dt ≤ 0); still stored raw |

### 11.2 Losing the network

| What needs the network | Without it |
| --- | --- |
| **Recording** | Not affected. Everything is stored locally. |
| **Map tiles** | Areas not cached by MapLibre show no background map. The route, arrow and recording are not affected. |
| **Gap filling** | Postponed: the trip shows "GPS gaps not checked yet (no internet)", and the check is retried when the trip is opened again (§8.3). |
| **Starting a share** | The create request fails after a 10 s timeout, and the error is shown. Recording continues. |
| **An active share** | Samples keep being stored locally and pile up as pending ("N samples waiting"). After reconnecting, the backlog is uploaded (see below). Viewers stop receiving new samples meanwhile, then get the whole backlog at once. |
| **Closing a share** | Retried at the next app start (§10.4) |

**Reconnection of an active share:**
1. **Connection drops.** SignalR's automatic reconnect takes over and the status shows "Offline, reconnecting…". It retries after 1, 2, 4, 8 and 16 s, then every 30 s, and never gives up while the trip is shared.
2. **Reconnected.** The client calls `Resume` again. The server returns the highest sequence it has stored, which becomes the new `acked`. Everything after it is uploaded in batches of 200, then normal streaming continues.
3. **Never connected, or the connection closed for good.** If the first connection fails, or automatic reconnect ends, the client starts a fresh connection every **5 s** until sharing stops.
4. **Upload failures in the middle of a batch** are only logged. The reconnect and `Resume` cycle re-sends whatever the server did not acknowledge, and duplicates are ignored, so nothing is lost and nothing is stored twice.
5. **Network still down when Stop is pressed.** The 3 s drain gives up. The samples not uploaded stay on the phone only, and the close request is retried at the next start.

### 11.3 App lifecycle

| Situation | Behaviour |
| --- | --- |
| **Screen locked / app in the background while recording** | Recording continues: the foreground service keeps the process alive. Each sample is stored as it arrives. |
| **Battery optimisation** (e.g. Samsung) | It may still kill or throttle the app on long trips. Set TAB's battery usage to *Unrestricted*. |
| **App swiped away, force-stopped, crashed, or the phone switched off while recording** | Samples up to that moment are already in SQLite. At the next start, `recoverUnfinishedJourneys()` finishes every journey with `ended_at_utc IS NULL`, using its last sample's time as the end and computing the statistics. Journeys without samples are deleted. Gap filling for them runs when they are opened. |
| **A share left open by a crash** | At start, after recovery, `closeLeftoverShareSessions()` closes every share not confirmed closed. An `open` share is closed as `ended`, a `closing` one as `revoked`. This runs in the background and needs the network; it is retried on later starts until it succeeds. |
| **Startup order** (`app/_layout.tsx`) | The splash screen stays until `recoverUnfinishedJourneys()` and `refreshOutdatedStats()` have finished, so the trip list is always consistent. |
| **App update with schema changes** | `migrate()` upgrades the database in place (§5.3). Stored statistics are recalculated if their version is outdated (§7.2). |

### 11.4 Performance notes

- **Per-sample work.** While recording, each new sample re-runs the track filter, smoothing, gap search and curve over the whole trip. All are linear in the number of samples; an hour has 3600.
- **Playback.** While recording and moving, the live map runs a `requestAnimationFrame` loop. Each frame computes one pose (a binary search and a short walk along the curve), sends one camera `jumpTo`, and updates a GeoJSON line of a few points. The full route is only re-sent when the arrow passes a fix. Only the small `LiveRoute` component re-renders, and nothing happens while standing still (§9.3).
- **Satellite status.** Re-renders from satellite updates are skipped when the counts did not change.

## 12. Tuning constants

| Constant | Value | File |
| --- | --- | --- |
| Location interval | 1000 ms | `RecordingContext.tsx` (`GPS_INTERVAL_MS`) |
| GNSS fix: satellites used | ≥ 4 | `RecordingContext.tsx` |
| Satellite status max age | 5 s | `TabGpsModule.kt` |
| Log buffer | 500 entries | `RecordingContext.tsx` |
| Max accuracy for the track | 25 m | `track.ts` |
| Max plausible speed | 470 km/h | `track.ts` |
| Process noise (moving / standing still) | 3 / 0.3 m/s² | `track.ts` |
| Filter restart after a pause of | 5 s | `track.ts` |
| Standing still: stop | < 0.5 m/s on 3 fixes | `track.ts` |
| Standing still: go | ≥ 1 m/s on 2 fixes, or ≥ 2.5 m/s once, or away > max(2·acc, 15 m) twice | `track.ts` |
| Moving threshold (moving average) | 1 km/h | `stats.ts` |
| Max speed accuracy for max speed | 3 m/s | `stats.ts` |
| Gap: min duration / length | 8 s / 120 m | `gaps.ts` |
| Edge anchor window / max accuracy | 15 s / 1000 m | `gaps.ts` |
| Dotted line: max fix accuracy | 300 m | `gaps.ts` |
| Snap distance: accurate end / anchor / rail minimum | 40 m / clamp(σ, 40, 300) m / 150 m | `gaps.ts`, `gapFill.ts` |
| Corridor: narrow / wide | 400 m / 15% of the gap length | `gapFill.ts` |
| Max tiles per gap | 60 | `gapFill.ts` |
| Detour limit | max(2.5×, +500 m) | `gapFill.ts` |
| Coarse fix agreement | 70% within max(1.5·acc, 150 m) | `gapFill.ts` |
| Underground (prefer tunnel path) | ≥ 50% of the gap's fixes with 0 satellites in view | `gapFill.ts` |
| Spline: turn / min segment / step / max steps | 8° / 3 m / 5 m / 8 | `spline.ts` |
| Live playback delay | clock 1.5 s behind the newest fix, plus 0.75 s from speed smoothing | `playback.ts` |
| Playback clock | offset averaged over ~5 fixes; rate ±10% (100% per 4 s of error); jumps when > 5 s off | `playback.ts` |
| Playback speed smoothing | Hermite distance between fixes, averaged over the last 1.5 s | `playback.ts` |
| Bearing smoothing | course 2 s / ≥ 5 m ahead on the route; time constant 0.7 s; dead band 2° (zoom ≥ 16) to 10° (zoom ≤ 12) | `playback.ts` |
| Playback off (GPS gap in progress) | newest sample > 3 s after the last track point | `TripMap.tsx` |
| Camera glide without playback | 900 ms | `TripMap.tsx` |
| Pan threshold | 12 px, one finger | `TripMap.tsx` |
| Share batch size | 200 samples | `ShareClient.ts` |
| Share reconnect delays | 1, 2, 4, 8, 16, then 30 s; fresh start every 5 s | `ShareClient.ts` |
| Share drain on Stop | 3 s | `RecordingContext.tsx` |
| Share REST timeout | 10 s | `share/api.ts` |
| Statistics version | 3 | `stats.ts` |
| Database schema version | 6 | `database.ts` |
