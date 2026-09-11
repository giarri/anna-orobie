# Le Orobie di Anna

Interactive map of 86 summits across the Alpi Orobie and Prealpi, spanning the provinces of Como, Lecco, Sondrio and Bergamo. Each mountain is drawn as its real catchment area — a watershed segmentation computed from actual elevation data, seeded at the summit, so the boundary with the next mountain over runs along the valley floor between them rather than an abstract straight line. Clicking anywhere in a mountain's territory to mark the peak climbed.

Basemap: [OpenTopoMap](https://opentopomap.org) tiles, desaturated to grayscale via CSS (`#map .leaflet-tile-pane { filter: grayscale(...) }` in `style.css`) so a mountain's territory pops in color once it's climbed.

Works offline with `localStorage`; optionally syncs across devices via a public S3 JSON file, written through an unauthenticated Cognito identity (no server, no secrets in the frontend).

## Contents

- [Local preview](#local-preview)
- [Deploy to GitHub Pages](#deploy-to-github-pages)
- [Project layout](#project-layout)
- [Data & the cell-generation pipeline](#data--the-cell-generation-pipeline)
- [Optional: cross-device sync via S3](#optional-cross-device-sync-via-s3)
- [Caveats](#caveats)

## Local preview

Open `index.html` directly in a browser, or serve the folder:

```
python3 -m http.server 8000
```

## Deploy to GitHub Pages

1. Create a repo on GitHub .
2. Push this folder to it (`main` branch).
3. Repo Settings → Pages → Source: `main` branch, `/ (root)`.
4. Site is live at `https://<username>.github.io/<repo>/`.

## Project layout

| Path | What |
|---|---|
| `index.html` | Page shell — loads Leaflet, AWS SDK, and the app scripts |
| `style.css` | Grayscale-basemap styling, popup/progress-bar UI |
| `app.js` | Map setup, click-to-toggle "climbed" logic, localStorage + S3 sync |
| `aws-config.js` | S3/Cognito settings for optional sync — blank by default |
| `manifest.json` | PWA manifest — name, icons, `display: standalone` for "Add to Home Screen" |
| `sw.js` | Service worker — caches the app shell for offline loading and PWA installability |
| `install-prompt.js` | Shows a one-time "Installa" banner on first visit (native prompt on Android/Chrome, instructions on iOS Safari) |
| `icons/` | App icons generated from the site's mountain glyph, in the sizes `manifest.json` and iOS require |
| `data/peaks.js` | The 86 summits: name, elevation, lat/lon, group, province |
| `data/boundary.js` | Province boundary rings — pipeline input only, not loaded by the site |
| `data/cells.js` | Precomputed mountain-territory polygons — what the site actually renders |
| `tools/generate_cells.py` | Offline pipeline that produces `data/cells.js` |
| `peaks.txt` | Original 39-peak Orobie source list this project started from |

## Data & the cell-generation pipeline

`data/peaks.js` — 86 summits (name, elevation, lat/lon, `group`: "Alpi Orobie" or "Prealpi", `province`: Bergamo/Como/Lecco/Sondrio). Started from the 39 Orobie peaks in `peaks.txt`, filtered to the ones inside Como/Lecco/Sondrio/Bergamo (the rest sit in Brescia, out of scope), plus a curated set of named Prealpi summits (Grigne, Resegone, Corni di Canzo, Monte Barro, San Primo, Bisbino, etc.), then hand-adjusted — dropping technical sub-pinnacles/near-duplicates and adding named peaks that were missing. Coordinates come from OSM `natural=peak` nodes (Overpass API); province is derived by point-in-polygon against `data/boundary.js`.

`data/boundary.js` — simplified administrative boundary rings for the 4 provinces (OSM relations, Douglas-Peucker simplified). Feeds the cell-generation pipeline below; not loaded by the site itself.

`data/cells.js` — one GeoJSON polygon per peak (its "whole mountain" territory), generated offline by `tools/generate_cells.py`:

1. Fetch SRTM elevation tiles (AWS Terrain Tiles, terrarium format) covering the peaks' bounding box.
2. Seed a marker pixel at each summit and run watershed segmentation (`skimage.segmentation.watershed`) on the *negated* elevation raster — peaks become basins in the negated surface, so catchment boundaries land on that surface's ridges, i.e. the real valleys.
3. Vectorize each label with `cv2.findContours`, buffer slightly outward and simplify (Douglas-Peucker) at a tolerance below the buffer, so shared borders stay gap-free instead of drifting apart under independent simplification.
4. Clip to province-union ∩ peaks-bbox, subtract Lake Como's surface, round coordinates, and write static GeoJSON.

To regenerate after changing the peak list:

```
python3 -m venv /tmp/cells-venv && source /tmp/cells-venv/bin/activate
pip install -r tools/requirements.txt
python tools/generate_cells.py --verify
```

`--verify` dense-samples the output and reports gap/overlap rates between adjacent cells — expect ~0% outside the area Lake Como was subtracted from.

## Optional: cross-device sync via S3

Without this, "climbed" status is saved only in the current browser (`localStorage`). To sync across devices/visitors, set up a public-read S3 object plus a Cognito unauthenticated identity that's allowed to write only that one object. No backend server needed.

### 1. Create the S3 bucket

AWS Console → S3 → Create bucket.

- Bucket name: something globally unique, e.g. `anna-orobie-climbed`
- Region: pick one close to you, e.g. `eu-central-1` (Frankfurt)
- **Uncheck** "Block all public access" (the one JSON object needs to be publicly readable)
- Acknowledge the warning, create bucket

### 2. Enable CORS on the bucket

Bucket → Permissions → Cross-origin resource sharing (CORS) → paste:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedOrigins": ["https://<username>.github.io"],
    "ExposeHeaders": []
  }
]
```

(You can temporarily use `"AllowedOrigins": ["*"]` while testing locally, then lock it down to your Pages URL.)

### 3. Bucket policy — allow public read of the one file

Bucket → Permissions → Bucket policy → paste (replace `BUCKET_NAME`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadClimbedStatus",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::BUCKET_NAME/climbed-status.json"
    }
  ]
}
```

### 4. Create a Cognito Identity Pool (unauthenticated access)

AWS Console → Cognito → Identity pools → Create identity pool.

- Name: `anna-orobie-pool`
- Under "Guest access", enable "Allow unauthenticated identities"
- Create pool — this generates an **unauthenticated IAM role** (e.g. `Cognito_anna_orobie_poolUnauth_Role`)
- Note the **Identity pool ID** shown after creation (looks like `eu-central-1:xxxxxxxx-xxxx-...`)

### 5. Restrict the unauthenticated role to just this one object

IAM → Roles → find the `...Unauth_Role` created above → Add permissions → Create inline policy → JSON (replace `BUCKET_NAME`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectAcl"],
      "Resource": "arn:aws:s3:::BUCKET_NAME/climbed-status.json"
    }
  ]
}
```

This means: anyone visiting the site can overwrite `climbed-status.json` — nothing else in the bucket, no read/delete/list. Fine for a small personal site; anyone with the link could technically vandalize the climbed list, but there's nothing sensitive at stake.

### 6. Fill in `aws-config.js`

```js
window.AWS_CONFIG = {
  region: "eu-central-1",
  identityPoolId: "eu-central-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  bucket: "anna-orobie-climbed",
  key: "climbed-status.json"
};
```

Commit and push. The site now reads `https://BUCKET_NAME.s3.REGION.amazonaws.com/climbed-status.json` on load, and writes to it (via temporary Cognito credentials) every time a peak is toggled. If any step above isn't done yet, or `aws-config.js` is left blank, the site silently falls back to `localStorage`-only mode — nothing breaks.

## Caveats

Everything above is best-effort — good enough for a hiking-progress map, not for navigation or precise boundary disputes.
