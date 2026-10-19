/* The moon artwork comes from the reference design (assets/moons/*.png, circular alpha-masked). */
export const MOON_SRC = (kind) => `assets/moons/${kind}.png`;
const KNOWN = new Set(['phobos', 'deimos', 'europa', 'enceladus', 'titan', 'ganymede', 'callisto']);
/** Assign every `.moon[data-moon]` its image (once). */
export function paintMoons(root = document) {
  root.querySelectorAll('.moon[data-moon]').forEach(el => { if (el.dataset.painted) return; const k = KNOWN.has(el.dataset.moon) ? el.dataset.moon : 'deimos'; el.style.setProperty('--tex', `url(${new URL(MOON_SRC(k), document.baseURI).href})`); el.dataset.painted = '1'; });
}
