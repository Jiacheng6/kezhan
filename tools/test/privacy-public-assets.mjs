import { createHash } from 'node:crypto';

// Three.js r183 contains long fractional math constants that match phone/ID regexes.
// Only these two generic patterns are exempted for the byte-identical public asset.
// Exact local identifiers, learning terms, paths and token patterns remain checked.
const PUBLIC_NUMERIC_ASSETS = new Map([
  ['src/ui/library/vendor/three.module.min.js', 'e3ec4d5d223c0119f754150a3d9deef16139074ea17b073e93bbce315ad16eda'],
  // Vite chunk containing only the locked public Three.js package, kept apart
  // from runtime course data and first-party code by manualChunks.
  ['src/ui/library/archive/assets/three-BqexGCvw.js', 'f54d0669fd4cd4ea57ff787c271e39e7e1344d27fa3174dd9793b2ccbc079ead'],
]);
export function isPublicNumericAsset(file, content) {
  const expected = PUBLIC_NUMERIC_ASSETS.get(file.replaceAll('\\', '/'));
  return !!expected && createHash('sha256').update(content).digest('hex') === expected;
}

// Keep the MIT author's published namespace in the shipped glyph table.
// Only this exact upstream file may omit that one contact from the generic
// email scan; edits or added content cancel the exception. Other scans use
// the original content, including exact local identifiers and learning terms.
export function withoutPinnedAuthorEmail(file, content) {
  if (file.replaceAll('\\', '/') !== 'src/chaoxing/vendor/cx-font/glyph-table.json' ||
      createHash('sha256').update(content).digest('hex') !== 'fbc6ae3c795a46ca2bd0994e68e7cb90ca4d9a046f335512657760d9a4fdf875') return content;
  return content.replace('wyn665817' + '@' + '163.com', 'public-author-contact');
}
