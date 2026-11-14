// The resting notch shows the date beside the clock as 14-Nov-26. Month names
// are fixed English abbreviations so the format doesn't change with locale.
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const formatNotchDate = (d: Date): string =>
	`${String(d.getDate()).padStart(2, "0")}-${MONTH_ABBR[d.getMonth()]}-${String(d.getFullYear() % 100).padStart(2, "0")}`;
