import { TextSelection } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import { findSuggestionMarkEnd } from "./findSuggestionMarkEnd.js";
import { suggestChangesKey } from "./plugin.js";
import { getSuggestionMarks } from "./utils.js";
/**
 * Given a node and a transform, add a set of steps to the
 * transform that applies all marks of type markTypeToApply
 * and reverts all marks of type markTypeToRevert.
 *
 * If suggestionId is provided, will only add steps that impact
 * deletions, insertions, and modifications with that id.
 */ function applySuggestionsToTransform(node, tr, markTypeToApply, markTypeToRevert, suggestionId, from, to) {
    const toApplyIsInSet = suggestionId === undefined ? (marks)=>markTypeToApply.isInSet(marks) : (marks)=>{
        const mark = markTypeToApply.isInSet(marks);
        return mark && mark.attrs["id"] === suggestionId ? mark : undefined;
    };
    const toRevertIsInSet = suggestionId === undefined ? (marks)=>markTypeToRevert.isInSet(marks) : (marks)=>{
        const mark = markTypeToRevert.isInSet(marks);
        return mark && mark.attrs["id"] === suggestionId ? mark : undefined;
    };
    const isToApply = toApplyIsInSet(node.marks);
    if (isToApply) {
        if (node.isInline) {
            tr.removeMark(0, node.nodeSize, markTypeToApply);
        } else {
            tr.removeNodeMark(0, markTypeToApply);
        }
    }
    node.descendants((child, pos)=>{
        if (from !== undefined && pos < from) {
            return true;
        }
        if (to !== undefined && pos > to) {
            return false;
        }
        const isToRevert = toRevertIsInSet(child.marks);
        const isToApply = toApplyIsInSet(child.marks);
        if (!isToRevert && !isToApply) {
            return true;
        }
        if (isToRevert) {
            const { pos: deletionFrom, deleted } = tr.mapping.mapResult(pos);
            if (deleted) return false;
            const deletionTo = findSuggestionMarkEnd(tr.doc.resolve(deletionFrom + child.nodeSize), markTypeToRevert);
            // check if the previous and the next text part is a space
            // if so, we can delete the whole text part
            const prevChar = tr.doc.textBetween(deletionFrom - 1, deletionFrom, "x", "x");
            const nextChar = // textBetween is fine with negative positions (??),
            // but it errors if passed a position greater than the
            // size of the doc
            deletionTo <= tr.doc.content.size ? tr.doc.textBetween(deletionTo, deletionTo + 1, "x", "x") : "";
            const addedRange = prevChar === " " && nextChar === " " ? 1 : 0;
            tr.deleteRange(deletionFrom, deletionTo + addedRange);
            return false;
        }
        const insertionFrom = tr.mapping.map(pos);
        const insertionTo = insertionFrom + child.nodeSize;
        if (child.isInline) {
            tr.removeMark(insertionFrom, insertionTo, markTypeToApply);
            if (child.text === "\u200B") {
                tr.delete(insertionFrom, insertionTo);
            }
        } else {
            tr.removeNodeMark(insertionFrom, markTypeToApply);
        }
        return true;
    });
}
function revertModifications(node, pos, tr) {
    const { modification } = getSuggestionMarks(node.type.schema);
    const existingMods = node.marks.filter((mark)=>mark.type === modification);
    for (const mod of existingMods){
        if (mod.attrs["type"] === "attr" && typeof mod.attrs["attrName"] === "string") {
            // LOCAL EDIT (wiki-viewer): `setNodeAttribute` on a TEXT node throws
            // `NodeType.create can't construct text nodes`, which killed the whole
            // revert. Text carries no attributes, so an "attr" modification over text
            // has nothing to restore and the mark is simply removed. Guarding here
            // keeps a modification that cannot be reverted from taking the command
            // down with it. See VENDORED.md.
            if (!node.isText) {
                tr.setNodeAttribute(pos, mod.attrs["attrName"], mod.attrs["previousValue"]);
            }
        } else if (mod.attrs["type"] === "mark") {
            if (mod.attrs["previousValue"]) {
                tr.addNodeMark(0, node.type.schema.markFromJSON(mod.attrs["previousValue"]));
            } else {
                tr.removeNodeMark(pos, node.type.schema.markFromJSON(mod.attrs["previousValue"]));
            }
        } else if (mod.attrs["type"] === "nodeType") {
            tr.setNodeMarkup(pos, node.type.schema.nodes[mod.attrs["previousValue"]], null);
        } else if (mod.attrs["type"] !== "text") {
            // LOCAL EDIT (wiki-viewer): `"text"` is a legitimate type - this app writes
            // it as the default in `suggest-changes.ts` and `to-markdown.ts` - but
            // upstream only handles attr/mark/nodeType and threw for it. A text
            // modification records a wording change, so there is no node state to
            // restore and removing the mark IS the revert. Only genuinely unknown types
            // throw now. See VENDORED.md.
            throw new Error("Unknown modification type");
        }
    }
}
function modificationIsInSet(modification, id, marks) {
    const mark = modification.isInSet(marks);
    if (id === undefined) return mark;
    if (mark?.attrs["id"] === id) return mark;
    return undefined;
}
function applyModificationsToTransform(node, tr, dir, suggestionId, from, to, startPos = 0) {
    const { modification } = getSuggestionMarks(node.type.schema);
    const isModification = modificationIsInSet(modification, suggestionId, node.marks);
    if (isModification) {
        const pos = startPos;
        let prevLength;
        do {
            // https://github.com/ProseMirror/prosemirror/issues/1525
            prevLength = tr.steps.length;
            // LOCAL EDIT (wiki-viewer): `removeNodeMark` removes a mark from a NODE,
            // and throws `NodeType.create can't construct text nodes` when the mark
            // sits on text - which is the usual case for a modification over words.
            // Text carries inline marks, so those need `removeMark` over the node's
            // range. See VENDORED.md.
            if (node.isText) {
                tr.removeMark(pos, pos + node.nodeSize, modification);
            } else {
                tr.removeNodeMark(pos, modification);
            }
        }while (tr.steps.length > prevLength);
        if (dir < 0) {
            revertModifications(node, startPos, tr);
        }
    }
    node.descendants((child, pos)=>{
        // `pos` is relative to `node`; the transform needs an absolute position.
        pos += startPos;
        if (from !== undefined && pos < from) {
            return true;
        }
        if (to !== undefined && pos > to) {
            return false;
        }
        const isModification = modificationIsInSet(modification, suggestionId, child.marks);
        if (!isModification) {
            return true;
        }
        let prevLength;
        do {
            // https://github.com/ProseMirror/prosemirror/issues/1525
            prevLength = tr.steps.length;
            // Same node-vs-text distinction as above: a mark on text is an inline mark
            // and `removeNodeMark` throws for it.
            if (child.isText) {
                tr.removeMark(pos, pos + child.nodeSize, modification);
            } else {
                tr.removeNodeMark(pos, modification);
            }
        }while (tr.steps.length > prevLength);
        if (dir < 0) {
            revertModifications(child, pos, tr);
        }
        return true;
    });
}
export function applySuggestionsToNode(node) {
    const { deletion, insertion } = getSuggestionMarks(node.type.schema);
    const transform = new Transform(node);
    applySuggestionsToTransform(node, transform, insertion, deletion);
    applyModificationsToTransform(node, transform, 1);
    return transform.doc;
}
export function applySuggestionsToRange(doc, from, to) {
    // blockRange can only return null if a predicate is provided
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const nodeRange = doc.resolve(from).blockRange(doc.resolve(to));
    const { deletion, insertion } = getSuggestionMarks(doc.type.schema);
    const transform = new Transform(doc);
    applySuggestionsToTransform(doc, transform, insertion, deletion, undefined, nodeRange.start, nodeRange.end);
    applyModificationsToTransform(doc, transform, 1, undefined, nodeRange.start, nodeRange.end);
    return transform.doc.slice(transform.mapping.map(from), transform.mapping.map(to));
}
/**
 * Command that applies all tracked changes in a document.
 *
 * This means that all content within deletion marks will be deleted.
 * Insertion marks and modification marks will be removed, and their
 * contents left in the doc.
 */ export function applySuggestions(state, dispatch) {
    const { deletion, insertion } = getSuggestionMarks(state.schema);
    const tr = state.tr;
    applySuggestionsToTransform(state.doc, tr, insertion, deletion);
    applyModificationsToTransform(tr.doc, tr, 1);
    tr.setMeta(suggestChangesKey, {
        skip: true
    });
    dispatch?.(tr);
    return true;
}
/**
 * Command that applies all tracked changes in specified range.
 *
 * This means that all content within deletion marks will be deleted.
 * Insertion marks and modification marks will be removed, and their
 * contents left in the doc.
 */ export function applySuggestionsInRange(from, to) {
    return (state, dispatch)=>{
        const { deletion, insertion } = getSuggestionMarks(state.schema);
        const tr = state.tr;
        applySuggestionsToTransform(state.doc, tr, insertion, deletion, undefined, from, to);
        applyModificationsToTransform(tr.doc, tr, 1, undefined, from, to);
        tr.setMeta(suggestChangesKey, {
            skip: true
        });
        dispatch?.(tr);
        return true;
    };
}
/**
 * Command that applies a given tracked change to a document.
 *
 * This means that all content within the deletion mark will be deleted.
 * The insertion mark and modification mark will be removed, and their
 * contents left in the doc.
 */ export function applySuggestion(suggestionId, from, to) {
    return (state, dispatch)=>{
        const { deletion, insertion } = getSuggestionMarks(state.schema);
        const tr = state.tr;
        applySuggestionsToTransform(state.doc, tr, insertion, deletion, suggestionId, from, to);
        // LOCAL EDIT (wiki-viewer): pass `suggestionId`, which upstream dropped as
        // `undefined`. `applyModificationsToTransform` already scopes by id through
        // `modificationIsInSet`, so omitting it applied EVERY modification in
        // [from, to] - approving one card settled others that happened to fall in the
        // same range. See VENDORED.md.
        applyModificationsToTransform(tr.doc, tr, 1, suggestionId, from, to);
        if (!tr.steps.length) return false;
        tr.setMeta(suggestChangesKey, {
            skip: true
        });
        dispatch?.(tr);
        return true;
    };
}
/**
 * Command that reverts all tracked changes in a document.
 *
 * This means that all content within insertion marks will be deleted.
 * Deletion marks will be removed, and their contents left in the doc.
 * Modifications tracked in modification marks will be reverted.
 */ export function revertSuggestions(state, dispatch) {
    const { deletion, insertion } = getSuggestionMarks(state.schema);
    const tr = state.tr;
    applySuggestionsToTransform(state.doc, tr, deletion, insertion);
    applyModificationsToTransform(tr.doc, tr, -1);
    tr.setMeta(suggestChangesKey, {
        skip: true
    });
    dispatch?.(tr);
    return true;
}
/**
 * Command that reverts all tracked changes in specified range.
 *
 * This means that all content within insertion marks will be deleted.
 * Deletion marks will be removed, and their contents left in the doc.
 * Modifications tracked in modification marks will be reverted.
 */ export function revertSuggestionsInRange(from, to) {
    return (state, dispatch)=>{
        const { deletion, insertion } = getSuggestionMarks(state.schema);
        const tr = state.tr;
        applySuggestionsToTransform(state.doc, tr, deletion, insertion, undefined, from, to);
        applyModificationsToTransform(tr.doc, tr, -1, undefined, from, to);
        tr.setMeta(suggestChangesKey, {
            skip: true
        });
        dispatch?.(tr);
        return true;
    };
}
/**
 * Command that reverts a given tracked change in a document.
 *
 * This means that all content within the insertion mark will be deleted.
 * The deletion mark will be removed, and their contents left in the doc.
 * Modifications tracked in modification marks will be reverted.
 */ export function revertSuggestion(suggestionId, from, to) {
    return (state, dispatch)=>{
        const { deletion, insertion } = getSuggestionMarks(state.schema);
        const tr = state.tr;
        applySuggestionsToTransform(state.doc, tr, deletion, insertion, suggestionId, from, to);
        // LOCAL EDIT (wiki-viewer): the `return false` used to run BEFORE the
        // modification pass, so rejecting a modification-only suggestion dispatched
        // nothing and the card stayed on screen. The guard only means "no insertion or
        // deletion mark was touched", which is the normal case for a modification, so
        // the modification pass runs first and the emptiness check moves after it.
        // `suggestionId` is passed for the same reason as in `applySuggestion`.
        applyModificationsToTransform(tr.doc, tr, -1, suggestionId, from, to);
        if (!tr.steps.length) return false;
        tr.setMeta(suggestChangesKey, {
            skip: true
        });
        dispatch?.(tr);
        return true;
    };
}
/**
 * Command that updates the selection to cover an existing change.
 */ export function selectSuggestion(suggestionId) {
    return (state, dispatch)=>{
        const { deletion, insertion, modification } = getSuggestionMarks(state.schema);
        let changeStart = null;
        let changeEnd = null;
        state.doc.descendants((node, pos)=>{
            const mark = node.marks.find((mark)=>mark.type === insertion || mark.type === deletion || mark.type === modification);
            if (mark?.attrs["id"] !== suggestionId) return true;
            if (changeStart === null) {
                changeStart = pos;
                changeEnd = pos + node.nodeSize;
                return false;
            }
            changeEnd = pos + node.nodeSize;
            return false;
        });
        if (changeStart === null || changeEnd === null) {
            return false;
        }
        if (!dispatch) return true;
        dispatch(state.tr.setSelection(TextSelection.create(state.doc, changeStart, changeEnd)).scrollIntoView());
        return true;
    };
}
/** Command that enables suggest changes */ export function enableSuggestChanges(state, dispatch) {
    if (!suggestChangesKey.getState(state)) return false;
    if (!dispatch) return true;
    dispatch(state.tr.setMeta(suggestChangesKey, {
        skip: true,
        enabled: true
    }));
    return true;
}
/** Command that disables suggest changes */ export function disableSuggestChanges(state, dispatch) {
    if (!suggestChangesKey.getState(state)) return false;
    if (!dispatch) return true;
    dispatch(state.tr.setMeta(suggestChangesKey, {
        skip: true,
        enabled: false
    }));
    return true;
}
/** Command that toggles suggest changes on or off */ export function toggleSuggestChanges(state, dispatch) {
    const pluginState = suggestChangesKey.getState(state);
    if (!pluginState) return false;
    if (!dispatch) return true;
    dispatch(state.tr.setMeta(suggestChangesKey, {
        skip: true,
        enabled: !pluginState.enabled
    }));
    return true;
}
