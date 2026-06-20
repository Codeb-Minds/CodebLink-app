import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

export default function Layout() {
  useEffect(() => {
    // Hide splash screen after a short delay to ensure everything is rendered
    SplashScreen.hideAsync();
  }, []);

  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#111214' } }} />
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}

