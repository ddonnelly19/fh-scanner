import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface Display {
	/** Windows device name, e.g. \\.\DISPLAY1. */
	name: string;
	primary: boolean;
	/** The laptop's built-in panel. */
	internal: boolean;
	/** Bounds in the desktop coordinates Edge's --window-position uses. */
	x: number;
	y: number;
	width: number;
	height: number;
}

// Screens come from Windows Forms; the built-in panel is the monitor whose connection WMI reports as internal
// (VideoOutputTechnology 0x80000000), matched to its screen through the monitor's PnP code.
const script = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FhDisplay {
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	public struct DISPLAY_DEVICE {
		public int cb;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
		public int StateFlags;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
	}
	[DllImport("user32.dll", CharSet = CharSet.Unicode)]
	public static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE info, uint flags);
	public static string MonitorId(string adapter) {
		var d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(d);
		return EnumDisplayDevices(adapter, 0, ref d, 0) ? d.DeviceID : "";
	}
}
"@
$internal = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams -ErrorAction SilentlyContinue |
	Where-Object { [uint32]$_.VideoOutputTechnology -eq [uint32]2147483648 } |
	ForEach-Object { ($_.InstanceName -split '\\')[1] })
ConvertTo-Json -Compress @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
	$code = ([FhDisplay]::MonitorId($_.DeviceName) -split '\\')[1]
	[pscustomobject]@{ name = $_.DeviceName; primary = $_.Primary; internal = ($internal -contains $code);
		x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
})
`;

/** The connected screens, or an empty list off Windows or when PowerShell can't say. */
export async function listDisplays(): Promise<Display[]> {
	if (process.platform !== "win32") return [];
	try {
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		const { stdout } = await promisify(execFile)("powershell.exe",
			["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeout: 30000 });
		const parsed: unknown = JSON.parse(stdout);
		return (Array.isArray(parsed) ? parsed : [parsed]) as Display[];
	} catch {
		return [];
	}
}

/**
 * Picks the screen to open the stream on. "internal" (the default) is the laptop panel, falling back to the
 * primary screen when the laptop is closed or there is none; "primary" is the primary screen; a number N is
 * \\.\DISPLAYN. Returns undefined when nothing matches, which leaves placement to Edge.
 */
export function pickDisplay(displays: readonly Display[], choice: string): Display | undefined {
	const wanted = choice.trim().toLowerCase();
	if (/^\d+$/.test(wanted)) return displays.find((display) => display.name.toUpperCase().endsWith(`DISPLAY${Number(wanted)}`));
	if (wanted === "internal") return displays.find((display) => display.internal) ?? displays.find((display) => display.primary);
	if (wanted === "primary") return displays.find((display) => display.primary);
	throw new Error(`Unknown --display "${choice}". Use internal, primary or a display number.`);
}
