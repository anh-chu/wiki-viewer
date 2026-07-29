(function () {
  const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = (rgb) => {
    const v = rgb.map((x) => srgbToLin(x / 255));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const parse = (s) => (s.match(/[0-9.]+/g) || []).slice(0, 3).map(Number);
  const ratio = (a, b) => {
    const s = [lum(a), lum(b)].sort((p, q) => q - p);
    return (s[0] + 0.05) / (s[1] + 0.05);
  };
  const pre = document.querySelector("#doc pre");
  const fenceBg = parse(getComputedStyle(pre).backgroundColor);
  const pageBg = parse(getComputedStyle(document.body).backgroundColor);
  const targets = [
    ["fence text (code)", "#doc pre code", fenceBg],
    ["comment", "#doc .hljs-comment", fenceBg],
    ["keyword", "#doc .hljs-keyword", fenceBg],
    ["string", "#doc .hljs-string", fenceBg],
    ["number", "#doc .hljs-number", fenceBg],
    ["function title", "#doc .hljs-title", fenceBg],
    ["body prose", "#doc p", pageBg],
    ["wiki link", "#doc a.wiki-link", pageBg],
    ["table header cell", "#doc th", pageBg],
    ["blockquote", "#doc blockquote p", pageBg],
  ];
  let worst = 99;
  const rows = targets
    .map((t) => {
      const el = document.querySelector(t[1]);
      if (!el) return "<tr><td>" + t[0] + '</td><td colspan="3">absent</td></tr>';
      const fg = parse(getComputedStyle(el).color);
      const r = ratio(fg, t[2]);
      if (r < worst) worst = r;
      const ok = r >= 4.5;
      return (
        "<tr><td>" + t[0] + "</td><td>rgb(" + fg.join(",") + ")</td><td>" + r.toFixed(2) +
        ':1</td><td style="color:' + (ok ? "#4ade80" : "#f87171") + '">' + (ok ? "PASS" : "FAIL") + "</td></tr>"
      );
    })
    .join("");
  // Source-file highlighting sits on the page background with no fence surface,
  // and it must be MONOSPACE: highlighting proportional text is worse than plain
  // monospace text. Disabling Tailwind preflight silently dropped the rule that
  // used to make <pre> monospace, so this is measured rather than assumed.
  const sourcePre = document.querySelector("#source pre");
  let sourceRows = "";
  if (sourcePre) {
    const sourceStyle = getComputedStyle(sourcePre);
    const fencePre = document.querySelector("#doc pre");
    const fenceFamily = fencePre ? getComputedStyle(fencePre).fontFamily : "absent";
    const isMono = (f) => /mono|courier|consolas|menlo/i.test(f);
    sourceRows +=
      "<tr><td>source font-family</td><td>" + sourceStyle.fontFamily.slice(0, 42) +
      '</td><td>' + sourceStyle.fontSize + '</td><td style="color:' +
      (isMono(sourceStyle.fontFamily) ? "#4ade80" : "#f87171") + '">' +
      (isMono(sourceStyle.fontFamily) ? "MONO" : "NOT MONO") + "</td></tr>";
    sourceRows +=
      "<tr><td>fence font-family</td><td>" + String(fenceFamily).slice(0, 42) +
      '</td><td></td><td style="color:' + (isMono(fenceFamily) ? "#4ade80" : "#f87171") + '">' +
      (isMono(fenceFamily) ? "MONO" : "NOT MONO") + "</td></tr>";
    const sourceBg = parse(getComputedStyle(sourcePre).backgroundColor);
    const backdrop = sourceBg[0] === undefined || getComputedStyle(sourcePre).backgroundColor === "rgba(0, 0, 0, 0)" ? pageBg : sourceBg;
    for (const [label, sel] of [
      ["source code text", "#source pre code, #source td"],
      ["source comment", "#source .hljs-comment"],
      ["source keyword", "#source .hljs-keyword"],
      ["source string", "#source .hljs-string"],
      ["source number", "#source .hljs-number"],
      ["line numbers", "#source td.select-none"],
    ]) {
      const el = document.querySelector(sel);
      if (!el) {
        sourceRows += "<tr><td>" + label + '</td><td colspan="3">absent</td></tr>';
        continue;
      }
      const fg = parse(getComputedStyle(el).color);
      const r = ratio(fg, backdrop);
      if (r < worst) worst = r;
      const ok = r >= 4.5;
      sourceRows +=
        "<tr><td>" + label + "</td><td>rgb(" + fg.join(",") + ")</td><td>" + r.toFixed(2) +
        ':1</td><td style="color:' + (ok ? "#4ade80" : "#f87171") + '">' + (ok ? "PASS" : "FAIL") + "</td></tr>";
    }
  }

  // A background measured against the background BEHIND it. Contrast tests cannot
  // see this, and it is what made the code block invisible on a near-black host.
  const fenceBgRgb = fenceBg;
  const surfaceDelta = Math.max(...fenceBgRgb.map((v, i) => Math.abs(v - pageBg[i])));
  const borderColour = pre ? getComputedStyle(pre).borderTopColor : "none";
  sourceRows +=
    "<tr><td>fence surface vs page</td><td>rgb(" + fenceBgRgb.join(",") + ") on rgb(" + pageBg.join(",") +
    ')</td><td>' + surfaceDelta.toFixed(0) + '/255</td><td style="color:' +
    (surfaceDelta >= 15 ? "#4ade80" : "#f87171") + '">' + (surfaceDelta >= 15 ? "VISIBLE" : "INVISIBLE") + "</td></tr>";
  sourceRows +=
    "<tr><td>fence border</td><td>" + borderColour + '</td><td></td><td style="color:' +
    (borderColour && borderColour !== "none" && !/rgba\(0, 0, 0, 0\)/.test(borderColour) ? "#4ade80" : "#f87171") +
    '">' + (borderColour && !/rgba\(0, 0, 0, 0\)/.test(borderColour) ? "PRESENT" : "ABSENT") + "</td></tr>";

  // NEGATIVE CONTROL. Without this, asserting window.__XSS_FIRED === undefined
  // against a page built from POST-sanitizer HTML is a tautology: no live payload is
  // present, so nothing could fire. The control injects the SAME payload through
  // innerHTML, bypassing the sanitizer, so the page proves its own detection works.
  // If the control does not fire, the sanitized result means nothing.
  const control = document.getElementById("control");
  if (control) {
    control.innerHTML = '<img src="x-does-not-exist" onerror="window.__XSS_CONTROL_FIRED=1" alt="">';
  }

  const xssClean = window.__XSS_FIRED === undefined;
  const inDoc = (sel) => document.querySelectorAll("#doc " + sel).length;
  document.getElementById("meter").innerHTML =
    "<p><strong>Measured in THIS browser. Fence rows compare against the fence background rgb(" +
    fenceBg.join(",") + "), prose rows against the page background rgb(" + pageBg.join(",") +
    "). AA floor for body text is 4.5:1.</strong></p>" +
    '<table><thead><tr><th>element</th><th>computed colour</th><th>contrast</th><th></th></tr></thead><tbody>' +
    rows + sourceRows + "</tbody></table>" +
    "<p>worst measured pair: <strong>" + worst.toFixed(2) + ":1</strong> &nbsp;|&nbsp; " +
    "detection control fired (MUST be true, else the line after it is meaningless): <strong style=\"color:" +
    (window.__XSS_CONTROL_FIRED ? "#4ade80" : "#f87171") + "\">" + Boolean(window.__XSS_CONTROL_FIRED) + "</strong>" +
    " &nbsp;|&nbsp; sanitized payload fired: <strong style=\"color:" + (xssClean ? "#4ade80" : "#f87171") + "\">" +
    String(!xssClean) + "</strong> &nbsp;|&nbsp; " +
    "window.__XSS_FIRED === undefined: <strong style=\"color:" + (xssClean ? "#4ade80" : "#f87171") + "\">" +
    xssClean + "</strong> &nbsp;|&nbsp; script tags: <strong>" + inDoc("script") +
    "</strong> &nbsp;|&nbsp; iframes: <strong>" + inDoc("iframe") +
    "</strong> &nbsp;|&nbsp; inline-style elements: <strong>" + inDoc("[style]") +
    "</strong> &nbsp;|&nbsp; fences: <strong>" + inDoc("pre") +
    "</strong> &nbsp;|&nbsp; tables: <strong>" + inDoc("table") + "</strong></p>";
})();
