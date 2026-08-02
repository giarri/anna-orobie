# Le Orobie di Anna

Interactive map of 93 summits across the Alpi Orobie and Prealpi, spanning the provinces of Como, Lecco, Sondrio and Bergamo. Each mountain is drawn as its real catchment area — a watershed segmentation computed from actual elevation data, seeded at the summit, so the boundary with the next mountain over runs along the valley floor between them rather than an abstract straight line. Clicking anywhere in a mountain's territory marks the whole thing climbed. Works offline with `localStorage`; optionally syncs across devices via a public S3 JSON file, written through an unauthenticated Cognito identity (no server, no secrets in the frontend).

## Local preview

Just open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
```

## Deploy to GitHub Pages

1. Create a repo on GitHub (e.g. `anna-orobie`).
2. Push this folder to it (`main` branch).
3. Repo Settings → Pages → Source: `main` branch, `/ (root)`.
4. Site will be live at `https://<username>.github.io/<repo>/`.

## Optional: cross-device sync via S3

Without this, "climbed" status is saved only in the current browser (`localStorage`). To sync across devices/visitors, set up a public-read S3 object plus a Cognito unauthenticated identity that's allowed to write only that one object. No backend server needed.

### 1. Create the S3 bucket

AWS Console → S3 → Create bucket.

- Bucket name: something globally unique, e.g. `anna-orobie-climbed`
- Region: pick one close to you, e.g. `eu-central-1` (Frankfurt)
- **Uncheck** "Block all public access" (we need the one JSON object to be publicly readable)
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

## Data

- `data/peaks.js` — 93 summits (name, elevation, lat/lon, group: "Alpi Orobie" or "Prealpi"). The 39 Orobie peaks in `peaks.txt` are filtered down to the 32 that actually fall within Como/Lecco/Sondrio/Bergamo (the rest sit in Brescia province, out of scope); the remaining 61 are a curated set of named Prealpi Lecchesi/Comasche summits (Grigne, Resegone, Corni di Canzo, Monte Barro, San Primo, Bisbino, etc), keeping distinct named peaks and dropping only technical sub-pinnacles that share a massif with an already-listed summit. Coordinates are OSM `natural=peak` nodes (Overpass API).
- `data/boundary.js` — simplified administrative boundary rings for the 4 provinces (OSM relations, Douglas-Peucker simplified). Used as an input to the cell-generation pipeline below (not loaded by the site itself).
- `data/cells.js` — precomputed GeoJSON polygon per peak (the "whole mountain" territory), generated offline:
  1. Fetch SRTM elevation tiles (AWS Terrain Tiles, terrarium format) covering the peaks' bounding box.
  2. Seed a marker at each summit's pixel and run watershed segmentation (`skimage.segmentation.watershed`) on the *negated* elevation raster — peaks become basins in the negated surface, so the catchment boundaries land on the ridges of that surface, i.e. the valleys of the real one.
  3. Vectorize each label with `cv2.findContours`, simplify (Douglas-Peucker), clip to the province-union ∩ peaks-bbox region, and dump as static GeoJSON.
  
  The pipeline isn't checked into the repo (one-off Python/venv script using numpy/scipy/scikit-image/opencv/shapely) — regenerate by re-running the same steps if the peak list changes.

All of the above is best-effort — good enough for a hiking-progress map, not for navigation or precise boundary disputes.
