/**
 * Element-picker script injected into rendered HTML surfaces (a local .html
 * preview loaded via srcDoc, or a proxied node-app page) to enable "web tweak":
 * point at a rendered element, and the agent receives a robust CSS selector +
 * snippet + your note.
 *
 * Design (adapted from termdeck-localterm's artifact-picker, MIT — reimplemented):
 * it talks to the parent ONLY via window.postMessage, so it works from a
 * sandboxed null-origin iframe (no allow-same-origin, matching the wiki-viewer
 * security model: never combine allow-scripts with allow-same-origin).
 *
 * Protocol (parent -> iframe):
 *   { source:'wv-tweak', cmd:'enable'|'disable'|'remove'|'clear', id? }
 *   { source:'wv-tweak', cmd:'apply', id, ops:DomOp[] }   apply an ephemeral
 *       preview patch to the picked element; the prior state is retained so it
 *       can be reverted. Ops are DATA-ONLY (no HTML/script injection):
 *         { type:'setText', value }
 *         { type:'setStyle', prop, value }
 *         { type:'setAttr', name, value }   (name/value denylisted below)
 *         { type:'removeAttr', name }
 *         { type:'addClass', value } | { type:'removeClass', value }
 *   { source:'wv-tweak', cmd:'revert', id }   undo the applied preview patch.
 *
 * Protocol (iframe -> parent):
 *   { source:'wv-tweak', event:'ready'|'selected', id, selector, tag, snippet, text, rect }
 *
 * SECURITY: iframe->parent messages carry SELECTION FACTS ONLY. They can never
 * trigger a filesystem write or an accept; accept/discard are driven by trusted
 * parent control state. The parent additionally verifies event.source identity
 * (see readPickerMessage below) because a sandboxed null-origin iframe has an
 * opaque origin that makes event.origin checks insufficient on their own.
 *
 * This module exports the script as a string so it can be (a) served at a
 * stable URL and referenced with <script src>, or (b) inlined into proxied HTML.
 */
export const WEB_TWEAK_PICKER_JS = String.raw`(function () {
  if (window.__wvTweakPicker) return;
  var enabled = false;
  var picks = []; // {id, el, mark, badge}
  var seq = 0;
  var hover = null;
  var style = null;

  function post(msg) {
    msg.source = 'wv-tweak';
    try { parent.postMessage(msg, '*'); } catch (e) {}
  }

  function ensureChrome() {
    if (style) return;
    style = document.createElement('style');
    style.textContent =
      '.__wv-hl{position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #2563eb;' +
      'background:rgba(37,99,235,0.12);border-radius:3px;box-sizing:border-box;}' +
      '.__wv-mark{position:fixed;pointer-events:none;z-index:2147483645;border:2px dashed #2563eb;' +
      'border-radius:3px;box-sizing:border-box;}' +
      '.__wv-badge{position:fixed;pointer-events:none;z-index:2147483647;background:#2563eb;color:#fff;' +
      "font:600 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;min-width:16px;text-align:center;" +
      'padding:0 5px;border-radius:9px;box-shadow:0 1px 4px rgba(0,0,0,.35);}' +
      'html.__wv-active,html.__wv-active *{cursor:crosshair !important;}';
    style.setAttribute('data-wv-picker-chrome', '');
    document.documentElement.appendChild(style);
    hover = document.createElement('div');
    hover.className = '__wv-hl';
    hover.style.display = 'none';
    document.documentElement.appendChild(hover);
  }

  function isOwn(el) {
    return el && el.classList && (el.classList.contains('__wv-hl') ||
      el.classList.contains('__wv-mark') || el.classList.contains('__wv-badge'));
  }

  function isPickerChrome(el) {
    return isOwn(el) || (el && el.getAttribute && el.getAttribute('data-wv-picker-chrome') !== null);
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
  }

  function place(node, r) {
    node.style.top = r.top + 'px';
    node.style.left = r.left + 'px';
    node.style.width = r.width + 'px';
    node.style.height = r.height + 'px';
  }

  // Build a reasonably stable, reasonably short CSS selector by walking up to
  // 6 ancestors: prefer #id (and stop), else tag + up to two classes, adding
  // :nth-of-type only when siblings share the tag name.
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
      var sel = node.nodeName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      var cls = (node.getAttribute('class') || '').trim().split(/\s+/)
        .filter(function (c) { return c && !/^__wv-/.test(c); });
      if (cls.length) sel += '.' + cls.slice(0, 2).map(function (c) { return CSS.escape(c); }).join('.');
      var parent = node.parentNode;
      if (parent && parent.children) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.nodeName === node.nodeName; });
        if (same.length > 1) sel += ':nth-of-type(' + (Array.prototype.indexOf.call(parent.children, node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentNode;
    }
    return parts.join(' > ');
  }

  function elementPath(el) {
    if (!(el instanceof Element)) return '';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var parent = node.parentElement;
      var index = 1;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) { return !isPickerChrome(c); });
        index = siblings.indexOf(node) + 1;
      }
      parts.unshift(node.nodeName.toLowerCase() + '[' + index + ']');
      if (node === document.documentElement) break;
      node = parent;
    }
    return parts.join('/');
  }

  function snippetOf(el) {
    var h = el.outerHTML || '';
    if (h.length > 400) {
      var openEnd = h.indexOf('>');
      var open = openEnd >= 0 ? h.slice(0, openEnd + 1) : h.slice(0, 120);
      h = open + ' … ' + (el.textContent || '').trim().slice(0, 140);
    }
    return h;
  }

  function badgePlace(p, i) {
    var r = rectOf(p.el);
    place(p.mark, r);
    p.badge.style.top = Math.max(r.top, 0) + 2 + 'px';
    p.badge.style.left = Math.max(r.left, 0) + 2 + 'px';
    p.badge.textContent = String(i + 1);
  }

  function onMove(e) {
    if (!enabled) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hover || isOwn(el)) return;
    hover.__el = el;
    hover.style.display = 'block';
    place(hover, rectOf(el));
  }

  function onClick(e) {
    if (!enabled) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOwn(el)) return;
    e.preventDefault();
    e.stopPropagation();
    var id = 'p' + ++seq;
    var mark = document.createElement('div');
    mark.className = '__wv-mark';
    var badge = document.createElement('div');
    badge.className = '__wv-badge';
    document.documentElement.appendChild(mark);
    document.documentElement.appendChild(badge);
    var p = { id: id, el: el, mark: mark, badge: badge };
    picks.push(p);
    badgePlace(p, picks.length - 1);
    post({
      event: 'selected', id: id, selector: cssPath(el), elementPath: elementPath(el), tag: el.nodeName.toLowerCase(),
      snippet: snippetOf(el), text: (el.textContent || '').trim().slice(0, 200), rect: rectOf(el),
    });
  }

  function reflow() {
    if (hover && hover.__el && hover.style.display !== 'none') place(hover, rectOf(hover.__el));
    picks.forEach(badgePlace);
  }

  function findPick(id) {
    for (var i = 0; i < picks.length; i++) { if (picks[i].id === id) return picks[i]; }
    return null;
  }

  // Data-only preview patch application. No HTML/script injection: we never set
  // innerHTML/outerHTML. "Data-only" here also means "non-executable / no active
  // content": we use ALLOWLISTS (not denylists) for attributes and style
  // properties, and we refuse setText on raw-text/active elements (SCRIPT,
  // STYLE, etc.) where text becomes code/CSS. A compromised parent message
  // therefore still cannot introduce executable content or external loads.
  //
  // Attribute allowlist: purely presentational / inert. No URL/network/nav/form
  // bearing attributes (src, href, data, srcset, poster, ping, action, target,
  // formaction, background, xlink:href, on*), which could load or navigate.
  // 'style' is deliberately NOT allowed here: all style changes must go through
  // setStyle so the STYLE_ALLOW property allowlist stays authoritative (a raw
  // style= string would only be value-screened, not property-restricted).
  var ATTR_ALLOW = {
    'title': 1, 'alt': 1, 'aria-label': 1, 'aria-hidden': 1, 'role': 1,
    'class': 1, 'placeholder': 1, 'value': 1, 'disabled': 1,
    'dir': 1, 'lang': 1, 'tabindex': 1
  };
  // Style property allowlist: presentation only. url()/expression/etc. can't
  // appear because values are additionally screened by STYLE_DENY.
  var STYLE_ALLOW = {
    'color': 1, 'background-color': 1, 'background': 1, 'font-size': 1,
    'font-weight': 1, 'font-style': 1, 'font-family': 1, 'text-align': 1,
    'text-decoration': 1, 'line-height': 1, 'letter-spacing': 1, 'opacity': 1,
    'display': 1, 'visibility': 1, 'margin': 1, 'padding': 1, 'border': 1,
    'border-color': 1, 'border-radius': 1, 'width': 1, 'height': 1,
    'max-width': 1, 'max-height': 1, 'min-width': 1, 'min-height': 1
  };
  var STYLE_DENY = /(expression|url\s*\(|javascript:|@import|behavior|[<>])/i;
  // Elements where textContent is executable/raw-text or otherwise unsafe to set.
  var TEXT_DENY_TAG = { 'SCRIPT': 1, 'STYLE': 1, 'IFRAME': 1, 'OBJECT': 1,
    'EMBED': 1, 'TEMPLATE': 1, 'LINK': 1, 'META': 1, 'BASE': 1, 'TITLE': 1,
    'NOSCRIPT': 1 };

  function safeAttrName(n) {
    return typeof n === 'string' && Object.prototype.hasOwnProperty.call(ATTR_ALLOW, n.toLowerCase());
  }
  function safeStyleProp(p) {
    return typeof p === 'string' && Object.prototype.hasOwnProperty.call(STYLE_ALLOW, p.toLowerCase());
  }
  function textEditable(el) {
    return el && el.tagName && !TEXT_DENY_TAG[el.tagName];
  }

  function applyOps(p, ops) {
    if (!p || !Array.isArray(ops)) return;
    if (p.undo) revertOps(p); // re-applying replaces the prior preview
    var undo = [];
    var el = p.el;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op || typeof op.type !== 'string') continue;
      try {
        if (op.type === 'setText') {
          if (!textEditable(el)) continue;
          undo.push({ type: 'setText', value: el.textContent });
          el.textContent = String(op.value == null ? '' : op.value);
        } else if (op.type === 'setStyle' && safeStyleProp(op.prop)) {
          if (STYLE_DENY.test(String(op.value))) continue;
          undo.push({ type: 'setStyle', prop: op.prop, value: el.style.getPropertyValue(op.prop) });
          el.style.setProperty(op.prop, String(op.value == null ? '' : op.value));
        } else if (op.type === 'setAttr' && safeAttrName(op.name)) {
          if (STYLE_DENY.test(String(op.value))) continue;
          undo.push({ type: 'setAttr', name: op.name, value: el.getAttribute(op.name), had: el.hasAttribute(op.name) });
          el.setAttribute(op.name, String(op.value == null ? '' : op.value));
        } else if (op.type === 'removeAttr' && safeAttrName(op.name)) {
          undo.push({ type: 'setAttr', name: op.name, value: el.getAttribute(op.name), had: el.hasAttribute(op.name) });
          el.removeAttribute(op.name);
        } else if (op.type === 'addClass' && typeof op.value === 'string') {
          if (!el.classList.contains(op.value)) { undo.push({ type: 'removeClass', value: op.value }); el.classList.add(op.value); }
        } else if (op.type === 'removeClass' && typeof op.value === 'string') {
          if (el.classList.contains(op.value)) { undo.push({ type: 'addClass', value: op.value }); el.classList.remove(op.value); }
        }
      } catch (err) { /* ignore a single bad op */ }
    }
    p.undo = undo;
    reflow();
    post({ event: 'applied', id: p.id });
  }

  function revertOps(p) {
    if (!p || !p.undo) return;
    var el = p.el;
    // Undo in reverse order.
    for (var i = p.undo.length - 1; i >= 0; i--) {
      var u = p.undo[i];
      try {
        if (u.type === 'setText') el.textContent = u.value;
        else if (u.type === 'setStyle') { if (u.value) el.style.setProperty(u.prop, u.value); else el.style.removeProperty(u.prop); }
        else if (u.type === 'setAttr') { if (u.had) el.setAttribute(u.name, u.value); else el.removeAttribute(u.name); }
        else if (u.type === 'addClass') el.classList.add(u.value);
        else if (u.type === 'removeClass') el.classList.remove(u.value);
      } catch (err) {}
    }
    p.undo = null;
    reflow();
    post({ event: 'reverted', id: p.id });
  }

  function removePick(id) {
    for (var i = 0; i < picks.length; i++) {
      if (picks[i].id === id) { revertOps(picks[i]); picks[i].mark.remove(); picks[i].badge.remove(); picks.splice(i, 1); break; }
    }
    picks.forEach(badgePlace);
  }

  function clearPicks() {
    picks.forEach(function (p) { revertOps(p); p.mark.remove(); p.badge.remove(); });
    picks = [];
  }

  function setEnabled(v) {
    enabled = v;
    ensureChrome();
    document.documentElement.classList.toggle('__wv-active', v);
    if (v) {
      document.addEventListener('mousemove', onMove, true);
    } else {
      document.removeEventListener('mousemove', onMove, true);
      if (hover) hover.style.display = 'none';
    }
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'wv-tweak' || !d.cmd) return;
    if (d.cmd === 'enable') setEnabled(true);
    else if (d.cmd === 'disable') setEnabled(false);
    else if (d.cmd === 'remove') removePick(d.id);
    else if (d.cmd === 'clear') clearPicks();
    else if (d.cmd === 'apply') applyOps(findPick(d.id), d.ops);
    else if (d.cmd === 'revert') revertOps(findPick(d.id));
  });
  document.addEventListener('click', onClick, true);
  window.addEventListener('scroll', reflow, true);
  window.addEventListener('resize', reflow, true);
  window.__wvTweakPicker = true;
  post({ event: 'ready' });
})();`;

/** Inline the picker as a <script> tag, safe to append into an HTML document. */
export function pickerScriptTag(): string {
  return `<script data-wv-tweak>${WEB_TWEAK_PICKER_JS.replace(/<\/script>/gi, "<\\/script>")}</script>`;
}

/**
 * Append the picker into an HTML document string (before </body> when present).
 * Used for local .html previews rendered via srcDoc and for proxied app HTML.
 */
export function injectPicker(html: string): string {
  const tag = pickerScriptTag();
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}</body>`);
  return html + tag;
}
