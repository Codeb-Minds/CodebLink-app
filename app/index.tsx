import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView, AppState, Platform, NativeModules, Modal, ToastAndroid, PermissionsAndroid } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

// Native background service bridge (only available in a native/dev build, not Expo Go)
const { ClipboardSync: ClipboardSyncBg } = NativeModules;
import { SafeAreaView } from 'react-native-safe-area-context';
import io, { Socket } from 'socket.io-client';
import * as Clipboard from 'expo-clipboard';
import { useKeepAwake } from 'expo-keep-awake';
import CryptoJS from 'crypto-js';
import Svg, { Path, Circle, Line } from 'react-native-svg';

// React Native's JS runtime does not provide crypto.getRandomValues, so CryptoJS
// fails when generating a random salt for AES.  Patch WordArray.random to use
// Math.random — the salt randomness doesn't affect security here because we use
// a pre-shared key on a private LAN, not a dictionary password.
(CryptoJS.lib.WordArray as any).random = (nBytes: number) => {
  const words: number[] = [];
  for (let i = 0; i < Math.ceil(nBytes / 4); i++) {
    words.push(((Math.random() * 0x100000000) | 0) >>> 0);
  }
  return CryptoJS.lib.WordArray.create(words, nBytes);
};

const isValidIpv4 = (value: string) => {
  const candidate = value.trim();
  return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(candidate);
};

type SharedPayload = {
  kind: 'text' | 'file';
  text?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
};

type IncomingFilePayload = {
  name: string;
  type?: string;
  data?: string;  // base64 (legacy)
  url?: string;   // HTTP download URL (large files)
};

type OutboundFilePayload = {
  name: string;
  type: string;
  data: string;
};

const keyFingerprint = (key: string) => CryptoJS.MD5(key).toString().slice(0, 8);

export default function HomeScreen() {
  useKeepAwake(); 
  const [ip, setIp] = useState('192.168.29.51');
  const [syncKey, setSyncKey] = useState('CodebLink-Default-Key');
  const [showKey, setShowKey] = useState(false);
  const [connected, setConnected] = useState(false);
  const [clipboardText, setClipboardText] = useState('Waiting...');
  const [accessibilityEnabled, setAccessibilityEnabled] = useState(false);
  const [batteryOptimized, setBatteryOptimized] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  
  const socketRef = useRef<Socket | null>(null);
  const lastClipboardText = useRef('');
  const syncKeyRef = useRef(syncKey);
  const ipRef = useRef(ip);
  const appStateRef = useRef(AppState.currentState);
  const hasConnectedRef = useRef(false);
  const ignoreClipboardEventsUntilRef = useRef(0);
  const pendingShareRef = useRef<SharedPayload | null>(null);

  useEffect(() => {
    syncKeyRef.current = syncKey;
  }, [syncKey]);

  useEffect(() => {
    ipRef.current = ip;
  }, [ip]);

  const syncClipboard = useCallback(async (source: 'poll' | 'event' | 'resume' | 'manual' = 'poll') => {
    if (source !== 'manual' && appStateRef.current !== 'active') return;

    try {
      if (source !== 'manual') {
        const hasText = await Clipboard.hasStringAsync();
        if (!hasText) return;
      }

      let text = '';
      if (source === 'manual') {
        try {
          text = (await ClipboardSyncBg?.readClipboard()) ?? '';
        } catch (nativeErr) {
          text = await Clipboard.getStringAsync();
        }
      } else {
        text = await Clipboard.getStringAsync();
      }

      if (!text) return;
      if (source !== 'manual' && text === lastClipboardText.current) return;

      lastClipboardText.current = text;
      setClipboardText(text);

      if (socketRef.current?.connected) {
        const encrypted = CryptoJS.AES.encrypt(text, syncKeyRef.current).toString();
        socketRef.current.emit('clipboard-update', encrypted);
        if (Platform.OS === 'android') {
          ToastAndroid.show('Clipboard synced to PC!', ToastAndroid.SHORT);
        }
      }
    } catch (err) {
      console.warn('Clipboard sync failed:', err);
    }
  }, []);

  const connectToServer = useCallback((forceReconnect = false, reason: 'manual' | 'auto' | 'resume' = 'manual') => {
    const serverIp = ipRef.current.trim();
    if (!isValidIpv4(serverIp)) return;

    const existingSocket = socketRef.current;
    if (existingSocket) {
      if (forceReconnect) {
        existingSocket.removeAllListeners();
        existingSocket.disconnect();
        socketRef.current = null;
      } else {
        if (!existingSocket.connected) {
          existingSocket.connect();
        }
        return;
      }
    }

    if (reason === 'manual') {
      hasConnectedRef.current = true;
    }

    const socket = io(`http://${serverIp}:4321`, {
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 10000,
    });

    socket.on('connect', () => {
      setConnected(true);
      socket.timeout(8000).emit(
        'sync-key',
        syncKeyRef.current,
        (err: unknown, response?: { ok?: boolean; keyId?: string }) => {
          if (err || !response?.ok) return;
        }
      );
      // Persist IP+key so the Accessibility Service can sync without the app open
      try { 
        ClipboardSyncBg?.saveConfig(serverIp, syncKeyRef.current); 
      } catch (e) { }

      // Start native foreground service as secondary keep-alive
      try {
        if (ClipboardSyncBg) {
          ClipboardSyncBg.startService(serverIp, syncKeyRef.current);
        }
      } catch (e) { }

      // Check if Accessibility Service (true background sync) is enabled
      ClipboardSyncBg?.isAccessibilityServiceEnabled?.()
        .then((enabled: boolean) => {
          setAccessibilityEnabled(enabled);
        })
        .catch(() => {});
      flushPendingShare();
    });

    socket.on('connect_error', (err) => console.warn(`Connection error: ${err.message}`));

    socket.on('disconnect', (reasonText) => {
      setConnected(false);
    });

    socket.on('clipboard-received', async (encryptedData: string) => {
      try {
        const bytes = CryptoJS.AES.decrypt(encryptedData, syncKeyRef.current);
        const text = bytes.toString(CryptoJS.enc.Utf8);

        if (text && text !== lastClipboardText.current) {
          ignoreClipboardEventsUntilRef.current = Date.now() + 2000;
          lastClipboardText.current = text;
          setClipboardText(text);
          await Clipboard.setStringAsync(text);
        }
      } catch (e) { }
    });

    socket.on('file-to-phone', async (fileData: IncomingFilePayload) => {
      try {
        const targetName = fileData.name || `codeb_${Date.now()}`;
        const mime = fileData.type || 'application/octet-stream';
        if (fileData.url) {
          // Streaming download: no base64 buffering, phone fetches directly from PC
          await ClipboardSyncBg?.downloadFileFromUrl?.(fileData.url, targetName, mime);
        } else if (fileData.data) {
          await ClipboardSyncBg?.saveIncomingFileToDownloads?.(targetName, mime, fileData.data);
        } else {
          throw new Error('No file data or URL provided');
        }
        socket.emit('file-delivered-phone', { name: targetName, ok: true });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        socket.emit('file-delivered-phone', { name: fileData?.name || 'unknown', ok: false, error: detail.slice(0, 120) });
      }
    });

    socketRef.current = socket;
  }, []);

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (!isScanning) return;
    
    try {
      // New format: IP:192.168.x.x|KEY:yourkey
      if (data.includes('IP:') && data.includes('KEY:')) {
        setIsScanning(false);
        const parts = data.split('|');
        const scIp = parts.find(p => p.startsWith('IP:'))?.split('IP:')[1];
        const scKey = parts.find(p => p.startsWith('KEY:'))?.split('KEY:')[1];
        
        if (scIp && isValidIpv4(scIp)) {
          setIp(scIp);
          ipRef.current = scIp;
          if (scKey) {
            setSyncKey(scKey);
            syncKeyRef.current = scKey;
          }
          // Give UI time to update before connecting
          setTimeout(() => connectToServer(true, 'manual'), 500);
        }
      }
    } catch (e) { }
  };

  const startScan = async () => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) return;
    }
    setIsScanning(true);
  };

  const sendTextToPC = useCallback((text: string, fromShare = false) => {
    if (!text.trim()) return;
    if (socketRef.current?.connected) {
      const encrypted = CryptoJS.AES.encrypt(text, syncKeyRef.current).toString();
      socketRef.current.emit('clipboard-update', encrypted);
    }
  }, []);

  const emitFileToPcWithAck = useCallback((payload: OutboundFilePayload): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        resolve(false);
        return;
      }
      socket.timeout(15000).emit('file-received', payload, (err: unknown, response?: { ok?: boolean }) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(Boolean(response?.ok));
      });
    });
  }, []);

  const sendFileToPC = useCallback(async (fileUri: string, fileName?: string, mimeType?: string): Promise<boolean> => {
    if (!socketRef.current?.connected) return false;
    const resolvedName = fileName || fileUri.split('/').pop() || `shared_${Date.now()}`;
    try {
      const base64Data = await ClipboardSyncBg?.readUriAsBase64?.(fileUri);
      if (!base64Data) throw new Error('Unable to read shared file');

      const payload: OutboundFilePayload = {
        name: resolvedName,
        type: mimeType || 'application/octet-stream',
        data: base64Data,
      };

      const delivered = await emitFileToPcWithAck(payload);
      ClipboardSyncBg?.notifyUploadDone?.(resolvedName, delivered);
      return delivered;
    } catch (err) {
      ClipboardSyncBg?.notifyUploadDone?.(resolvedName, false);
      return false;
    }
  }, [emitFileToPcWithAck]);

  const flushPendingShare = useCallback(async () => {
    const payload = pendingShareRef.current;
    if (!payload || !socketRef.current?.connected) return;
    if (payload.kind === 'text') {
      sendTextToPC(payload.text || '', true);
      pendingShareRef.current = null;
      return;
    }
    if (payload.uri) {
      const sent = await sendFileToPC(payload.uri, payload.name, payload.mimeType);
      if (sent) pendingShareRef.current = null;
    }
  }, [sendFileToPC, sendTextToPC]);



  const checkPermissions = useCallback(async () => {
    try {
      const acc = await ClipboardSyncBg?.isAccessibilityServiceEnabled();
      setAccessibilityEnabled(!!acc);
      
      const batt = await ClipboardSyncBg?.isBatteryOptimizationIgnored();
      setBatteryOptimized(!batt); // If NOT ignored, it IS optimized (bad for us)

      // Android 13+ requires POST_NOTIFICATIONS runtime permission
      if (Number(Platform.Version) >= 33) {
        const granted = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
        );
        setNotificationsEnabled(granted);
      } else {
        // Older Android: check via notification manager (channel could be disabled)
        const enabled = await ClipboardSyncBg?.isNotificationsEnabled?.();
        setNotificationsEnabled(enabled !== false);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    checkPermissions();
    const interval = setInterval(checkPermissions, 5000);
    return () => clearInterval(interval);
  }, [checkPermissions]);

  const hydrateSavedConfig = useCallback(async () => {
    try {
      const cfg = await ClipboardSyncBg?.getSavedConfig?.();
      const savedIp = (cfg?.ip || '').trim();
      const savedKey = cfg?.key || '';
      if (savedIp) {
        ipRef.current = savedIp;
        setIp(savedIp);
      }
      if (savedKey) {
        syncKeyRef.current = savedKey;
        setSyncKey(savedKey);
      }
      return { savedIp, savedKey };
    } catch {
      return { savedIp: '', savedKey: '' };
    }
  }, []);

  const consumeSharePayload = useCallback(async () => {
    try {
      const payload: SharedPayload | null = await ClipboardSyncBg?.consumeSharePayload?.();
      if (!payload) return;
      pendingShareRef.current = payload;
      if (!socketRef.current?.connected) {
        const { savedIp } = await hydrateSavedConfig();
        if (isValidIpv4(savedIp)) {
          connectToServer(false, 'auto');
          return;
        }
        return;
      }
      await flushPendingShare();
    } catch (e) { }
  }, [connectToServer, flushPendingShare, hydrateSavedConfig]);

  useEffect(() => {
    hydrateSavedConfig().then(({ savedIp }) => {
      if (isValidIpv4(savedIp)) connectToServer(false, 'auto');
    });
    consumeSharePayload();
  }, [connectToServer, consumeSharePayload, hydrateSavedConfig]);

  useEffect(() => {
    ignoreClipboardEventsUntilRef.current = Date.now() + 1200;
    const clipboardSubscription = Clipboard.addClipboardListener(() => {
      if (Date.now() < ignoreClipboardEventsUntilRef.current) return;
      // Use socketRef directly — React state 'connected' can lag behind actual socket state
      if (socketRef.current?.connected) syncClipboard('event');
    });
    const subscription = AppState.addEventListener('change', nextAppState => {
      appStateRef.current = nextAppState;
      if (nextAppState === 'active') {
        ignoreClipboardEventsUntilRef.current = Date.now() + 1200;
        consumeSharePayload();
        if (hasConnectedRef.current) {
          connectToServer(false, 'resume');
          // Catch any text copied while the app was backgrounded
          setTimeout(() => syncClipboard('resume'), 800);
        }
      }
    });
    return () => {
      subscription.remove();
      clipboardSubscription.remove();
    };
  }, [connected, connectToServer, consumeSharePayload, syncClipboard]);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Codeb Link</Text>
          <Text style={{ color: '#0070f3', fontSize: 12, fontWeight: 'bold' }}>SECURE P2P</Text>
        </View>
        <View style={[styles.statusDot, connected ? styles.connected : styles.disconnected]} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
        <View style={styles.card}>
          <Text style={styles.label}>Connection</Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: '#0070f3', marginBottom: 15 }]} onPress={startScan}>
            <Text style={styles.buttonText}>Scan QR to Connect</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={ip}
            onChangeText={setIp}
            placeholder="PC IP Address"
            placeholderTextColor="#64748b"
            keyboardType="numeric"
          />
          <TouchableOpacity style={styles.button} onPress={() => connectToServer(true, 'manual')}>
            <Text style={styles.buttonText}>{connected ? 'Reconnect' : 'Manual Connect'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Security Config</Text>
          <View style={{ position: 'relative', marginBottom: 15 }}>
            <TextInput
              style={[styles.input, { paddingRight: 50, marginBottom: 0 }]}
              value={syncKey}
              onChangeText={setSyncKey}
              placeholder="Enter secret key..."
              placeholderTextColor="#64748b"
              secureTextEntry={!showKey}
            />
            <TouchableOpacity 
              onPress={() => setShowKey(!showKey)}
              style={{
                position: 'absolute',
                right: 0,
                top: 0,
                bottom: 0,
                width: 50,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              {showKey ? (
                <Svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                  <Path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                  <Path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                  <Line x1="2" x2="22" y1="2" y2="22" />
                </Svg>
              ) : (
                <Svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                  <Circle cx="12" cy="12" r="3" />
                </Svg>
              )}
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Clipboard Status</Text>
          <View style={styles.clipboardBox}>
            <Text style={styles.clipboardText} numberOfLines={3}>
              {clipboardText}
            </Text>
          </View>
          <TouchableOpacity style={[styles.button, styles.accentBtn]} onPress={() => syncClipboard('manual')}>
            <Text style={styles.buttonText}>Force Manual Sync</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* SETUP MODAL: ASKS FOR PERMISSIONS ON THE SPOT */}
      <Modal visible={!accessibilityEnabled || batteryOptimized || !notificationsEnabled} animationType="fade" transparent={true}>
        <View style={styles.modalBlur}>
          <View style={styles.setupCard}>
            <Text style={styles.setupTitle}>Finalizing Setup</Text>
            <Text style={styles.setupDesc}>
              To sync your clipboard in the background, Codeb Link needs a few critical permissions:
            </Text>

            {!accessibilityEnabled && (
              <TouchableOpacity style={styles.setupAction} onPress={() => ClipboardSyncBg?.openAccessibilitySettings()}>
                <View>
                  <Text style={styles.actionTitle}>1. Accessibility Service</Text>
                  <Text style={styles.actionDesc}>Allows background clipboard reading.</Text>
                </View>
                <Text style={styles.actionArrow}>→</Text>
              </TouchableOpacity>
            )}

            {batteryOptimized && (
              <TouchableOpacity style={styles.setupAction} onPress={() => ClipboardSyncBg?.requestIgnoreBatteryOptimization()}>
                <View>
                  <Text style={styles.actionTitle}>2. Battery Unrestricted</Text>
                  <Text style={styles.actionDesc}>Prevents the app from being killed.</Text>
                </View>
                <Text style={styles.actionArrow}>→</Text>
              </TouchableOpacity>
            )}

            {!notificationsEnabled && (
              <TouchableOpacity
                style={styles.setupAction}
                onPress={async () => {
                  if (Number(Platform.Version) >= 33) {
                    await PermissionsAndroid.request(
                      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
                    );
                  } else {
                    ClipboardSyncBg?.requestNotificationPermission?.();
                  }
                  checkPermissions();
                }}
              >
                <View>
                  <Text style={styles.actionTitle}>3. Allow Notifications</Text>
                  <Text style={styles.actionDesc}>Needed for clipboard sync alerts.</Text>
                </View>
                <Text style={styles.actionArrow}>→</Text>
              </TouchableOpacity>
            )}

            <Text style={styles.setupFooter}>The app will start syncing as soon as these are green.</Text>
          </View>
        </View>
      </Modal>

      <Modal visible={isScanning} animationType="slide">
        <CameraView
          style={StyleSheet.absoluteFillObject}
          onBarcodeScanned={handleBarCodeScanned}
          barcodeScannerSettings={{
            barcodeTypes: ["qr"],
          }}
        />
        <View style={styles.scanOverlay}>
          <View style={styles.scanTarget} />
          <TouchableOpacity style={styles.cancelButton} onPress={() => setIsScanning(false)}>
            <Text style={styles.cancelText}>Cancel Scan</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: '#fff',
  },
  statusDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  connected: {
    backgroundColor: '#22c55e',
    shadowColor: '#22c55e',
    shadowRadius: 10,
    elevation: 10,
  },
  disconnected: {
    backgroundColor: '#ef4444',
  },
  card: {
    backgroundColor: '#111',
    borderRadius: 24,
    padding: 20,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: '#222',
  },
  label: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 10,
  },
  input: {
    backgroundColor: '#000',
    color: '#fff',
    borderRadius: 16,
    padding: 15,
    fontSize: 16,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: '#222',
  },
  button: {
    backgroundColor: '#222',
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  accentBtn: {
    backgroundColor: '#0070f3',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  checkItem: {
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 10,
  },
  checkSuccess: {
    borderColor: '#22c55e',
    backgroundColor: '#064e3b',
  },
  checkText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  clipboardBox: {
    backgroundColor: '#000',
    borderRadius: 16,
    padding: 15,
    marginBottom: 15,
    minHeight: 80,
    borderWidth: 1,
    borderColor: '#222',
  },
  clipboardText: {
    color: '#fff',
    fontSize: 15,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  logs: {
    backgroundColor: '#000',
    borderRadius: 12,
    padding: 10,
  },
  logText: {
    color: '#71717a',
    marginBottom: 4,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  scanOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanTarget: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: '#0070f3',
    borderRadius: 20,
    backgroundColor: 'transparent',
  },
  cancelButton: {
    marginTop: 40,
    backgroundColor: '#fff',
    padding: 15,
    borderRadius: 30,
  },
  cancelText: {
    color: '#000',
    fontWeight: 'bold',
  },
  modalBlur: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    padding: 20,
  },
  setupCard: {
    backgroundColor: '#111',
    borderRadius: 32,
    padding: 30,
    borderWidth: 1,
    borderColor: '#333',
  },
  setupTitle: {
    fontSize: 26,
    fontWeight: '900',
    color: '#fff',
    marginBottom: 10,
    textAlign: 'center',
  },
  setupDesc: {
    fontSize: 16,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 30,
    lineHeight: 22,
  },
  setupAction: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#0070f3',
    padding: 20,
    borderRadius: 20,
    marginBottom: 15,
  },
  actionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fff',
  },
  actionDesc: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 2,
  },
  actionArrow: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '900',
  },
  setupFooter: {
    fontSize: 12,
    color: '#475569',
    textAlign: 'center',
    marginTop: 15,
  },
});
