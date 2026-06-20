import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView, AppState, Platform, NativeModules, Modal, ToastAndroid, PermissionsAndroid, BackHandler, DeviceEventEmitter, Image } from 'react-native';

// Native background service bridge (only available in a native/dev build, not Expo Go)
const { ClipboardSync: ClipboardSyncBg } = NativeModules;
import { SafeAreaView } from 'react-native-safe-area-context';
import io, { Socket } from 'socket.io-client';
import * as Clipboard from 'expo-clipboard';
import * as Device from 'expo-device';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import CryptoJS from 'crypto-js';
import Svg, { Path, Circle, Line, Rect } from 'react-native-svg';

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
const KEEP_AWAKE_TAG = 'codeblink-main';

export default function HomeScreen() {
  useEffect(() => {
    let active = true;

    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch((err) => {
      if (active) {
        console.warn('Keep awake unavailable:', err);
      }
    });

    return () => {
      active = false;
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => { });
    };
  }, []);

  const [ip, setIp] = useState('192.168.29.51');
  const [syncKey, setSyncKey] = useState('CodebLink-Default-Key');
  const [connected, setConnected] = useState(false);
  const [clipboardText, setClipboardText] = useState('Waiting...');
  const [accessibilityEnabled, setAccessibilityEnabled] = useState(false);
  const [batteryOptimized, setBatteryOptimized] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);


  const [consentAccepted, setConsentAccepted] = useState<boolean | null>(null);
  const [consentCheckbox, setConsentCheckbox] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(false);
  const [ghostServiceEnabled, setGhostServiceEnabled] = useState(true);
  const [showAccessibilityAlert, setShowAccessibilityAlert] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const [pcDiscoveryEnabled, setPcDiscoveryEnabled] = useState(true);
  const pcDiscoveryEnabledRef = useRef(true);


  const machineIdRef = useRef('');
  const deviceNameRef = useRef(Device.modelName || `Android-${Platform.OS}`);

  // Pairing modal — shown when Linux initiates pairing
  const [pairingModal, setPairingModal] = useState<{
    pairingCode: string;
    pcHostname: string;
    secretKey: string;
    pcMachineId: string;
  } | null>(null);

  const pairingModalRef = useRef(pairingModal);
  useEffect(() => {
    pairingModalRef.current = pairingModal;
  }, [pairingModal]);

  // Track paired state (so we can show Unpair button)
  const [pairedPcId, setPairedPcId] = useState('');
  const [pairedPcHostname, setPairedPcHostname] = useState('');
  const [socketConnected, setSocketConnected] = useState(false);
  const pairedPcIdRef = useRef('');
  useEffect(() => {
    pairedPcIdRef.current = pairedPcId;
  }, [pairedPcId]);

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
    if (!pairedPcIdRef.current) return;
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
      setSocketConnected(true);
      const isPaired = pairedPcIdRef.current !== '';

      if (isPaired) {
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

        // Start native foreground service as secondary keep-alive if enabled
        try {
          if (ClipboardSyncBg && ghostServiceEnabledRef.current) {
            ClipboardSyncBg.startService(serverIp, syncKeyRef.current);
          }
        } catch (e) { }
      }

      // Announce to Linux for discovery/pairing
      if (machineIdRef.current) {
        socket.emit('announce-device', {
          machineId: machineIdRef.current,
          hostname: deviceNameRef.current,
          device: 'android'
        });
      }

      // Check if Accessibility Service (true background sync) is enabled
      ClipboardSyncBg?.isAccessibilityServiceEnabled?.()
        .then((enabled: boolean) => {
          setAccessibilityEnabled(enabled);
        })
        .catch(() => { });
      flushPendingShare();
    });

    socket.on('connect_error', (err) => console.warn(`Connection error: ${err.message}`));

    socket.on('disconnect', (reasonText) => {
      setSocketConnected(false);
      setConnected(false);
    });

    // Linux initiates pairing — shows pairing code on Android
    socket.on('initiate-pairing', (data: { pairingCode: string; secretKey: string; pcHostname: string; pcMachineId: string }) => {
      setPairingModal(data);
    });

    // Linux accepted our pairing request (for future Android-initiated flows)
    socket.on('pairing-response', (data: { status: string; machineId?: string; hostname?: string }) => {
      if (data.status === 'accepted') {
        const pId = data.machineId || '';
        const pName = data.hostname || 'PC';
        setPairedPcId(pId);
        setPairedPcHostname(pName);
        ClipboardSyncBg?.saveSetting?.('paired_pc_id', pId);
        ClipboardSyncBg?.saveSetting?.('paired_pc_hostname', pName);

        // Save the secret key from the pairing modal!
        if (pairingModalRef.current?.secretKey) {
          const sKey = pairingModalRef.current.secretKey;
          setSyncKey(sKey);
          syncKeyRef.current = sKey;
          ClipboardSyncBg?.saveSetting?.('paired_pc_secret_key', sKey);
          ClipboardSyncBg?.saveConfig?.(ipRef.current, sKey);
        }

        setPairingModal(null);
        setConnected(true);
        hasConnectedRef.current = true;

        // Start native foreground service now that we are paired and connected
        try {
          ClipboardSyncBg?.getSetting?.('ghost_service_enabled', true)
            .then((val: boolean) => {
              if (val) ClipboardSyncBg?.startService(ipRef.current, syncKeyRef.current);
            })
            .catch(() => { });
        } catch (e) { }

        ToastAndroid.show('Paired with PC successfully!', ToastAndroid.SHORT);
      } else if (data.status === 'rejected') {
        setPairingModal(null);
        ToastAndroid.show('Pairing rejected by PC.', ToastAndroid.SHORT);
      }
    });

    // Server forces a manual disconnect
    socket.on('force-disconnect', () => {
      hasConnectedRef.current = false;
      try {
        ClipboardSyncBg?.stopService?.();
      } catch (e) { }
      socket.disconnect();
      setConnected(false);
      ToastAndroid.show('Disconnected by PC.', ToastAndroid.SHORT);
    });

    // Server tells us we've been unpaired
    socket.on('unpaired-by-peer', (data: { machineId: string }) => {
      setPairedPcId(prev => {
        if (prev === data.machineId || !data.machineId) {
          hasConnectedRef.current = false;
          setPairedPcHostname('');
          setSyncKey('CodebLink-Default-Key');
          syncKeyRef.current = 'CodebLink-Default-Key';
          ClipboardSyncBg?.saveSetting?.('paired_pc_id', '');
          ClipboardSyncBg?.saveSetting?.('paired_pc_hostname', '');
          ClipboardSyncBg?.saveSetting?.('paired_pc_secret_key', '');
          ClipboardSyncBg?.saveConfig?.(ipRef.current, 'CodebLink-Default-Key');
          try {
            ClipboardSyncBg?.stopService?.();
          } catch (e) { }
          socket.disconnect();
          setConnected(false);
          ToastAndroid.show('Unpaired and disconnected by PC.', ToastAndroid.SHORT);
          return '';
        }
        return prev;
      });
    });

    socket.on('clipboard-received', async (encryptedData: string) => {
      if (!pairedPcIdRef.current) return;
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
      if (!pairedPcIdRef.current) return;
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

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('onConnectCommand', (serverIp: string) => {
      console.log('Received UDP connect command for server IP:', serverIp);
      setIp(serverIp);
      ipRef.current = serverIp;
      connectToServer(false, 'auto');
    });
    return () => sub.remove();
  }, [connectToServer]);



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



  const ghostServiceEnabledRef = useRef(ghostServiceEnabled);
  useEffect(() => {
    ghostServiceEnabledRef.current = ghostServiceEnabled;
  }, [ghostServiceEnabled]);

  useEffect(() => {
    pcDiscoveryEnabledRef.current = pcDiscoveryEnabled;
  }, [pcDiscoveryEnabled]);



  // Load machineId from persistent storage on mount
  useEffect(() => {
    const loadMachineId = async () => {
      try {
        let stored = await ClipboardSyncBg?.getSetting?.('device_machine_id', '');
        if (!stored) {
          // Generate a new unique ID
          stored = 'android-' + Date.now() + '-' + Math.random().toString(36).slice(2);
          await ClipboardSyncBg?.saveSetting?.('device_machine_id', stored);
        }
        machineIdRef.current = stored;
      } catch (e) {
        machineIdRef.current = 'android-' + Date.now();
      }
    };
    loadMachineId();
  }, []);

  // Manage native UDP discovery state based on pcDiscoveryEnabled toggle
  useEffect(() => {
    if (pcDiscoveryEnabled) {
      ClipboardSyncBg?.startUdpDiscovery?.(deviceNameRef.current, machineIdRef.current);
    } else {
      ClipboardSyncBg?.stopUdpDiscovery?.();
    }
    return () => {
      ClipboardSyncBg?.stopUdpDiscovery?.();
    };
  }, [pcDiscoveryEnabled]);

  const togglePcDiscovery = async () => {
    const next = !pcDiscoveryEnabled;
    setPcDiscoveryEnabled(next);
    pcDiscoveryEnabledRef.current = next;
    await ClipboardSyncBg?.saveSetting?.('pc_discovery_enabled', next);

    if (next) {
      ToastAndroid.show('PC Discovery enabled. Discoverable to PC.', ToastAndroid.SHORT);
    } else {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      setConnected(false);
      ToastAndroid.show('PC Discovery disabled.', ToastAndroid.SHORT);
    }
  };

  useEffect(() => {
    ClipboardSyncBg?.getSetting?.('user_consent_accepted', false)
      .then((val: boolean) => {
        setConsentAccepted(val);
      })
      .catch(() => setConsentAccepted(false));

    ClipboardSyncBg?.getSetting?.('ghost_service_enabled', true)
      .then((val: boolean) => {
        setGhostServiceEnabled(val);
      })
      .catch(() => setGhostServiceEnabled(true));
  }, []);

  const toggleGhostService = async () => {
    if (ghostServiceEnabled) {
      setGhostServiceEnabled(false);
      await ClipboardSyncBg?.saveSetting?.('ghost_service_enabled', false);
      try {
        ClipboardSyncBg?.stopService?.();
      } catch (e) { }
      ToastAndroid.show('Ghost background service stopped.', ToastAndroid.SHORT);
    } else {
      if (!accessibilityEnabled) {
        setShowAccessibilityAlert(true);
      } else {
        setGhostServiceEnabled(true);
        await ClipboardSyncBg?.saveSetting?.('ghost_service_enabled', true);
        if (connected && ip) {
          try {
            ClipboardSyncBg?.startService?.(ip, syncKey);
          } catch (e) { }
        }
        ToastAndroid.show('Ghost background service active.', ToastAndroid.SHORT);
      }
    }
  };

  const handleEnableAccessibility = () => {
    setShowAccessibilityAlert(false);
    ClipboardSyncBg?.openAccessibilitySettings?.();
    ClipboardSyncBg?.saveSetting?.('ghost_service_enabled', true);
    setGhostServiceEnabled(true);
  };

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

      // Start service if accessibility is enabled, ghost service setting is ON, and we're connected
      if (acc && ghostServiceEnabledRef.current && hasConnectedRef.current && ipRef.current) {
        try {
          ClipboardSyncBg?.startService?.(ipRef.current, syncKeyRef.current);
        } catch (e) { }
      }
    } catch (_) { }
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
    const init = async () => {
      const { savedIp } = await hydrateSavedConfig();
      const pId = await ClipboardSyncBg?.getSetting?.('paired_pc_id', '');
      const pName = await ClipboardSyncBg?.getSetting?.('paired_pc_hostname', '');
      const pKey = await ClipboardSyncBg?.getSetting?.('paired_pc_secret_key', '');
      const enabledSetting = await ClipboardSyncBg?.getSetting?.('pc_discovery_enabled', true);
      const isEnabled = enabledSetting === true;

      setPairedPcId(pId || '');
      setPairedPcHostname(pName || '');
      if (pKey) {
        setSyncKey(pKey);
        syncKeyRef.current = pKey;
      }
      setPcDiscoveryEnabled(isEnabled);
      pcDiscoveryEnabledRef.current = isEnabled;

      if (isEnabled && isValidIpv4(savedIp)) {
        connectToServer(false, 'auto');
      }
      consumeSharePayload();
    };
    init();
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
        if (hasConnectedRef.current && pcDiscoveryEnabledRef.current) {
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
  }, [connected, connectToServer, consumeSharePayload, syncClipboard, pcDiscoveryEnabled]);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  if (consentAccepted === false) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.consentHeader}>
          <Text style={styles.consentTitle}>Codeb Link</Text>
          <Text style={styles.consentSubtitle}>Privacy Disclosure & Consent</Text>
        </View>
        <ScrollView style={styles.consentScroll} showsVerticalScrollIndicator={true}>
          <Text style={styles.consentTextHeader}>Data Access & Privacy Policy</Text>
          <Text style={styles.consentBody}>
            Effective: May 28, 2026{"\n\n"}
            Codeb Link is a local-first peer-to-peer utility developed by Codeb Minds. It syncs clipboard text and files between your Android device and Linux desktop over your private Wi-Fi network.{"\n\n"}
            <Text style={{ fontWeight: 'bold', color: '#fff' }}>No Cloud, No Third Parties:</Text> Your data never leaves your devices. We do not use servers, accounts, or remote storage. All transmission is direct and local-only.{"\n\n"}
            To provide these services, the app requires the following permissions. Please read how they are used:
          </Text>

          <View style={styles.consentItem}>
            <Text style={styles.consentItemTitle}>1. Clipboard Read & Write</Text>
            <Text style={styles.consentItemDesc}>
              Allows the app to read when you copy text to sync it to your PC, and write text sent from your PC back to your clipboard. Payload content is encrypted locally using AES-256 before transmission.
            </Text>
          </View>

          <View style={styles.consentItem}>
            <Text style={styles.consentItemTitle}>2. Accessibility Service (Optional)</Text>
            <Text style={styles.consentItemDesc}>
              Required for automatic background clipboard sync on Android 10+. Background apps are blocked from clipboard reads. The service transiently listens to clipboard preview signals. It does NOT log or transmit any keystrokes, UI content, or usage data. If denied, auto background sync will be disabled, but manual sync and file sharing will work.
            </Text>
          </View>

          <View style={styles.consentItem}>
            <Text style={styles.consentItemTitle}>3. Local Network Access</Text>
            <Text style={styles.consentItemDesc}>
              Allows direct IP and socket communication with your PC on your local Wi-Fi. No public internet connection is established.
            </Text>
          </View>

          <View style={styles.consentItem}>
            <Text style={styles.consentItemTitle}>4. Files & External Storage</Text>
            <Text style={styles.consentItemDesc}>
              Allows reading files you share with Codeb Link to send to your PC, and writing files received from the PC directly to your Downloads folder.
            </Text>
          </View>

          <View style={styles.consentItem}>
            <Text style={styles.consentItemTitle}>5. Camera (Pairing Scan)</Text>
            <Text style={styles.consentItemDesc}>
              Used only to scan the pairing QR code displayed on your PC to sync configuration details.
            </Text>
          </View>

          <View style={styles.consentItem}>
            <Text style={styles.consentItemTitle}>6. Notifications & Battery Exemption</Text>
            <Text style={styles.consentItemDesc}>
              Shows a persistent notification to keep the connection active in the background and requests battery exemption so Android does not kill the synchronization service.
            </Text>
          </View>

          <Text style={{ color: '#64748b', fontSize: 13, marginTop: 15, marginBottom: 30, fontStyle: 'italic' }}>
            For more details, visit our official privacy documentation at link.codebminds.com/privacy.
          </Text>
        </ScrollView>

        <View style={styles.consentActions}>
          <TouchableOpacity
            style={styles.checkboxRow}
            onPress={() => setConsentCheckbox(!consentCheckbox)}
            activeOpacity={0.8}
          >
            <View style={[styles.checkbox, consentCheckbox && styles.checkboxChecked]}>
              {consentCheckbox && <Text style={{ color: '#fff', fontSize: 10, fontWeight: 'bold' }}>✓</Text>}
            </View>
            <Text style={styles.checkboxLabel}>
              I agree to the Terms of Use and Privacy Policy
            </Text>
          </TouchableOpacity>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
            <TouchableOpacity
              style={[styles.consentButton, styles.declineButton]}
              onPress={() => BackHandler.exitApp()}
            >
              <Text style={styles.declineText}>Decline</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.consentButton, styles.acceptButton, !consentCheckbox && styles.disabledButton]}
              disabled={!consentCheckbox}
              onPress={async () => {
                await ClipboardSyncBg?.saveSetting?.('user_consent_accepted', true);
                setConsentAccepted(true);
                setOnboardingStep(true);
              }}
            >
              <Text style={styles.acceptText}>Accept</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Image source={require('../assets/images/icon.png')} style={{ width: 40, height: 40, borderRadius: 10 }} />
          <View>
            <Text style={styles.title}>Codeb Link</Text>
            <Text style={{ color: '#22c55e', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' }}>SECURE P2P</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 15 }}>
          <View style={[styles.statusDot, connected ? styles.connected : styles.disconnected]} />
          <TouchableOpacity onPress={() => setIsSettingsOpen(true)} style={{ padding: 5 }}>
            <Svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#eceef2" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <Circle cx="12" cy="12" r="3" />
              <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </Svg>
          </TouchableOpacity>
        </View>
      </View>
 
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
 
 
        {/* PC Pairing Status card — shown when paired with a Linux app */}
        {pairedPcId !== '' && (
          <View style={styles.card}>
            <Text style={styles.label}>Paired PC</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
              <View style={{ marginRight: 12 }}>
                <Svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#eceef2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <Rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <Line x1="8" y1="21" x2="16" y2="21" />
                  <Line x1="12" y1="17" x2="12" y2="21" />
                </Svg>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{pairedPcHostname || 'Linux PC'}</Text>
                <Text style={{ color: connected ? '#22c55e' : '#ef4444', fontSize: 11, fontWeight: '800', marginTop: 2, letterSpacing: 1 }}>
                  {connected ? 'CONNECTED' : 'DISCONNECTED'}
                </Text>
              </View>
            </View>
            <View style={{ gap: 10 }}>
              {connected && (
                <TouchableOpacity
                  style={[styles.button, { backgroundColor: '#1c1e22', borderColor: 'rgba(255, 255, 255, 0.05)', marginBottom: 0 }]}
                  onPress={() => {
                    hasConnectedRef.current = false;
                    try {
                      ClipboardSyncBg?.stopService?.();
                    } catch (e) { }
                    if (socketRef.current?.connected) {
                      socketRef.current.emit('client-disconnect', { machineId: machineIdRef.current });
                      setTimeout(() => {
                        socketRef.current?.disconnect();
                      }, 150);
                    } else {
                      socketRef.current?.disconnect();
                    }
                    setConnected(false);
                    ToastAndroid.show('Disconnected.', ToastAndroid.SHORT);
                  }}
                >
                  <Text style={styles.buttonText}>Disconnect</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.button, { backgroundColor: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.2)', borderWidth: 1, marginBottom: 0 }]}
                onPress={() => {
                  hasConnectedRef.current = false;
                  if (socketRef.current?.connected) {
                    socketRef.current.emit('unpaired-by-peer', { machineId: pairedPcId });
                    setTimeout(() => {
                      socketRef.current?.disconnect();
                    }, 250);
                  }
                  try {
                    ClipboardSyncBg?.stopService?.();
                  } catch (e) { }
                  setPairedPcId('');
                  setPairedPcHostname('');
                  setSyncKey('CodebLink-Default-Key');
                  syncKeyRef.current = 'CodebLink-Default-Key';
                  ClipboardSyncBg?.saveSetting?.('paired_pc_id', '');
                  ClipboardSyncBg?.saveSetting?.('paired_pc_hostname', '');
                  ClipboardSyncBg?.saveSetting?.('paired_pc_secret_key', '');
                  ClipboardSyncBg?.saveConfig?.(ipRef.current, 'CodebLink-Default-Key');
                  setConnected(false);
                  ToastAndroid.show('Unpaired from PC.', ToastAndroid.SHORT);
                }}
              >
                <Text style={[styles.buttonText, { color: '#ef4444' }]}>Unpair</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.label}>Clipboard Status</Text>
          <View style={styles.clipboardBox}>
            <Text style={styles.clipboardText} numberOfLines={3}>
              {clipboardText}
            </Text>
          </View>
          <TouchableOpacity style={[styles.button, styles.accentBtn]} onPress={() => syncClipboard('manual')}>
            <Text style={[styles.buttonText, { color: '#0a0a0a' }]}>Force Manual Sync</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
 
      {/* SETUP MODAL: ASKS FOR PERMISSIONS ON ONBOARDING */}
      <Modal visible={onboardingStep} animationType="fade" transparent={true}>
        <View style={styles.modalBlur}>
          <View style={styles.setupCard}>
            <Text style={styles.setupTitle}>Permissions Setup</Text>
            <Text style={styles.setupDesc}>
              Configure how Codeb Link operates. You can enable or deny these permissions individually:
            </Text>
 
            {/* Accessibility permission row */}
            <View style={styles.permissionSetupRow}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={styles.permissionSetupTitle}>1. Accessibility Service</Text>
                <Text style={styles.permissionSetupDesc}>
                  Allows automatic background clipboard reading (Safe, local only).
                </Text>
              </View>
              {accessibilityEnabled ? (
                <View style={styles.grantedBadge}><Text style={styles.badgeText}>Active</Text></View>
              ) : (
                <View style={{ flexDirection: 'row', gap: 5 }}>
                  <TouchableOpacity
                    style={[styles.permissionBtn, { backgroundColor: '#f5f5f5' }]}
                    onPress={() => ClipboardSyncBg?.openAccessibilitySettings()}
                  >
                    <Text style={[styles.permissionBtnText, { color: '#0a0a0a' }]}>Enable</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.permissionBtn, { backgroundColor: '#1f2125', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.05)' }]}
                    onPress={async () => {
                      await ClipboardSyncBg?.saveSetting?.('ghost_service_enabled', false);
                      setGhostServiceEnabled(false);
                      ToastAndroid.show('Accessibility skipped. Auto sync disabled.', ToastAndroid.SHORT);
                    }}
                  >
                    <Text style={[styles.permissionBtnText, { color: '#64748b' }]}>Skip</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
 
            {/* Battery Optimization row */}
            <View style={styles.permissionSetupRow}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={styles.permissionSetupTitle}>2. Unrestricted Battery</Text>
                <Text style={styles.permissionSetupDesc}>
                  Prevents Android from aggressively terminating background sync.
                </Text>
              </View>
              {!batteryOptimized ? (
                <View style={styles.grantedBadge}><Text style={styles.badgeText}>Active</Text></View>
              ) : (
                <View style={{ flexDirection: 'row', gap: 5 }}>
                  <TouchableOpacity
                    style={[styles.permissionBtn, { backgroundColor: '#f5f5f5' }]}
                    onPress={() => ClipboardSyncBg?.requestIgnoreBatteryOptimization()}
                  >
                    <Text style={[styles.permissionBtnText, { color: '#0a0a0a' }]}>Enable</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.permissionBtn, { backgroundColor: '#1f2125', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.05)' }]}
                    onPress={() => {
                      ToastAndroid.show('Battery optimization skipped.', ToastAndroid.SHORT);
                    }}
                  >
                    <Text style={[styles.permissionBtnText, { color: '#64748b' }]}>Skip</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
 
            {/* Notification Permission row */}
            <View style={styles.permissionSetupRow}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={styles.permissionSetupTitle}>3. Post Notifications</Text>
                <Text style={styles.permissionSetupDesc}>
                  Required to show persistent network and clipboard status.
                </Text>
              </View>
              {notificationsEnabled ? (
                <View style={styles.grantedBadge}><Text style={styles.badgeText}>Active</Text></View>
              ) : (
                <View style={{ flexDirection: 'row', gap: 5 }}>
                  <TouchableOpacity
                    style={[styles.permissionBtn, { backgroundColor: '#f5f5f5' }]}
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
                    <Text style={[styles.permissionBtnText, { color: '#0a0a0a' }]}>Enable</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.permissionBtn, { backgroundColor: '#1f2125', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.05)' }]}
                    onPress={() => {
                      ToastAndroid.show('Notifications skipped.', ToastAndroid.SHORT);
                    }}
                  >
                    <Text style={[styles.permissionBtnText, { color: '#64748b' }]}>Skip</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
 
            <TouchableOpacity
              style={[styles.button, styles.accentBtn, { marginTop: 20 }]}
              onPress={() => setOnboardingStep(false)}
            >
              <Text style={[styles.buttonText, { color: '#0a0a0a' }]}>Finish Setup</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* SYSTEM SETTINGS SCREEN MODAL */}
      <Modal visible={isSettingsOpen} animationType="slide" transparent={false} onRequestClose={() => setIsSettingsOpen(false)}>
        <SafeAreaView style={styles.container}>
          <View style={[styles.header, { justifyContent: 'flex-start' }]}>
            <TouchableOpacity onPress={() => setIsSettingsOpen(false)} style={{ padding: 8, marginRight: 12, marginLeft: -8 }}>
              <Svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <Path d="M19 12H5M12 19l-7-7 7-7" />
              </Svg>
            </TouchableOpacity>
            <View>
              <Text style={styles.title}>Settings</Text>
              <Text style={{ color: '#22c55e', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' }}>CODEB LINK CONFIG</Text>
            </View>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 50 }}>
            {/* DISCOVERABLE SETTING */}
            <View style={styles.card}>
              <Text style={styles.label}>PC Discovery</Text>
              <View style={styles.settingsRow}>
                <View style={{ flex: 1, marginRight: 10 }}>
                  <Text style={styles.settingsLabel}>Discoverable</Text>
                  <Text style={styles.settingsDesc}>
                    Allow Desktop app to discover and pair with this phone.
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.toggleSwitch, pcDiscoveryEnabled ? styles.toggleOn : styles.toggleOff]}
                  onPress={togglePcDiscovery}
                  activeOpacity={0.8}
                >
                  <View style={[styles.toggleKnob, pcDiscoveryEnabled ? styles.knobOn : styles.knobOff]} />
                </TouchableOpacity>
              </View>
            </View>

            {/* GHOST BACKGROUND SERVICE SETTING */}
            <View style={styles.card}>
              <Text style={styles.label}>Background Sync</Text>
              <View style={styles.settingsRow}>
                <View style={{ flex: 1, marginRight: 10 }}>
                  <Text style={styles.settingsLabel}>Ghost Background Service</Text>
                  <Text style={styles.settingsDesc}>
                    Auto sync in the background using Accessibility Service.
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.toggleSwitch, ghostServiceEnabled ? styles.toggleOn : styles.toggleOff]}
                  onPress={toggleGhostService}
                  activeOpacity={0.8}
                >
                  <View style={[styles.toggleKnob, ghostServiceEnabled ? styles.knobOn : styles.knobOff]} />
                </TouchableOpacity>
              </View>
            </View>



            {/* SYSTEM PERMISSIONS SETTING */}
            <View style={styles.card}>
              <Text style={styles.label}>Permissions</Text>

              <View style={styles.settingsRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingsSubLabel}>Accessibility Permission</Text>
                  <Text style={styles.settingsStatus}>
                    Status: {accessibilityEnabled ? 'Granted' : 'Denied'}
                  </Text>
                </View>
                {!accessibilityEnabled && (
                  <TouchableOpacity
                    style={styles.settingsActionBtn}
                    onPress={() => ClipboardSyncBg?.openAccessibilitySettings()}
                  >
                    <Text style={styles.settingsActionText}>Enable</Text>
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.permissionDivider} />

              <View style={styles.settingsRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingsSubLabel}>Battery Restrictions</Text>
                  <Text style={styles.settingsStatus}>
                    Status: {batteryOptimized ? 'Optimized' : 'Unrestricted'}
                  </Text>
                </View>
                {batteryOptimized && (
                  <TouchableOpacity
                    style={styles.settingsActionBtn}
                    onPress={() => ClipboardSyncBg?.requestIgnoreBatteryOptimization()}
                  >
                    <Text style={styles.settingsActionText}>Configure</Text>
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.permissionDivider} />

              <View style={styles.settingsRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingsSubLabel}>Notifications</Text>
                  <Text style={styles.settingsStatus}>
                    Status: {notificationsEnabled ? 'Allowed' : 'Blocked'}
                  </Text>
                </View>
                {!notificationsEnabled && (
                  <TouchableOpacity
                    style={styles.settingsActionBtn}
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
                    <Text style={styles.settingsActionText}>Configure</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* ACCESSIBILITY PERMISSION WARNING ALERT MODAL */}
      <Modal visible={showAccessibilityAlert} animationType="slide" transparent={true}>
        <View style={styles.modalBlur}>
          <View style={styles.setupCard}>
            <Text style={styles.setupTitle}>Accessibility Required</Text>
            <Text style={styles.setupDesc}>
              To automatically synchronize clipboard content in the background, Codeb Link requires you to enable its Accessibility Service.{"\n\n"}
              This allows the app to detect clipboard signals without running in the foreground. No keystrokes or screen contents are read or transmitted.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
              <TouchableOpacity
                style={[styles.consentButton, styles.declineButton]}
                onPress={() => {
                  setShowAccessibilityAlert(false);
                  ToastAndroid.show('Ghost background service kept disabled.', ToastAndroid.SHORT);
                }}
              >
                <Text style={styles.declineText}>Deny</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.consentButton, styles.acceptButton]}
                onPress={handleEnableAccessibility}
              >
                <Text style={styles.acceptText}>Enable</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* PAIRING CODE MODAL — Linux initiated pairing; Android confirms with Accept/Decline */}
      <Modal visible={pairingModal !== null} animationType="slide" transparent={true}>
        <View style={styles.modalBlur}>
          <View style={[styles.setupCard, { alignItems: 'center' }]}>
            <View style={{ marginBottom: 15 }}>
              <Svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#eceef2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <Rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <Line x1="8" y1="21" x2="16" y2="21" />
                <Line x1="12" y1="17" x2="12" y2="21" />
              </Svg>
            </View>
            <Text style={styles.setupTitle}>Pairing Request</Text>
            <Text style={styles.setupDesc}>
              <Text style={{ color: '#fff', fontWeight: '700' }}>{pairingModal?.pcHostname || 'A Linux PC'}</Text>
              {' '}wants to pair with your phone.{'\n\n'}Verify the code below matches what is shown on your PC, then tap Accept:
            </Text>

            {/* 6-digit code tiles */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
              {(pairingModal?.pairingCode || '------').split('').map((ch, i) => (
                <View key={i} style={{
                  width: 42,
                  height: 52,
                  backgroundColor: '#111214',
                  borderRadius: 10,
                  borderWidth: 1.5,
                  borderColor: '#22c55e',
                  justifyContent: 'center',
                  alignItems: 'center'
                }}>
                  <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900' }}>{ch}</Text>
                </View>
              ))}
            </View>

            <Text style={{ color: '#64748b', fontSize: 11, textAlign: 'center', marginBottom: 24 }}>
              If this code matches on your Linux app, tap Accept to complete pairing.
            </Text>

            {/* Accept / Decline row */}
            <View style={{ flexDirection: 'row', gap: 12, width: '100%' }}>
              <TouchableOpacity
                style={[styles.consentButton, styles.declineButton]}
                onPress={() => {
                  if (socketRef.current?.connected) {
                    socketRef.current.emit('request-pairing-reject');
                  }
                  setPairingModal(null);
                  ToastAndroid.show('Pairing declined.', ToastAndroid.SHORT);
                }}
              >
                <Text style={styles.declineText}>Decline</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.consentButton, styles.acceptButton]}
                onPress={() => {
                  if (socketRef.current?.connected && pairingModal) {
                    // Emit request-pairing with the code+key Linux sent us
                    // The server will auto-complete since Linux is the initiator
                    socketRef.current.emit('request-pairing', {
                      machineId: machineIdRef.current,
                      hostname: deviceNameRef.current,
                      pairingCode: pairingModal.pairingCode,
                      secretKey: pairingModal.secretKey,
                    });
                  }
                  // Don't close modal yet — wait for pairing-response from server
                }}
              >
                <Text style={styles.acceptText}>Accept</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111214',
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    paddingTop: 10,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#eceef2',
    letterSpacing: 0.5,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  connected: {
    backgroundColor: '#22c55e',
    shadowColor: '#22c55e',
    shadowRadius: 10,
    elevation: 8,
  },
  disconnected: {
    backgroundColor: '#ef4444',
    shadowColor: '#ef4444',
    shadowRadius: 10,
    elevation: 8,
  },
  card: {
    backgroundColor: '#16171a',
    borderRadius: 16,
    padding: 20,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  label: {
    color: '#9ca3af',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  input: {
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    color: '#eceef2',
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  button: {
    backgroundColor: '#1f2125',
    padding: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.03)',
  },
  accentBtn: {
    backgroundColor: '#f5f5f5',
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  checkItem: {
    padding: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    marginBottom: 10,
  },
  checkSuccess: {
    borderColor: 'rgba(34, 197, 94, 0.3)',
    backgroundColor: 'rgba(34, 197, 94, 0.08)',
  },
  checkText: {
    color: '#eceef2',
    fontSize: 13,
    fontWeight: '600',
  },
  clipboardBox: {
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 15,
    minHeight: 80,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  clipboardText: {
    color: '#eceef2',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    lineHeight: 20,
  },
  logs: {
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  logText: {
    color: '#71717a',
    marginBottom: 4,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  scanOverlay: {
    flex: 1,
    backgroundColor: 'rgba(17, 18, 20, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanTarget: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: '#f5f5f5',
    borderRadius: 24,
    backgroundColor: 'transparent',
  },
  cancelButton: {
    marginTop: 40,
    backgroundColor: '#f5f5f5',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 30,
  },
  cancelText: {
    color: '#0a0a0a',
    fontWeight: 'bold',
    fontSize: 14,
  },
  modalBlur: {
    flex: 1,
    backgroundColor: 'rgba(17, 18, 20, 0.95)',
    justifyContent: 'center',
    padding: 20,
  },
  setupCard: {
    backgroundColor: '#16171a',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  setupTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#eceef2',
    marginBottom: 10,
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  setupDesc: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  setupAction: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1f2125',
    padding: 20,
    borderRadius: 16,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  actionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fff',
  },
  actionDesc: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  actionArrow: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
  },
  setupFooter: {
    fontSize: 11,
    color: '#475569',
    textAlign: 'center',
    marginTop: 15,
  },
  consentHeader: {
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
    alignItems: 'center',
    marginBottom: 10,
  },
  consentTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#eceef2',
  },
  consentSubtitle: {
    color: '#22c55e',
    fontSize: 11,
    fontWeight: 'bold',
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  consentScroll: {
    flex: 1,
    paddingHorizontal: 5,
  },
  consentTextHeader: {
    fontSize: 16,
    fontWeight: '800',
    color: '#eceef2',
    marginVertical: 12,
  },
  consentBody: {
    fontSize: 13,
    color: '#94a3b8',
    lineHeight: 18,
    marginBottom: 16,
  },
  consentItem: {
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  consentItemTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#eceef2',
    marginBottom: 4,
  },
  consentItemDesc: {
    fontSize: 12,
    color: '#64748b',
    lineHeight: 16,
  },
  consentActions: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
    paddingVertical: 15,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingVertical: 5,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#f5f5f5',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  checkboxChecked: {
    backgroundColor: '#f5f5f5',
  },
  checkboxLabel: {
    color: '#94a3b8',
    fontSize: 13,
  },
  consentButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  declineButton: {
    backgroundColor: '#16171a',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  acceptButton: {
    backgroundColor: '#f5f5f5',
  },
  disabledButton: {
    opacity: 0.4,
  },
  declineText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '700',
  },
  acceptText: {
    color: '#0a0a0a',
    fontSize: 14,
    fontWeight: '700',
  },
  permissionSetupRow: {
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  permissionSetupTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#eceef2',
    marginBottom: 2,
  },
  permissionSetupDesc: {
    fontSize: 11,
    color: '#64748b',
    lineHeight: 15,
  },
  grantedBadge: {
    backgroundColor: 'rgba(34, 197, 94, 0.08)',
    borderWidth: 1,
    borderColor: '#22c55e',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  badgeText: {
    color: '#22c55e',
    fontSize: 12,
    fontWeight: 'bold',
  },
  permissionBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  permissionBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  settingsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 6,
  },
  settingsLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#eceef2',
  },
  settingsSubLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#eceef2',
  },
  settingsDesc: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
    lineHeight: 15,
  },
  settingsStatus: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 1,
  },
  settingsActionBtn: {
    backgroundColor: '#1f2125',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  settingsActionText: {
    color: '#eceef2',
    fontSize: 12,
    fontWeight: 'bold',
  },
  permissionDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginVertical: 10,
  },
  toggleSwitch: {
    width: 46,
    height: 26,
    borderRadius: 13,
    padding: 2,
    justifyContent: 'center',
  },
  toggleOn: {
    backgroundColor: '#22c55e',
  },
  toggleOff: {
    backgroundColor: '#1f2125',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#fff',
  },
  knobOn: {
    alignSelf: 'flex-end',
  },
  knobOff: {
    alignSelf: 'flex-start',
  },
  settingsCloseBtn: {
    backgroundColor: '#1f2125',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  settingsCloseBtnText: {
    color: '#eceef2',
    fontSize: 13,
    fontWeight: 'bold',
  },
});
