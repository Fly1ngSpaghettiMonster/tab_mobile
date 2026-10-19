import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { SymbolView, type AndroidSymbol } from 'expo-symbols';

import { colors } from '@/src/theme';

function icon(name: AndroidSymbol) {
  return ({ color }: { color: ColorValue }) => (
    <SymbolView name={{ ios: 'circle', android: name, web: name }} tintColor={color} size={26} />
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.onPrimary,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
      }}>
      <Tabs.Screen name="index" options={{ title: 'Map', tabBarIcon: icon('map') }} />
      <Tabs.Screen name="trips" options={{ title: 'Trips', tabBarIcon: icon('route') }} />
      <Tabs.Screen name="logs" options={{ title: 'Logs', tabBarIcon: icon('terminal') }} />
    </Tabs>
  );
}
