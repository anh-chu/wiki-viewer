/**
 * Payload-size model: how much does whole-file PUT cost vs a diff/patch,
 * across realistic .md sizes and uplink speeds? Decides whether a server-side
 * patch endpoint is worth building.
 *
 * Pure arithmetic model (no network needed): upload_time = bytes / uplink_Bps.
 * A small edit changes ~1 line; a patch payload ≈ the changed region + framing.
 *
 * Run: node packages/wiki-viewer-mcp/bench-payload.mjs
 */
const DOC_SIZES = [
	{ label: "small note (2 KB)", bytes: 2 * 1024 },
	{ label: "typical doc (20 KB)", bytes: 20 * 1024 },
	{ label: "long doc (100 KB)", bytes: 100 * 1024 },
	{ label: "big doc (500 KB)", bytes: 500 * 1024 },
];
// Uplink speeds (bytes/sec). Home/office uplinks are often the bottleneck.
const UPLINKS = [
	{ label: "fast (10 MB/s)", bps: 10 * 1024 * 1024 },
	{ label: "typical home up (2 Mbps = 0.25 MB/s)", bps: 0.25 * 1024 * 1024 },
	{ label: "slow / shared (0.5 Mbps)", bps: 0.0625 * 1024 * 1024 },
];
const PATCH_PAYLOAD = 300; // bytes: a one-line str-replace patch + JSON framing

function ms(bytes, bps) { return (bytes / bps) * 1000; }

console.log("\nupload-time model — whole-file PUT vs ~300B patch (transfer only)\n");
for (const up of UPLINKS) {
	console.log(`uplink: ${up.label}`);
	console.log("  " + ["doc".padEnd(22), "whole-file", "patch", "speedup"].join("  "));
	for (const d of DOC_SIZES) {
		const whole = ms(d.bytes, up.bps);
		const patch = ms(PATCH_PAYLOAD, up.bps);
		const speedup = whole / patch;
		console.log("  " + [
			d.label.padEnd(22),
			`${whole.toFixed(0)}ms`.padStart(10),
			`${patch.toFixed(1)}ms`.padStart(7),
			`${speedup.toFixed(0)}x`.padStart(7),
		].join("  "));
	}
	console.log("");
}
console.log("Note: this is transfer time only; add RTT + handshake (now pooled) on top.");
console.log("Whole-file PUT also re-sends unchanged bytes every edit; patch sends only the change.\n");
