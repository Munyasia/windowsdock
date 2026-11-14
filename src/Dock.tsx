import {
	useState,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	memo,
	type ReactNode
} from "react";
import { motion, AnimatePresence, Reorder, useReducedMotion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./Dock.css";
import { EdgeSurface } from "./components/EdgeSurface";
import { CommandCenter, WifiIcon, applyBarMode, nextBarMode } from "./components/CommandCenter";
import { readCommandCenterLocation } from "./commandCenterLocation";
import { WifiPanel } from "./components/WifiPanel";
import { BluetoothPanel } from "./components/BluetoothPanel";
import { BatteryIcon } from "./components/BatteryIcon";
import { SpeakerIcon } from "./icons";
import { useQuickControls } from "./hooks/useQuickControls";
import type { BatteryDetails } from "./batteryTooltip";
import { initTheme } from "./theme";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { reloadIfMirrorWasStale } from "./hooks/settingsMirror";
import { dockOverlapSpan } from "./dockGeometry";

import {
	dockIconKey,
	matchesPackagedExecutable,
	mergeTrayApps,
	sameBrowserProfile,
	selectDockTrayApps,
	type AppInfo,
	type TrayApp
} from "./dockApps";
import { driveLetter, hideDrive, removeCustomFolder, type DockExtra } from "./dockExtras";
import { createRegionSender, measureElements, padRect, type RegionRect } from "./windowRegion";

// Host processes (Edge/Chrome/Brave/ApplicationFrameHost) run every PWA/UWP
// window, so their window title must be part of their identity — otherwise two
// PWAs running under the same browser collapse into a single dock item.
const HOST_PROCESSES = ["msedge.exe", "chrome.exe", "brave.exe", "applicationframehost.exe"];
export function isBrowserHost(path: string) {
	const p = path.toLowerCase();
	return HOST_PROCESSES.some((host) => p.includes(host));
}

// Stable identity for a dock item.
export function appIdentity(p: string, executable?: string, name?: string, profile?: string) {
	if (!p) return "";
	const normalized = p.toLowerCase().replace(/\\/g, "/");
	// Shell application ids (AUMIDs) and bare names are unique on their own.
	if (!normalized.includes("/")) return normalized;
	// Each profile of a multi-profile browser is its own item, identified by
	// its directory so a renamed profile keeps its pin. Mirrors the backend's
	// window_group_key.
	if (profile && isBrowserHost(normalized)) {
		return `${normalized}:profile:${profile.toLowerCase()}`;
	}
	if (name && isBrowserHost(normalized)) {
		return `${normalized}:${name.toLowerCase()}`;
	}
	if (executable) return `${normalized}:${executable.toLowerCase()}`;
	return normalized;
}

const itemKey = (app: AppInfo) => appIdentity(app.path, app.executable, app.name, app.profile);

// WinEvent notifications can arrive for windows that do not change the dock.
// Keep the existing array when its visible content is identical so Framer
// Motion does not restart dock layout work on every notification.
function sameRunningApps(left: AppInfo[], right: AppInfo[]): boolean {
	return (
		left.length === right.length &&
		left.every((app, index) => {
			const next = right[index];
			return (
				app.name === next.name &&
				app.path === next.path &&
				app.icon === next.icon &&
				app.is_running === next.is_running &&
				app.is_background === next.is_background &&
				app.hwnd === next.hwnd &&
				app.executable === next.executable &&
				(app.tray_ids?.join("\0") ?? "") === (next.tray_ids?.join("\0") ?? "") &&
				JSON.stringify(app.all_hwnds ?? []) === JSON.stringify(next.all_hwnds ?? [])
			);
		})
	);
}

// Fuzzy identity: a running window and its installed/pinned entry often carry
// different paths (exe vs .lnk vs AUMID), so exact keys miss and the same app
// looks pinnable twice. Mirrors the dock list's own pinned↔running matching.
export function isSameApp(a: AppInfo, b: AppInfo): boolean {
	if (!a.path || !b.path) return false;
	if (itemKey(a) === itemKey(b)) return true;
	// Two browser profiles are separate apps even though they share an exe.
	if (!sameBrowserProfile(a, b)) return false;
	if (matchesPackagedExecutable(a, b)) return true;
	// Browser hosts run many apps under one exe — only the full identity
	// (which folds in the window/AUMID name) can match those.
	if (isBrowserHost(a.path) || isBrowserHost(b.path)) return false;
	const aId = isIdentifier(a.path);
	const bId = isIdentifier(b.path);
	// Two opaque shell ids match only exactly (checked above).
	if (aId && bId) return false;
	if (aId !== bId) {
		// One side is a shell id (AUMID), the other a file path. AUMIDs embed
		// the product name (ZedIndustries.Zed, com.squirrel.Figma.Figma), so
		// match on overlapping display names plus id/stem cross-containment.
		// This is the common shape: installed entries come from the AppsFolder
		// scan (AUMID) while pinned entries are exe/.lnk paths.
		const fileSide = aId ? b : a;
		const idLower = (aId ? a : b).path.toLowerCase();
		const na = a.name.toLowerCase();
		const nb = b.name.toLowerCase();
		if (na !== nb && !na.includes(nb) && !nb.includes(na)) return false;
		const stem = (fileSide.executable?.toLowerCase() || fileOf(fileSide.path)).replace(
			/\.(exe|lnk)$/,
			""
		);
		return stem.length >= 3 && idLower.includes(stem);
	}
	if (appIdentity(a.path) === appIdentity(b.path)) return true;
	const normExe = (s: string) => (s.endsWith(".exe") ? s : `${s}.exe`);
	const aExe = a.executable?.toLowerCase() || fileOf(a.path);
	const bExe = b.executable?.toLowerCase() || fileOf(b.path);
	if (!aExe || !bExe) return false;
	return normExe(aExe) === normExe(bExe);
}

const fileOf = (p: string) =>
	(p.split("/").pop()?.split("\\").pop()?.toLowerCase() || "").replace(/\.lnk$/, "");

// Shell application ids (AUMIDs) identify one specific app; two different PWAs
// running in the same browser must never be matched by their shared exe name.
const isIdentifier = (p: string) => !p.includes("/") && !p.includes("\\");

// Resolve the configured start-button icon to a public asset, or to the data
// URI of a user-uploaded icon (stored with a "custom:" prefix).
// Task View's glyph: a window in front of another, as on the taskbar.
function TaskViewIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round">
			<rect x="3.5" y="7.5" width="13" height="13" rx="3" />
			<path d="M8 3.5h9.5a3 3 0 0 1 3 3V16" />
		</svg>
	);
}

function resolveStartIcon(startIcon: string): string {
	if (startIcon === "bloom-colorful") return "/bloom-colorful.png";
	if (startIcon === "bloom-golden") return "/bloom-golden.png";
	if (startIcon === "bloom-biscuit") return "/bloom-biscuit.png";
	if (startIcon === "windows") return "/windows-11.png";
	if (startIcon.startsWith("custom:")) return startIcon.slice("custom:".length);
	return "/bloom.png";
}

// Stable module-level constants so object references never change between renders,
// preventing Framer Motion from re-triggering animations on every re-render.
const ITEM_ENTRY_TRANSITION = {
	opacity: { duration: 0.15, delay: 0.15 },
	scale: { type: "spring" as const, stiffness: 400, damping: 25, delay: 0.15 }
};
const ITEM_INITIAL = { opacity: 0, scale: 0 };
const ITEM_ANIMATE = { opacity: 1, scale: 1 };
const ITEM_EXIT = { opacity: 0, scale: 0 };

// The Command Center panel's views: its tiles, or a tile's own list.
type CommandCenterView = "main" | "wifi" | "bluetooth";

// What the webview's Battery Status API hands back, as far as the corner
// pill reads it.
interface BatteryManagerLike extends EventTarget {
	level: number;
	charging: boolean;
}

// Reorder value for the divider between pinned and running icons. No
// itemKey can contain a NUL, so it never collides with an app.
const PIN_DIVIDER = "\0pin-divider";

// A pin keeps the app's identity but none of its running window state.
const toPin = (app: AppInfo): AppInfo => ({
	...app,
	is_pinned: true,
	is_running: false,
	hwnd: undefined
});

// Reorder.Group ignores further moves after proposing an order until it
// renders again. A refused proposal changes no dock state, so this re-renders
// just the group (its children bail out) to keep the drag responsive.
function DockReorderGroup({
	values,
	onReorder,
	className,
	children
}: {
	values: string[];
	onReorder: (next: string[]) => boolean;
	className?: string;
	children: ReactNode;
}) {
	const [, rearm] = useReducer((n: number) => n + 1, 0);
	return (
		<Reorder.Group
			as="div"
			axis="x"
			values={values}
			className={className}
			onReorder={(next: string[]) => {
				if (!onReorder(next)) rearm();
			}}
		>
			{children}
		</Reorder.Group>
	);
}

// One dot per open window, capped at three.
function WindowDots({ count, background }: { count: number; background?: boolean }) {
	return (
		<div
			className="window-dots"
			role="img"
			aria-label={background ? "Running in background" : `${count} open windows`}
		>
			{Array.from({ length: background ? 1 : Math.min(Math.max(count, 1), 3) }, (_, i) => (
				<div key={i} className={`active-indicator${background ? " background-indicator" : ""}`} />
			))}
		</div>
	);
}

const Dock = memo(function Dock() {
	useEffect(() => {
		return initTheme();
	}, []);

	const [pinnedApps, setPinnedApps] = useState<AppInfo[]>([]);
	const [activeApps, setActiveApps] = useState<AppInfo[]>([]);
	const iconsRef = useRef<Record<string, string>>({});
	const pendingIconsRef = useRef(new Set<string>());
	const iconGenerationRef = useRef(0);
	const [, setIconsTick] = useState(0);
	const [dockMode, setDockMode] = useState(() => {
		const raw = localStorage.getItem("bloom-dock-mode") || "smart";
		if (raw === "auto-hide") return "smart";
		return raw;
	});
	const [dockPreviewEnabled, setDockPreviewEnabled] = useState(
		() => localStorage.getItem("bloom-dock-preview-enabled") !== "false"
	);
	const [dockShowBackgroundApps, setDockShowBackgroundApps] = useState(
		() => localStorage.getItem("bloom-dock-show-background-apps") !== "false"
	);
	const [edgeShineEnabled, setEdgeShineEnabled] = useState(
		() => localStorage.getItem("bloom-edge-shine-enabled") !== "false"
	);
	const [dockIconOnly, setDockIconOnly] = useState(
		() => localStorage.getItem("bloom-dock-icon-only") === "true"
	);
	const [dockSeparatorEnabled, setDockSeparatorEnabled] = useState(
		() => localStorage.getItem("bloom-dock-separator-enabled") !== "false"
	);
	const [dockAdaptive, setDockAdaptive] = useState(
		() => localStorage.getItem("bloom-dock-adaptive") === "true"
	);
	const [dockTaskView, setDockTaskView] = useState(
		() => localStorage.getItem("bloom-dock-task-view") === "true"
	);
	const [startIcon, setStartIcon] = useState(
		() => localStorage.getItem("bloom-start-icon") || "default"
	);
	const [dockExtrasPosition, setDockExtrasPosition] = useState(
		() => localStorage.getItem("bloom-dock-extras-position") || "off"
	);
	const [dockExtras, setDockExtras] = useState<DockExtra[]>([]);
	const [dockExtrasRevision, setDockExtrasRevision] = useState(0);
	const [isMaximized, setIsMaximized] = useState(false);
	const [previewData, setPreviewData] = useState<{
		id: string;
		previews: { hwnd: number; title: string; image: string }[];
	} | null>(null);
	const [isDockHovered, setIsDockHovered] = useState(false);
	const [isEdgeHovered, setIsEdgeHovered] = useState(false);
	const [isOverlapped, setIsOverlapped] = useState(false);
	const [systemVisible, setIsVisible] = useState(true);
	const [shellInteraction, setShellInteraction] = useState(false);
	const isVisible = systemVisible || shellInteraction;
	const [showAddPopup, setShowAddPopup] = useState(false);
	const [nativeMenuOpen, setNativeMenuOpen] = useState(false);
	// The Command Center in the bottom-right corner, unless Settings puts it in
	// the notch. ccView is null while the panel is closed, else the view shown.
	const [commandCenterLocation, setCommandCenterLocation] = useState(() =>
		readCommandCenterLocation(localStorage.getItem("bloom-command-center-location"))
	);
	const commandCenterInDock = commandCenterLocation === "dock";
	const [ccView, setCcView] = useState<CommandCenterView | null>(null);
	const ccOpen = ccView !== null;
	const [isCornerHovered, setIsCornerHovered] = useState(false);
	const [cornerWidth, setCornerWidth] = useState(0);
	const cornerSlotRef = useRef<HTMLDivElement>(null);
	const ccAnchorRef = useRef<HTMLDivElement>(null);
	// For the panel's Notch Mode tile.
	const [notchMode, setNotchMode] = useState(() => {
		const raw = localStorage.getItem("bloom-notch-mode") || "fixed";
		return raw === "auto-hide" ? "smart" : raw;
	});
	const quickControls = useQuickControls({ panelOpen: ccOpen, watchBatterySaver: ccOpen });
	const reduceMotion = useReducedMotion();
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		app: AppInfo | null;
		extra?: DockExtra | null;
		taskView?: boolean;
	} | null>(null);
	const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
	const [activeOrder, setActiveOrder] = useState<string[]>([]);
	const observedTrayPathsRef = useRef(new Set<string>());
	// The icon being dragged, and the order it has produced so far (pinned keys,
	// PIN_DIVIDER, running keys). Nothing is saved until the drop.
	const [draggingKey, setDraggingKey] = useState<string | null>(null);
	const isDragging = draggingKey !== null;
	const [dragOrder, setDragOrder] = useState<string[] | null>(null);
	const dragOrderRef = useRef<string[] | null>(null);
	const dragMovedRef = useRef(false);
	const [hoveredApp, setHoveredApp] = useState<string | null>(null);
	const [pressedApp, setPressedApp] = useState<string | null>(null);
	const [isReady, setIsReady] = useState(false);
	const [isImpacted, setIsImpacted] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [startupAnimating, setStartupAnimating] = useState(false);
	const [customIcons, setCustomIcons] = useState<Record<string, string>>({});
	const [toast, setToast] = useState<string | null>(null);
	const iconPickerTargetRef = useRef<string | null>(null);
	const toastTimerRef = useRef<any>(null);
	const dockRef = useRef<HTMLDivElement>(null);
	const [popupBottom, setPopupBottom] = useState(56);
	const pinnedItemsRef = useRef<AppInfo[]>([]);
	const handleAppClickRef = useRef<(app: AppInfo) => void>(() => {});
	const [scale, setScale] = useState(() =>
		parseFloat(localStorage.getItem("bloom-scale") || "1.0")
	);
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

	useEffect(() => {
		const onResize = () => setViewportWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	// Measure the dock pill when the popup opens; the card tucks ~14px
	// behind the pill (which paints above it), so the seam stays fused even
	// if the measurement is off by a few px at some scale.
	useEffect(() => {
		if (showAddPopup) {
			const h = dockRef.current?.getBoundingClientRect().height ?? 0;
			if (h > 0) setPopupBottom(h / (scale || 1) - 14);
		}
	}, [showAddPopup, scale]);

	const isCurrentlyHovered = isDockHovered || isEdgeHovered || isCornerHovered;
	const [interactionState, setInteractionState] = useState<"active" | "grace" | "none">("none");
	const isAnyInteraction =
		isCurrentlyHovered || !!contextMenu || showAddPopup || nativeMenuOpen || ccOpen;

	const previewTimerRef = useRef<any>(null);
	const isPreviewHoveredRef = useRef(false);
	const hoveredAppRef = useRef<string | null>(null);

	useEffect(() => {
		if (isAnyInteraction) {
			setInteractionState("active");
		} else if (interactionState !== "none") {
			setInteractionState("grace");
			const timer = setTimeout(() => setInteractionState("none"), 800);
			return () => clearTimeout(timer);
		}
	}, [isAnyInteraction]);

	const isHidden =
		!startupAnimating &&
		((dockMode === "smart" && isOverlapped && interactionState === "none") ||
			(dockMode === "peek" && interactionState === "none"));

	// Adaptive mode (fixed dock only): stretch into a full-width taskbar while a
	// standard maximized window is in the foreground, so the reserved strip no
	// longer looks like a cut-out around the centered pill.
	const isAdaptive =
		dockAdaptive && dockMode === "fixed" && isMaximized && isExpanded && !isHidden && isVisible;
	// Nearly full width — 24px margin per side at the visual (scaled) size.
	// Pre-transform: visual = width * scale, so width = (viewport - 48*scale) / scale.
	// The bar stays centred, so clearing the Command Center's corner pill takes
	// the pill's width (plus room for both flares) off each side.
	const cornerReserve = commandCenterInDock && cornerWidth > 0 ? cornerWidth + 40 * scale : 0;
	const adaptiveWidth = (viewportWidth - 48 * scale - 2 * cornerReserve) / scale;
	// The corner pill comes and goes with the bar itself.
	const cornerShown = commandCenterInDock && isReady && isExpanded && isVisible && !isHidden;

	useEffect(() => {
		let cleared = false;

		const checkVisibility = async (): Promise<boolean> => {
			try {
				const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
				const visible = await getCurrentWebviewWindow().isVisible();
				if (visible) {
					setStartupAnimating(true);
					setIsReady(true);
					setTimeout(() => setIsImpacted(true), 280);
					setTimeout(() => setIsExpanded(true), 350);
					setTimeout(() => setStartupAnimating(false), 1500);
					return true;
				}
			} catch (_) {}
			return false;
		};

		// Keep polling until visible — no time cap, since the dock can be
		// enabled at runtime from settings after any delay.
		const interval = setInterval(async () => {
			if (cleared) return;
			if (await checkVisibility()) {
				clearInterval(interval);
				cleared = true;
			}
		}, 200);

		// Also attempt immediately
		checkVisibility().then((ok) => {
			if (ok) {
				clearInterval(interval);
				cleared = true;
			}
		});

		return () => {
			clearInterval(interval);
			cleared = true;
		};
	}, []);

	useEffect(() => {
		const updateRect = () => {
			if (dockRef.current) {
				const rect = dockRef.current.getBoundingClientRect();
				const hasPreview = !!previewData;
				const content = dockRef.current.querySelector<HTMLElement>(".dock-reorder-container");
				const style = getComputedStyle(dockRef.current);
				const overlap = content
					? dockOverlapSpan(
							window.innerWidth,
							content.scrollWidth,
							parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
							scale
						)
					: null;
				invoke("update_dock_rect", {
					rect: {
						x: Math.round(rect.x) - (hasPreview ? 500 : 0),
						y: Math.round(rect.y) - (hasPreview ? 320 : 0),
						width: Math.round(rect.width) + (hasPreview ? 1000 : 0),
						height: Math.round(rect.height) + (hasPreview ? 320 : 0)
					},
					overlapRect: overlap
						? { ...overlap, y: Math.round(rect.y), height: Math.round(rect.height) }
						: null
				}).catch(() => {});
			}
		};

		updateRect();
		window.addEventListener("resize", updateRect);
		const observer = new ResizeObserver(updateRect);
		if (dockRef.current) observer.observe(dockRef.current);
		const content = dockRef.current?.querySelector(".dock-reorder-container");
		if (content) observer.observe(content);

		return () => {
			window.removeEventListener("resize", updateRect);
			observer.disconnect();
		};
	}, [pinnedApps, activeApps, isHidden, isExpanded, previewData, scale]);

	useEffect(() => {
		const init = async () => {
			const settings: any = await invoke("load_settings").catch(() => ({}));
			if (await reloadIfMirrorWasStale(settings)) return;
			const getVal = (key: string, fallback: string | null = null) => {
				const val = settings[key];
				if (val !== undefined && val !== null) return String(val);
				const local = localStorage.getItem(key);
				if (local !== null) return local;
				return fallback;
			};

			const dMode = getVal("bloom-dock-mode", "smart");
			if (dMode) {
				const mapped = dMode === "auto-hide" ? "smart" : dMode;
				setDockMode(mapped);
			}

			const preview = getVal("bloom-dock-preview-enabled", "true");
			setDockPreviewEnabled(preview === "true");
			setDockShowBackgroundApps(getVal("bloom-dock-show-background-apps") !== "false");
			setEdgeShineEnabled(getVal("bloom-edge-shine-enabled", "true") !== "false");

			const iconOnly = getVal("bloom-dock-icon-only", "false");
			setDockIconOnly(iconOnly === "true");

			const separator = getVal("bloom-dock-separator-enabled", "true");
			setDockSeparatorEnabled(separator === "true");

			const adaptive = getVal("bloom-dock-adaptive", "false");
			setDockAdaptive(adaptive === "true");
			setDockTaskView(getVal("bloom-dock-task-view", "false") === "true");

			const startIconVal = getVal("bloom-start-icon", "default") || "default";
			setStartIcon(startIconVal);

			const extrasPosition = getVal("bloom-dock-extras-position", "off");
			if (extrasPosition) setDockExtrasPosition(extrasPosition);

			setCommandCenterLocation(
				readCommandCenterLocation(getVal("bloom-command-center-location", "dock"))
			);
			const nMode = getVal("bloom-notch-mode", "fixed") || "fixed";
			setNotchMode(nMode === "auto-hide" ? "smart" : nMode);

			const scaleVal = getVal("bloom-scale");
			if (scaleVal !== null) setScale(parseFloat(scaleVal));

			const pinned = await invoke<AppInfo[]>("load_pinned_apps");
			setPinnedApps(pinned.map((a) => ({ ...a, is_pinned: true })));
			pinned.forEach((app) => fetchIcon(app.path, app.name, undefined, app.profile));

			// Warm the installed-apps cache in the background so the add-app
			// popup opens with data ready instead of waiting on the scan.
			invoke<AppInfo[]>("get_installed_apps").catch(() => {});

			// Load custom icons
			try {
				const icons = await invoke<Record<string, string>>("get_custom_icons");
				setCustomIcons(icons);
			} catch (_) {}
		};
		init();

		// The installed-apps scan finishes after the first load; pins saved under
		// their executable's name then get their Start menu name.
		const unlistenInstalledApps = listen("installed-apps-updated", async () => {
			try {
				const refreshed = await invoke<AppInfo[]>("load_pinned_apps");
				const names = new Map(refreshed.map((a) => [a.path, a.name]));
				setPinnedApps((prev) => {
					const next = prev.map((a) => ({ ...a, name: names.get(a.path) ?? a.name }));
					if (!next.some((a, i) => a.name !== prev[i].name)) return prev;
					// Pins are otherwise saved only when they change; keep the names.
					queueMicrotask(() => {
						invoke("save_pinned_apps", { apps: next }).catch(console.error);
					});
					return next;
				});
			} catch (_) {}
		});

		const unlistenOverlap = listen<boolean>("dock-overlap", (event) => {
			setIsOverlapped(event.payload);
		});

		const unlistenEdgeHover = listen<boolean>("dock-edge-hover", (event) => {
			setIsEdgeHovered(event.payload);
		});

		const unlistenVisibility = listen<boolean>("visibility-change", (event) => {
			setIsVisible(event.payload);
		});

		const unlistenMaximized = listen<boolean>("dock-maximized", (event) => {
			setIsMaximized(event.payload);
		});

		return () => {
			unlistenOverlap.then((f) => f());
			unlistenInstalledApps.then((f) => f());
			unlistenEdgeHover.then((f) => f());
			unlistenVisibility.then((f) => f());
			unlistenMaximized.then((f) => f());
		};
	}, []);

	useSettingsSync({
		"bloom-dock-mode": setDockMode,
		"bloom-dock-preview-enabled": setDockPreviewEnabled,
		"bloom-dock-show-background-apps": { set: setDockShowBackgroundApps, defaultValue: true },
		"bloom-edge-shine-enabled": setEdgeShineEnabled,
		"bloom-dock-icon-only": setDockIconOnly,
		"bloom-dock-separator-enabled": setDockSeparatorEnabled,
		"bloom-dock-adaptive": setDockAdaptive,
		"bloom-dock-task-view": setDockTaskView,
		"bloom-start-icon": setStartIcon,
		"bloom-scale": setScale,
		"bloom-dock-extras-position": setDockExtrasPosition,
		"bloom-command-center-location": {
			set: (value: unknown) => setCommandCenterLocation(readCommandCenterLocation(value)),
			defaultValue: "dock"
		},
		"bloom-notch-mode": (value: unknown) =>
			setNotchMode(value === "auto-hide" ? "smart" : String(value)),
		"bloom-dock-extras-drives": () => setDockExtrasRevision((r) => r + 1),
		"bloom-dock-extras-recycle-bin": () => setDockExtrasRevision((r) => r + 1),
		"bloom-dock-extras-hidden-drives": () => setDockExtrasRevision((r) => r + 1),
		"bloom-dock-extras-folders": () => setDockExtrasRevision((r) => r + 1),
		"bloom-dock-extras-custom-folders": () => setDockExtrasRevision((r) => r + 1)
	});

	useEffect(() => {
		if (dockExtrasPosition === "off") {
			setDockExtras([]);
			return;
		}
		let stopped = false;
		let loadSeq = 0;
		const load = async () => {
			const seq = ++loadSeq;
			try {
				const extras = await invoke<DockExtra[]>("get_dock_extras");
				// A slow load must never overwrite a newer one that already landed.
				if (!stopped && seq === loadSeq) setDockExtras(extras);
			} catch (e) {
				console.error("Failed to load dock extras:", e);
			}
		};
		load();

		// Drives can be plugged in or removed at any time; converge like the
		// window list does instead of trusting a one-shot fetch.
		const interval = setInterval(load, 10000);
		return () => {
			stopped = true;
			clearInterval(interval);
		};
	}, [dockExtrasPosition, dockExtrasRevision]);

	useEffect(() => {
		let pollSeq = 0;
		let stopped = false;

		const poll = async () => {
			if (isDragging) return;
			const seq = ++pollSeq;
			let windows: AppInfo[];
			let tray: TrayApp[];
			try {
				[windows, tray] = await Promise.all([
					invoke<AppInfo[]>("get_active_windows"),
					invoke<TrayApp[]>("get_tray_apps").catch(() => [])
				]);
			} catch (error) {
				console.error("Failed to refresh dock apps:", error);
				return;
			}
			// Ignore responses that arrive out of order: an older poll must never
			// overwrite a newer state, which would resurrect closed apps.
			if (stopped || seq !== pollSeq) return;
			const selected = selectDockTrayApps(windows, tray, observedTrayPathsRef.current, (app) =>
				pinnedApps.some((pinned) =>
					isSameApp(pinned, {
						name: app.name,
						path: app.path,
						icon: null,
						is_running: true,
						executable: fileOf(app.path)
					})
				)
			);
			observedTrayPathsRef.current = selected.observed;
			const running = mergeTrayApps(windows, selected.visible);
			setActiveApps((prev) => (sameRunningApps(prev, running) ? prev : running));

			setActiveOrder((prev) => {
				const newPaths = running.map(itemKey);
				const existingPaths = prev.filter((p) => newPaths.includes(p));
				const addedPaths = newPaths.filter((p) => !prev.includes(p));
				const next = [...existingPaths, ...addedPaths];
				return next.length === prev.length && next.every((path, i) => path === prev[i])
					? prev
					: next;
			});

			pinnedApps.forEach((app) => fetchIcon(app.path, app.name, undefined, app.profile));
			running.forEach((app) => fetchIcon(app.path, app.name, app.hwnd, app.profile));
		};

		poll();

		const unlistenWindowChange = listen("windows-changed", () => {
			poll();
		});

		// Safety net: even if a window event is missed, converge on the real state
		const interval = setInterval(poll, 10000);

		return () => {
			stopped = true;
			clearInterval(interval);
			unlistenWindowChange.then((f) => f());
		};
	}, [isDragging, pinnedApps]);

	const fetchIcon = async (path: string, name?: string, hwnd?: number, profile?: string) => {
		const isHost = isBrowserHost(path);
		const cacheKey =
			isHost && name ? `${path}:${name.toLowerCase()}` : hwnd ? `${path}-${hwnd}` : path;

		if (iconsRef.current[cacheKey] || pendingIconsRef.current.has(cacheKey)) return;
		pendingIconsRef.current.add(cacheKey);
		const generation = iconGenerationRef.current;
		try {
			const icon = await invoke<string | null>("get_app_icon", {
				path,
				name: name || null,
				hwnd: hwnd || null,
				profile: profile || null
			});
			if (icon && generation === iconGenerationRef.current) {
				iconsRef.current[cacheKey] = icon;
				if (!isHost) iconsRef.current[path] = icon;
				setIconsTick((t) => t + 1);
			}
		} catch (e) {
			console.error(`Failed to fetch icon for ${path}:`, e);
		} finally {
			// Window changes and the existing poll retry missing icons. Only an
			// actual in-flight request is excluded; no timer can retain a stale HWND.
			if (generation === iconGenerationRef.current) pendingIconsRef.current.delete(cacheKey);
		}
	};

	const handleClearIconCache = async () => {
		try {
			await invoke("clear_icon_cache");
			iconGenerationRef.current += 1;
			pendingIconsRef.current.clear();
			iconsRef.current = {};
			setIconsTick((t) => t + 1);
			pinnedApps.forEach((app) => fetchIcon(app.path, app.name, undefined, app.profile));
		} catch (e) {
			console.error("Failed to clear icon cache:", e);
		}
	};

	const handleIconFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		const target = iconPickerTargetRef.current;
		if (!file || !target) return;

		const reader = new FileReader();
		reader.onload = async () => {
			const dataUri = reader.result as string;
			try {
				const newIcon = await invoke<string>("set_custom_icon", {
					cacheKey: target,
					iconData: dataUri
				});
				setCustomIcons((prev) => ({ ...prev, [target]: newIcon }));
			} catch (err) {
				const msg = typeof err === "string" ? err : "Failed to set icon";
				if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
				setToast(msg);
				toastTimerRef.current = setTimeout(() => setToast(null), 4000);
			}
		};
		reader.readAsDataURL(file);
		e.target.value = "";
	};

	const handleRemoveCustomIcon = async (app: AppInfo) => {
		try {
			await invoke("remove_custom_icon", { path: app.path, name: app.name || null });
			const isHost = isBrowserHost(app.path);
			const ck =
				isHost && app.name
					? `${app.path}:${app.name.toLowerCase()}`
					: app.hwnd
						? `${app.path}-${app.hwnd}`
						: app.path;
			setCustomIcons((prev) => {
				const next = { ...prev };
				delete next[ck];
				delete next[app.path];
				return next;
			});
			// Invalidate only this app's cached icon and re-fetch only this app
			delete iconsRef.current[ck];
			delete iconsRef.current[app.path];
			if (app.hwnd) delete iconsRef.current[`${app.path}-${app.hwnd}`];
			setIconsTick((t) => t + 1);
			fetchIcon(app.path, app.name, app.hwnd, app.profile);
		} catch (err) {
			console.error("Failed to remove custom icon:", err);
		}
	};

	const handleClosePreview = async (e: React.MouseEvent, hwnd: number) => {
		e.stopPropagation();
		try {
			await invoke("close_window", { hwnd });
			setPreviewData((prev) => {
				if (!prev) return null;
				const remaining = prev.previews.filter((p) => p.hwnd !== hwnd);
				if (remaining.length === 0) {
					setHoveredApp(null);
					return null;
				}
				return { ...prev, previews: remaining };
			});
		} catch (err) {
			console.error("Failed to close window:", err);
		}
	};

	const handleAppClick = async (app: AppInfo) => {
		try {
			if (app.path === "start") {
				await invoke("open_app", { appName: "start" });
			} else if (app.is_background && app.tray_ids?.length === 1) {
				await invoke("activate_tray_icon", { trayId: app.tray_ids[0] });
			} else if (app.all_hwnds && app.all_hwnds.length > 1) {
				// Several windows: bring the most recent forward, then cycle.
				await invoke("focus_app_windows", { hwnds: app.all_hwnds.map(([hwnd]) => hwnd) });
			} else if (app.hwnd) {
				await invoke("focus_window", { hwnd: app.hwnd });
			} else {
				await invoke("open_app", { appName: app.path, profile: app.profile ?? null });
			}
		} catch (e) {
			console.error(`Failed to interact with ${app.name}:`, e);
			showActionError(e);
		}
	};

	const handleNewInstance = async (app: AppInfo) => {
		if (!app || app.path === "start") return;
		try {
			await invoke("launch_new_instance", {
				appPath: app.path,
				appName: app.name,
				profile: app.profile ?? null
			});
		} catch (e) {
			console.error(`Failed to launch a new instance of ${app.name}:`, e);
		}
	};

	// Middle-click opens a new instance, matching the native taskbar. The
	// mousedown preventDefault suppresses Chromium's autoscroll cursor.
	const handleMiddleClick = (e: React.MouseEvent, app: AppInfo) => {
		if (e.button !== 1) return;
		e.preventDefault();
		e.stopPropagation();
		handleNewInstance(app);
	};

	const togglePin = async (app: AppInfo) => {
		let newPinned;
		if (app.is_pinned) {
			newPinned = pinnedApps.filter((a) => itemKey(a) !== itemKey(app));
		} else {
			// Fuzzy guard: the same app pinned via another entry shape (running
			// window vs installed shortcut) must never create a duplicate.
			if (pinnedApps.some((a) => isSameApp(a, app))) return;
			newPinned = [...pinnedApps, toPin(app)];
			fetchIcon(app.path, app.name, undefined, app.profile);
		}
		setPinnedApps(newPinned);
		await invoke("save_pinned_apps", { apps: newPinned });
		closeMenu();
	};

	const menuRef = useRef<HTMLDivElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);

	const showActionError = (error: unknown) => {
		if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		setToast(typeof error === "string" ? error : "Could not complete this action.");
		toastTimerRef.current = setTimeout(() => setToast(null), 5000);
	};

	const openTrayMenu = async (trayId: string) => {
		setNativeMenuOpen(true);
		closeMenu();
		setPreviewData(null);
		try {
			// DOCK_RECT can still include the preview's padded hit area until
			// the next render. Publish the actual bar before placing its menu.
			const bar = dockRef.current?.getBoundingClientRect();
			if (bar) {
				await invoke("update_dock_rect", {
					rect: {
						x: Math.round(bar.x),
						y: Math.round(bar.y),
						width: Math.round(bar.width),
						height: Math.round(bar.height)
					}
				});
			}
			await invoke("show_tray_context_menu", { trayId });
		} catch (error) {
			showActionError(error);
		} finally {
			setNativeMenuOpen(false);
		}
	};

	const handleContextMenu = (e: React.MouseEvent, app: AppInfo | null) => {
		e.stopPropagation();
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, app });
	};

	const handleExtraClick = (extra: DockExtra) => {
		invoke("open_dock_extra", { kind: extra.kind, path: extra.path }).catch(showActionError);
	};

	const handleExtraContextMenu = (e: React.MouseEvent, extra: DockExtra) => {
		e.stopPropagation();
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, app: null, extra });
	};

	const ejectExtra = (extra: DockExtra) => {
		closeMenu();
		invoke("eject_dock_extra", { path: extra.path }).catch(showActionError);
	};

	const removeExtraFromDock = (extra: DockExtra) => {
		const next = removeCustomFolder(
			localStorage.getItem("bloom-dock-extras-custom-folders"),
			extra.path
		);
		localStorage.setItem("bloom-dock-extras-custom-folders", next);
		invoke("save_setting", {
			key: "bloom-dock-extras-custom-folders",
			value: next
		}).catch(console.error);
		closeMenu();
	};

	// Settings > Dock > Drives shows it again.
	const hideDriveFromDock = (extra: DockExtra) => {
		const letter = driveLetter(extra);
		if (!letter) return;
		const next = hideDrive(localStorage.getItem("bloom-dock-extras-hidden-drives"), letter);
		localStorage.setItem("bloom-dock-extras-hidden-drives", next);
		invoke("save_setting", { key: "bloom-dock-extras-hidden-drives", value: next }).catch(
			showActionError
		);
		closeMenu();
	};

	const openTaskView = () => {
		invoke("open_system_action", { action: "task-view" }).catch(showActionError);
	};

	// Like the taskbar's "Hide Task View button"; Settings turns it back on.
	const hideTaskView = () => {
		setDockTaskView(false);
		localStorage.setItem("bloom-dock-task-view", "false");
		invoke("save_setting", { key: "bloom-dock-task-view", value: "false" }).catch(
			showActionError
		);
		closeMenu();
	};

	// Measured before paint: the menu's height depends on which items it shows,
	// so it opens just above the cursor and stays inside the dock window.
	// Positions are in visual pixels; the menu's CSS zoom scales left/top.
	const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		if (!contextMenu || !menuRef.current) {
			setMenuPos(null);
			return;
		}
		const margin = 8;
		const r = menuRef.current.getBoundingClientRect();
		setMenuPos({
			left: Math.max(margin, Math.min(contextMenu.x, window.innerWidth - r.width - margin)),
			top: Math.max(margin, contextMenu.y - r.height - margin)
		});
	}, [contextMenu, scale]);

	// Any press elsewhere in the dock closes the Command Center too, the way a
	// taskbar click closes Windows' quick settings.
	const closeMenu = () => {
		setContextMenu(null);
		setActiveSubmenu(null);
		setCcView(null);
		invoke("set_menu_open", { open: false, rect: null }).catch(() => {});
	};

	const closePopup = () => {
		setShowAddPopup(false);
		invoke("set_menu_open", { open: false, rect: null }).catch(() => {});
	};

	// A press outside the dock while a menu or the Add App popup is open. The
	// click itself goes to whatever is under it (the window region keeps the
	// dock out of the way), so the backend's mouse hook reports it instead.
	useEffect(() => {
		const unlisten = listen("dock-dismiss-menu", () => {
			setContextMenu(null);
			setActiveSubmenu(null);
			setShowAddPopup(false);
			setCcView(null);
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, []);

	const openCommandCenter = (view: CommandCenterView) => {
		setContextMenu(null);
		setActiveSubmenu(null);
		setShowAddPopup(false);
		setPreviewData(null);
		setHoveredApp(null);
		setCcView(view);
	};
	const openCommandCenterRef = useRef(openCommandCenter);
	openCommandCenterRef.current = openCommandCenter;
	const commandCenterInDockRef = useRef(commandCenterInDock);
	commandCenterInDockRef.current = commandCenterInDock;
	const ccOpenRef = useRef(ccOpen);
	ccOpenRef.current = ccOpen;

	// Win+A from the backend's keyboard hook, and the notch's Bluetooth device
	// alert, whose device list now lives here.
	useEffect(() => {
		const unlistenToggle = listen("dock-command-center-toggle", () => {
			if (!commandCenterInDockRef.current) return;
			if (ccOpenRef.current) setCcView(null);
			else openCommandCenterRef.current("main");
		});
		const unlistenOpen = listen<string>("dock-command-center-open", ({ payload }) => {
			if (!commandCenterInDockRef.current) return;
			openCommandCenterRef.current(payload === "wifi" || payload === "bluetooth" ? payload : "main");
		});
		return () => {
			unlistenToggle.then((f) => f());
			unlistenOpen.then((f) => f());
		};
	}, []);

	useEffect(() => {
		if (!commandCenterInDock) setCcView(null);
	}, [commandCenterInDock]);

	// One popup at a time: a right-click menu or the Add App popup replaces the
	// panel, since the backend's hit rect only follows one of them.
	useEffect(() => {
		if (contextMenu || showAddPopup) setCcView(null);
	}, [contextMenu, showAddPopup]);

	// Escape closes the panel. Keys only arrive once the dock has focus, which
	// it takes for typing a Wi-Fi password.
	useEffect(() => {
		if (!ccOpen) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setCcView(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [ccOpen]);

	// The dock is WS_EX_NOACTIVATE, so DOM focus alone gets no keystrokes. A
	// field that wants typing asks for the window's focus, then keeps its own.
	// Stable: the Wi-Fi and Bluetooth lists subscribe to events keyed on it.
	const focusDockForTyping = useCallback((pinned: boolean) => {
		if (!pinned) return;
		const field = document.activeElement as HTMLElement | null;
		getCurrentWebviewWindow()
			.setFocus()
			.then(() => field?.focus())
			.catch(console.error);
	}, []);

	// The tiles sit to the left of the Wi-Fi and Bluetooth lists: opening a list
	// slides it in from the right, and Back slides the tiles in from the left.
	const ccViewMotion = (side: 1 | -1) => ({
		initial: { opacity: 0, x: reduceMotion ? 0 : side * 18 },
		animate: { opacity: 1, x: 0 },
		exit: { opacity: 0, x: reduceMotion ? 0 : side * 18 },
		transition: { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] as const }
	});

	const cycleDockMode = (e: React.MouseEvent) => {
		e.stopPropagation();
		const next = nextBarMode(dockMode);
		setDockMode(next);
		void applyBarMode("dock", next);
	};

	const cycleNotchMode = (e: React.MouseEvent) => {
		e.stopPropagation();
		const next = nextBarMode(notchMode);
		setNotchMode(next);
		void applyBarMode("notch", next);
	};

	// The corner pill's battery, on devices that have one.
	const [battery, setBattery] = useState<{ level: number; charging: boolean } | null>(null);
	useEffect(() => {
		if (!commandCenterInDock) return;
		let cancelled = false;
		let stop = () => {};
		(async () => {
			try {
				const details = await invoke<BatteryDetails>("get_battery_details");
				if (cancelled || !details.present) return;
				const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
				const manager = await nav.getBattery?.();
				if (!manager || cancelled) return;
				const update = () =>
					setBattery({ level: Math.round(manager.level * 100), charging: manager.charging });
				update();
				manager.addEventListener("levelchange", update);
				manager.addEventListener("chargingchange", update);
				stop = () => {
					manager.removeEventListener("levelchange", update);
					manager.removeEventListener("chargingchange", update);
				};
			} catch (err) {
				console.error("Failed to read the battery for the corner pill:", err);
			}
		})();
		return () => {
			cancelled = true;
			stop();
		};
	}, [commandCenterInDock]);

	// The corner pill takes clicks only over itself (see set_dock_corner_rect),
	// and its width keeps an adaptive full-width bar clear of it.
	useEffect(() => {
		const slot = cornerSlotRef.current;
		if (!cornerShown || !slot) {
			invoke("set_dock_corner_rect", { rect: null }).catch(() => {});
			return;
		}
		const report = () => {
			const r = slot.getBoundingClientRect();
			setCornerWidth(r.width);
			invoke("set_dock_corner_rect", {
				rect: {
					x: Math.round(r.x),
					y: Math.round(r.y),
					width: Math.round(r.width),
					height: Math.round(r.height)
				}
			}).catch(() => {});
		};
		report();
		const observer = new ResizeObserver(report);
		observer.observe(slot);
		window.addEventListener("resize", report);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", report);
		};
	}, [cornerShown, scale]);

	// The tallest the expanded bar has been, which sets the region's bottom band.
	const dockBandHeightRef = useRef(0);
	const sendDockRegion = useMemo(
		() =>
			createRegionSender((rects) => {
				invoke("set_window_region", { rects }).catch(() => {});
			}),
		[]
	);

	// Clip the dock window to what it draws (see window_region.rs). The bar
	// gets a full-width band along the bottom, as tall as the expanded bar plus
	// room for the icons' lift and tooltips above it, so its reveal and width
	// animations are never clipped; the click-through switching still keeps
	// the band clear unless the cursor is at the dock. The floating parts are
	// measured, padded for their shadows. While an icon is dragged the whole
	// window is included so the dragged icon isn't clipped.
	useEffect(() => {
		const bar = dockRef.current?.getBoundingClientRect();
		if (bar && isExpanded && !isHidden && isVisible) {
			dockBandHeightRef.current = Math.max(dockBandHeightRef.current, bar.height);
		}
		const band = (dockBandHeightRef.current || 72 * scale) + 64 * scale;
		const wanted: RegionRect[] = [
			{ x: 0, y: window.innerHeight - band, width: window.innerWidth, height: band }
		];
		if (isDragging) {
			wanted.push({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
		}
		wanted.push(
			...measureElements([
				[".preview-tooltip", 40],
				[".context-menu", 34],
				[".submenu", 34],
				[".dock-toast", 20],
				// The anchor isn't transformed, so it holds the panel's final box
				// while the panel itself is still sliding up.
				[".cc-dock-anchor", 40]
			])
		);
		// The Add App popup grows from scaleY 0, and that animation doesn't
		// re-render the dock, so its own box would be measured collapsed. Its
		// anchor isn't transformed and is exactly as tall as the open popup, so
		// the height comes from there and the width from the popup itself.
		const popup = popupRef.current;
		const anchor = popup?.parentElement;
		if (popup && anchor) {
			const p = popup.getBoundingClientRect();
			const a = anchor.getBoundingClientRect();
			wanted.push(padRect({ x: p.left, y: a.top, width: p.width, height: a.height }, 40));
		}
		sendDockRegion(wanted);
	});

	useEffect(() => {
		let open = false;
		let rect = null;

		if (contextMenu && menuRef.current) {
			const r = menuRef.current.getBoundingClientRect();
			rect = {
				x: Math.round(r.x),
				y: Math.round(r.y),
				width: Math.round(r.width + (activeSubmenu ? 160 : 0)),
				height: Math.round(r.height)
			};
			open = true;
		} else if (showAddPopup && popupRef.current) {
			const r = popupRef.current.getBoundingClientRect();
			rect = {
				x: Math.round(r.x),
				y: Math.round(r.y),
				width: Math.round(r.width),
				height: Math.round(r.height)
			};
			open = true;
		} else if (ccOpen && ccAnchorRef.current) {
			const r = ccAnchorRef.current.getBoundingClientRect();
			rect = {
				x: Math.round(r.x),
				y: Math.round(r.y),
				width: Math.round(r.width),
				height: Math.round(r.height)
			};
			open = true;
		}

		invoke("set_menu_open", { open, rect }).catch(() => {});
	}, [contextMenu, menuPos, showAddPopup, pinnedApps, activeApps, activeSubmenu, scale, ccOpen]);

	const dockItems = useMemo(() => {
		const runningMap = new Map();
		activeApps.forEach((a) => {
			const id = itemKey(a);
			if (!runningMap.has(id)) runningMap.set(id, a);
		});

		const matchedRunningKeys = new Set<string>();

		// Fuzzy fallbacks never cross browser profiles: a plain browser pin
		// stands for the Default profile and a profile pin only for its own
		// profile. Among candidates, the Default profile's browser windows win
		// over a web app that happens to share the browser's exe.
		const findFuzzy = (p: AppInfo, matches: (a: AppInfo) => boolean) => {
			const candidates = activeApps.filter((a) => sameBrowserProfile(p, a) && matches(a));
			return candidates.find((a) => a.profile) ?? candidates[0];
		};

		const findRunningApp = (p: AppInfo) => {
			// 1. Try exact match by identity
			const id = itemKey(p);
			let running = runningMap.get(id);
			if (running) {
				matchedRunningKeys.add(itemKey(running));
				return running;
			}

			// 2. Try match by path (without executable)
			const pathId = appIdentity(p.path);
			running = runningMap.get(pathId);
			if (running && sameBrowserProfile(p, running)) {
				matchedRunningKeys.add(itemKey(running));
				return running;
			}

			// 3. Try fallback match by executable name if defined
			if (p.executable) {
				const targetExe = p.executable.toLowerCase();
				const found = findFuzzy(
					p,
					(a) => !isIdentifier(a.path) && a.executable?.toLowerCase() === targetExe
				);
				if (found) {
					matchedRunningKeys.add(itemKey(found));
					return found;
				}
			}

			// 4. Try fallback match by path's file name (e.g., if path is "msedge" and running app's executable is "msedge.exe")
			const pinFilename = p.path.split("/").pop()?.split("\\").pop()?.toLowerCase() || "";
			if (pinFilename) {
				const found = findFuzzy(p, (a) => {
					if (isIdentifier(a.path)) return false;
					const runExe =
						a.executable?.toLowerCase() ||
						a.path.split("/").pop()?.split("\\").pop()?.toLowerCase() ||
						"";
					return (
						runExe === pinFilename ||
						runExe === `${pinFilename}.exe` ||
						`${runExe}.exe` === pinFilename
					);
				});
				if (found) {
					matchedRunningKeys.add(itemKey(found));
					return found;
				}
			}

			// A pinned shell id and a visible window can have different paths
			// (for example com.sehaz.bloom and bloom.exe). Match both visible
			// and background apps so the window cannot become a second dock item.
			const equivalent = activeApps.find(
				(app) => !matchedRunningKeys.has(itemKey(app)) && isSameApp(p, app)
			);
			if (equivalent) {
				matchedRunningKeys.add(itemKey(equivalent));
				return equivalent;
			}
			return undefined;
		};

		const pinned: AppInfo[] = [
			{
				name: "Start",
				path: "start",
				icon: null,
				is_running: false,
				is_pinned: true,
				hwnd: undefined,
				all_hwnds: undefined,
				executable: undefined
			},
			...pinnedApps.map((p) => {
				const running = findRunningApp(p);
				return {
					...p,
					is_running: !!running,
					icon_path: running?.path,
					icon_name: running?.name,
					hwnd: running?.hwnd,
					all_hwnds: running?.all_hwnds,
					tray_ids: running?.tray_ids,
					is_background: running?.is_background
				};
			})
		];

		const unpinned = activeOrder
			.map((id) => activeApps.find((a) => itemKey(a) === id))
			.filter(
				(a): a is AppInfo =>
					!!a && (dockShowBackgroundApps || !a.is_background) && !matchedRunningKeys.has(itemKey(a))
			);

		return [...pinned, ...unpinned];
	}, [pinnedApps, activeApps, activeOrder, dockShowBackgroundApps]);

	const startItem = useMemo(
		() => dockItems.find((i) => i.path === "start") as AppInfo,
		[dockItems]
	);
	// Only a deliberate icon hover dismisses Start. Once dismissed, the session
	// belongs to the whole dock, including the gaps between icons and its popups.
	const dockPopupRequested = !!contextMenu || showAddPopup || nativeMenuOpen || ccOpen;
	const dockHoverTarget =
		hoveredApp !== null && (!startItem || hoveredApp !== itemKey(startItem)) ? hoveredApp : null;
	const keepShellInteraction =
		shellInteraction && (isDockHovered || !!previewData || dockPopupRequested);
	useEffect(() => {
		const report = (active: boolean) => {
			void invoke("set_dock_popup_active", { active }).catch(console.error);
		};
		if (dockPopupRequested || keepShellInteraction) {
			report(true);
			return;
		}
		// Cancel short pass-overs; restarting for a different icon requires a
		// fresh dwell. A brief leave grace bridges the dock-to-popup handoff.
		const timer = setTimeout(() => report(dockHoverTarget !== null), dockHoverTarget ? 350 : 250);
		return () => clearTimeout(timer);
	}, [dockPopupRequested, dockHoverTarget, keepShellInteraction]);
	useEffect(() => {
		let disposed = false;
		const unlisten = listen<boolean>("dock-shell-interaction", ({ payload }) => {
			if (!disposed) setShellInteraction(payload);
		});
		return () => {
			disposed = true;
			void unlisten.then((stop) => stop());
			void invoke("set_dock_popup_active", { active: false });
		};
	}, []);
	const pinnedItems = useMemo(
		() => dockItems.filter((i) => i.path !== "start" && i.is_pinned),
		[dockItems]
	);
	const unpinnedItems = useMemo(() => dockItems.filter((i) => !i.is_pinned), [dockItems]);

	// Latest state for the Win+Number listener, which subscribes only once.
	useEffect(() => {
		pinnedItemsRef.current = pinnedItems;
		handleAppClickRef.current = handleAppClick;
	});

	useEffect(() => {
		// The backend claims Win+1-9 while the native taskbar is hidden and reports
		// which pinned slot was pressed; behaviour matches a click on that icon.
		const unlisten = listen<number>("dock-win-number", (event) => {
			const app = pinnedItemsRef.current[event.payload];
			if (app) handleAppClickRef.current(app);
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, []);

	// Pinned and running icons share one reorder list, split by PIN_DIVIDER.
	// Items are keyed by identity, not path: web apps running in the same
	// browser share one executable path.
	const appsByKey = useMemo(
		() => new Map([...pinnedItems, ...unpinnedItems].map((app) => [itemKey(app), app])),
		[pinnedItems, unpinnedItems]
	);
	const dockOrder = useMemo(() => {
		const keys = pinnedItems.map(itemKey);
		if (unpinnedItems.length > 0) keys.push(PIN_DIVIDER, ...unpinnedItems.map(itemKey));
		return keys;
	}, [pinnedItems, unpinnedItems]);
	const shownOrder = useMemo(
		() => (dragOrder ?? dockOrder).filter((key) => key === PIN_DIVIDER || appsByKey.has(key)),
		[dragOrder, dockOrder, appsByKey]
	);

	// Pinned icons stay left of the divider. A running app may cross it, which
	// pins it when dropped there.
	const handleReorder = (next: string[]): boolean => {
		const divider = next.indexOf(PIN_DIVIDER);
		if (divider !== -1 && next.slice(divider + 1).some((key) => appsByKey.get(key)?.is_pinned)) {
			return false;
		}
		dragOrderRef.current = next;
		setDragOrder(next);
		return true;
	};

	const applyDockOrder = (order: string[]) => {
		const divider = order.indexOf(PIN_DIVIDER);
		const pinnedSide = divider === -1 ? order : order.slice(0, divider);
		const runningSide = divider === -1 ? [] : order.slice(divider + 1);

		const nextPinned: AppInfo[] = [];
		for (const key of pinnedSide) {
			const pin = pinnedApps.find((p) => itemKey(p) === key);
			if (pin) {
				nextPinned.push(pin);
				continue;
			}
			// A running app dropped on the pinned side. Same duplicate guard as
			// togglePin: another entry shape of the same app must not pin twice.
			const app = appsByKey.get(key);
			if (app && !pinnedApps.some((p) => isSameApp(p, app))) {
				nextPinned.push(toPin(app));
				fetchIcon(app.path, app.name, undefined, app.profile);
			}
		}
		// A pin the drag never saw (renamed mid-drag) is kept, at the end.
		pinnedApps.forEach((p) => {
			if (!nextPinned.includes(p)) nextPinned.push(p);
		});
		if (nextPinned.length !== pinnedApps.length || nextPinned.some((p, i) => p !== pinnedApps[i])) {
			setPinnedApps(nextPinned);
			invoke("save_pinned_apps", { apps: nextPinned }).catch(console.error);
		}

		// Running apps keep the dragged order until they close. Only the slots
		// they hold are reassigned, so hidden background apps keep theirs.
		const moved = new Set(runningSide);
		setActiveOrder((prev) => {
			let i = 0;
			const next = prev.map((key) => (moved.has(key) ? (runningSide[i++] ?? key) : key));
			return next.every((key, j) => key === prev[j]) ? prev : next;
		});
	};

	const handleDragEnd = () => {
		const order = dragOrderRef.current;
		dragOrderRef.current = null;
		setDragOrder(null);
		setDraggingKey(null);
		setPressedApp(null);
		if (order) applyDockOrder(order);
	};

	useEffect(() => {
		// Only report true dock-window hover, not the edge-hover from Rust,
		// to avoid a feedback loop that keeps the dock open.
		// The corner pill counts as the dock, so resting on it keeps both shown.
		invoke("set_dock_hovered", { hovered: isDockHovered || isCornerHovered }).catch(() => {});
	}, [isDockHovered, isCornerHovered]);

	useEffect(() => {
		const handleBlur = () => {
			closeMenu();
			closePopup();
		};
		window.addEventListener("blur", handleBlur);
		return () => window.removeEventListener("blur", handleBlur);
	}, []);

	useEffect(() => {
		if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
		isPreviewHoveredRef.current = false;
		hoveredAppRef.current = hoveredApp;

		if (!hoveredApp) {
			const timer = setTimeout(() => setPreviewData(null), 100);
			return () => clearTimeout(timer);
		}

		if (hoveredApp && !isDragging) {
			const app = dockItems.find((a) => itemKey(a) === hoveredApp);
			if (app && app.is_running && !app.is_background) {
				const hwndsToCapture = app.all_hwnds || (app.hwnd ? [[app.hwnd, app.name]] : []);

				previewTimerRef.current = setTimeout(async () => {
					try {
						const results = await Promise.all(
							hwndsToCapture.map(async ([hwnd, title]) => {
								try {
									const res = await invoke<[string, number] | null>("capture_window_thumbnail", {
										hwnd,
										maxWidth: 320,
										maxHeight: 200
									});
									if (res) {
										const [image, lastFocused] = res;
										return { hwnd, title, image, lastFocused };
									}
								} catch {}
								return null;
							})
						);

						const captured = results
							.filter(
								(r): r is { hwnd: number; title: string; image: string; lastFocused: number } =>
									r !== null
							)
							.sort((a, b) => b.lastFocused - a.lastFocused)
							.map(({ hwnd, title, image }) => ({ hwnd, title, image }));

						const currentHovered = hoveredAppRef.current;
						if (captured.length > 0 && currentHovered === itemKey(app)) {
							setPreviewData({ id: itemKey(app), previews: captured });
						} else if (currentHovered === itemKey(app)) {
							setPreviewData(null);
						}
					} catch (e) {
						console.error("Failed to capture thumbnails:", e);
						setPreviewData(null);
					}
				}, 300);
			} else {
				setPreviewData(null);
			}
		}

		return () => {
			if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
		};
	}, [hoveredApp, isDragging, dockItems]);

	const iconVariants = {
		// Opacity is explicit everywhere so a dropped icon fades back from "drag".
		idle: { y: 0, scale: 1, opacity: 1 },
		hover: { y: -5, scale: 1.1, opacity: 1 },
		drag: { y: -10, scale: 1.1, opacity: 0.8 },
		tap: { scale: 0.95, opacity: 1 }
	};

	const renderExtra = (extra: DockExtra) => (
		<motion.div
			key={extra.id}
			layout
			initial={{ opacity: 0, scale: 0 }}
			animate={{ opacity: 1, scale: 1 }}
			exit={{ opacity: 0, scale: 0, transition: { duration: 0.12 } }}
			className="dock-icon-wrapper"
			onContextMenu={(e) => handleExtraContextMenu(e, extra)}
			onMouseEnter={() => setHoveredApp(extra.id)}
			onMouseLeave={() => {
				setHoveredApp(null);
				setPressedApp(null);
			}}
			onMouseDown={(e) => {
				if (e.button === 1) e.preventDefault();
			}}
			onClick={(e) => {
				e.stopPropagation();
				handleExtraClick(extra);
			}}
		>
			{hoveredApp === extra.id && <div className="tooltip">{extra.name}</div>}
			<motion.div
				className="dock-icon"
				variants={iconVariants}
				animate={pressedApp === extra.id ? "tap" : hoveredApp === extra.id ? "hover" : "idle"}
				onPointerDown={() => setPressedApp(extra.id)}
				onPointerUp={() => setPressedApp(null)}
				onPointerCancel={() => setPressedApp(null)}
			>
				{extra.icon ? (
					<img src={extra.icon} alt={extra.name} draggable={false} />
				) : (
					<div className="fallback-icon">{extra.name[0]}</div>
				)}
			</motion.div>
		</motion.div>
	);

	return (
		<div className={`dock-container ${isDragging ? "dragging" : ""}`} onClick={closeMenu}>
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					justifyContent: "center",
					alignItems: "flex-end"
				}}
			>
				<motion.div
					ref={dockRef}
					layout
					className={`dock ${isExpanded && !isHidden ? "dock-expanded" : ""} ${isImpacted && !isExpanded && !isHidden ? "dock-impacted" : ""} ${dockIconOnly ? "dock-icon-only" : ""} ${isAdaptive ? "dock-adaptive" : ""}`}
					onMouseEnter={() => setIsDockHovered(true)}
					onMouseLeave={() => {
						setIsDockHovered(false);
						setHoveredApp(null);
						setPressedApp(null);
					}}
					initial={{
						y: -800,
						opacity: 1,
						width: 34,
						height: 34,
						borderTopLeftRadius: 17,
						borderTopRightRadius: 17,
						borderBottomLeftRadius: 17,
						borderBottomRightRadius: 17
					}}
					animate={{
						y: !isReady ? -800 : isVisible ? (isHidden ? 100 : 0) : 150,
						width:
							isExpanded && !isHidden && isVisible ? (isAdaptive ? adaptiveWidth : "auto") : 34,
						height: isExpanded && !isHidden && isVisible ? "auto" : 34,
						borderTopLeftRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 18 : 17,
						borderTopRightRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 18 : 17,
						borderBottomLeftRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 0 : 17,
						borderBottomRightRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 0 : 17,
						opacity: isVisible ? 1 : 0,
						scale: scale
					}}
					transition={{
						y: { type: "spring", stiffness: 400, damping: 35, mass: 0.8 },
						width: { type: "spring", stiffness: 250, damping: 22, mass: 0.8 },
						height: { type: "spring", stiffness: 250, damping: 22, mass: 0.8 },
						layout: isDragging ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 25 },
						borderTopLeftRadius: { type: "spring", stiffness: 500, damping: 30 },
						borderTopRightRadius: { type: "spring", stiffness: 500, damping: 30 },
						borderBottomLeftRadius: { type: "spring", stiffness: 500, damping: 30 },
						borderBottomRightRadius: { type: "spring", stiffness: 500, damping: 30 },
						opacity: { type: "tween", duration: 0.2 },
						scale: { duration: 0 }
					}}
					style={{ originX: 0.5, originY: 1, minWidth: 34 }}
					onContextMenu={(e) => handleContextMenu(e, null)}
				>
					<EdgeSurface edge="bottom" flares={isExpanded && !isHidden} reflective={edgeShineEnabled} resolutionScale={scale} />
					<AnimatePresence>
						{isExpanded && (
							<motion.div
								key="dock-content"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.15 }}
								className="dock-reorder-container"
							>
								{startItem && (
									<motion.div
										initial={{ opacity: 0, scale: 0 }}
										animate={{ opacity: 1, scale: 1 }}
										transition={{
											opacity: { duration: 0.15, delay: 0.15 },
											scale: { type: "spring", stiffness: 400, damping: 25, delay: 0.15 }
										}}
										className="dock-icon-wrapper"
										onContextMenu={(e) => handleContextMenu(e, startItem)}
										onMouseEnter={() => setHoveredApp(itemKey(startItem))}
										onMouseLeave={() => {
											setHoveredApp(null);
											setPressedApp(null);
										}}
									>
										{(!dockPreviewEnabled ||
											(dockPreviewEnabled && hoveredApp === itemKey(startItem))) && (
											<div className="tooltip">{startItem.name}</div>
										)}
										<motion.div
											className="dock-icon"
											variants={iconVariants}
											animate={
												pressedApp === itemKey(startItem)
													? "tap"
													: hoveredApp === itemKey(startItem)
														? "hover"
														: "idle"
											}
											onPointerDown={() => setPressedApp(itemKey(startItem))}
											onPointerUp={() => setPressedApp(null)}
											onPointerCancel={() => setPressedApp(null)}
											onClick={(e) => {
												e.stopPropagation();
												handleAppClick(startItem);
											}}
										>
											<img
												src={resolveStartIcon(startIcon)}
												alt="Start"
												className="bloom-icon-img"
												style={
													startIcon.startsWith("custom:") ? { borderRadius: "8px" } : undefined
												}
												draggable={false}
											/>
										</motion.div>
									</motion.div>
								)}

								{dockTaskView && (
									<motion.div
										key="task-view"
										initial={{ opacity: 0, scale: 0 }}
										animate={{ opacity: 1, scale: 1 }}
										exit={{ opacity: 0, scale: 0, transition: { duration: 0.12 } }}
										className="dock-icon-wrapper"
										onContextMenu={(e) => {
											e.stopPropagation();
											e.preventDefault();
											setContextMenu({ x: e.clientX, y: e.clientY, app: null, taskView: true });
										}}
										onMouseEnter={() => setHoveredApp("task-view")}
										onMouseLeave={() => {
											setHoveredApp(null);
											setPressedApp(null);
										}}
									>
										{(!dockPreviewEnabled || hoveredApp === "task-view") && (
											<div className="tooltip">Task View</div>
										)}
										<motion.div
											className="dock-icon"
											variants={iconVariants}
											animate={
												pressedApp === "task-view"
													? "tap"
													: hoveredApp === "task-view"
														? "hover"
														: "idle"
											}
											onPointerDown={() => setPressedApp("task-view")}
											onPointerUp={() => setPressedApp(null)}
											onPointerCancel={() => setPressedApp(null)}
											onClick={(e) => {
												e.stopPropagation();
												openTaskView();
											}}
										>
											<TaskViewIcon />
										</motion.div>
									</motion.div>
								)}

								{dockExtrasPosition === "left" && dockExtras.length > 0 && (
									<>
										{dockExtras.map((extra) => renderExtra(extra))}
										<div
											className="dock-app-divider"
											role="separator"
											aria-orientation="vertical"
										/>
									</>
								)}

								<DockReorderGroup
									values={shownOrder}
									onReorder={handleReorder}
									className="dock-reorder-group"
								>
									{shownOrder.map((key) => {
										if (key === PIN_DIVIDER) {
											// A reorder item so icons can be dragged across it. Hidden
											// by the setting, it still marks where pinning starts.
											return (
												<Reorder.Item
													as="div"
													key={key}
													value={key}
													dragListener={false}
													className={`dock-app-divider${dockSeparatorEnabled ? "" : " dock-app-divider-hidden"}`}
													role="separator"
													aria-orientation="vertical"
													aria-hidden={!dockSeparatorEnabled}
												/>
											);
										}
										const app = appsByKey.get(key);
										if (!app) return null;
										const pinHint =
											!app.is_pinned &&
											draggingKey === key &&
											dragOrder !== null &&
											dragOrder.indexOf(key) < dragOrder.indexOf(PIN_DIVIDER);
										return (
											<Reorder.Item
												as="div"
												key={key}
												value={key}
												style={{ position: "relative" }}
												onPointerDown={() => {
													dragMovedRef.current = false;
												}}
												onDragStart={() => {
													dragMovedRef.current = true;
													setDraggingKey(key);
													setHoveredApp(null);
													setPressedApp(null);
												}}
												onDragEnd={handleDragEnd}
												onContextMenu={(e) => handleContextMenu(e, app)}
												onMouseDown={(e) => {
													if (e.button === 1) e.preventDefault();
												}}
												onAuxClick={(e) => handleMiddleClick(e, app)}
												onClick={(e) => {
													e.stopPropagation();
													// Dropping a dragged icon must not also open or focus it.
													if (!dragMovedRef.current) handleAppClick(app);
												}}
											>
												<motion.div
													className="dock-icon-wrapper"
													initial={ITEM_INITIAL}
													animate={ITEM_ANIMATE}
													exit={ITEM_EXIT}
													transition={ITEM_ENTRY_TRANSITION}
													onMouseEnter={() => setHoveredApp(key)}
													onMouseLeave={() => {
														if (!isPreviewHoveredRef.current) {
															setHoveredApp(null);
															setPressedApp(null);
														}
													}}
												>
													<AnimatePresence>
														{dockPreviewEnabled &&
															previewData &&
															previewData.id === key &&
															hoveredApp === key && (
																<motion.div
																	className={`preview-tooltip ${previewData.previews.length > 1 ? "multi" : ""}`}
																	initial={{ opacity: 0, y: 10, scale: 0.95 }}
																	animate={{ opacity: 1, y: 0, scale: 1 }}
																	exit={{ opacity: 0, scale: 0.95 }}
																	transition={{ duration: 0.15 }}
																	onMouseEnter={() => {
																		isPreviewHoveredRef.current = true;
																	}}
																	onMouseLeave={() => {
																		isPreviewHoveredRef.current = false;
																		setHoveredApp(null);
																		setPressedApp(null);
																	}}
																>
																	<div className="preview-items">
																		{previewData.previews.map((prev, idx) => (
																			<div
																				key={prev.hwnd}
																				className="preview-item"
																				onClick={() => invoke("focus_window", { hwnd: prev.hwnd })}
																			>
																				<img src={prev.image} alt={`Preview ${idx}`} />
																				<div className="preview-label">{prev.title || app.name}</div>
																				<button
																					className="preview-close-btn"
																					onClick={(e) => handleClosePreview(e, prev.hwnd)}
																					title="Close Window"
																				>
																					<svg
																						width="10"
																						height="10"
																						viewBox="0 0 24 24"
																						fill="none"
																						stroke="currentColor"
																						strokeWidth="3"
																						strokeLinecap="round"
																					>
																						<line x1="18" y1="6" x2="6" y2="18"></line>
																						<line x1="6" y1="6" x2="18" y2="18"></line>
																					</svg>
																				</button>
																			</div>
																		))}
																	</div>
																</motion.div>
															)}
													</AnimatePresence>

													{/* Fallback to text tooltip if previews are disabled, app isn't running, or preview failed to load */}
													{pinHint ? (
														<div className="tooltip drag-hint">Pin to Dock</div>
													) : (
														(!dockPreviewEnabled ||
															(dockPreviewEnabled && hoveredApp === key && !previewData)) && (
															<div className="tooltip">{app.name}</div>
														)
													)}
													<motion.div
														className="dock-icon"
														variants={iconVariants}
														animate={
															draggingKey === key
																? "drag"
																: pressedApp === key
																	? "tap"
																	: hoveredApp === key && !isDragging
																		? "hover"
																		: "idle"
														}
														onPointerDown={() => setPressedApp(key)}
														onPointerUp={() => setPressedApp(null)}
														onPointerCancel={() => setPressedApp(null)}
													>
														{(() => {
															const isHost = isBrowserHost(app.path);
															const cacheKey = isHost
																? `${app.path}:${app.name.toLowerCase()}`
																: app.hwnd
																	? `${app.path}-${app.hwnd}`
																	: app.path;
															// Running host items must not use the shared path fallback: the
															// browser and its PWAs share one path, so it would leak one item's
															// icon onto the others.
															const allowPathFallback = !isHost || !app.is_running;
															const icon =
																customIcons[cacheKey] ||
																(allowPathFallback && customIcons[app.path]) ||
																iconsRef.current[dockIconKey(app, isHost)] ||
																iconsRef.current[cacheKey] ||
																(allowPathFallback && iconsRef.current[app.path]) ||
																app.icon;

															const isBloomOrSettings =
																app.name.toLowerCase() === "settings" ||
																app.name.toLowerCase() === "bloom" ||
																app.path.toLowerCase().includes("bloom.exe");

															return icon ? (
																<img
																	src={icon}
																	alt={app.name}
																	className={isBloomOrSettings ? "bloom-icon-img" : ""}
																	draggable={false}
																/>
															) : (
																<div className="fallback-icon">{app.name[0]}</div>
															);
														})()}
													</motion.div>
													{app.is_running && (dockShowBackgroundApps || !app.is_background) && (
														<WindowDots
															count={app.all_hwnds?.length ?? 1}
															background={app.is_background}
														/>
													)}
												</motion.div>
											</Reorder.Item>
										);
									})}
								</DockReorderGroup>

								{dockExtrasPosition === "right" && dockExtras.length > 0 && (
									<>
										<div
											className="dock-app-divider"
											role="separator"
											aria-orientation="vertical"
										/>
										{dockExtras.map((extra) => renderExtra(extra))}
									</>
								)}
							</motion.div>
						)}
					</AnimatePresence>
				</motion.div>
			</div>

			{/* Command Center: the corner pill, like the taskbar's quick settings
			    button, and the panel it opens above itself. */}
			{commandCenterInDock && (
				<div ref={cornerSlotRef} className="cc-corner-slot" style={{ zoom: scale }}>
					{/* The whole pill takes the click; the button inside gives it a
					    name and keyboard access, and its click bubbles up here. */}
					<motion.div
						className={`cc-corner${ccOpen ? " open" : ""}`}
						initial={false}
						animate={{ y: cornerShown ? 0 : 90, opacity: cornerShown ? 1 : 0 }}
						transition={{
							y: reduceMotion
								? { duration: 0 }
								: { type: "spring", stiffness: 400, damping: 35, mass: 0.8 },
							opacity: { duration: 0.2 }
						}}
						onMouseEnter={() => setIsCornerHovered(true)}
						onMouseLeave={() => setIsCornerHovered(false)}
						onClick={(e) => {
							e.stopPropagation();
							if (ccOpen) setCcView(null);
							else openCommandCenter("main");
						}}
					>
						<EdgeSurface
							edge="bottom"
							flares
							reflective={edgeShineEnabled}
							resolutionScale={scale}
						/>
						<button
							type="button"
							className="cc-corner-status"
							aria-label="Command Center"
							aria-haspopup="dialog"
							aria-expanded={ccOpen}
						>
							<WifiIcon
								enabled={quickControls.wifiEnabled}
								connected={quickControls.wifiConnected}
							/>
							<SpeakerIcon
								size={16}
								className="cc-corner-speaker"
								muted={quickControls.displayVolume === 0}
							/>
							{battery && (
								<span className="cc-corner-battery">
									<BatteryIcon
										charging={battery.charging}
										level={battery.level}
										fill="currentColor"
									/>
									<span>{battery.level}%</span>
								</span>
							)}
						</button>
					</motion.div>
				</div>
			)}

			<AnimatePresence>
				{ccOpen && (
					<div key="cc-panel" ref={ccAnchorRef} className="cc-dock-anchor" style={{ zoom: scale }}>
						<motion.div
							className="cc-dock-panel"
							role="dialog"
							aria-label="Command Center"
							initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 28 }}
							animate={{
								opacity: 1,
								y: 0,
								transition: { duration: 0.26, ease: [0.1, 0.9, 0.2, 1] }
							}}
							exit={
								reduceMotion
									? { opacity: 0, transition: { duration: 0.12 } }
									: { opacity: 0, y: 20, transition: { duration: 0.16, ease: [0.7, 0, 1, 0.5] } }
							}
							onClick={(e) => e.stopPropagation()}
							onContextMenu={(e) => {
								e.preventDefault();
								e.stopPropagation();
							}}
						>
							<AnimatePresence initial={false}>
								{ccView === "main" && (
									<motion.div
										key="main"
										className="cc-dock-view cc-dock-main cc-large"
										{...ccViewMotion(-1)}
									>
										<CommandCenter
											controls={quickControls}
											dockMode={dockMode}
											notchMode={notchMode}
											onCycleDockMode={cycleDockMode}
											onCycleNotchMode={cycleNotchMode}
											onOpenWifi={() => setCcView("wifi")}
											onOpenBluetooth={() => setCcView("bluetooth")}
										/>
									</motion.div>
								)}
								{ccView === "wifi" && (
									<motion.div key="wifi" className="cc-dock-view" {...ccViewMotion(1)}>
										<div className="cc-dock-zoom">
											<WifiPanel
												enabled={quickControls.wifiEnabled}
												onToggle={quickControls.toggleWifi}
												onBack={() => setCcView("main")}
												onPinChange={focusDockForTyping}
											/>
										</div>
									</motion.div>
								)}
								{ccView === "bluetooth" && (
									<motion.div key="bluetooth" className="cc-dock-view" {...ccViewMotion(1)}>
										<div className="cc-dock-zoom">
											<BluetoothPanel
												enabled={quickControls.bluetoothEnabled}
												onToggle={quickControls.toggleBluetooth}
												onBack={() => setCcView("main")}
												onPinChange={focusDockForTyping}
											/>
										</div>
									</motion.div>
								)}
							</AnimatePresence>
						</motion.div>
					</div>
				)}
			</AnimatePresence>

			{contextMenu && (
				<div
					ref={menuRef}
					className="context-menu"
					style={{
						left: (menuPos?.left ?? contextMenu.x) / scale,
						top: (menuPos?.top ?? contextMenu.y) / scale,
						visibility: menuPos ? "visible" : "hidden",
						zoom: scale
					}}
					onClick={(e) => e.stopPropagation()}
				>
					{!contextMenu.extra &&
						!contextMenu.taskView &&
						(!contextMenu.app || contextMenu.app.path === "start") && (
						<div
							style={{
								maxHeight: Math.max(64, window.innerHeight / scale - 200),
								overflowY: "auto"
							}}
						>
							{(contextMenu.app
								? [
										["installed-apps", "Installed Apps"],
										["power-options", "Power Options"],
										["device-manager", "Device Manager"],
										["network-connections", "Network Connections"],
										["disk-management", "Disk Management"],
										["computer-management", "Computer Management"],
										["task-manager", "Task Manager"],
										["settings", "Settings"]
									]
								: [
										["task-manager", "Task Manager"],
										["taskbar-settings", "Taskbar Settings"]
									]
							).map(([action, label]) => (
								<div
									key={action}
									className="menu-item"
									onClick={() => {
										closeMenu();
										invoke("open_system_action", { action }).catch(showActionError);
									}}
								>
									{label}
								</div>
							))}
							<div className="menu-divider" />
						</div>
					)}
					{contextMenu.extra ? (
						<>
							<div
								className="menu-item"
								onClick={() => {
									const extra = contextMenu.extra!;
									closeMenu();
									handleExtraClick(extra);
								}}
							>
								Open
							</div>
							{contextMenu.extra.kind === "drive" && contextMenu.extra.removable && (
								<div className="menu-item" onClick={() => ejectExtra(contextMenu.extra!)}>
									Eject
								</div>
							)}
							{contextMenu.extra.kind === "drive" && (
								<>
									<div className="menu-divider" />
									<div
										className="menu-item quit"
										onClick={() => hideDriveFromDock(contextMenu.extra!)}
									>
										Remove from Dock
									</div>
								</>
							)}
							{contextMenu.extra.kind === "custom" && (
								<>
									<div className="menu-divider" />
									<div
										className="menu-item quit"
										onClick={() => removeExtraFromDock(contextMenu.extra!)}
									>
										Remove from Dock
									</div>
								</>
							)}
						</>
					) : contextMenu.taskView ? (
						<>
							<div
								className="menu-item"
								onClick={() => {
									closeMenu();
									openTaskView();
								}}
							>
								Open Task View
							</div>
							<div className="menu-divider" />
							<div className="menu-item" onClick={hideTaskView}>
								Hide Task View
							</div>
						</>
					) : contextMenu.app ? (
						<>
							<div className="menu-item" onClick={() => togglePin(contextMenu.app!)}>
								{contextMenu.app.is_pinned ? "Unpin from Dock" : "Pin to Dock"}
							</div>
							{contextMenu.app.is_pinned && contextMenu.app.path !== "start" && (
								<>
									<div className="menu-divider" />
									<div
										className="menu-item"
										onClick={() => {
											const isHost = isBrowserHost(contextMenu.app!.path);
											const ck = isHost
												? `${contextMenu.app!.path}:${contextMenu.app!.name.toLowerCase()}`
												: contextMenu.app!.path;
											iconPickerTargetRef.current = ck;
											closeMenu();
											setTimeout(() => {
												document.getElementById("icon-file-input")?.click();
											}, 50);
										}}
									>
										Change Icon...
									</div>
									{(() => {
										const isHost = isBrowserHost(contextMenu.app!.path);
										const ck = isHost
											? `${contextMenu.app!.path}:${contextMenu.app!.name.toLowerCase()}`
											: contextMenu.app!.path;
										return customIcons[ck] ? (
											<div
												className="menu-item"
												onClick={() => {
													handleRemoveCustomIcon(contextMenu.app!);
													closeMenu();
												}}
											>
												Reset Icon
											</div>
										) : null;
									})()}
								</>
							)}
							<div className="menu-divider" />
							<div
								className="menu-item"
								onClick={() => {
									setShowAddPopup(true);
									closeMenu();
								}}
							>
								Add App to Dock...
							</div>
							<div
								className="menu-item has-submenu"
								onMouseEnter={() => setActiveSubmenu("bloom")}
								onMouseLeave={() => setActiveSubmenu(null)}
							>
								Bloom Options
								<span className="submenu-arrow">▶</span>
								<div className="submenu">
									<div
										className="menu-item"
										onClick={() => {
											invoke("open_settings_window");
											closeMenu();
										}}
									>
										Open Settings
									</div>
									<div className="menu-item" onClick={() => invoke("restart_bloom")}>
										Restart Bloom
									</div>
									<div
										className="menu-item"
										onClick={() => {
											handleClearIconCache();
											closeMenu();
										}}
									>
										Clear Icon Cache
									</div>
									<div className="menu-divider" />
									<div className="menu-item quit" onClick={() => invoke("quit_bloom")}>
										Quit Bloom
									</div>
								</div>
							</div>
							{(() => {
								// App actions sit together just above Close, like the taskbar's
								// jump list: the app's tray menus, then a new instance.
								const app = contextMenu.app!;
								const canOpenNew = app.is_running && app.path !== "start";
								if (!app.tray_ids?.length && !canOpenNew) return null;
								return (
									<>
										<div className="menu-divider" />
										{app.tray_ids?.map((id, index, ids) => (
											<div key={id} className="menu-item" onClick={() => void openTrayMenu(id)}>
												{ids.length > 1 ? `Tray menu ${index + 1}` : "App tray menu"}
											</div>
										))}
										{canOpenNew && (
											<div
												className="menu-item"
												onClick={() => {
													handleNewInstance(app);
													closeMenu();
												}}
											>
												Open New Instance
											</div>
										)}
									</>
								);
							})()}
							{contextMenu.app.is_running && !contextMenu.app.is_background && (
								<>
									{contextMenu.app.path === "start" && !contextMenu.app.tray_ids?.length && (
										<div className="menu-divider" />
									)}
									<div
										className="menu-item quit"
										onClick={async () => {
											// Close every window of the item, like the taskbar's
											// "Close all windows", not just the first one.
											const app = contextMenu.app;
											const hwnds =
												app?.all_hwnds?.map(([hwnd]) => hwnd) ?? (app?.hwnd ? [app.hwnd] : []);
											await Promise.all(hwnds.map((hwnd) => invoke("close_window", { hwnd })));
											closeMenu();
										}}
									>
										Close{" "}
										{contextMenu.app.all_hwnds && contextMenu.app.all_hwnds.length > 1
											? "all windows"
											: "window"}
									</div>
								</>
							)}
						</>
					) : (
						<>
							<div
								className="menu-item"
								onClick={() => {
									setShowAddPopup(true);
									closeMenu();
								}}
							>
								Add App to Dock...
							</div>
							<div
								className="menu-item has-submenu"
								onMouseEnter={() => setActiveSubmenu("bloom")}
								onMouseLeave={() => setActiveSubmenu(null)}
							>
								Bloom Options
								<span className="submenu-arrow">▶</span>
								<div className="submenu">
									<div
										className="menu-item"
										onClick={() => {
											invoke("open_settings_window");
											closeMenu();
										}}
									>
										Open Settings
									</div>
									<div className="menu-item" onClick={() => invoke("restart_bloom")}>
										Restart Bloom
									</div>
									<div
										className="menu-item"
										onClick={() => {
											handleClearIconCache();
											closeMenu();
										}}
									>
										Clear Icon Cache
									</div>
									<div className="menu-divider" />
									<div className="menu-item quit" onClick={() => invoke("quit_bloom")}>
										Quit Bloom
									</div>
								</div>
							</div>
						</>
					)}
				</div>
			)}

			<input
				id="icon-file-input"
				type="file"
				accept=".png,.ico,.jpg,.jpeg,.svg,.bmp"
				style={{ display: "none" }}
				onChange={handleIconFileSelect}
			/>

			<AnimatePresence>
				{showAddPopup && (
					<AddAppPopup
						containerRef={popupRef}
						onClose={closePopup}
						onAdd={(app: AppInfo) => {
							togglePin(app);
							closePopup();
						}}
						scale={scale}
						runningApps={activeApps}
						pinned={pinnedApps}
						bottom={popupBottom}
					/>
				)}
			</AnimatePresence>

			<AnimatePresence>
				{toast && (
					<motion.div
						className="dock-toast"
						initial={{ opacity: 0, y: 10 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 10 }}
						transition={{ duration: 0.2 }}
						style={{ zoom: scale }}
					>
						{toast}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
});

function AddAppPopup({
	onClose,
	onAdd,
	containerRef,
	scale,
	runningApps,
	pinned,
	bottom
}: {
	onClose: () => void;
	onAdd: (app: AppInfo) => void;
	containerRef: React.RefObject<HTMLDivElement | null>;
	scale: number;
	runningApps: AppInfo[];
	pinned: AppInfo[];
	bottom: number;
}) {
	const [apps, setApps] = useState<AppInfo[]>([]);
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [loading, setLoading] = useState(true);
	const [listIcons, setListIcons] = useState<Record<string, string>>({});
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const mountedRef = useRef(false);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedSearch(search), 150);
		return () => clearTimeout(timer);
	}, [search]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Reset selection when search changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [debouncedSearch]);

	// Running, unpinned apps — already in memory, so the default view is
	// instant and relevant instead of the first 20 alphabetical installs.
	// Pinned matching is fuzzy: a pinned .lnk and its running .exe are the
	// same app and must not show up as pinnable again.
	const runningSuggestions = useMemo(
		() => runningApps.filter((a) => a.path !== "start" && !pinned.some((p) => isSameApp(p, a))),
		[runningApps, pinned]
	);

	const sections = useMemo(() => {
		const s = debouncedSearch.trim().toLowerCase();
		// No query: running apps first, then the full installed list.
		// Already-pinned entries are excluded; backend filters helper junk
		// (uninstallers, help/readme entries) out of the scan itself.
		if (!s) {
			const runningIds = new Set(runningSuggestions.map((a) => itemKey(a)));
			const rest = apps
				.filter(
					(a) =>
						a.path !== "start" &&
						!pinned.some((p) => isSameApp(p, a)) &&
						!runningIds.has(itemKey(a))
				)
				.slice(0, 60);
			const out: { title: string | null; items: AppInfo[] }[] = [];
			if (runningSuggestions.length > 0) out.push({ title: "Running", items: runningSuggestions });
			if (rest.length > 0) out.push({ title: "All apps", items: rest });
			return out;
		}
		const starts: AppInfo[] = [];
		const contains: AppInfo[] = [];
		for (const a of apps) {
			// Search covers everything, including pinned — unlike the browse
			// view, which skips what's already on the dock.
			if (a.path === "start") continue;
			const n = a.name.toLowerCase();
			if (n.startsWith(s)) starts.push(a);
			else if (n.includes(s)) contains.push(a);
		}
		const byName = (x: AppInfo, y: AppInfo) => x.name.localeCompare(y.name);
		starts.sort(byName);
		contains.sort(byName);
		return [{ title: null, items: [...starts, ...contains].slice(0, 50) }];
	}, [apps, debouncedSearch, pinned, runningSuggestions]);

	// Flat selectable list; section headers are not selectable.
	const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
	const flatIndex = useMemo(() => new Map(flat.map((a, i) => [a, i])), [flat]);

	// Keep selection in range as results narrow.
	useEffect(() => {
		setSelectedIndex((i) => Math.min(i, Math.max(0, flat.length - 1)));
	}, [flat.length]);

	// Scroll selected item into view on keyboard nav only — never on mount,
	// where it yanks the freshly-opened list and reads as jitter.
	useEffect(() => {
		if (!mountedRef.current) {
			mountedRef.current = true;
			return;
		}
		if (!listRef.current) return;
		const row = listRef.current.querySelector(
			`[data-idx="${selectedIndex}"]`
		) as HTMLElement | null;
		if (row) row.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	useEffect(() => {
		const load = async () => {
			try {
				const res = await invoke<AppInfo[]>("get_installed_apps");
				setApps(res.sort((a, b) => a.name.localeCompare(b.name)));
			} finally {
				setLoading(false);
			}
		};
		load();
	}, []);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				const target = flat[selectedIndex];
				if (!target) return;
				// Already on the dock: just dismiss, never pin twice.
				if (pinned.some((p) => isSameApp(p, target))) onClose();
				else onAdd(target);
			}
		};
		const handleMouseDown = (e: MouseEvent) => {
			const popup = containerRef.current;
			if (popup && !popup.contains(e.target as Node)) {
				onClose();
			}
		};
		const handleBlur = () => onClose();
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("blur", handleBlur);
		document.addEventListener("mousedown", handleMouseDown, true);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("blur", handleBlur);
			document.removeEventListener("mousedown", handleMouseDown, true);
		};
	}, [onClose, containerRef, flat, selectedIndex, onAdd, pinned]);

	// Fetch visible icons in parallel and commit as one batch. The old
	// sequential 20ms-per-icon loop popped icons in one by one, which read as
	// the list shifting after open. Row and icon boxes are fixed-size and
	// images fade in via onLoad, so late icons never move layout.
	useEffect(() => {
		let active = true;
		const targets = flat.slice(0, 25).filter((a) => !listIcons[a.path]);
		if (targets.length === 0) return;
		Promise.all(
			targets.map(async (app) => {
				try {
					const icon = await invoke<string | null>("get_app_icon", { path: app.path });
					return [app.path, icon] as const;
				} catch (err) {
					console.error(err);
					return [app.path, null] as const;
				}
			})
		).then((pairs) => {
			if (!active) return;
			const batch: Record<string, string> = {};
			for (const [path, icon] of pairs) if (icon) batch[path] = icon;
			if (Object.keys(batch).length > 0) setListIcons((prev) => ({ ...prev, ...batch }));
		});
		return () => {
			active = false;
		};
	}, [flat, listIcons]);

	return (
		<div className="add-popup-anchor" style={{ zoom: scale, bottom }}>
			<motion.div
				ref={containerRef}
				className="add-app-popup"
				style={{ transformOrigin: "bottom center" }}
				initial={{ opacity: 0, scaleY: 0 }}
				animate={{ opacity: 1, scaleY: 1 }}
				exit={{ opacity: 0, scaleY: 0, transition: { duration: 0.16, ease: "easeIn" } }}
				transition={{
					opacity: { duration: 0.15 },
					scaleY: { type: "spring", stiffness: 300, damping: 28, mass: 0.9 }
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="popup-search-row">
					<svg
						className="popup-search-icon"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="11" cy="11" r="8" />
						<line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
					<input
						ref={inputRef}
						type="text"
						className="popup-search-input"
						placeholder="Search apps..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
				<div className="popup-apps-scroll" ref={listRef}>
					{loading ? (
						<div aria-hidden>
							{Array.from({ length: 8 }, (_, i) => (
								<div className="popup-app-row popup-skeleton-row" key={i}>
									<div className="popup-app-icon popup-skeleton-box" />
									<div className="popup-skeleton-line" />
								</div>
							))}
						</div>
					) : flat.length > 0 ? (
						sections.map((sec) => (
							<div key={sec.title ?? "all"}>
								{sec.title && <div className="popup-section-label">{sec.title}</div>}
								{sec.items.map((app) => {
									const gi = flatIndex.get(app) ?? 0;
									const icon = listIcons[app.path];
									const alreadyPinned = pinned.some((p) => isSameApp(p, app));
									return (
										<div
											key={`${app.path}::${app.name}`}
											data-idx={gi}
											className={`popup-app-row${gi === selectedIndex ? " selected" : ""}${alreadyPinned ? " is-pinned" : ""}`}
											onClick={() => (alreadyPinned ? onClose() : onAdd(app))}
											onMouseEnter={() => setSelectedIndex(gi)}
										>
											<div className="popup-app-icon">
												{icon ? (
													<img
														key={icon}
														src={icon}
														alt=""
														draggable={false}
														style={{ opacity: 0 }}
														onLoad={(e) => {
															e.currentTarget.style.opacity = "1";
														}}
													/>
												) : (
													<span className="popup-app-initial">{app.name[0]}</span>
												)}
											</div>
											<span className="popup-app-name">{app.name}</span>
											<span className="popup-app-pin">{alreadyPinned ? "✓" : "+"}</span>
										</div>
									);
								})}
							</div>
						))
					) : (
						<div className="popup-empty">
							{debouncedSearch.trim()
								? "No results"
								: "Running apps show up here — search to pin anything else"}
						</div>
					)}
				</div>
			</motion.div>
		</div>
	);
}

export default Dock;
