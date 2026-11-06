# TAB – trip tracker (Android)

TAB records GPS data while you drive. It saves every trip on the phone, so you can review the route and statistics (distance, duration, average / moving-average / max speed) later.

Built with React Native, Expo (development build), TypeScript, MapLibre, and expo-sqlite.

## Location data

Positions come from **Google's fused location provider** at high-accuracy priority, through the local native module in `modules/tab-gps`. It is set to deliver a fix every second, with no batching, and to wait for an accurate first fix.
With a satellite signal the fixes come from GNSS. Without one, for example in tunnels or underground, fused falls back to Wi-Fi/cell positions instead of stopping.
For that fallback to work, the phone's *Google Location Accuracy* and *Wi-Fi scanning* settings must be on; the app asks Android to show the "turn on" dialog when they are off.
The GNSS satellite status is tracked alongside, so every sample stores the satellites used/in view, plus accuracy, speed accuracy and bearing accuracy. In the Logs tab, `gnss` means a satellite fix and `net` a Wi-Fi/cell fix.

While a trip is recording, a foreground service (`RecordingService`) shows a notification and keeps the app running. This way recording continues in the background and with the screen locked.
Swiping the app away from the recent apps list ends the recording. The trip is closed from its saved samples on the next launch.
On some phones (e.g. Samsung), set the app's battery usage to *Unrestricted* for long trips.

Distance and the drawn route are computed from a filtered track (`src/geo/stats.ts`):
- fixes worse than 25 m and implausible jumps are dropped (anything implying more than 470 km/h, roughly the top speed of the fastest production cars),
- positions are smoothed with a Kalman filter weighted by each fix's accuracy,
- no distance is added while standing still.

The raw samples stay unchanged in the database.

### Speed colours

The trip map colours the route relative to the trip's own speeds, so slow and fast stretches stand out on both motorway and city trips (`src/geo/speedColors.ts`):

| Speed | Colour |
| --- | --- |
| 0 | red |
| ½ × moving average | yellow |
| moving average | green |
| halfway to max | light blue |
| max | deep blue |

Colours blend linearly between these stops. The moving average leaves out stops, so waiting at lights does not drag the green point down. The legend under the map shows the trip's actual values.

### Filling GPS gaps along roads

After a trip, stretches without accurate fixes (at least 8 s and 120 m) are matched to the road network, so a tunnel is drawn through the tunnel and not straight through the mountain (`src/geo/gapFill.ts`). This runs on the phone and needs no server:
1. Download the OpenFreeMap vector tiles (zoom 14, the same tiles the map shows) in a strip along the gap; their `transportation` layer contains road geometry, one-way flags and a tunnel marker.
2. Build a small road graph and take the shortest drivable path between the last good fix before the gap and the first good fix after it. If a narrow 400 m strip has no connection, retry with a strip of 15% of the gap length.
3. Accept the path only if it is plausible:
   - not much longer than the straight line,
   - drivable in the time the gap lasted,
   - matching most of the coarse Wi-Fi/cell fixes recorded inside the gap.

Accepted paths are stored in `gap_fills`, used for the trip's distance and drawn dashed on the trip map. Gaps without a matching road are drawn as a dotted grey line.
If the phone is offline when a trip ends, the check runs again when the trip is opened.

## Screens

| Tab | What it does |
| --- | --- |
| **Map** | Heading-up map following your position, **Record / Stop** button, current speed, distance, elapsed time, GPS accuracy and satellites |
| **Trips** | Saved trips. Tap one for its details (route coloured by speed relative to that trip, stats); long-press to delete |
| **Logs** | Raw GPS fixes as they arrive: position, speed, accuracy, satellites used/in view and provider. Rows shaded red are too inaccurate (> 25 m) and are left out of the route and statistics |

## Development environment (Windows)

1. **Node.js 22 LTS** (≥ 22.13, required by Expo CLI).
2. **JDK 17** (Microsoft OpenJDK 17 or Eclipse Temurin 17). Set `JAVA_HOME` to it and put `%JAVA_HOME%\bin` first in `PATH`.
3. **Android Studio**. In SDK Manager, install:
   - an Android SDK Platform (latest stable + API 35)
   - SDK Build-Tools, Platform-Tools, Command-line Tools
   - NDK (Side by side), CMake, Google USB Driver
4. Set `ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk` and add `%ANDROID_HOME%\platform-tools` to `PATH`.
5. Enable Windows long paths (`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`).
   The app build uses CMake 3.31.6, pinned by `plugins/withAndroidCmakeVersion.js`, because the default CMake 3.22.1 ships a ninja that fails on paths longer than 260 characters. Gradle downloads it automatically.
6. On the phone, turn on Developer options and USB debugging. Connect it and check that `adb devices` lists it.

## Run

```bash
npm install
npm run android      # builds the dev client and installs it on the connected phone
```

After the first native build, a JS-only change only needs `npx expo start`. The installed TAB dev client reconnects to it.
Rebuild with `npm run android` whenever you add a native dependency or change `app.json`.

To test away from the PC, install a standalone release build. It has the JS bundle inside, so it doesn't need Metro:

```bash
npx expo run:android --variant release
```

## Project layout

```
app/                      expo-router screens (tabs: Map, Trips, Logs; trip/[id] detail)
src/db/database.ts        SQLite schema and queries (journeys, gps_samples)
modules/tab-gps/          native module: fused location, satellite status, recording foreground service
src/recording/            recording state shared across tabs
src/geo/stats.ts          distance, filtering and speed statistics
src/geo/gapFill.ts        filling GPS gaps along roads after a trip
src/components/           map and UI components
```

Each GPS sample is written to SQLite as soon as it arrives. If the app is killed mid-trip, the trip is closed from its saved samples the next time the app starts.
Map tiles: [OpenFreeMap](https://openfreemap.org) (© OpenStreetMap contributors).
