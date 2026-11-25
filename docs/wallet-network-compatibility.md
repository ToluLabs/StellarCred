# Wallet and Network Compatibility Matrix

This document provides the authoritative compatibility matrix for wallet providers, web browsers, and Stellar network environments supported by StellarCred.

## Wallet Compatibility Matrix

StellarCred integrates with Stellar wallets using the Stellar Wallets Kit and Soroban RPC protocols.

| Wallet Provider | Type | Platform | Status | Minimum Version | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Freighter** | Browser Extension | Desktop (Chrome, Brave, Firefox, Edge) | Recommended | v5.12.0+ | Native Soroban contract invocation and transaction simulation. |
| **xBull** | Extension / Web / Mobile | Desktop, Android, iOS | Supported | v1.0.0+ | Supports direct Soroban transaction signing across platforms. |
| **Albedo** | Web / Popup | All modern browsers | Supported | Current | Does not require browser extensions; uses postMessage popup auth. |
| **Lobstr** | Mobile / Extension | iOS, Android, Desktop | Supported | v8.0.0+ | Mobile connection via WalletConnect and browser extension. |
| **Hana** | Browser Extension | Desktop | Supported | v1.5.0+ | Multi-chain Stellar and Soroban extension wallet. |
| **Ledger** | Hardware Wallet | Desktop via USB / WebHID | Supported | Firmware 2.1+ | Requires Freighter or xBull as bridge software for Soroban signing. |

## Browser Compatibility Matrix

Zero-knowledge proving (`bb.js` / Barretenberg UltraHonk) executes client-side inside the browser via WebAssembly (WASM).

| Browser | Minimum Version | WebAssembly Support | Extension Support | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Google Chrome / Chromium** | 109+ | Full (SIMD + Multi-threading) | Supported | Recommended |
| **Brave** | 1.48+ | Full (Shields allow WASM) | Supported | Recommended |
| **Mozilla Firefox** | 115+ | Full | Supported | Supported |
| **Microsoft Edge** | 109+ | Full | Supported | Supported |
| **Apple Safari (macOS)** | 16.4+ | Full | Partial (Albedo / Web) | Supported |
| **Mobile Chrome / Safari** | iOS 16.4+ / Android 10+ | Supported | Albedo / WalletConnect | Supported (Limited extensions) |

## Network Compatibility Matrix

| Network | Passphrase / Network ID | Soroban RPC Status | StellarCred Deployment Status |
| :--- | :--- | :--- | :--- |
| **Stellar Testnet** | `Test SDF Network ; September 2015` | Active | Fully Deployed and Verified |
| **Stellar Futurenet** | `Test SDF Future Network ; October 2022` | Active | Supported |
| **Stellar Mainnet** | `Public Global Stellar Network ; July 2015` | Active | Staged for Deployment |
| **Local Devnet / Standalone** | `Standalone Network ; February 2017` | Local container | Supported via Docker local setup |

## Actionable Guidance for Unsupported or Restricted Environments

### 1. Private / Incognito Browsing
- **Symptom**: "Storage unavailable" or credential loss upon closing the window.
- **Root Cause**: Browsers restrict or partition `localStorage` and `IndexedDB` in private browsing modes.
- **Action**: Use standard browsing mode for persistent credential storage, or export credential backups via the Dashboard export utility prior to closing the session.

### 2. Network Mismatch Warning
- **Symptom**: Dashboard displays "Network Mismatch" alert.
- **Root Cause**: Connected wallet is configured to a network different from the application target (e.g. wallet is on Mainnet while app expects Testnet).
- **Action**: Switch the active network inside your wallet extension settings to Stellar Testnet, then refresh or reconnect.

### 3. Missing WebAssembly or Outdated Browser
- **Symptom**: Proving stalls or fails with `WebAssembly.RuntimeError` or `compile failed`.
- **Root Cause**: Older browser engines lack WASM SIMD instructions or memory allocation limits prevent UltraHonk circuit instantiation.
- **Action**: Upgrade your browser to the latest version (Chrome 109+, Firefox 115+, or Safari 16.4+).

### 4. Hardware Wallet Popups Blocked
- **Symptom**: Ledger signing hangs without prompting on the physical device.
- **Root Cause**: Browser pop-up blocker or missing WebHID permissions.
- **Action**: Ensure the Ledger Stellar app is open and "Allow contract data" is enabled in device settings.
