export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

function encodeOctal(n: number, length: number): string {
	return n.toString(8).padStart(length - 1, "0") + "\0";
}

function writePaddedString(buf: Buffer, offset: number, str: string, len: number): void {
	const bytes = Buffer.from(str, "utf-8").subarray(0, len);
	bytes.copy(buf, offset);
}

function tarHeader(name: string, size: number, mtime: number): Buffer {
	const header = Buffer.alloc(512, 0);

	writePaddedString(header, 0, name, 100);          // name
	writePaddedString(header, 100, "0000644\0", 8);   // mode
	writePaddedString(header, 108, "0000000\0", 8);   // uid
	writePaddedString(header, 116, "0000000\0", 8);   // gid
	writePaddedString(header, 124, encodeOctal(size, 12), 12); // size
	writePaddedString(header, 136, encodeOctal(mtime, 12), 12); // mtime
	header[156] = 0x30;                                // typeflag '0' = regular
	// linkname: 157-256, all zero
	writePaddedString(header, 257, "ustar\0", 6);     // magic
	writePaddedString(header, 263, "00", 2);           // version
	// uname, gname, devmajor, devminor, prefix: zeros

	// checksum
	let sum = 0;
	for (let i = 0; i < 512; i++) {
		// treat checksum field (148..155) as spaces while computing
		sum += i >= 148 && i < 156 ? 32 : header[i];
	}
	writePaddedString(header, 148, encodeOctal(sum, 7) + " ", 8);

	return header;
}

function buildTar(entries: Array<{ name: string; content: Buffer; mtime: number }>): Buffer {
	const parts: Buffer[] = [];

	for (const entry of entries) {
		const hdr = tarHeader(entry.name, entry.content.length, entry.mtime);
		parts.push(hdr);
		parts.push(entry.content);
		// pad content to 512-byte boundary
		const rem = entry.content.length % 512;
		if (rem !== 0) {
			parts.push(Buffer.alloc(512 - rem, 0));
		}
	}

	// two zero blocks = end-of-archive
	parts.push(Buffer.alloc(1024, 0));

	return Buffer.concat(parts);
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
	const skillDir = path.resolve(process.cwd(), "agents/wiki-viewer-skill");
	const files = await readdir(skillDir, { withFileTypes: true });
	const mtime = Math.floor(Date.now() / 1000);

	const entries: Array<{ name: string; content: Buffer; mtime: number }> = [];

	for (const f of files) {
		if (!f.isFile()) continue;
		const content = await readFile(path.join(skillDir, f.name));
		entries.push({ name: `wiki-viewer-skill/${f.name}`, content, mtime });
	}

	const tar = buildTar(entries);
	const gz = gzipSync(tar);

	return new NextResponse(gz, {
		status: 200,
		headers: {
			"Content-Type": "application/gzip",
			"Content-Disposition": `attachment; filename="wiki-viewer-skill.tar.gz"`,
			"Cache-Control": "no-store",
		},
	});
}
