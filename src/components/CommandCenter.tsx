import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import {
	ChevronRight,
	VolumeX,
	Volume,
	Volume1,
	Volume2,
	SunDim,
	SunMedium,
	Sun
} from "lucide-react";
import type { QuickControls } from "../hooks/useQuickControls";
import "./CommandCenter.css";

/** Fixed, then Smart, then Peek, as the mode tiles cycle. */
export const nextBarMode = (mode: string) =>
	mode === "fixed" ? "smart" : mode === "smart" ? "peek" : "fixed";

/** Saves a dock or notch mode picked from a mode tile and applies it. */
export async function applyBarMode(bar: "dock" | "notch", mode: string) {
	const key = `bloom-${bar}-mode`;
	localStorage.setItem(key, mode);
	invoke("save_setting", { key, value: mode }).catch(console.error);
	try {
		await invoke(bar === "dock" ? "change_dock_mode" : "change_notch_mode", { mode });
	} catch (err) {
		console.error(`Failed to change ${bar} mode:`, err);
	}
}

const modeLabel = (mode: string) =>
	mode === "fixed" ? "Fixed" : mode === "smart" ? "Smart" : "Peek";

interface CommandCenterProps {
	controls: QuickControls;
	dockMode: string;
	notchMode: string;
	onCycleDockMode: (e: React.MouseEvent) => void;
	onCycleNotchMode: (e: React.MouseEvent) => void;
	onOpenWifi: () => void;
	onOpenBluetooth: () => void;
}

/**
 * The Command Center's tiles, action buttons and sliders. The notch and the
 * dock each wrap it in their own container, which sets the layout and, for
 * the dock, the larger `cc-large` sizes.
 */
export function CommandCenter({
	controls,
	dockMode,
	notchMode,
	onCycleDockMode,
	onCycleNotchMode,
	onOpenWifi,
	onOpenBluetooth
}: CommandCenterProps) {
	const {
		wifiStatus,
		wifiEnabled,
		wifiConnected,
		toggleWifi,
		bluetoothEnabled,
		toggleBluetooth,
		btConnectedNames,
		batterySaverEnabled,
		displayVolume,
		handleVolumeChange,
		toggleVolumeLevel,
		currentBrightness,
		handleBrightnessChange,
		toggleBrightnessLevel
	} = controls;

	const VolumeIcon =
		displayVolume === 0
			? VolumeX
			: displayVolume < 0.33
				? Volume
				: displayVolume < 0.67
					? Volume1
					: Volume2;
	const BrightnessIcon =
		currentBrightness < 34 ? SunDim : currentBrightness < 67 ? SunMedium : Sun;

	// Right-click opens the tile's own view, the same as its › button.
	const openOnRightClick = (open: () => void) => (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		open();
	};

	return (
		<>
			{/* Pills Grid */}
			<div className="cc-pills-grid">
				{/* Wi-Fi Pill */}
				<div
					className={`cc-pill-tile ${wifiEnabled ? "active" : ""}`}
					onClick={(e) => {
						e.stopPropagation();
						toggleWifi();
					}}
					onContextMenu={openOnRightClick(onOpenWifi)}
					title="Left-click to toggle, Right-click for networks"
				>
					<div className="cc-pill-icon-wrapper">
						<WifiIcon enabled={wifiEnabled} connected={wifiConnected} />
					</div>
					<div className="cc-pill-info">
						<span className="cc-pill-title">Wi-Fi</span>
						<span className="cc-pill-status">
							{wifiStatus === null
								? "…"
								: !wifiEnabled
									? "Off"
									: wifiConnected
										? (wifiStatus?.ssid ?? "Connected")
										: "Not connected"}
						</span>
					</div>
					<button
						className="cc-pill-more"
						aria-label="Wi-Fi networks"
						title="Wi-Fi networks"
						onClick={(e) => {
							e.stopPropagation();
							onOpenWifi();
						}}
					>
						<ChevronRight />
					</button>
				</div>

				{/* Dock Mode Pill */}
				<div
					className={`cc-pill-tile ${dockMode === "fixed" ? "active" : ""}`}
					onClick={onCycleDockMode}
					title="Cycle dock mode: Fixed / Smart / Peek"
				>
					<div className="cc-pill-icon-wrapper">
						<DockIcon />
					</div>
					<div className="cc-pill-info">
						<span className="cc-pill-title">Dock Mode</span>
						<span className="cc-pill-status">{modeLabel(dockMode)}</span>
					</div>
				</div>

				{/* Bluetooth Pill */}
				<div
					className={`cc-pill-tile ${bluetoothEnabled ? "active" : ""}`}
					onClick={(e) => {
						e.stopPropagation();
						toggleBluetooth();
					}}
					onContextMenu={openOnRightClick(onOpenBluetooth)}
					title="Left-click to toggle, Right-click for devices"
				>
					<div className="cc-pill-icon-wrapper">
						<BluetoothIcon />
					</div>
					<div className="cc-pill-info">
						<span className="cc-pill-title">Bluetooth</span>
						<span className="cc-pill-status">
							{!bluetoothEnabled
								? "Off"
								: btConnectedNames.length === 1
									? btConnectedNames[0]
									: btConnectedNames.length > 1
										? `${btConnectedNames.length} connected`
										: "On"}
						</span>
					</div>
					<button
						className="cc-pill-more"
						aria-label="Bluetooth devices"
						title="Bluetooth devices"
						onClick={(e) => {
							e.stopPropagation();
							onOpenBluetooth();
						}}
					>
						<ChevronRight />
					</button>
				</div>

				{/* Notch Mode Pill */}
				<div
					className={`cc-pill-tile ${notchMode === "fixed" ? "active" : ""}`}
					onClick={onCycleNotchMode}
					title="Cycle notch mode: Fixed / Smart / Peek"
				>
					<div className="cc-pill-icon-wrapper">
						<NotchIcon />
					</div>
					<div className="cc-pill-info">
						<span className="cc-pill-title">Notch Mode</span>
						<span className="cc-pill-status">{modeLabel(notchMode)}</span>
					</div>
				</div>
			</div>

			{/* Circular Actions Row */}
			<div className="cc-circular-actions-row">
				<button
					className="cc-circular-btn"
					onClick={(e) => {
						e.stopPropagation();
						invoke("open_app", { appName: "ms-settings:notifications" }).catch(console.error);
					}}
					title="Do Not Disturb: open Windows notification settings"
				>
					<MoonIcon />
				</button>
				<button
					className={`cc-circular-btn ${batterySaverEnabled ? "active" : ""}`}
					onClick={(e) => {
						e.stopPropagation();
						// No public API toggles Energy Saver without admin rights.
						invoke("open_battery_saver_settings").catch((err) =>
							console.error("Failed to open Battery Saver settings:", err)
						);
					}}
					title={`Energy Saver is ${batterySaverEnabled ? "on" : "off"}. Click to open Settings`}
				>
					<BatterySaverIcon />
				</button>
				<button
					className="cc-circular-btn"
					onClick={(e) => {
						e.stopPropagation();
						// Unhides the taskbar and presses Win+B.
						invoke("open_system_tray").catch((err) =>
							console.error("Failed to open system tray:", err)
						);
					}}
					title="System Tray"
				>
					<TrayIcon />
				</button>
				<button
					className="cc-circular-btn"
					onClick={(e) => {
						e.stopPropagation();
						invoke("open_notification_center");
					}}
					title="Notification Center"
				>
					<BellIcon />
				</button>
				<button
					className="cc-circular-btn"
					onClick={(e) => {
						e.stopPropagation();
						invoke("open_settings_window").catch((err) =>
							console.error("Failed to open settings window:", err)
						);
					}}
					title="Bloom Settings"
				>
					<SettingsIcon />
				</button>
				<button
					className="cc-circular-btn"
					onClick={(e) => {
						e.stopPropagation();
						invoke("restart_bloom");
					}}
					title="Restart Bloom"
				>
					<ReloadIcon />
				</button>
			</div>

			{/* Classic Sliders Area */}
			<div className="cc-classic-sliders-area">
				{/* Volume Slider */}
				<div className="cc-classic-slider-row">
					<div className="cc-classic-slider-label">
						<button
							type="button"
							className="cc-level-toggle"
							onClick={toggleVolumeLevel}
							aria-label={displayVolume > 0 ? "Mute volume" : "Restore volume"}
							aria-pressed={displayVolume === 0}
							title={displayVolume > 0 ? "Mute volume" : "Restore volume"}
						>
							<VolumeIcon />
						</button>
						<span>Volume</span>
					</div>
					<div className="cc-classic-slider-track">
						<input
							type="range"
							min="0"
							max="1"
							step="0.01"
							aria-label="Volume"
							value={displayVolume}
							onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
							onPointerDown={(e) => e.stopPropagation()}
							onClick={(e) => e.stopPropagation()}
							className="cc-classic-input"
						/>
						<div className="cc-classic-fill" style={{ width: `${displayVolume * 100}%` }} />
					</div>
					<span className="cc-classic-percentage">{Math.round(displayVolume * 100)}%</span>
				</div>

				{/* Brightness Slider */}
				<div className="cc-classic-slider-row">
					<div className="cc-classic-slider-label">
						<button
							type="button"
							className="cc-level-toggle"
							onClick={toggleBrightnessLevel}
							aria-label={currentBrightness > 0 ? "Minimize brightness" : "Restore brightness"}
							aria-pressed={currentBrightness === 0}
							title={currentBrightness > 0 ? "Minimize brightness" : "Restore brightness"}
						>
							<BrightnessIcon />
						</button>
						<span>Brightness</span>
					</div>
					<div className="cc-classic-slider-track">
						<input
							type="range"
							min="0"
							max="100"
							step="1"
							aria-label="Brightness"
							value={currentBrightness}
							onChange={(e) => handleBrightnessChange(parseInt(e.target.value))}
							onPointerDown={(e) => e.stopPropagation()}
							onClick={(e) => e.stopPropagation()}
							className="cc-classic-input"
						/>
						<div className="cc-classic-fill" style={{ width: `${currentBrightness}%` }} />
					</div>
					<span className="cc-classic-percentage">{currentBrightness}%</span>
				</div>
			</div>
		</>
	);
}

// Simple SVG icons
export function WifiIcon({ enabled, connected }: { enabled: boolean; connected: boolean }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			opacity={!enabled ? 0.4 : connected ? 1 : 0.7}
		>
			<path d="M5 12.55a11 11 0 0 1 14.08 0" />
			<path d="M1.42 9a16 16 0 0 1 21.16 0" />
			<path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
			<line x1="12" y1="20" x2="12.01" y2="20" />
		</svg>
	);
}

function TrayIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="3" y="3" width="6" height="6" rx="1" />
			<rect x="15" y="3" width="6" height="6" rx="1" />
			<rect x="15" y="15" width="6" height="6" rx="1" />
			<rect x="3" y="15" width="6" height="6" rx="1" />
		</svg>
	);
}

function BluetoothIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11" />
		</svg>
	);
}

function SettingsIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{ opacity: 0.9 }}
		>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
		</svg>
	);
}

function DockIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="2" y="14" width="20" height="8" rx="2" />
			<line x1="6" y1="18" x2="6.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
			<line x1="10" y1="18" x2="10.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
			<line x1="14" y1="18" x2="14.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
			<line x1="18" y1="18" x2="18.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
		</svg>
	);
}

function NotchIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M4 3h16a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
			<path d="M9 9v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V9" />
		</svg>
	);
}

function BellIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9z" />
			<path d="M13.73 21a2 2 0 0 1-3.46 0" />
		</svg>
	);
}

function ReloadIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
		</svg>
	);
}

function BatterySaverIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="2" y="7" width="16" height="10" rx="2" />
			<path d="M22 11v2" />
			<path d="M6 12h4l2-3v6l-2-3H6" />
		</svg>
	);
}
