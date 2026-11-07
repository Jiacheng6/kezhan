import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const MAX_FONT_BYTES = 512 * 1024;
const MAX_CHARACTERS = 8192;
let resources;

function isSupportedSubset(bytes) {
  if (bytes.length < 12 || bytes.length > MAX_FONT_BYTES || bytes.readUInt32BE(0) !== 0x00010000) return false;
  const count = bytes.readUInt16BE(4);
  if (!count || count > 64 || 12 + count * 16 > bytes.length) return false;
  const tables = new Set();
  for (let entry = 12; entry < 12 + count * 16; entry += 16) {
    const name = bytes.toString('ascii', entry, entry + 4);
    const offset = bytes.readUInt32BE(entry + 8);
    const length = bytes.readUInt32BE(entry + 12);
    if (offset + length > bytes.length || tables.has(name)) return false;
    if (name === 'maxp' && (length < 6 || bytes.readUInt16BE(offset + 4) > MAX_CHARACTERS)) return false;
    tables.add(name);
  }
  return ['cmap', 'glyf', 'head', 'loca', 'maxp'].every(name => tables.has(name));
}

export async function resolveCxQuestionFont(frame, blocks) {
  const inline = await frame.evaluate(async blockSelector => {
    const name = 'font-cxsecret';
    const faces = [...document.fonts].filter(face => face.family.replace(/["']/g, '').trim().toLowerCase() === name);
    if (faces.length !== 1 || faces[0].status === 'error') return null;
    const rules = [];
    const visit = list => {
      for (const rule of list) {
        if (rule.type === CSSRule.FONT_FACE_RULE && rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim().toLowerCase() === name) rules.push(rule);
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet.disabled) continue;
      try { visit(sheet.cssRules); } catch { /* A cross-origin stylesheet is not used as an input. */ }
    }
    if (rules.length !== 1) return null;
    const range = rules[0].style.getPropertyValue('unicode-range').trim().toLowerCase();
    if (range && range !== 'u+0-10ffff') return null;
    const src = rules[0].style.getPropertyValue('src').trim();
    const base64 = src.match(/^url\((["']?)data:(?:application\/font-ttf|font\/ttf|application\/x-font-ttf)(?:;charset=[a-z0-9-]+)?;base64,([a-z0-9+/=]+)\1\)(?:\s+format\(["']?(?:truetype|ttf)["']?\))?$/i)?.[2];
    if (!base64 || base64.length > 700_000) return null;
    const characters = new Set();
    for (const block of document.querySelectorAll(blockSelector)) {
      for (const character of block.textContent || '') {
        characters.add(character);
        if (characters.size > 8192) return null;
      }
    }
    if (faces[0].status !== 'loaded') {
      let timer;
      try {
        await Promise.race([faces[0].load(), new Promise(resolve => { timer = setTimeout(resolve, 800); })]);
      } catch { return null; }
      finally { clearTimeout(timer); }
      if (faces[0].status !== 'loaded') return null;
    }
    return { base64, characters: [...characters].join('') };
  }, blocks).catch(() => null);
  if (!inline) return null;
  try {
    const bytes = Buffer.from(inline.base64, 'base64');
    // This platform embeds a TrueType subset. Other containers and empty or
    // oversized input stay on the normal unrecognized-font path.
    if (!isSupportedSubset(bytes)) return null;
    if ([...inline.characters].length > MAX_CHARACTERS) return null;
    resources ??= Promise.all([
      import('./vendor/cx-font/typr.mjs').then(module => module.default),
      readFile(new URL('./vendor/cx-font/glyph-table.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    const [typr, table] = await resources;
    const [font] = typr.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (!font?.glyf || !font.cmap) return null;
    const decoded = {};
    let hits = 0;
    for (const character of inline.characters) {
      const glyph = typr.U.codeToGlyph(font, character.codePointAt(0));
      if (!glyph) {
        // A character absent from this subset is rendered by the fallback
        // font, so its normal Unicode text stays unchanged.
        decoded[character] = character;
        continue;
      }
      const path = typr.U.glyphToPath(font, glyph);
      const key = createHash('md5').update(JSON.stringify(path)).digest('hex').slice(-8);
      const point = Object.hasOwn(table, key) ? table[key] : null;
      if (!Number.isInteger(point) || point < 0x4e00 || point > 0x9fff) decoded[character] = null;
      else {
        decoded[character] = String.fromCodePoint(point);
        hits++;
      }
    }
    return hits ? decoded : null;
  } catch {
    return null;
  }
}
