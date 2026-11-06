import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { kmh } from '@/src/geo/stats';
import { LOCATION_SOURCE, useRecording, type LogEntry } from '@/src/recording/RecordingContext';
import { colors } from '@/src/theme';

const mono = Platform.select({ android: 'monospace', default: undefined });

export default function LogsScreen() {
  const rec = useRecording();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.status}>
            {rec.isRecording ? `● Recording trip #${rec.journeyId} · ${rec.samples.length} saved` : 'Not recording'}
          </Text>
          <Text style={styles.source}>
            Source: {LOCATION_SOURCE} · now {rec.satellites.used}/{rec.satellites.inView} satellites used/in
            view · src: gnss = satellite fix, net = Wi-Fi/cell
          </Text>
        </View>
        <Pressable onPress={rec.clearLog}>
          <Text style={styles.clear}>Clear</Text>
        </Pressable>
      </View>
      <View style={[styles.line, styles.columns]}>
        <Text style={[styles.cell, styles.colHeader, styles.wTime]}>time</Text>
        <Text style={[styles.cell, styles.colHeader, styles.wCoord]}>lat</Text>
        <Text style={[styles.cell, styles.colHeader, styles.wCoord]}>lon</Text>
        <Text style={[styles.cell, styles.colHeader, styles.wNum]}>km/h</Text>
        <Text style={[styles.cell, styles.colHeader, styles.wNum]}>±m</Text>
        <Text style={[styles.cell, styles.colHeader, styles.wSat]}>sat</Text>
        <Text style={[styles.cell, styles.colHeader, styles.wSrc]}>src</Text>
        <Text style={[styles.cell, styles.colHeader, styles.wSeq]}>#</Text>
      </View>
      <FlatList
        data={rec.log}
        keyExtractor={(e) => String(e.key)}
        renderItem={({ item }) => <LogLine entry={item} />}
        ListEmptyComponent={<Text style={styles.empty}>Waiting for GPS fixes…</Text>}
      />
    </View>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const time = new Date(entry.timestampUtc).toLocaleTimeString(undefined, { hour12: false });
  return (
    <View style={[styles.line, !entry.accepted && styles.rejected]}>
      <Text style={[styles.cell, styles.wTime]}>{time}</Text>
      <Text style={[styles.cell, styles.wCoord]}>{entry.latitude.toFixed(5)}</Text>
      <Text style={[styles.cell, styles.wCoord]}>{entry.longitude.toFixed(5)}</Text>
      <Text style={[styles.cell, styles.wNum]}>{kmh(entry.speedMps)}</Text>
      <Text style={[styles.cell, styles.wNum]}>{entry.accuracyMeters?.toFixed(0) ?? '–'}</Text>
      <Text style={[styles.cell, styles.wSat]}>
        {entry.satellitesUsed}/{entry.satellitesInView}
      </Text>
      <Text style={[styles.cell, styles.wSrc, entry.source === 'net' && styles.net]}>{entry.source}</Text>
      <Text style={[styles.cell, styles.wSeq]}>{entry.sequence ?? ''}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 12,
    gap: 12,
    backgroundColor: colors.surface,
  },
  headerText: { flex: 1, gap: 2 },
  status: { color: colors.primary, fontWeight: '600' },
  source: { color: colors.textMuted, fontSize: 12 },
  clear: { color: colors.accent, fontWeight: '600' },
  columns: { backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  line: { flexDirection: 'row', paddingHorizontal: 6, paddingVertical: 3 },
  rejected: { backgroundColor: '#fdecea' },
  cell: { fontFamily: mono, fontSize: 10, color: colors.text },
  colHeader: { color: colors.textMuted, fontWeight: '700' },
  wTime: { width: 52 },
  wCoord: { width: 60 },
  wNum: { width: 34, textAlign: 'right' },
  wSat: { width: 42, textAlign: 'right' },
  wSrc: { width: 30, textAlign: 'right' },
  net: { color: colors.danger },
  wSeq: { flex: 1, textAlign: 'right' },
  empty: { color: colors.textMuted, textAlign: 'center', padding: 24 },
});
