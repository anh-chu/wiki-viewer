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
 * Protocol:
 *   parent -> iframe : { source:'wv-tweak', cmd:'enable'|'disable'|'remove'|'clear', id? }
 *   iframe -> parent : { source:'wv-tweak', event:'ready'|'selected', id, selector, tag, snippet, text, rect }
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
      event: 'selected', id: id, selector: cssPath(el), tag: el.nodeName.toLowerCase(),
      snippet: snippetOf(el), text: (el.textContent || '').trim().slice(0, 200), rect: rectOf(el),
    });
  }

  function reflow() {
    if (hover && hover.__el && hover.style.display !== 'none') place(hover, rectOf(hover.__el));
    picks.forEach(badgePlace);
  }

  function removePick(id) {
    for (var i = 0; i < picks.length; i++) {
      if (picks[i].id === id) { picks[i].mark.remove(); picks[i].badge.remove(); picks.splice(i, 1); break; }
    }
    picks.forEach(badgePlace);
  }

  function clearPicks() {
    picks.forEach(function (p) { p.mark.remove(); p.badge.remove(); });
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
