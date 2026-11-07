// Browser-side, read-only extraction. Work on inert templates, never on the
// live inputs/editors. Legacy raw text remains the draft/review identity.
export function extractBankMathContent({ blocks, optionSelector, cxFont }) {
  const tidy = value => String(value || '').replace(/\s+/gu, ' ').trim();
  const familyName = name => name.replace(/["']/g, '').trim().toLowerCase();
  const customFonts = new Set([...document.fonts].map(f => familyName(f.family))
    .filter(name => !/^cxchinesequote\d*$/.test(name)));
  const sourceSelector = 'annotation[encoding="application/x-tex"]';
  const hasTex = root => !!root?.querySelector(sourceSelector)?.textContent.trim();
  const stripProtocol = value => value.replace(/http[s]?:\/\//, '');
  const parse = html => {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template;
  };
  // Preserve spelling, query order, signatures, entities, and the legacy
  // U+2002 rule. Do not turn the input into a URL and serialize it back.
  const normalize = (html, stem) => {
    let value = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    value = value.replace(/<img([^>]*)>/gi, tag => {
      const image = parse(tag).content.firstElementChild;
      const src = image?.getAttribute('src');
      return src ? stripProtocol(src) : tag;
    });
    value = value.replace(/<iframe([^>]*)>/gi, tag => {
      const iframe = parse(tag).content.firstElementChild;
      const src = iframe?.getAttribute('_src') || iframe?.getAttribute('src');
      return src ? stripProtocol(src) : tag;
    });
    const template = parse(value);
    for (const player of template.content.querySelectorAll('.audioReader')) {
      const src = player.querySelector('source')?.getAttribute('src');
      player.innerHTML = src ? stripProtocol(src) : '';
    }
    value = template.innerHTML.replace(/([\x00-\x1F\x7F]|\s){2,}/g, ' ')
      .replace(/<[^>]*>/g, '').replaceAll('javascript:void(0);', '');
    if (stem) {
      const from = '，。？！：；“”‘’（）【】、';
      const to = ',.?!:;"' + '"' + "''()[],";
      value = value.replace(/[，。？！：；“”‘’（）【】、]/g, char => to[from.indexOf(char)]);
      value = value.replaceAll('"', '*').replaceAll('&nbsp;', '').replaceAll("'", '*').replaceAll('%', '*');
    }
    value = value.replaceAll('\u2002', '').replace(/^([\x00-\x1F\x7F]|\s)+/g, '').replace(/([\x00-\x1F\x7F]|\s)+$/g, '');
    return stem ? value : value.replaceAll('&nbsp;', '');
  };
  const resourceOk = src => {
    if (!src || src.length > 4000 || /[\x00-\x20<>"']/u.test(src)) return false;
    if (/^data:/i.test(src)) return /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(src);
    try {
      const url = new URL(src, document.baseURI);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  };
  const read = (element, group = element, stem = false) => {
    if (!element) return { text: '', issue: 'question-text', identity: '' };
    const media = [...group.querySelectorAll('img,svg,math,canvas,video,audio,iframe,.audioReader')];
    const identityRoot = element.querySelector('.after') || element;
    const identity = JSON.stringify({
      text: tidy(identityRoot.textContent),
      media: [...identityRoot.querySelectorAll('img,iframe,source,annotation,svg,math,canvas,video')].map(node => [
        node.tagName.toLowerCase(), node.getAttribute('_src') || node.getAttribute('src') || '',
        ['math','svg','canvas'].includes(node.tagName.toLowerCase()) ? node.outerHTML : node.tagName.toLowerCase() === 'annotation' ? node.textContent : '',
      ]),
    });
    let issue = null;
    for (const node of media) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'canvas' || tag === 'video') issue ||= 'question-media';
      if (tag === 'math' && !hasTex(node)) issue ||= 'question-media';
      if (tag === 'svg' && !hasTex(node.closest('.katex,mjx-container,.MathJax'))) issue ||= 'question-media';
      if (tag === 'audio' && !node.closest('.audioReader')) issue ||= 'question-media';
      const src = tag === 'img' ? node.getAttribute('src') : tag === 'iframe' ? node.getAttribute('_src') || node.getAttribute('src')
        : node.matches('.audioReader') ? node.querySelector('source')?.getAttribute('src') : undefined;
      if ((tag === 'img' || tag === 'iframe' || node.matches('.audioReader')) && !resourceOk(src)) issue ||= 'question-resource';
    }
    if (media.some(node => !element.contains(node))) issue ||= 'question-media';
    const template = parse(element.innerHTML);
    const liveText = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const copyText = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    let decoded = false;
    while (liveText.nextNode()) {
      const live = liveText.currentNode;
      if (!copyText.nextNode() || copyText.currentNode.data !== live.data) { issue ||= 'question-text'; break; }
      if (!live.data.trim() || live.parentElement.closest('script,style,annotation[encoding="application/x-tex"]')) continue;
      // KaTeX's visual layer uses ordinary math fonts, not cxsecret. Its TeX
      // source remains in the same request and provides the formula identity.
      if (live.parentElement.closest('.katex-html') && hasTex(live.parentElement.closest('.katex'))) continue;
      const families = getComputedStyle(live.parentElement).fontFamily.split(',').map(familyName);
      if (!families.some(name => customFonts.has(name) || /secret|obfuscat/i.test(name))) continue;
      if (!cxFont || families[0] !== 'font-cxsecret' || families.slice(1).some(name => customFonts.has(name) || /secret|obfuscat/i.test(name))) {
        issue ||= 'question-font'; continue;
      }
      let text = '';
      for (const char of live.data) {
        if (/\s/u.test(char) && !Object.hasOwn(cxFont, char)) { text += char; continue; }
        if (!Object.hasOwn(cxFont, char) || cxFont[char] === null) { issue ||= 'question-font'; text += char; continue; }
        text += cxFont[char];
        decoded ||= cxFont[char] !== char;
      }
      copyText.currentNode.data = text;
    }
    const text = normalize(template.innerHTML, stem);
    if (/[\ue000-\uf8ff\ufffd]/u.test(text) || !text.trim()) issue ||= 'question-text';
    if (text.length > (stem ? 8000 : 1500)) issue ||= 'question-length';
    return { text, issue, identity, decoded };
  };
  return [...document.querySelectorAll(blocks)].map((block, domIndex) => {
    const heading = block.querySelector('.Zy_TItle .fontLabel') || block.querySelector('.Zy_TItle,.fontLabel');
    const optionNodes = [...block.querySelectorAll(optionSelector)];
    if (![block.querySelector('.Zy_TItle') || heading, ...optionNodes].some(node => node?.querySelector('img,svg,math,canvas,video,audio,iframe,.audioReader'))) return null;
    const stem = read(heading, block.querySelector('.Zy_TItle') || heading, true);
    const options = optionNodes.map(option => {
      const result = read(option);
      result.text = result.text.replace(/^[A-Z]([\x00-\x1F\x7F]|\s)+/ig, '');
      const body = option.querySelector('.after');
      const aliases = body ? [read(body, option).text] : [];
      result.aliases = [...new Set([result.text, ...aliases].filter(Boolean))];
      return result;
    });
    const issue = stem.issue || options.find(option => option.issue)?.issue || null;
    return { domIndex, stem, options, issue, decoded: stem.decoded || options.some(option => option.decoded) };
  });
}

