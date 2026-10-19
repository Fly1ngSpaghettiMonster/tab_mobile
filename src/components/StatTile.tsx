import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

type Props = { label: string; value: string; unit?: string; compact?: boolean };

export function StatTile({ label, value, unit, compact }: Props) {
  return (
    <View style={[styles.tile, compact && styles.compact]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, compact && styles.valueCompact]}>
        {value}
        {unit ? <Text style={styles.unit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  compact: { flexBasis: 0, paddingVertical: 6, paddingHorizontal: 8 },
  label: { color: colors.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { color: colors.primary, fontSize: 22, fontWeight: '700', marginTop: 2 },
  valueCompact: { fontSize: 18 },
  unit: { color: colors.textMuted, fontSize: 13, fontWeight: '400' },
});
