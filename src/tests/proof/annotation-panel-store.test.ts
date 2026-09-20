/**
 * The annotations panel's state: counts published by the editor, and the tab the
 * reader chose.
 *
 * The counts and the choice have different writers and different lifetimes, which
 * is the part worth testing: `count` comes from the document (the editor is the
 * only thing that can see it) and `tab` is the reader's. Keeping them separate is
 * what lets a document with no comments still offer the Changes tab.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
	panelContents,
	useAnnotationPanelStore,
} from "@/stores/annotation-panel-store";

beforeEach(() => {
	useAnnotationPanelStore.setState({
		commentCount: 0,
		suggestionCount: 0,
		panelOpen: false,
		tab: "all",
	});
});

describe("annotation panel state", () => {
	test("the panel starts closed, showing both kinds", () => {
		const s = useAnnotationPanelStore.getState();
		assert.equal(s.panelOpen, false);
		assert.equal(s.tab, "all");
	});

	test("the counts come from the editor and are published together", () => {
		useAnnotationPanelStore.getState().setCounts(3, 2);
		const s = useAnnotationPanelStore.getState();
		assert.equal(s.commentCount, 3);
		assert.equal(s.suggestionCount, 2);

		// One setter, so the two counts can never be updated a render apart and leave
		// the badge summing a stale pair.
		useAnnotationPanelStore.getState().setCounts(0, 0);
		assert.equal(useAnnotationPanelStore.getState().commentCount, 0);
		assert.equal(useAnnotationPanelStore.getState().suggestionCount, 0);
	});

	test("the tab filters which kind the panel shows", () => {
		const base = { commentCount: 3, suggestionCount: 2, panelOpen: true };

		assert.deepEqual(panelContents({ ...base, tab: "all" }), {
			comments: 3,
			suggestions: 2,
			total: 5,
			empty: false,
		});
		assert.deepEqual(panelContents({ ...base, tab: "comments" }), {
			comments: 3,
			suggestions: 0,
			total: 3,
			empty: false,
		});
		assert.deepEqual(panelContents({ ...base, tab: "changes" }), {
			comments: 0,
			suggestions: 2,
			total: 2,
			empty: false,
		});
	});

	test("empty means open with nothing to draw, not merely closed", () => {
		// A closed panel is not empty — it is closed, and the button already says so.
		// Conflating them would make the panel announce emptiness it was never asked to.
		assert.equal(
			panelContents({
				commentCount: 0,
				suggestionCount: 0,
				panelOpen: false,
				tab: "all",
			}).empty,
			false,
		);
		assert.equal(
			panelContents({
				commentCount: 0,
				suggestionCount: 0,
				panelOpen: true,
				tab: "all",
			}).empty,
			true,
		);
	});

	test("a tab whose kind is absent is empty, even if the other kind is not", () => {
		// The reviewer is looking at a tab that shows nothing; the panel has to say so
		// rather than drawing the other kind under a heading that contradicts it.
		assert.equal(
			panelContents({
				commentCount: 0,
				suggestionCount: 4,
				panelOpen: true,
				tab: "comments",
			}).empty,
			true,
		);
	});

	test("revealComments is idempotent and lands on the comments tab", () => {
		// Used by jump-to-comment. It must not flip the panel shut the way a toggle
		// would: hiding the very card being jumped to is worse than doing nothing.
		useAnnotationPanelStore.getState().revealComments();
		assert.equal(useAnnotationPanelStore.getState().panelOpen, true);
		assert.equal(useAnnotationPanelStore.getState().tab, "comments");

		useAnnotationPanelStore.getState().revealComments();
		const s = useAnnotationPanelStore.getState();
		assert.equal(s.panelOpen, true, "a second call must not close the panel");
		assert.equal(s.tab, "comments");
	});

	test("toggling the panel does not disturb the chosen tab", () => {
		useAnnotationPanelStore.getState().setTab("changes");
		useAnnotationPanelStore.getState().togglePanel();
		useAnnotationPanelStore.getState().togglePanel();
		const s = useAnnotationPanelStore.getState();
		assert.equal(s.panelOpen, false);
		assert.equal(s.tab, "changes", "the reader's tab outlives a close and reopen");
	});
});