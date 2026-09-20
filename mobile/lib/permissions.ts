import { Linking, Platform } from 'react-native';
import { check, PERMISSIONS, request, RESULTS } from 'react-native-permissions';

export type PermissionState = 'granted' | 'denied' | 'blocked' | 'unavailable';

const LOCATION =
  Platform.OS === 'android'
    ? PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION
    : PERMISSIONS.IOS.LOCATION_WHEN_IN_USE;

const BLUETOOTH_CONNECT =
  Platform.OS === 'android' ? PERMISSIONS.ANDROID.BLUETOOTH_CONNECT : null;

const BLUETOOTH_SCAN =
  Platform.OS === 'android' ? PERMISSIONS.ANDROID.BLUETOOTH_SCAN : null;

const BACKGROUND_LOCATION =
  Platform.OS === 'android'
    ? PERMISSIONS.ANDROID.ACCESS_BACKGROUND_LOCATION
    : null;

export const LOCATION_PERMISSIONS = [
  PERMISSIONS.ANDROID.ACCESS_BACKGROUND_LOCATION,
  PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION,
  PERMISSIONS.ANDROID.ACCESS_COARSE_LOCATION,
];

function toState(result: string): PermissionState {
  if (result === RESULTS.GRANTED || result === RESULTS.LIMITED)
    return 'granted';
  if (result === RESULTS.BLOCKED) return 'blocked';
  if (result === RESULTS.UNAVAILABLE) return 'unavailable';
  return 'denied';
}

export async function locationStatus(): Promise<PermissionState> {
  return toState(await check(LOCATION));
}

export async function requestLocation(): Promise<PermissionState> {
  return toState(await request(LOCATION));
}

export async function backgroundLocationStatus(): Promise<PermissionState> {
  if (!BACKGROUND_LOCATION) return 'unavailable';
  return toState(await check(BACKGROUND_LOCATION));
}

export async function requestBackgroundLocation(): Promise<PermissionState> {
  if (!BACKGROUND_LOCATION) return 'unavailable';
  return toState(await request(BACKGROUND_LOCATION));
}

export async function bluetoothConnectStatus(): Promise<PermissionState> {
  if (!BLUETOOTH_CONNECT) return 'granted';
  return toState(await check(BLUETOOTH_CONNECT));
}

export async function requestBluetoothConnect(): Promise<PermissionState> {
  if (!BLUETOOTH_CONNECT) return 'granted';
  return toState(await request(BLUETOOTH_CONNECT));
}

export async function bluetoothScanStatus(): Promise<PermissionState> {
  if (!BLUETOOTH_SCAN) return 'granted';
  return toState(await check(BLUETOOTH_SCAN));
}

export async function requestBluetoothScan(): Promise<PermissionState> {
  if (!BLUETOOTH_SCAN) return 'granted';
  return toState(await request(BLUETOOTH_SCAN));
}

export function openAppSettings(): void {
  Linking.openSettings().catch(() => {});
}
