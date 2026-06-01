import { createHash } from "node:crypto";
import type { RootContent } from "mdast";
import type { Block, Sidecar } from "./types";
import { blockToMarkdown, blockType } from "./blocks";

function sha256hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function textHash(markdown: string): string {
	return sha256hex(markdown).slice(0, 12);
}

function mintRef(markdown: string, usedRefs: Set<string>, position: number): string {
	const base = "b" + sha256hex(markdown).slice(0, 6);
	if (!usedRefs.has(base)) return base;
	// Collision: try position suffix
	const withPos = `${base}_${position}`;
	if (!usedRefs.has(withPos)) return withPos;
	// Fallback: increment counter
	let i = 0;
	while (usedRefs.has(`${base}_${i}`)) i++;
	return `${base}_${i}`;
}

/**
 * Assign Block refs to a list of parsed mdast nodes.
 * If a sidecar is provided, reuse existing refs for matching content hashes.
 * Returns Block[] with stable refs and a new refMap.
 */
export function assignRefs(
	nodes: RootContent[],
	sidecar: Sidecar | null,
): { blocks: Block[]; newRefMap: Record<string, { textHash: string; lastSeenAt: string }> } {
	const now = new Date().toISOString();
	const usedRefs = new Set<string>();
	const newRefMap: Record<string, { textHash: string; lastSeenAt: string }> = {};

	// Build a reverse map: textHash -> ref from existing sidecar
	const hashToRef = new Map<string, string>();
	if (sidecar) {
		for (const [ref, entry] of Object.entries(sidecar.refMap)) {
			// Only map each hash once (first wins, since refs may have been aliased)
			if (!hashToRef.has(entry.textHash)) {
				hashToRef.set(entry.textHash, ref);
			}
		}
	}

	const blocks: Block[] = nodes.map((node, i) => {
		const md = blockToMarkdown(node);
		const hash = textHash(md);
		const { type, level, lang } = blockType(node);

		let ref: string;
		const existingRef = hashToRef.get(hash);
		if (existingRef && !usedRefs.has(existingRef)) {
			ref = existingRef;
		} else {
			ref = mintRef(md, usedRefs, i);
		}

		usedRefs.add(ref);
		newRefMap[ref] = { textHash: hash, lastSeenAt: now };

		const block: Block = { ref, type, markdown: md };
		if (level !== undefined) block.level = level;
		if (lang !== undefined) block.lang = lang;
		return block;
	});

	return { blocks, newRefMap };
}

/**
 * Resolve a ref against current block refs, falling back to aliases.
 */
export function resolveRef(
	sidecar: Sidecar,
	ref: string,
	currentRefs: Set<string>,
): string | null {
	if (currentRefs.has(ref)) return ref;
	const aliased = sidecar.refAliases[ref];
	if (aliased && currentRefs.has(aliased)) return aliased;
	return null;
}

/**
 * After applying ops: compute new refMap and collect aliases for changed blocks.
 * oldRefMap: refMap before ops. newBlocks: blocks after ops.
 * Returns { newRefMap, refAliases } — aliases map old ref -> new ref for any block
 * that changed identity this mutation. Aliases are ONE-generation only.
 */
export function computeRefDelta(
	oldRefMap: Record<string, { textHash: string; lastSeenAt: string }>,
	oldHashToRef: Map<string, string>,
	newBlocks: Block[],
): {
	newRefMap: Record<string, { textHash: string; lastSeenAt: string }>;
	refAliases: Record<string, string>;
} {
	const now = new Date().toISOString();
	const newRefMap: Record<string, { textHash: string; lastSeenAt: string }> = {};
	const refAliases: Record<string, string> = {};

	for (const block of newBlocks) {
		const hash = textHash(block.markdown);
		newRefMap[block.ref] = { textHash: hash, lastSeenAt: now };

		// If this block's hash previously mapped to a different ref, record alias
		const oldRef = oldHashToRef.get(hash);
		if (oldRef && oldRef !== block.ref) {
			refAliases[oldRef] = block.ref;
		}
	}

	// For any old ref that's no longer present (was replaced/deleted), try to alias
	// it if we can identify which new block replaced it by position or hash.
	for (const [oldRef, entry] of Object.entries(oldRefMap)) {
		if (!newRefMap[oldRef] && !refAliases[oldRef]) {
			// Old ref gone, no content match found. Check if new block with same hash exists
			const match = newBlocks.find((b) => b.ref !== oldRef && textHash(b.markdown) === entry.textHash);
			if (match) {
				refAliases[oldRef] = match.ref;
			}
		}
	}

	return { newRefMap, refAliases };
}

export { textHash };
