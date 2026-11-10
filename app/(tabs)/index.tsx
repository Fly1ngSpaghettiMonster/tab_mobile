import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { StatTile } from '@/src/components/StatTile';
import { TripMap } from '@/src/components/TripMap';
import { formatDuration, km, kmh } from '@/src/geo/stats';
import { fixSource, useRecording } from '@/src/recording/RecordingContext';
import type { ShareState } from '@/src/share/ShareClient';
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
        position={rec.position ? { ...rec.position, bearing: rec.bearing } : null}
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
        {rec.isRecording && (
          <SharePanel share={rec.share} onStart={rec.startSharing} onStop={rec.stopSharing} />
        )}
      </View>
    </View>
  );
}

const SHARE_STATUS_TEXT: Record<ShareState['status'], string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Offline, reconnecting…',
  closed: 'Closed',
};

function SharePanel({
  share,
  onStart,
  onStop,
}: {
  share: ShareState | null;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      Alert.alert('Sharing', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendLink = (url: string) =>
    Share.share({ message: `Follow my trip live: ${url}` }).catch((e) => console.warn('Share sheet failed', e));

  const confirmStop = () =>
    Alert.alert('Stop sharing?', 'The link stops working for everyone. Recording continues.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop sharing', style: 'destructive', onPress: () => run(onStop) },
    ]);

  if (!share) {
    return (
      <Pressable style={[styles.shareButton, styles.shareStart]} onPress={() => run(onStart)} disabled={busy}>
        {busy ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.shareStartText}>Share live</Text>}
      </Pressable>
    );
  }

  const pending = share.pending > 1 ? ` · ${share.pending} samples waiting` : '';
  return (
    <View style={styles.shareBox}>
      <Text style={styles.gpsInfo}>
        Sharing: {SHARE_STATUS_TEXT[share.status]}
        {pending}
      </Text>
      <View style={styles.shareRow}>
        <Pressable style={[styles.shareButton, styles.shareStart, styles.flex]} onPress={() => sendLink(share.viewerUrl)}>
          <Text style={styles.shareStartText}>Send link</Text>
        </Pressable>
        <Pressable style={[styles.shareButton, styles.shareStop, styles.flex]} onPress={confirmStop} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.danger} /> : <Text style={styles.shareStopText}>Stop sharing</Text>}
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
  shareBox: { gap: 6 },
  shareRow: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  shareButton: { borderRadius: 12, paddingVertical: 10, alignItems: 'center', borderWidth: 2 },
  shareStart: { borderColor: colors.accent },
  shareStartText: { color: colors.accent, fontSize: 15, fontWeight: '700' },
  shareStop: { borderColor: colors.danger },
  shareStopText: { color: colors.danger, fontSize: 15, fontWeight: '700' },
});
