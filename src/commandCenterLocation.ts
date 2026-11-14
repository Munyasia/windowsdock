/**
 * Where Settings puts the Command Center (`bloom-command-center-location`):
 * the dock's bottom-right corner by default, or the notch. With the dock
 * turned off there is no corner, so it shows in the notch either way.
 */
export type CommandCenterLocation = "dock" | "notch";

export const readCommandCenterLocation = (value: unknown): CommandCenterLocation =>
	value === "notch" ? "notch" : "dock";
