/* The seven STARDUST modes. Each mode is a *working configuration* of the registration engine plus the
   workspace emphasis that suits one of SIH26166's difficulty axes. */
export const SENSORS = [
  { id: 'OHRC', label: 'OHRC', gsd: 0.25, note: '0.25 m/px · panchromatic' },
  { id: 'TMC-2', label: 'TMC-2', gsd: 5, note: '5 m/px · panchromatic' },
  { id: 'IIRS', label: 'IIRS', gsd: 80, note: '~80 m/px · hyperspectral (one band)' },
  { id: 'Other', label: 'Other', gsd: 0, note: 'Unknown resolution' }
];
export const sensorById = (id) => SENSORS.find(s => s.id === id) || SENSORS[3];

export const MODES = [
  {
    id: 'phobos', no: '01', name: 'Phobos', title: 'Scale invariance', blurb: 'Bridge the resolution gap',
    headline: 'Match images captured at very different scales.',
    text: 'OHRC resolves 0.25 m, TMC-2 5 m and IIRS about 80 m. Phobos uses the sensor resolutions as a scale prior, then sweeps scale hypotheses coarse-to-fine before verifying the geometry.',
    cfg: { pre: 'illum', model: 'similarity', sweep: true }, tab: 'registration',
    sample: { kind: 'scale', label: 'Fine view vs 4× coarser context' }
  },
  {
    id: 'deimos', no: '02', name: 'Deimos', title: 'Image registration', blurb: 'Image registration',
    headline: 'Align two observations of the same region.',
    text: 'Deimos registers a moving image onto a fixed reference using scale-space keypoints, RootSIFT descriptors and RANSAC-verified geometry. It reports RMSE, inlier count and inlier ratio.',
    cfg: { pre: 'raw', model: 'similarity', sweep: false }, tab: 'registration',
    sample: { kind: 'basic', label: 'Rotated, rescaled window of the same terrain' }
  },
  {
    id: 'europa', no: '03', name: 'Europa', title: 'Sun-angle invariance', blurb: 'Sun-angle invariance',
    headline: 'Let the terrain, not the shadows, drive the match.',
    text: 'Low Sun elevation makes shadows the dominant texture, and they move between passes. Europa removes illumination with log and local-contrast normalisation before any feature is computed.',
    cfg: { pre: 'illum', model: 'similarity', sweep: false }, tab: 'comparison',
    sample: { kind: 'sun', label: 'Same terrain under a different illumination ramp' }
  },
  {
    id: 'enceladus', no: '04', name: 'Enceladus', title: 'Cross-modal matching', blurb: 'Cross-modal matching',
    headline: 'Match structure, not brightness.',
    text: 'A panchromatic image and a spectral band rarely agree on brightness — sometimes contrast even reverses. Enceladus matches polarity-folded gradient structure so unlike sensors can still be paired.',
    cfg: { pre: 'struct', model: 'similarity', sweep: false }, tab: 'registration',
    sample: { kind: 'inverted', label: 'Contrast-reversed, softened moving image' }
  },
  {
    id: 'titan', no: '05', name: 'Titan', title: 'Point distribution', blurb: 'Point distribution',
    headline: 'Spread the evidence across the whole overlap.',
    text: 'Accurate registration needs control points everywhere, not clustered on one crater. Titan balances matches across a grid and scores how completely they cover the overlapping area.',
    cfg: { pre: 'illum', model: 'affine', sweep: false, grid: 8, cap: 2 }, tab: 'distribution',
    sample: { kind: 'basic', label: 'Rotated, rescaled window of the same terrain' }
  },
  {
    id: 'ganymede', no: '06', name: 'Ganymede', title: 'Method benchmark', blurb: 'Method benchmark',
    headline: 'Let the data choose the method.',
    text: 'Ganymede runs six configurations — three preprocessing strategies by two geometric models — on the same pair, ranks them by RMSE, inliers and inlier ratio, and adopts the best.',
    cfg: { pre: 'raw', model: 'similarity', sweep: false }, tab: 'registration', benchmark: true,
    sample: { kind: 'sun', label: 'Same terrain under a different illumination ramp' }
  },
  {
    id: 'callisto', no: '07', name: 'Callisto', title: 'Validation & quality control', blurb: 'Validation & quality control',
    headline: 'Check the result before trusting it.',
    text: 'Callisto separates fit from evidence: spatial holdout error, a synthetic known-transform test on your reference image, and visual checks — checkerboard, flicker and difference.',
    cfg: { pre: 'illum', model: 'similarity', sweep: false }, tab: 'validation',
    sample: { kind: 'basic', label: 'Rotated, rescaled window of the same terrain' }
  }
];
export const modeById = (id) => MODES.find(m => m.id === id) || MODES[1];

export const DEFAULT_PARAMS = { model: null, pre: null, ratio: 0.8, thr: 3, maxKp: 2500, workRes: 1000, grid: null, cap: null, sweep: null, mutual: true, scalePrior: null, sens: 0.03 };
