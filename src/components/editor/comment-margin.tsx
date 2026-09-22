/**
 * The annotations panel: the pushed right-hand column, holding comments AND
 * suggested changes.
 *
 * This was once two surfaces. Comments lived in an anchored column and
 * suggestions in a floating list, on the argument that a comment annotates a
 * BLOCK (so aligning its card to the block's top edge is meaningful) while a
 * suggestion is a mark over a few words (so the same alignment tells the reader
 * nothing). That argument is sound about alignment and wrong about what to do
 * with it: the answer is to anchor a suggestion to the BLOCK its mark sits in
 * and quote the words the mark covers. The card then says both "near here" and
 * "these words", which is more than either surface showed alone.
 *
 * One panel also means one collision pass. Two independent layouts let a comment
 * and a suggestion on the same line print on top of each other, which is the
 * failure mode the anchored layout exists to avoid.
 *
 * LAYOUT: the panel PUSHES the document, it does not overlay it. As a flex
 * sibling with `shrink-0` it reserves its own width, so no card can cover text.
 * `COMMENT_COLUMN_WIDTH_CSS` is the single definition of that width, and the
 * editor relies on it for the text's centring — see the note on the constant.
 *
 * It was previously an absolute overlay, for a measured reason: a flex sibling
 * subtracts from the document area, and at 60rem the leftover slack was too
 * small for `margin-inline: auto` to centre, so the document pinned left and
 * Center looked broken. The fix is not to overlay but to reserve the width
 * honestly — the column comes out of the ROW (it is a flex sibling) and never
 * out of `--editor-max-w`, so the narrow/normal/wide setting keeps its meaning.
 *
 * Positioning: each card is placed at its anchor block's vertical offset inside
 * the scroll container, then pushed down if it would overlap the card above it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ListChecks } from "lucide-react";
import type { Comment } from "@/lib/proof/types";
import type { MarkId } from "@/lib/proof/suggestion-mark";
import { cn } from "@/lib/utils";
import { type AnnotationTab, useAnnotationPanelStore } from "@/stores/annotation-panel-store";
import { PanelRightClose } from "lucide-react";
import { CommentThread } from "./comment-thread";

export interface MarginThread {
	/** Block ref the thread is anchored to. */
	blockRef: string;
	comments: Comment[];
}

/**
 * A pending suggested change, as the panel draws it.
 *
 * `id` is the mark's `data-id`, which is also what settles it: accepting or
 * rejecting calls the vendored `applySuggestion(id, from, to)`, so the card
 * needs the range too. The id keeps its ORIGINAL type — see `MarkId` — because
 * the library compares with strict equality and generates numbers.
 */
export interface PanelSuggestion {
	/** The mark's `data-id`, keeping its original type — see `MarkId`. */
	id: MarkId;
	kind: "insert" | "remove" | "modify";
	from: number;
	to: number;
	/** The text the mark covers, for the card's one-line summary. */
	text: string;
	/**
	 * Block ref the mark sits in, used to anchor the card beside that block.
	 *
	 * Null when the block could not be resolved, in which case the card is placed
	 * at the top rather than dropped: a suggested change the reader cannot see is
	 * worse than one sitting slightly away from its text.
	 */
	blockRef: string | null;
}

interface Props {
	path: string;
	threads: readonly MarginThread[];
	suggestions: readonly PanelSuggestion[];
	/** Live per-ref vertical offsets (px) from the top of the scroll content. */
	blockOffsets: ReadonlyMap<string, number>;
	/** The thread being edited right now; null means all are read-only cards. */
	activeRef: string | null;
	/** Open a thread for composing; used when the panel shows a new comment. */
	onActivate: (blockRef: string) => void;
	onClose: () => void;
	onHoverChange: (blockRef: string, hovered: boolean) => void;
	/** Accept a suggested change, identified by its mark id and range. */
	onAcceptSuggestion: (id: MarkId, from: number, to: number) => void;
	/** Reject a suggested change, identified by its mark id and range. */
	onRejectSuggestion: (id: MarkId, from: number, to: number) => void;
	/** Which of the two the tabs are showing. */
	showComments: boolean;
	showSuggestions: boolean;
}

/** Minimum vertical gap between two cards, matching Docs' comfortable rhythm. */
const CARD_GAP = 8;

/**
 * Inset from the top of the card area: exactly the header's height, nothing more.
 *
 * `blockOffsets` is measured against the SCROLL CONTAINER, but the cards are
 * positioned inside the body BELOW the tab header. The two disagree by precisely
 * the header's height, so that is what the layout is shifted by.
 *
 * NOT header + CARD_GAP. Adding a gap as well pushed every card a further 8px below
 * the text it annotates, which is visible against a short anchor — the card reads
 * as belonging to the line beneath. The header's own bottom border already
 * separates it from the card area, so no extra breathing room is needed here.
 *
 * The header is measured rather than assumed: its height depends on font metrics
 * and on whether the counts render, which is exactly the kind of difference that
 * would leave a few pixels of overlap or a gap on a different machine.
 */

/**
 * The panel's width, in one place.
 *
 * A second copy of this number is how the layout calculation in `editor.tsx`
 * drifts from the width actually rendered.
 */
export const COMMENT_COLUMN_WIDTH_REM = 19;
export const COMMENT_COLUMN_WIDTH_CSS = `${COMMENT_COLUMN_WIDTH_REM}rem`;

export function CommentMargin({
	path,
	threads,
	suggestions,
	blockOffsets,
	activeRef,
	onActivate,
	onClose,
	onHoverChange,
	onAcceptSuggestion,
	onRejectSuggestion,
	showComments,
	showSuggestions,
}: Props) {
	// Measured heights, so the collision pass knows how tall each card really is
	// (comment bodies are free text and can be any length).
	const [heights, setHeights] = useState<Record<string, number>>({});
	// The header's real height, so the card area can be inset by exactly that much.
	const headerRef = useRef<HTMLDivElement>(null);
	const [headerHeight, setHeaderHeight] = useState(0);

	useEffect(() => {
		const el = headerRef.current;
		if (!el) return;
		const measure = () => setHeaderHeight(el.offsetHeight);
		measure();
		// Fonts can land after first paint, which changes the header's height.
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// Re-measure on `activeRef` too, not just on the visible set.
	//
	// Expanding a card changes its height without changing `threads`, so keying
	// this on `[threads]` alone left the collision pass running with the
	// COLLAPSED height. The expanded card then overlapped the cards below it:
	// measured live, an expanded card spanning 45-230px had the next two sitting
	// at 108-163 and 171-226, i.e. printed on top of its body.
	// Memoized identities: a bare `[]` literal here is a NEW array every render, and
	// these feed the measuring effect's dependency array — the fresh identity made
	// the effect fire after every render, and since `setHeights` always produced a
	// new object, render → effect → setState looped until React killed it with
	// "Maximum update depth exceeded" (observed live by clicking a comment on a
	// document whose suggestion list had just emptied).
	const visibleThreads = useMemo(() => (showComments ? threads : []), [showComments, threads]);
	const visibleSuggestions = useMemo(() => (showSuggestions ? suggestions : []), [showSuggestions, suggestions]);

	useEffect(() => {
		setHeights((prev) => {
			const next = { ...prev };
			let changed = false;
			for (const t of visibleThreads) {
				const el = document.querySelector<HTMLElement>(
					`[data-margin-card="${t.blockRef}"]`,
				);
				// Assign only on a real change: returning the PREVIOUS object when
				// nothing moved lets React bail out of the re-render, which is what
				// breaks the measure → render → measure cycle this effect sits in.
				if (el && next[t.blockRef] !== el.offsetHeight) {
					next[t.blockRef] = el.offsetHeight;
					changed = true;
				}
			}
			for (const sg of visibleSuggestions) {
				const el = document.querySelector<HTMLElement>(
					`[data-margin-card="suggestion:${String(sg.id)}"]`,
				);
				const key = `suggestion:${String(sg.id)}`;
				if (el && next[key] !== el.offsetHeight) {
					next[key] = el.offsetHeight;
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [visibleThreads, visibleSuggestions, activeRef]);

	// Bring the active card into view when it is activated from the TEXT.
	//
	// Clicking a comment in the document sets the active ref from outside this
	// component, and the panel does not scroll with the document — so the card that
	// just opened can easily be off-screen, making the click look like it did
	// nothing. Keyed on `activeRef` so it fires on activation, not on every render,
	// which would fight the reader scrolling the panel by hand.
	useEffect(() => {
		if (!activeRef) return;
		const el = document.querySelector<HTMLElement>(
			`[data-margin-card="${CSS.escape(activeRef)}"]`,
		);
		// `block: "nearest"` so an already-visible card is left alone rather than
		// jumping to the middle of the panel.
		el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, [activeRef]);

	// One collision pass over BOTH kinds of card, so a comment and a suggestion on
	// the same line cannot print on top of each other.
	const laid = layout(
		visibleThreads,
		visibleSuggestions,
		blockOffsets,
		heights,
		// MINUS the header's height, because that is the amount by which the two frames
		// already disagree. `blockOffsets` is measured from the SCROLL CONTAINER's top
		// (the panel's top edge), but the cards render in a box that begins BELOW the
		// header, so the card area is already 28px further down than the measurement
		// assumes: the required offset is `blockOffset - headerHeight`.
		//
		// Adding it instead was the bug — and it produced a perfectly CONSISTENT 56px
		// error on every card, which is exactly the shape of error that reads as "the
		// whole column is shifted" rather than as an arithmetic mistake.
		-headerHeight,
	);

	if (laid.length === 0 && !showComments && !showSuggestions) return null;

	return (
		<aside
			// `shrink-0` is what makes it push rather than be squeezed: the panel
			// keeps its width and the document takes what is left.
			className="relative z-10 flex shrink-0 flex-col self-stretch overflow-hidden"
			style={{ width: COMMENT_COLUMN_WIDTH_CSS }}
			aria-label="Comments and suggested changes"
			data-comment-margin
		>
			{/* The tabs live HERE, on the panel's own header, expanded from the overlay
			    toggle that shows this column. Keeping them on the column means there is
			    one surface rather than a floating box over a reading panel, and the
			    header is outside the card area so it cannot be covered by a card. */}
			{/* The header sits BELOW the row's top, matching the outline column's
			    pt-8. The space is inside the MEASURED wrapper: headerHeight comes
			    from this div's offsetHeight, so the card layout's `-headerHeight`
			    compensation grows by exactly the same amount and every card stays
			    at the vertical position it had before. */}
			<div ref={headerRef} className="pt-8">
				<PanelHeader commentCount={threads.length} suggestionCount={suggestions.length} />
			</div>

			{/* Cards are positioned against THIS box. The header sits between this box
			    and the scroll container the offsets were measured from, so the layout is
			    shifted down by the header's measured height: without it every card is
			    high by exactly that much and the first one overlaps the tabs. */}
			<div className="relative min-h-0 flex-1" data-annotations-body>
			{laid.map((card) => (
				<div
					key={card.key}
					data-margin-card={card.key}
					data-active={
						card.thread
							? activeRef === card.thread.blockRef
								? "true"
								: "false"
							: "false"
					}
					className="absolute left-0 right-0 px-2"
					style={{ top: card.top }}
				>
					{card.thread ? (
						activeRef === card.thread.blockRef ? (
							<CommentThread
								path={path}
								anchorKey={card.thread.blockRef}
								anchorRef={card.thread.blockRef}
								// The words the comment is about, not the opaque ref: the
								// block ref says WHERE the thread lives but not WHAT it
								// discusses, and a text-anchored comment has the exact
								// words available — hiding them made the card read as
								// block-scoped even when the anchor was precise.
								anchorLabel={
									card.thread.comments.find((c) => c.textAnchor?.selectedText)
										?.textAnchor?.selectedText ?? card.thread.blockRef
								}
								comments={card.thread.comments}
								anchorEl={null}
								variant="margin"
								onHoverChange={(h) => onHoverChange(card.thread!.blockRef, h)}
								onClose={onClose}
							/>
						) : (
							<CollapsedCard
								thread={card.thread}
								active={activeRef === card.thread.blockRef}
								onActivate={() => onActivate(card.thread!.blockRef)}
								onHoverChange={(h) => onHoverChange(card.thread!.blockRef, h)}
							/>
						)
					) : card.suggestion ? (
						<SuggestionCard
							suggestion={card.suggestion}
							onAccept={() =>
								onAcceptSuggestion(
									card.suggestion!.id,
									card.suggestion!.from,
									card.suggestion!.to,
								)
							}
							onReject={() =>
								onRejectSuggestion(
									card.suggestion!.id,
									card.suggestion!.from,
									card.suggestion!.to,
								)
							}
						/>
					) : null}
				</div>
			))}
			</div>
		</aside>
	);
}

/**
 * The panel's header: the three tabs, with counts.
 *
 * Counts come from the props rather than the store so the row cannot disagree with
 * the cards drawn beneath it — the same lists are the source of both.
 */
function PanelHeader({
	commentCount,
	suggestionCount,
}: {
	commentCount: number;
	suggestionCount: number;
}) {
	const tab = useAnnotationPanelStore((s) => s.tab);
	const setTab = useAnnotationPanelStore((s) => s.setTab);
	const togglePanel = useAnnotationPanelStore((s) => s.togglePanel);
	const total = commentCount + suggestionCount;
	const tabs: { id: AnnotationTab; label: string; count: number }[] = [
		{ id: "all", label: "All", count: total },
		{ id: "comments", label: "Comments", count: commentCount },
		{ id: "changes", label: "Changes", count: suggestionCount },
	];

	return (
		<div className="flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 py-1">
			<ListChecks className="mr-0.5 h-3 w-3 shrink-0 text-muted-foreground/40" />
			<div role="tablist" aria-label="Comments and suggested changes" className="flex items-center gap-0.5">
				{tabs.map((t) => {
					const active = tab === t.id;
					return (
						<button
							key={t.id}
							type="button"
							role="tab"
							aria-selected={active}
							// Disabled rather than hidden: the three are one control, and
							// removing one would move the others under the cursor.
							disabled={t.count === 0}
							onClick={() => setTab(t.id)}
							className={cn(
								"rounded px-1.5 py-0.5 text-[10px] transition-colors",
								active
									? "bg-primary/10 font-medium text-primary"
									: "text-muted-foreground/60 hover:bg-accent hover:text-foreground",
								"disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60",
							)}
						>
							{t.label}
							{t.count > 0 && (
								<span className="ml-1 tabular-nums opacity-60">{t.count}</span>
							)}
						</button>
					);
				})}
			</div>
			{/* The hide toggle lives ON the header row, symmetric with the outline
			    column (whose header label closes that panel too): while the column is
			    open there is no corner button, and hiding leaves only the corner. */}
			<button
				type="button"
				onClick={togglePanel}
				className="ml-auto rounded p-0.5 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
				aria-label="Hide comments and suggested changes"
			>
				<PanelRightClose className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

/**
 * A comment card at rest: avatar, author, first line of text, reply count.
 *
 * Deliberately terse — the panel is a reading surface, and Docs' cards collapse
 * to roughly this. Clicking expands in place rather than opening anything
 * floating, so the comment never moves away from its text.
 */
function CollapsedCard({
	thread,
	onActivate,
	onHoverChange,
	active,
}: {
	thread: MarginThread;
	onActivate: () => void;
	onHoverChange: (hovered: boolean) => void;
	active: boolean;
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
			aria-current={active ? "true" : undefined}
			className={cn(
				"w-full rounded-lg border bg-popover p-2.5 text-left transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				active
					? // The active card is the one the reader clicked: a ring and a tint,
						// so it stays distinguishable without relying on hover, which is
						// gone as soon as the pointer moves to the text it points at.
						"border-primary/50 bg-primary/5 ring-1 ring-primary/30"
					: "border-border shadow-sm hover:border-ring/40",
			)}
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
 * A pending suggested change: what it is, the words it covers, and the two decisions.
 *
 * The quoted text is what the anchored position alone could not convey, because a
 * mark covers a few words rather than a block edge. Showing both — anchored to
 * the block, quoting the words — is the reason this panel needs no separate list.
 */
function SuggestionCard({
	suggestion,
	onAccept,
	onReject,
}: {
	suggestion: PanelSuggestion;
	onAccept: () => void;
	onReject: () => void;
}) {
	const isRemoval = suggestion.kind === "remove";
	return (
		<div className="w-full rounded-lg border border-amber-500/30 bg-popover p-2.5 shadow-sm">
			<div className="flex items-start gap-2">
				<span
					aria-hidden="true"
					className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[9px] font-medium uppercase text-amber-600"
				>
					s
				</span>
				<span className="min-w-0 flex-1">
					<span className="block text-[11px] font-medium text-foreground">
						{isRemoval ? "Suggested deletion" : "Suggested insertion"}
					</span>
					<span
						className={
							isRemoval
								? "mt-0.5 block line-clamp-3 text-[11px] leading-snug text-muted-foreground line-through"
								: "mt-0.5 block line-clamp-3 text-[11px] leading-snug text-muted-foreground"
						}
					>
						{suggestion.text || "(no text)"}
					</span>
				</span>
			</div>
			<div className="mt-2 flex items-center gap-2">
				<button
					type="button"
					onClick={onReject}
					className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					Reject
				</button>
				<button
					type="button"
					onClick={onAccept}
					className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					Approve
				</button>
			</div>
		</div>
	);
}

/**
 * Assign each card a top offset: its anchor's position, then pushed below the
 * previous card when they would collide.
 *
 * ponytail: O(n log n) single downward pass, no upward relaxation. A card can
 * end up below its anchor when a tall comment sits above it; bounded by the fact
 * that the panel scrolls with the document.
 *
 * A suggestion with no resolvable `blockRef` is placed at 0 rather than dropped,
 * so an unreviewable change cannot silently vanish from the only surface that
 * can settle it.
 */
function layout(
	threads: readonly MarginThread[],
	suggestions: readonly PanelSuggestion[],
	blockOffsets: ReadonlyMap<string, number>,
	heights: Record<string, number>,
	/**
	 * Added to every card's offset.
	 *
	 * The offsets are measured from the scroll container, but the cards live in a box
	 * that starts BELOW the tab header. Without this the whole column is high by the
	 * header's height and the first card overlaps the tabs — the defect the user saw.
	 * It is applied here rather than as CSS padding so the scrollable height is
	 * unaffected.
	 */
	inset = 0,
): {
	key: string;
	thread: MarginThread | null;
	suggestion: PanelSuggestion | null;
	top: number;
}[] {
	const sorted = [
		...threads.map((thread) => ({
			key: thread.blockRef,
			thread: thread as MarginThread | null,
			suggestion: null as PanelSuggestion | null,
			desired: blockOffsets.get(thread.blockRef) ?? 0,
			height: heights[thread.blockRef] ?? 72,
		})),
		...suggestions.map((suggestion) => {
			const key = `suggestion:${String(suggestion.id)}`;
			return {
				key,
				thread: null as MarginThread | null,
				suggestion: suggestion as PanelSuggestion | null,
				desired: suggestion.blockRef
					? (blockOffsets.get(suggestion.blockRef) ?? 0)
					: 0,
				height: heights[key] ?? 96,
			};
		}),
	].sort((a, b) => a.desired - b.desired);

	// `inset` shifts the whole column (it is negative for the panel header), and the
	// collision pass runs in the SAME space as the values it produces:
	// `floor` accumulates from each card's final `top`, so a card pushed down by a
	// collision cannot also inherit the inset a second time. Building the floor from
	// un-inset values while adding the inset to `top` was a real bug: each pushed-down
	// card landed a further `inset` below the one it was clearing.
	//
	// The clip at 0 keeps a card from being positioned above the card area, which the
	// negative inset would otherwise allow for the topmost block.
	let floor = 0;
	return sorted.map(({ key, thread, suggestion, desired, height }) => {
		const top = Math.max(desired + inset, floor);
		floor = top + height + CARD_GAP;
		return { key, thread, suggestion, top };
	});
}

export const __test = { layout };