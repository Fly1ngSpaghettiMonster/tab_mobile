import { requireNativeModule, type EventSubscription } from 'expo';

/** One fix from Google's fused location provider, with the GNSS satellite status at that moment. */
export type GpsFix = {
  provider: string;
  timestamp: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  speed: number | null;
  speedAccuracy: number | null;
  bearing: number | null;
  bearingAccuracy: number | null;
  satellitesUsed: number;
  satellitesInView: number;
  mocked: boolean;
};

export type GnssStatus = { satellitesUsed: number; satellitesInView: number };

type TabGpsEvents = {
  onLocation: (fix: GpsFix) => void;
  onGnssStatus: (status: GnssStatus) => void;
};

type TabGpsNativeModule = {
  isLocationEnabled(): boolean;
  startUpdates(intervalMs: number): Promise<void>;
  /** Shows Android's dialog if high-accuracy location is off; resolves true when it was already on. */
  ensureLocationSettings(intervalMs: number): Promise<boolean>;
  stopUpdates(): Promise<void>;
  startForegroundService(title: string, body: string): Promise<void>;
  stopForegroundService(): Promise<void>;
  addListener<E extends keyof TabGpsEvents>(event: E, listener: TabGpsEvents[E]): EventSubscription;
};

const TabGps = requireNativeModule<TabGpsNativeModule>('TabGps');

export default TabGps;
