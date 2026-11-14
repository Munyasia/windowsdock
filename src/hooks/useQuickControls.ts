import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTrailingThrottle } from "./useTrailingThrottle";

export interface WifiStatus {
	enabled: boolean;
	connected: boolean;
	ssid: string | null;
}

/**
 * The Command Center's system state and actions: Wi-Fi, Bluetooth, volume,
 * brightness and Energy Saver. The notch and the dock each run their own copy
 * (every window is a separate webview), and both follow the backend's change
 * events, so they stay in step.
 *
 * `panelOpen` turns on the Wi-Fi poll that catches changes made outside Bloom.
 * `watchBatterySaver` polls Energy Saver, which has no change event.
 */
export function useQuickControls({
	panelOpen,
	watchBatterySaver
}: {
	panelOpen: boolean;
	watchBatterySaver: boolean;
}) {
	const [volume, setVolume] = useState(0.5);
	const [isMuted, setIsMuted] = useState(false);
	// Sliders show 0 while muted, matching the overlay HUD.
	const displayVolume = isMuted ? 0 : volume;
	// Null until the first successful fetch so the pill can't flash a wrong
	// default on startup.
	const [wifiStatus, setWifiStatus] = useState<WifiStatus | null>(null);
	const wifiEnabled = wifiStatus?.enabled ?? false;
	const wifiConnected = wifiStatus?.connected ?? false;
	const [bluetoothEnabled, setBluetoothEnabled] = useState(true);
	// Names of connected Bluetooth devices, for the controls tile.
	const [btConnectedNames, setBtConnectedNames] = useState<string[]>([]);
	const [batterySaverEnabled, setBatterySaverEnabled] = useState(false);
	const [currentBrightness, setCurrentBrightness] = useState(50);
	const previousVolume = useRef(0.5);
	const previousBrightness = useRef(50);

	useEffect(() => {
		const unlisten = listen<{ volume: number; is_muted: boolean }>("volume-change", (event) => {
			setVolume(event.payload.volume);
			setIsMuted(event.payload.is_muted);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	useEffect(() => {
		const unlisten = listen<{ brightness: number }>("brightness-change", (event) => {
			setCurrentBrightness(event.payload.brightness);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Wi-Fi is a three-state control: Off, on-but-not-connected, Connected.
	// The radio state alone can't tell those apart, so get_wifi_status returns
	// both flags, plus the connected network's name. Returns false so the startup loader knows to retry.
	const refreshWifiStatus = useCallback(async (): Promise<boolean> => {
		try {
			setWifiStatus(await invoke<WifiStatus>("get_wifi_status"));
			return true;
		} catch {
			return false;
		}
	}, []);

	// Seed the Wi-Fi pill at startup. The first call can fail while the WLAN
	// service is still coming up, so retry instead of leaving the pill stuck on
	// its default.
	useEffect(() => {
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const initializeWifiStatus = async (attempt: number) => {
			const loaded = await refreshWifiStatus();
			if (!loaded && !cancelled && attempt < 3) {
				retryTimer = setTimeout(() => void initializeWifiStatus(attempt + 1), (attempt + 1) * 1000);
			}
		};
		void initializeWifiStatus(0);
		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [refreshWifiStatus]);

	// Connected Bluetooth devices for the tile, refreshed whenever the backend
	// reports a device connecting, disconnecting, pairing or being removed.
	useEffect(() => {
		if (!bluetoothEnabled) {
			setBtConnectedNames([]);
			return;
		}
		const refresh = () =>
			invoke<{ name: string; connected: boolean }[]>("bluetooth_list_devices")
				.then((devices) =>
					setBtConnectedNames(devices.filter((d) => d.connected).map((d) => d.name))
				)
				.catch(() => {});
		let debounce: ReturnType<typeof setTimeout> | undefined;
		void refresh();
		const unlisten = listen("bluetooth-changed", () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => void refresh(), 400);
		});
		return () => {
			clearTimeout(debounce);
			unlisten.then((f) => f());
		};
	}, [bluetoothEnabled]);

	// The backend reports connection changes and finished scans as they
	// happen, so the pill follows without waiting for the next poll.
	useEffect(() => {
		let debounce: ReturnType<typeof setTimeout> | undefined;
		const unlisten = listen("wifi-changed", () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => void refreshWifiStatus(), 300);
		});
		return () => {
			clearTimeout(debounce);
			unlisten.then((f) => f());
		};
	}, [refreshWifiStatus]);

	// Load bluetooth/volume/brightness state on mount
	useEffect(() => {
		invoke<boolean>("get_bluetooth_state")
			.then(setBluetoothEnabled)
			.catch(() => {});
		invoke<boolean>("get_battery_saver_state")
			.then(setBatterySaverEnabled)
			.catch(() => {});
		invoke<{ volume: number; is_muted: boolean }>("get_volume_state")
			.then((state) => {
				setVolume(state.volume);
				setIsMuted(state.is_muted);
			})
			.catch(() => {});
		invoke<number>("get_brightness")
			.then(setCurrentBrightness)
			.catch(() => {});
	}, []);

	// Poll battery saver state every 5s (since we can't listen for changes)
	useEffect(() => {
		if (!watchBatterySaver) return;
		const read = () =>
			invoke<boolean>("get_battery_saver_state")
				.then(setBatterySaverEnabled)
				.catch(() => {});
		read();
		const interval = setInterval(read, 5000);
		return () => clearInterval(interval);
	}, [watchBatterySaver]);

	// Refresh Wi-Fi status while the command center is open so changes made
	// outside Bloom (keyboard toggle, Windows quick settings) show up.
	useEffect(() => {
		if (!panelOpen) return;
		void refreshWifiStatus();
		const interval = setInterval(() => void refreshWifiStatus(), 5000);
		return () => clearInterval(interval);
	}, [panelOpen, refreshWifiStatus]);

	const sendVolume = useTrailingThrottle((newVol: number) => {
		invoke("set_volume", { volume: newVol }).catch(() => {});
	}, 50);

	const handleVolumeChange = useCallback(
		(newVol: number) => {
			if (volume > 0 && !isMuted) previousVolume.current = volume;
			setVolume(newVol);
			// set_volume unmutes for any non-zero level.
			setIsMuted(newVol === 0);
			sendVolume(newVol);
		},
		[sendVolume, volume, isMuted]
	);
	const toggleVolumeLevel = () => {
		handleVolumeChange(
			displayVolume > 0 ? 0 : isMuted && volume > 0 ? volume : previousVolume.current
		);
	};

	const toggleWifi = useCallback(async () => {
		const previous = wifiStatus;
		const newState = !(previous?.enabled ?? false);
		setWifiStatus({
			enabled: newState,
			connected: newState ? (previous?.connected ?? false) : false,
			ssid: newState ? (previous?.ssid ?? null) : null
		});
		try {
			await invoke("set_wifi_state", { enabled: newState });
			// The radio and association take a moment to settle.
			setTimeout(() => void refreshWifiStatus(), 800);
		} catch (e) {
			setWifiStatus(previous);
			console.error("Failed to toggle WiFi:", e);
		}
	}, [wifiStatus, refreshWifiStatus]);

	const toggleBluetooth = useCallback(async () => {
		const newState = !bluetoothEnabled;
		setBluetoothEnabled(newState);
		try {
			await invoke("set_bluetooth_state", { enabled: newState });
		} catch (e) {
			setBluetoothEnabled(!newState);
			console.error("Failed to toggle Bluetooth:", e);
		}
	}, [bluetoothEnabled]);

	const sendBrightness = useTrailingThrottle((newVal: number) => {
		invoke("set_brightness", { brightness: newVal }).catch(() => {});
	}, 50);

	const handleBrightnessChange = useCallback(
		(newVal: number) => {
			if (currentBrightness > 0) previousBrightness.current = currentBrightness;
			setCurrentBrightness(newVal);
			sendBrightness(newVal);
		},
		[sendBrightness, currentBrightness]
	);
	const toggleBrightnessLevel = () => {
		handleBrightnessChange(currentBrightness > 0 ? 0 : previousBrightness.current);
	};

	return {
		volume,
		isMuted,
		displayVolume,
		handleVolumeChange,
		toggleVolumeLevel,
		wifiStatus,
		wifiEnabled,
		wifiConnected,
		toggleWifi,
		bluetoothEnabled,
		toggleBluetooth,
		btConnectedNames,
		batterySaverEnabled,
		currentBrightness,
		handleBrightnessChange,
		toggleBrightnessLevel
	};
}

export type QuickControls = ReturnType<typeof useQuickControls>;
