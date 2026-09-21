import { useEffect } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { registerDomain } from './bridge';
import { TEXT } from './theme';
import { TONE_BG, TONE_BORDER, TONE_TEXT } from './tone';

export type ScreenshotItem = {
  deviceId: string;
  fileUri: string;
  capturedAtMs: number;
};

type ScreenshotsState = {
  items: ScreenshotItem[];
  toastSeq: number;
  viewerUri: string | null;
};

const empty: ScreenshotsState = { items: [], toastSeq: 0, viewerUri: null };

export const useScreenshotsStore = create<ScreenshotsState>(() => ({ ...empty }));

export function registerScreenshotsDomain(): void {
  registerDomain({
    name: 'screenshots',
    apply: event => {
      if (event.type !== 'screenshotReceived') return;
      const item: ScreenshotItem = {
        deviceId: event.deviceId,
        fileUri: event.fileUri,
        capturedAtMs: event.capturedAtMs,
      };
      useScreenshotsStore.setState(s => ({
        items: [item, ...s.items].slice(0, 50),
        toastSeq: s.toastSeq + 1,
      }));
    },
    reconcile: () => {},
  });
}

export function dismissScreenshotToast(): void {
  useScreenshotsStore.setState({ toastSeq: 0 });
}

export function openScreenshotViewer(fileUri: string): void {
  useScreenshotsStore.setState({ viewerUri: fileUri, toastSeq: 0 });
}

export function closeScreenshotViewer(): void {
  useScreenshotsStore.setState({ viewerUri: null });
}

export function useScreenshots<T>(selector: (state: ScreenshotsState) => T): T {
  return useScreenshotsStore(useShallow(selector));
}

const TOAST_MS = 6000;

export function ScreenshotToast() {
  const toastSeq = useScreenshots(s => s.toastSeq);
  const latest = useScreenshots(s => s.items[0] ?? null);
  useEffect(() => {
    if (toastSeq === 0) return;
    const timer = setTimeout(dismissScreenshotToast, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toastSeq]);
  if (toastSeq === 0 || latest == null) return null;
  return (
    <View className="absolute inset-x-4 top-14 z-50">
      <Pressable
        onPress={() => openScreenshotViewer(latest.fileUri)}
        className={`rounded-xl border px-3 py-2 ${TONE_BORDER.accent} ${TONE_BG.accent}`}
      >
        <Text
          className={`font-mono uppercase ${TONE_TEXT.accent}`}
          style={TEXT.eyebrow}
          numberOfLines={1}
        >
          screenshot captured
        </Text>
        <Text
          className={`mt-0.5 font-mono ${TONE_TEXT.accent}`}
          style={TEXT.hint}
          numberOfLines={1}
        >
          tap to view
        </Text>
      </Pressable>
    </View>
  );
}

export function ScreenshotViewer() {
  const viewerUri = useScreenshots(s => s.viewerUri);
  if (viewerUri == null) return null;
  return (
    <View className="absolute inset-0 z-50 items-center justify-center bg-black/90">
      <Pressable
        onPress={closeScreenshotViewer}
        className="absolute inset-0"
        accessibilityLabel="close screenshot viewer"
      />
      <Image
        source={{ uri: viewerUri }}
        className="h-3/4 w-full"
        resizeMode="contain"
      />
      <Pressable onPress={closeScreenshotViewer} className="mt-4 px-4 py-2">
        <Text className="font-mono uppercase text-white" style={TEXT.eyebrow}>
          close
        </Text>
      </Pressable>
    </View>
  );
}
