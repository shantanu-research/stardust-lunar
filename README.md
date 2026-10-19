# STARDUST — web app (SIH26166)

A standalone, dependency-free web app for Sun-angle, scale and modality invariant image correspondence on Chandrayaan-2 imagery (OHRC / TMC-2 / IIRS).

## Run

Serve this folder over HTTP (Web Workers and ES modules do not run from `file://`):

```bash
python -m http.server 8790 --directory stardust
```

Then open http://127.0.0.1:8790.

## Flow

Home → **New Project** → *Choose your mode* → New Project dialog → mode brief (load the source and reference images, or a sample pair) → **Start Analysis** → workspace: Overview (Registration · Comparison · Distribution · Validation), Data, Processing, Results, Export.

| Mode | Focus | Engine configuration |
|---|---|---|
| 01 Phobos | Scale invariance | Sun-angle normalised input, scale prior from the instrument resolutions, ±2× scale sweep |
| 02 Deimos | Image registration | Intensity input, similarity transform |
| 03 Europa | Sun-angle invariance | Log + local mean/variance normalisation |
| 04 Enceladus | Cross-modal matching | Polarity-folded gradient descriptors (tolerant of contrast reversal) |
| 05 Titan | Point distribution | Affine model, grid-balanced control-point selection |
| 06 Ganymede | Method benchmark | Runs 3 preprocessing × 2 models and adopts the best |
| 07 Callisto | Validation & QC | Spatial holdout, synthetic known-transform test, visual checks |

## Engine

`js/engine.js` runs in a Web Worker: scale-space (DoG) keypoints → RootSIFT descriptors → mutual ratio-test matching → RANSAC + least-squares refinement → warp. It outputs the registered image (PNG), match points (CSV), transform and statistics (JSON: RMSE, inliers, inlier ratio, coverage, uniformity, holdout) and an HTML report.

## Data

Projects, images and results are stored in IndexedDB on this device; nothing is uploaded. The sample pairs use real LRO WAC terrain (`assets/lro-wac-sample.jpg`, NASA/GSFC/ASU, public domain), with the moving view synthesised from a known transform, so their error against ground truth can be reported.

## Desktop app (Linux, also Windows/macOS)

The app ships as an Electron shell that serves the bundled files from a loopback-only server and runs the renderer sandboxed (context isolation, no Node in the page, strict CSP, no permissions granted).

```bash
npm install
npm start                 # run locally
npm run dist:linux        # AppImage + .deb + .tar.gz in dist/
```

Build Linux packages on Linux (or use the `STARDUST Linux build` GitHub Action in `.github/workflows`). Run the AppImage with `chmod +x STARDUST-*.AppImage && ./STARDUST-*.AppImage`.

Rendering notes: the flare and aurora are WebGL shaders with a frame-time governor that lowers their resolution on slow GPUs and pauses them when the window is hidden. If your driver misbehaves, `STARDUST_NO_GPU=1 stardust` forces software rendering. Reduced-motion is honoured. The browser build registers an offline service worker (not on localhost).

## Third-party

GSAP 3.12.5 (gsap.com, standard no-charge licence) and Lenis 1.1.13 (MIT) are vendored in `vendor/`. Manrope is SIL OFL (see `assets/fonts`).
