// Must run BEFORE @tiptap/core / ProseMirror are imported: they capture
// globals at module-eval time.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const w = dom.window;
const set = (k, v) => {
	try {
		globalThis[k] = v;
	} catch {
		Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
	}
};
set("window", w);
set("document", w.document);
set("navigator", w.navigator);
set("DOMParser", w.DOMParser);
set("Node", w.Node);
set("HTMLElement", w.HTMLElement);
set("Element", w.Element);
set("XMLSerializer", w.XMLSerializer);
set("MutationObserver", w.MutationObserver);
set("getComputedStyle", w.getComputedStyle.bind(w));
