/**
 * Google-Docs-style comment margin.
 *
 * The old shape was a gutter pip plus a floating popover: one dot per block, and
 * the thread only existed while you held it open. Docs instead keeps every
 * comment **persistently visible** in a right-hand column, vertically aligned
 * with the text it discusses, and the thread is the card itself.
 *
 * This component owns that column. It does not own comment state or operations —
 * `CommentThread` does both, and is rendered here with `variant="margin"` so the
 * popover and the column can never drift apart in what they offer.
 *
 * Positioning: each card is placed at the anchor's vertical offset inside the
 * scroll container, then pushed down if it would overlap the card above it. That
 * collision pass is what keeps two comments on adjacent lines from stacking on
 * top of each other — the failure mode a naive absolute layout always has.
 */

import { useEffect, useState } from "react";
import type { Comment } from "@/lib/proof/types";
import { CommentThread } from "./comment-thread";

export interface MarginThread {
	/** Block ref the thread is anchored to. */
	blockRef: string;
	comments: Comment[];
}

interface Props {
	path: string;
	threads: readonly MarginThread[];
	/** Live per-ref vertical offsets (px) from the top of the scroll content. */
	blockOffsets: ReadonlyMap<string, number>;
	/** The thread being edited right now; null means all are read-only cards. */
	activeRef: string | null;
	/** Open a thread for composing; used when the column shows a new comment. */
	onActivate: (blockRef: string) => void;
	onClose: () => void;
	onHoverChange: (blockRef: string, hovered: boolean) => void;
}

/** Minimum vertical gap between two cards, matching Docs' comfortable rhythm. */
const CARD_GAP = 8;

export function CommentMargin({
	path,
	threads,
	blockOffsets,
	activeRef,
	onActivate,
	onClose,
	onHoverChange,
}: Props) {
	// Measured heights, so the collision pass knows how tall each card really is
	// (comment bodies are free text and can be any length).
	const [heights, setHeights] = useState<Record<string, number>>({});

	// Re-measure on `activeRef` too, not just on the visible set.
	//
	// Expanding a card changes its height without changing `threads`, so keying this
	// on `[threads]` alone left the collision pass running with the COLLAPSED height.
	// The expanded card then overlapped the cards below it: measured live, an
	// expanded card spanning 45-230px had the next two sitting at 108-163 and
	// 171-226, i.e. printed on top of its body.
	useEffect(() => {
		setHeights((prev) => {
			const next = { ...prev };
			for (const t of threads) {
				const el = document.querySelector<HTMLElement>(
					`[data-margin-card="${t.blockRef}"]`,
				);
				if (el) next[t.blockRef] = el.offsetHeight;
			}
			return next;
		});
	}, [threads, activeRef]);

	const laid = layout(threads, blockOffsets, heights);

	if (threads.length === 0) return null;

	return (
		<div
			className="pointer-events-none absolute inset-y-0 right-2 z-10 w-[19rem] overflow-hidden"
			data-comment-margin
		>
			{laid.map(({ thread, top }) => (
				<div
					key={thread.blockRef}
					data-margin-card={thread.blockRef}
					// pointer-events-auto because the overlay root is transparent to
					// clicks: only the cards should be interactive, so the document
					// underneath stays selectable everywhere else.
					className="pointer-events-auto absolute left-0 right-0"
					style={{ top }}
				>
					{activeRef === thread.blockRef ? (
						<CommentThread
							path={path}
							anchorKey={thread.blockRef}
							anchorRef={thread.blockRef}
							anchorLabel={thread.blockRef}
							comments={thread.comments}
							anchorEl={null}
							variant="margin"
							onHoverChange={(h) => onHoverChange(thread.blockRef, h)}
							onClose={onClose}
						/>
					) : (
						<CollapsedCard
							thread={thread}
							onActivate={() => onActivate(thread.blockRef)}
							onHoverChange={(h) => onHoverChange(thread.blockRef, h)}
						/>
					)}
				</div>
			))}
		</div>
	);
}

/**
 * A card at rest: avatar, author, first line of text, reply count.
 *
 * Deliberately terse — the column is a reading surface, and Docs' cards collapse
 * to roughly this. Clicking expands in place rather than opening anything
 * floating, so the comment never moves away from its text.
 */
function CollapsedCard({
	thread,
	onActivate,
	onHoverChange,
}: {
	thread: MarginThread;
	onActivate: () => void;
	onHoverChange: (hovered: boolean) => void;
}) {
	const first = thread.comments[0];
	if (!first) return null;
	const replies = thread.comments.reduce((n, c) => n + c.turns.length, 0) - 1;

	return (
		<button
			type="button"
			onMouseEnter={() => onHoverChange(true)}
			onMouseLeave={() => onHoverChange(false)}
			onClick={onActivate}
			className="w-full text-left rounded-lg border border-border bg-popover p-2.5 shadow-sm transition-colors hover:border-ring/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
		>
			<div className="flex items-start gap-2">
				<span
					aria-hidden="true"
					className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-medium uppercase text-primary"
				>
					{(first.turns[0]?.by ?? "h").replace(/^human$/, "h").slice(0, 1)}
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[11px] font-medium text-foreground">
						{first.turns[0]?.by ?? "human"}
					</span>
					<span className="mt-0.5 block line-clamp-3 text-[11px] leading-snug text-muted-foreground">
						{first.turns[0]?.text}
					</span>
					{replies > 0 && (
						<span className="mt-1 block text-[10px] text-muted-foreground/60">
							{replies} {replies === 1 ? "reply" : "replies"}
						</span>
					)}
				</span>
				{first.resolved && (
					<span className="shrink-0 text-[10px] text-muted-foreground/50">resolved</span>
				)}
			</div>
		</button>
	);
}

/**
 * Assign each card a top offset: its anchor's position, then pushed below the
 * previous card when they would collide.
 *
 * ponytail: O(n log n) single downward pass, no upward relaxation. A card can
 * end up below its anchor when a tall comment sits above it; bounded by the fact
 * that the column scrolls with the document.
 */
function layout(
	threads: readonly MarginThread[],
	blockOffsets: ReadonlyMap<string, number>,
	heights: Record<string, number>,
): { thread: MarginThread; top: number }[] {
	const sorted = threads
		.map((thread) => ({
			thread,
			desired: blockOffsets.get(thread.blockRef) ?? 0,
			height: heights[thread.blockRef] ?? 72,
		}))
		.sort((a, b) => a.desired - b.desired);

	let floor = 0;
	return sorted.map(({ thread, desired, height }) => {
		const top = Math.max(desired, floor);
		floor = top + height + CARD_GAP;
		return { thread, top };
	});
}

export const __test = { layout };