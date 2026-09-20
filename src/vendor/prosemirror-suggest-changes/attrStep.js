import { rebasePos } from "./rebasePos.js";
import { getSuggestionMarks } from "./utils.js";
/**
 * Transform an attr mark step into its equivalent tracked steps.
 *
 * Attr steps are processed normally, and then a modification
 * mark is added to the node as well, to track the change.
 */ export function trackAttrStep(trackedTransaction, state, _doc, step, prevSteps, suggestionId) {
    const { modification } = getSuggestionMarks(state.schema);
    const rebasedPos = rebasePos(step.pos, prevSteps, trackedTransaction.steps);
    const $pos = trackedTransaction.doc.resolve(rebasedPos);
    const node = $pos.nodeAfter;
    // LOCAL EDIT (wiki-viewer): a modification mark cannot exist on a BLOCK node.
    // The schema in `schema.js` declares it for inline content, so attaching it to a
    // paragraph makes the document invalid and `setNodeMarkup` throws
    // `RangeError: Invalid content for node doc`. That is not hypothetical: the
    // paragraph node here has a settable `textAlign`, so clicking Align in Suggesting
    // mode crashed the editor before the change could be reviewed.
    //
    // The attribute change is applied WITHOUT a tracking mark, which is the only thing
    // the schema permits. It therefore lands as a plain formatting change rather than a
    // reviewable suggestion - a real gap, recorded in VENDORED.md, but a formatting
    // change the user can see and undo beats an editor that throws.
    if (node && !node.isInline && !node.isText) {
        trackedTransaction.setNodeMarkup(rebasedPos, null, {
            ...node.attrs,
            [step.attr]: step.value
        }, node.marks);
        return true;
    }
    let marks = node?.marks ?? [];
    const existingMod = marks.find((mark)=>mark.type === modification && mark.attrs["type"] === "attr" && mark.attrs["attrName"] === step.attr);
    if (existingMod) {
        marks = existingMod.removeFromSet(marks);
    }
    marks = modification.create({
        id: suggestionId,
        type: "attr",
        attrName: step.attr,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        previousValue: node?.attrs[step.attr],
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        newValue: step.value
    }).addToSet(marks);
    trackedTransaction.setNodeMarkup(rebasedPos, null, // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    {
        ...node?.attrs,
        [step.attr]: step.value
    }, marks);
    return true;
}
