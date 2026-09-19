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
	/**
	 * The previous block ORDER, when the caller can supply it.
	 *
	 * Refs are content-derived, so editing a block changes its ref. Nothing above
	 * matches a changed block to the ref it used to have — the hash lookups only find
	 * content that MOVED — so an edited block's old ref was left unaliased and every
	 * annotation on it was orphaned the moment the user typed. That is the "my
	 * suggestions reset" failure: the sidecar still holds them, but their ref no
	 * longer exists in the document, so nothing can resolve or render them.
	 *
	 * Position identifies that case, because a block being edited stays where it is.
	 */
	oldOrder?: readonly string[],
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

	// A block that was EDITED keeps its position but gets a new ref.
	//
	// The hash lookups above cannot see this: the content is new, so nothing matches
	// it, yet the block is the same one the user was annotating. Aliasing on position
	// recovers the annotation instead of orphaning it.
	if (oldOrder) {
		const stillNamed = new Set(Object.keys(newRefMap));
		for (let i = 0; i < newBlocks.length && i < oldOrder.length; i += 1) {
			const oldRef = oldOrder[i];
			const newRef = newBlocks[i].ref;
			if (oldRef === newRef) continue;
			// Only a ref that is genuinely gone gets aliased. If the old ref still names
			// a block, this slot was taken by a different block and the old one moved
			// elsewhere; aliasing here would drag annotations onto unrelated text.
			if (stillNamed.has(oldRef)) continue;
			if (!oldRefMap[oldRef]) continue;
			if (refAliases[oldRef]) continue;
			refAliases[oldRef] = newRef;
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
