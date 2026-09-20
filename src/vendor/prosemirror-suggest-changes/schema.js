import { suggestionIdValidate } from "./generateId.js";
export const deletion = {
    inclusive: false,
    excludes: "insertion modification deletion",
    attrs: {
        id: {
            validate: suggestionIdValidate
        }
    },
    toDOM (mark, inline) {
        return [
            "del",
            {
                "data-id": JSON.stringify(mark.attrs["id"]),
                "data-inline": String(inline),
                ...!inline && {
                    style: "display: block"
                }
            },
            0
        ];
    },
    parseDOM: [
        {
            tag: "del",
            getAttrs (node) {
                if (!node.dataset["id"]) return false;
                return {
                    id: JSON.parse(node.dataset["id"])
                };
            }
        }
    ]
};
export const insertion = {
    inclusive: false,
    excludes: "deletion modification insertion",
    attrs: {
        id: {
            validate: suggestionIdValidate
        }
    },
    toDOM (mark, inline) {
        return [
            "ins",
            {
                "data-id": JSON.stringify(mark.attrs["id"]),
                "data-inline": String(inline),
                ...!inline && {
                    style: "display: block"
                }
            },
            0
        ];
    },
    parseDOM: [
        {
            tag: "ins",
            getAttrs (node) {
                if (!node.dataset["id"]) return false;
                return {
                    id: JSON.parse(node.dataset["id"])
                };
            }
        }
    ]
};
export const modification = {
    inclusive: false,
    excludes: "deletion insertion",
    attrs: {
        id: {
            validate: suggestionIdValidate
        },
        type: {
            validate: "string"
        },
        attrName: {
            default: null,
            validate: "string|null"
        },
        previousValue: {
            default: null
        },
        newValue: {
            default: null
        }
    },
    toDOM (mark, inline) {
        return [
            inline ? "span" : "div",
            {
                "data-type": "modification",
                "data-id": JSON.stringify(mark.attrs["id"]),
                "data-mod-type": mark.attrs["type"],
                "data-mod-prev-val": JSON.stringify(mark.attrs["previousValue"]),
                // TODO: Try to serialize marks with toJSON?
                "data-mod-new-val": JSON.stringify(mark.attrs["newValue"])
            },
            0
        ];
    },
    parseDOM: [
        {
            tag: "span[data-type='modification']",
            getAttrs (node) {
                if (!node.dataset["id"]) return false;
                return {
                    id: JSON.parse(node.dataset["id"]),
                    type: node.dataset["modType"],
                    previousValue: node.dataset["modPrevVal"],
                    newValue: node.dataset["modNewVal"]
                };
            }
        },
        {
            tag: "div[data-type='modification']",
            getAttrs (node) {
                if (!node.dataset["id"]) return false;
                return {
                    id: JSON.parse(node.dataset["id"]),
                    type: node.dataset["modType"],
                    previousValue: node.dataset["modPrevVal"]
                };
            }
        }
    ]
};
/**
 * Add the deletion, insertion, and modification marks to
 * the provided MarkSpec map.
 */ export function addSuggestionMarks(marks) {
    return {
        ...marks,
        deletion,
        insertion,
        modification
    };
}
