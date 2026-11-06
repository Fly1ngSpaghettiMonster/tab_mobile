import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { StatTile } from '@/src/components/StatTile';
import { TripMap } from '@/src/components/TripMap';
import { formatDuration, km, kmh } from '@/src/geo/stats';
import { fixSource, useRecording } from '@/src/recording/RecordingContext';
import { colors } from '@/src/theme';

export default function MapScreen() {
  const router = useRouter();
  const rec = useRecording();
  const [busy, setBusy] = useState(false);
  const elapsed = useElapsedSeconds(rec.startedAtMs);

  const onPress = async () => {
    setBusy(true);
    try {
      if (rec.isRecording) {
        const id = await rec.stop();
        if (id != null) router.push(`/trip/${id}`);
        else Alert.alert('Nothing recorded', 'No GPS samples were received during this recording.');
      } else {
        await rec.start();
      }
    } catch (e) {
      Alert.alert('Error', String(e));
    } finally {
      setBusy(false);
    }
  };

  if (rec.permission === 'denied') {
    return (
      <View style={styles.center}>
        <Text style={styles.message}>Location permission is required to show the map and record trips.</Text>
        <Pressable style={[styles.button, styles.record]} onPress={rec.requestPermission}>
          <Text style={styles.buttonText}>Grant permission</Text>
        </Pressable>
      </View>
    );
  }

  const fix = rec.lastFix;
  const currentSpeed = fix?.speed != null && fix.speed >= 0 ? fix.speed : null;
  const sats = `${rec.satellites.used}/${rec.satellites.inView} satellites`;
  const gpsInfo = !rec.gpsEnabled
    ? 'Location is turned off in system settings'
    : fix
      ? `${fixSource(fix.satellitesUsed) === 'gnss' ? 'GPS' : 'Wi-Fi/cell'} ±${fix.accuracy?.toFixed(0) ?? '?'} m · ${sats}${rec.isRecording ? ` · ${rec.samples.length} samples` : ''}`
      : `Waiting for GPS fix · ${sats} (go outside if this takes long)`;

  return (
    <View style={styles.container}>
      <TripMap
        samples={rec.samples}
        position={
          fix
            ? { latitude: fix.latitude, longitude: fix.longitude, accuracyMeters: fix.accuracy, bearing: rec.bearing }
            : null
        }
      />

      <View style={styles.panel}>
        <View style={styles.stats}>
          <StatTile compact label="Speed" value={kmh(currentSpeed)} unit="km/h" />
          <StatTile compact label="Distance" value={km(rec.liveStats.distanceMeters)} unit="km" />
          <StatTile compact label="Time" value={formatDuration(elapsed)} />
        </View>
        <Text style={styles.gpsInfo}>{gpsInfo}</Text>
        <Pressable
          style={[styles.button, rec.isRecording ? styles.stop : styles.record]}
          onPress={onPress}
          disabled={busy}>
          {busy ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.buttonText}>{rec.isRecording ? 'Stop' : 'Record'}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function useElapsedSeconds(startedAtMs: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (startedAtMs == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAtMs]);
  return startedAtMs == null ? 0 : Math.max(0, (now - startedAtMs) / 1000);
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  message: { textAlign: 'center', color: colors.text, fontSize: 16 },
  panel: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    backgroundColor: colors.background,
    borderRadius: 16,
    padding: 12,
    gap: 8,
    elevation: 6,
  },
  stats: { flexDirection: 'row', gap: 8 },
  gpsInfo: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  button: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', paddingHorizontal: 24 },
  record: { backgroundColor: colors.accent },
  stop: { backgroundColor: colors.danger },
  buttonText: { color: colors.onPrimary, fontSize: 18, fontWeight: '700', letterSpacing: 1 },
});
