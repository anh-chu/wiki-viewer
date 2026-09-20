/**
 * Opening the composer on an already-commented block must ADD a comment.
 *
 * The bug this pins: `CommentThread` derived its target from every comment on the
 * block (`openComments[0] ?? comments[0]`), so selecting text on a block that already
 * had a comment opened THAT comment's thread — Edit / Delete / Resolve — and
 * `handleSend` then routed the typed text to `comment.reply`. The selection was
 * silently discarded, and a second comment could never be added to a block that
 * already had one.
 *
 * It was found in a browser, and it did not look like a lost write: the composer
 * rendered, accepted text, and reported success. Only the resulting sidecar showed
 * that the new comment never existed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const THREAD = readFileSync(
	path.join(process.cwd(), "src/components/editor/comment-thread.tsx"),
	"utf8",
);

describe("a composer opened for a selection targets a NEW comment", () => {
	test("a textAnchor overrides the block's existing comment", () => {
		// `textAnchor` is passed only for a deliberate "comment on this selection", so it
		// must win over the block's first existing comment.
		assert.match(
			THREAD,
			/const composing = textAnchor !== undefined && hasOpen;/,
			"a selection-driven composer must be recognised",
		);
		assert.match(
			THREAD,
			/const activeComment = composing \? null : \(openComments\[0\] \?\? comments\[0\] \?\? null\);/,
			"and it must NOT adopt the existing comment, or the send routes to a reply",
		);
	});

	test("with no active comment the send builds comment.add, not comment.reply", () => {
		// The routing itself was always correct; it was simply unreachable while
		// `activeComment` was non-null. Assert the shape so a future edit cannot quietly
		// make the reply branch the only reachable one again.
		const send = THREAD.slice(
			THREAD.indexOf("async function handleSend"),
			THREAD.indexOf("async function handleEscalate"),
		);
		assert.match(send, /const sendOp = activeComment\s*\?\s*\{ type: "comment\.reply"/);
		assert.match(send, /type: "comment\.add",\s*\n\s*ref: anchorRef \?\? anchorKey/);
		assert.match(
			send,
			/\.\.\.\(textAnchor \? \{ textAnchor \} : \{\}\)/,
			"a new comment carries the selected range so it re-anchors",
		);
	});

	test("the per-comment controls are hidden while composing", () => {
		// They are all gated on `activeComment`, so a null target removes Add-comment's
		// Edit/Delete/Resolve row. Assert the gate rather than the markup.
		assert.match(THREAD, /\{activeComment && \(/);
		assert.match(THREAD, /\{activeComment\.turns\[0\] && \(/);
	});
});
