import { AddMarkStep, AddNodeMarkStep, AttrStep, RemoveMarkStep, RemoveNodeMarkStep, ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform";
import { trackAddMarkStep } from "./addMarkStep.js";
import { trackAddNodeMarkStep } from "./addNodeMarkStep.js";
import { trackAttrStep } from "./attrStep.js";
import { suggestRemoveMarkStep } from "./removeMarkStep.js";
import { suggestRemoveNodeMarkStep } from "./removeNodeMarkStep.js";
import { suggestReplaceAroundStep } from "./replaceAroundStep.js";
import { suggestReplaceStep } from "./replaceStep.js";
import { isSuggestChangesEnabled, suggestChangesKey } from "./plugin.js";
import { generateNextNumberId } from "./generateId.js";
import { getSuggestionMarks } from "./utils.js";
function getStepHandler(step) {
    if (step instanceof ReplaceStep) {
        return suggestReplaceStep;
    }
    if (step instanceof ReplaceAroundStep) {
        return suggestReplaceAroundStep;
    }
    if (step instanceof AddMarkStep) {
        return trackAddMarkStep;
    }
    if (step instanceof RemoveMarkStep) {
        return suggestRemoveMarkStep;
    }
    if (step instanceof AddNodeMarkStep) {
        return trackAddNodeMarkStep;
    }
    if (step instanceof RemoveNodeMarkStep) {
        return suggestRemoveNodeMarkStep;
    }
    if (step instanceof AttrStep) {
        return trackAttrStep;
    }
    // Default handler — simply rebase the step onto the
    // tracked transaction and apply it.
    return (trackedTransaction, _state, _doc, step, prevSteps)=>{
        const reset = prevSteps.slice().reverse().reduce((acc, step)=>acc?.map(step.getMap().invert()) ?? null, step);
        const rebased = trackedTransaction.steps.reduce((acc, step)=>acc?.map(step.getMap()) ?? null, reset);
        if (rebased) {
            trackedTransaction.step(rebased);
        }
        return false;
    };
}
/**
 * Given a standard transaction from ProseMirror, produce
 * a new transaction that tracks the changes from the original,
 * rather than applying them.
 *
 * For each type of step, we implement custom behavior to prevent
 * deletions from being removed from the document, instead adding
 * deletion marks, and ensuring that all insertions have insertion
 * marks.
 */ export function transformToSuggestionTransaction(originalTransaction, state, generateId) {
    getSuggestionMarks(state.schema);
    let suggestionId = generateId ? generateId(state.schema, originalTransaction.docs[0]) : generateNextNumberId(state.schema, originalTransaction.docs[0]);
    // Create a new transaction from scratch. The original transaction
    // is going to be dropped in favor of this one.
    const trackedTransaction = state.tr;
    for(let i = 0; i < originalTransaction.steps.length; i++){
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const step = originalTransaction.steps[i];
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const doc = originalTransaction.docs[i];
        const stepTracker = getStepHandler(step);
        if (stepTracker(trackedTransaction, state, doc, step, originalTransaction.steps.slice(0, i), suggestionId) && i < originalTransaction.steps.length - 1) {
            // If the suggestionId was used by one of the step handlers,
            // increment it so that it's not reused.
            if (generateId) {
                suggestionId = generateId(state.schema, trackedTransaction.doc);
            } else if (typeof suggestionId === "number") {
                suggestionId = suggestionId + 1;
            }
        }
        continue;
    }
    if (originalTransaction.selectionSet && !trackedTransaction.selectionSet) {
        // Map the original selection backwards through the original transaction,
        // and then forwards through the new one.
        const originalBaseDoc = originalTransaction.docs[0];
        const base = originalBaseDoc ? originalTransaction.selection.map(originalBaseDoc, originalTransaction.mapping.invert()) : originalTransaction.selection;
        trackedTransaction.setSelection(base.map(trackedTransaction.doc, trackedTransaction.mapping));
    }
    if (originalTransaction.scrolledIntoView) {
        trackedTransaction.scrollIntoView();
    }
    if (originalTransaction.storedMarksSet) {
        trackedTransaction.setStoredMarks(originalTransaction.storedMarks);
    }
    // @ts-expect-error Preserve original transaction meta exactly as-is
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    trackedTransaction.meta = originalTransaction.meta;
    return trackedTransaction;
}
/**
 * A `dispatchTransaction` decorator. Wrap your existing `dispatchTransaction`
 * function with `withSuggestChanges`, or pass no arguments to use the default
 * implementation (`view.setState(view.state.apply(tr))`).
 *
 * The result is a `dispatchTransaction` function that will intercept
 * and modify incoming transactions when suggest changes is enabled.
 * These modified transactions will suggest changes instead of directly
 * applying them, e.g. by marking a range with the deletion mark rather
 * than removing it from the document.
 */ export function withSuggestChanges(dispatchTransaction, generateId) {
    const dispatch = dispatchTransaction ?? function(tr) {
        this.updateState(this.state.apply(tr));
    };
    return function dispatchTransaction(tr) {
        const ySyncMeta = tr.getMeta("y-sync$") ?? {};
        const transaction = isSuggestChangesEnabled(this.state) && !tr.getMeta("history$") && !tr.getMeta("collab$") && !ySyncMeta.isUndoRedoOperation && !ySyncMeta.isChangeOrigin && !("skip" in (tr.getMeta(suggestChangesKey) ?? {})) ? transformToSuggestionTransaction(tr, this.state, generateId) : tr;
        dispatch.call(this, transaction);
    };
}
