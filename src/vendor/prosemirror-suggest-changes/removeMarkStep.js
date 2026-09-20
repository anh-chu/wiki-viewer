import { replaceStep } from "@tiptap/pm/transform";
import { applySuggestionsToRange } from "./commands.js";
import { suggestReplaceStep } from "./replaceStep.js";
/**
 * Transform a remove mark step into its equivalent tracked steps.
 *
 * Add mark steps are treated as replace steps in this model. An
 * equivalent replace step will be generated, and then processed via
 * trackReplaceStep().
 */ export function suggestRemoveMarkStep(trackedTransaction, state, doc, step, prevSteps, suggestionId) {
    const applied = step.apply(doc).doc;
    if (!applied) return false;
    const slice = applySuggestionsToRange(applied, step.from, step.to);
    const replace = replaceStep(doc, step.from, step.to, slice);
    if (!replace) return false;
    return suggestReplaceStep(trackedTransaction, state, doc, replace, prevSteps, suggestionId);
}
