# Codeb Link — Mobile Companion (Android/React Native)

Codeb Link is the native Android companion client built to keep your mobile device in sync with your Linux desktop. Built on React Native, Expo, and Native Android Services, it provides background clipboard synchronization and file transfers.

> 💻 **Desktop Client**: This companion app pairs with the Linux desktop application. The source code and instructions for the desktop client can be found at [CodebLink-linux](https://github.com/Codeb-Minds/CodebLink-linux).

---

## 🎯 Purpose & Problem Solver

This mobile client is designed to overcome specific mobile operating system constraints:

1. **Android Power Management & Service Sleep**: Modern Android OS strictly kills background JavaScript runners to preserve battery. Codeb Link utilizes native Android services (`ClipboardSyncService.kt` and `SyncTrampolineActivity.kt`) to process background sockets and clipboard changes even when the primary React Native thread is inactive.
2. **Foreground/Background Transition Lag**: Shifts dynamically between active, low-latency WebSocket connections (when the dashboard is active) and background HTTP long-polling loops ("Ghost Channel") to save system resources and prevent false disconnects.
3. **Decryption Overhead**: Ensures all clipboard payloads decrypted on the mobile client match client-side AES-256 standards, preventing network observers from accessing unencrypted clipboard transfers.

---

## 🚀 Core Features

- **Native Android Background Service**: Continuously listens to local system socket updates and writes back directly to the Android OS clipboard.
- **Dynamic Port & Sync Connection**: Uses dynamic connection strings shared securely via dynamic QR Code scans.
- **Security Key Reveal**: Integrated custom input field visibility controllers for managing the system synchronization key.
- **System Telemetry Logs**: Displays instant, lightweight connection logs and pairing status indicators.

---

## 🛠️ Prerequisites & Requirements

- **Android SDK**: Compilation of native Android background services requires the Android SDK configured.
- **Local Wi-Fi Connection**: Desktop and mobile devices must operate on the same local network subnets to identify and connect to local sockets.

---

## ⚙️ Setup & Development

Follow these instructions to run and build the mobile client:

### 1. Install Dependencies
Install the required npm packages directly from the repository root:
```bash
npm install
```

### 2. Start the Metro Developer Server
Start the local server and Expo client:
```bash
npx expo start
```
*Press `a` to load the application directly on your connected Android device or active emulator.*

### 3. Generate Native Android Code
Compile Expo build paths into raw Gradle and native Kotlin project resources:
```bash
npx expo prebuild
```

### 4. Build Production APK
Build the release bundle for Android distribution:
```bash
npx expo run:android --variant release
```
