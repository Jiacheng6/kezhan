// Serialized into the question frame. Never await a network operation here:
// the caller owns the polling budget and cancellation.
export function inspectQuestionFonts(node, { recover = false, stallMs = 2000 } = {}) {
  const doc = node.ownerDocument, win = doc.defaultView;
  const normalize = value => String(value).replace(/["']/g, '').trim().toLowerCase();
  const requests = new Map();
  const roots = [...node.querySelectorAll('.Zy_TItle, .Zy_ulTop, .Zy_ulBottom')];
  for (const root of roots.length ? roots : [node]) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim(), parent = walker.currentNode.parentElement;
      if (!text || !parent || !parent.getClientRects().length) continue;
      const style = getComputedStyle(parent);
      if (style.visibility !== 'visible' || style.display === 'none') continue;
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const current = requests.get(font) || { text: '', families: style.fontFamily.split(',').map(normalize) };
      current.text += text; requests.set(font, current);
    }
  }
  const memory = win.__keboQuestionFontLoads ||= new Map();
  // Keep the document-local cache bounded on long courses. Do not accumulate
  // one observer or unresolved awaited promise per question.
  while (memory.size > 96) memory.delete(memory.keys().next().value);
  let loadAttempts = 0, pending = 0, failed = false, stalled = false;
  const failedFonts = [];
  for (const [font, { text, families }] of requests) {
    if (doc.fonts.check(font, text)) continue;
    pending++;
    const key = font + '\n' + text;
    let entry = memory.get(key);
    if (!entry) {
      entry = { started: Date.now(), recovered: new Map() }; memory.set(key, entry);
      loadAttempts++;
      // Fire and observe, never return/await the load promise from evaluate().
      doc.fonts.load(font, text).catch(() => {});
    }
    const faces = [...doc.fonts].filter(face => families.includes(normalize(face.family)));
    const bad = faces.filter(face => face.status === 'error');
    if (bad.length) { failed = true; failedFonts.push(...bad.map(face => face.family)); }
    if (Date.now() - entry.started >= stallMs) stalled = true;
    if (!recover) continue;
    // Recover only from an exact accessible @font-face definition. Resource
    // timing cannot identify font families (and zero transfer size can be a
    // successful cached/CORS font); never assign the first URL to every face.
    const visit = (rules, base) => {
      for (const rule of rules) {
        if (rule.type === CSSRule.FONT_FACE_RULE && families.includes(normalize(rule.style.getPropertyValue('font-family')))) {
          const raw = rule.style.getPropertyValue('src');
          if (!raw) continue;
          const descriptors = {};
          for (const [css, prop] of [['font-style','style'],['font-weight','weight'],['font-stretch','stretch'],['unicode-range','unicodeRange'],['font-display','display']]) {
            const value = rule.style.getPropertyValue(css); if (value) descriptors[prop] = value;
          }
          const identity = rule.cssText;
          const attempts = entry.recovered.get(identity) || 0;
          if (attempts >= 3) continue;
          entry.recovered.set(identity, attempts + 1);
          const source = raw.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_, quote, url) => `url("${new URL(url, base).href}")`);
          try {
            const family = rule.style.getPropertyValue('font-family').replace(/["']/g,'');
            const url = /url\("([^"]+)"\)/.exec(source)?.[1];
            if (url && /^https?:/.test(url)) {
              // Reload the exact original URL, retaining signed query strings.
              // A new FontFace from downloaded bytes avoids a cached error.
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 1500);
              fetch(url, { cache: 'reload', signal: controller.signal }).then(response => {
                if (!response.ok) throw Error('font response failed');
                return response.arrayBuffer();
              }).then(async bytes => {
                // Validate bytes before replacing this exact CSS face. Merely
                // adding a loaded duplicate leaves the original error in the
                // FontFaceSet, so fonts.check() would continue to fail forever.
                await new FontFace(family, bytes, descriptors).load();
                const blob = URL.createObjectURL(new Blob([bytes]));
                try {
                  rule.style.setProperty('src', `url("${blob}")`);
                  doc.fonts.load(font, text).catch(() => {});
                } catch (error) { URL.revokeObjectURL(blob); throw error; }
              }).catch(() => {}).finally(() => clearTimeout(timer));
            } else {
              const fresh = new FontFace(family, source, descriptors);
              fresh.load().then(() => doc.fonts.add(fresh)).catch(() => {});
            }
            loadAttempts++;
          } catch { /* inaccessible/invalid definitions stay pending, never guess */ }
        }
        if (rule.cssRules) visit(rule.cssRules, base);
      }
    };
    for (const sheet of doc.styleSheets) {
      try { visit(sheet.cssRules, sheet.href || doc.baseURI); } catch { /* cross-origin CSS */ }
    }
  }
  return { pending, failed, stalled, loadAttempts, failedFonts: [...new Set(failedFonts)].slice(0,3) };
}
