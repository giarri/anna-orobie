#!/usr/bin/env python3
"""
Generate data/cells.js: one "whole mountain" polygon per peak in data/peaks.js.

WHAT THIS DOES AND WHY
-----------------------
The site highlights each climbed mountain as a filled region, not just a
summit dot. A naive way to carve up the map between peaks is a Voronoi
diagram (each point of land assigned to its nearest peak in a straight
line). That was the first approach used here, and it looks wrong: the
boundary between two peaks is an abstract straight bisector that ignores
the actual terrain, so it can cut across the middle of a slope or run
along the wrong side of a valley.

What a hiker actually means by "this is Peak A's mountain, that's Peak B's"
is a real hydrological idea: A's mountain is the ground that drains toward
A's side of the valley between them, and the valley floor itself is the
natural boundary. That's a watershed catchment, computed from a "hill"
built by seeding a flood-fill at each summit -- the opposite of a normal
river watershed (which seeds at outlets/valleys), so an ordinary watershed
tool won't do it directly. See `compute_watershed()` for how this script
gets there by flooding the *negated* elevation surface.

PIPELINE
--------
1. Load data/peaks.js (summit coordinates) and data/boundary.js (province
   boundary rings) from the repo.
2. Fetch real elevation data (AWS/Mapzen "terrarium" terrain tiles, SRTM-
   derived, free & keyless) covering the peaks, and stitch it into one
   raster.
3. Seed a unique marker pixel at each summit, and run watershed
   segmentation on the *negated* elevation raster. Every pixel ends up
   labelled with the id of the peak whose "hill" it belongs to; two
   labels meet exactly at the valley floor between them.
4. Vectorize each peak's label mask into a polygon (its pixel-space
   outline), and convert pixel coordinates back to lon/lat.
5. Fix up the vector topology (see `vectorize_labels()` docstring -- this
   is the "borders not aligned" bug from an earlier version) and clip
   everything to the region of interest.
6. Subtract named lakes (e.g. Lake Como) from any cell that overlaps them,
   so a mountain's territory never paints over open water.
7. Write the result as data/cells.js: `window.CELLS = { "<peak id>":
   <GeoJSON geometry>, ... }`. The site just renders this statically --
   no geometry computation happens in the browser.

USAGE
-----
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r tools/requirements.txt
    python3 tools/generate_cells.py

Re-run this whenever data/peaks.js or data/boundary.js changes (peaks
added/removed/moved, or the province boundaries are refreshed). Takes a
few minutes; most of that is downloading elevation tiles.

This script is not run by the website -- it's a one-off content generator,
same category as a build tool. Its own dependencies (numpy, scipy,
scikit-image, opencv, shapely) are intentionally kept out of the site's
runtime.
"""

import io
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
import requests
from PIL import Image
from shapely.geometry import LineString, Polygon, box, mapping
from shapely.ops import polygonize, unary_union
from shapely.validation import make_valid
from skimage.segmentation import watershed

REPO_ROOT = Path(__file__).resolve().parent.parent
PEAKS_JS = REPO_ROOT / "data" / "peaks.js"
BOUNDARY_JS = REPO_ROOT / "data" / "boundary.js"
CELLS_JS = REPO_ROOT / "data" / "cells.js"

# Zoom level for the elevation raster. Each step up doubles resolution
# (~19m/px at 13, this latitude) and roughly quadruples tile count/runtime.
ELEVATION_ZOOM = 13

# How far to pad the peaks' bounding box before intersecting with the
# province union, in degrees. Generous enough that no peak's watershed
# catchment gets truncated by the raster edge.
BBOX_PAD_DEG = 0.15

# Lakes to cut out of any cell that overlaps them: OSM relation id -> label
# (label is just for logging). Add more here if the map ever needs it.
LAKES_TO_EXCLUDE = {
    541757: "Lago di Como",
}

# Elevation floor for the watershed flood, in meters. Without this, a
# summit's catchment floods downhill along its valley for as long as the
# province boundary allows -- which, on the south side of Bergamo/Lecco/
# Como, runs well past the last foothill and out into the flat Po/Brianza
# plain, so a peak's cell ends up painting farmland tens of km from any
# mountain. All 88 peaks sit above 900m, so a cutoff well below that (but
# above the lowland floor, ~150-250m here) stops the flood at the plain's
# edge without ever touching a real catchment boundary.
PLAIN_ELEVATION_M = 400


# --------------------------------------------------------------------------
# Web Mercator tile math (the same scheme every XYZ raster tile server
# uses, including the OpenTopoMap basemap the site renders on top of --
# using this consistently is what keeps generated polygons aligned with
# the map underneath).
# --------------------------------------------------------------------------

def lonlat_to_tile(lon, lat, zoom):
    lat_rad = math.radians(lat)
    n = 2.0 ** zoom
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def tile_to_lonlat(x, y, zoom):
    n = 2.0 ** zoom
    lon = x / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
    return lon, math.degrees(lat_rad)


class Raster:
    """Elevation raster plus the pixel<->lonlat conversions for it."""

    def __init__(self, mosaic, zoom, tile_x0, tile_y0):
        self.mosaic = mosaic
        self.zoom = zoom
        self.tile_x0 = tile_x0
        self.tile_y0 = tile_y0

    def lonlat_to_px(self, lon, lat):
        tx, ty = lonlat_to_tile(lon, lat, self.zoom)
        return (tx - self.tile_x0) * 256, (ty - self.tile_y0) * 256

    def px_to_lonlat(self, px, py):
        tx = px / 256 + self.tile_x0
        ty = py / 256 + self.tile_y0
        return tile_to_lonlat(tx, ty, self.zoom)


# --------------------------------------------------------------------------
# Step 1: load peaks + province boundary from the repo's data files.
# They're plain `var X = <json-ish>;` files rather than pure JSON (so the
# browser can <script src> them directly with no build step), so we strip
# the assignment/semicolon and parse the rest as JSON.
# --------------------------------------------------------------------------

def load_js_assignment(path):
    # Strip `//` comment lines first: data/peaks.js documents its coordinate
    # source in a comment containing "natural=peak", which would otherwise
    # be mistaken for the assignment's "=" if we split on the first "=" in
    # the raw file.
    code_lines = [line for line in path.read_text().splitlines() if not line.strip().startswith("//")]
    payload = "\n".join(code_lines).split("=", 1)[1].strip().rstrip(";")
    return json.loads(payload)


def load_peaks():
    return load_js_assignment(PEAKS_JS)


def load_province_union():
    rings = load_js_assignment(BOUNDARY_JS)
    polys = [Polygon(ring) for ring in rings.values()]
    return unary_union(polys)


# --------------------------------------------------------------------------
# Step 2: fetch and stitch the elevation raster.
# --------------------------------------------------------------------------

def fetch_elevation_raster(clip_region, zoom=ELEVATION_ZOOM):
    minlon, minlat, maxlon, maxlat = clip_region.bounds

    x0f, y1f = lonlat_to_tile(minlon, minlat, zoom)
    x1f, y0f = lonlat_to_tile(maxlon, maxlat, zoom)
    x0, x1 = int(math.floor(x0f)), int(math.ceil(x1f))
    y0, y1 = int(math.floor(y0f)), int(math.ceil(y1f))

    n_tiles = (x1 - x0) * (y1 - y0)
    print(f"[elevation] zoom={zoom} tiles=[{x0},{x1})x[{y0},{y1}) = {n_tiles} tiles")

    width, height = (x1 - x0) * 256, (y1 - y0) * 256
    mosaic = np.zeros((height, width), dtype=np.float32)

    def fetch_tile(coords):
        tx, ty = coords
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{zoom}/{tx}/{ty}.png"
        for _attempt in range(4):
            try:
                resp = requests.get(url, timeout=15)
                if resp.status_code == 200:
                    img = Image.open(io.BytesIO(resp.content)).convert("RGB")
                    arr = np.array(img, dtype=np.float32)
                    # Terrarium encoding: https://github.com/tilezen/joerd/blob/master/docs/formats.md
                    elevation = arr[:, :, 0] * 256 + arr[:, :, 1] + arr[:, :, 2] / 256 - 32768
                    return tx, ty, elevation
            except requests.RequestException:
                pass
        print(f"[elevation] WARNING: failed to fetch tile {tx},{ty}, using flat 0m", file=sys.stderr)
        return tx, ty, np.zeros((256, 256), dtype=np.float32)

    tasks = [(tx, ty) for ty in range(y0, y1) for tx in range(x0, x1)]
    with ThreadPoolExecutor(max_workers=16) as pool:
        for tx, ty, elevation in pool.map(fetch_tile, tasks):
            px, py = (tx - x0) * 256, (ty - y0) * 256
            mosaic[py:py + 256, px:px + 256] = elevation

    print(f"[elevation] mosaic {mosaic.shape}, range {mosaic.min():.0f}m-{mosaic.max():.0f}m")
    return Raster(mosaic, zoom, x0, y0)


# --------------------------------------------------------------------------
# Step 3: watershed segmentation.
# --------------------------------------------------------------------------

def compute_watershed(raster, peaks, clip_region):
    """
    Label every raster pixel with the id of the peak whose "hill" it's on.

    `skimage.segmentation.watershed(surface, markers, mask)` floods
    outward from each marker across `surface`, and stops each flood where
    it meets another (or the mask edge) -- the boundary lands at a local
    *maximum* of `surface` between two markers.

    We want the boundary between two peaks to land at the *valley*
    between them (a minimum of true elevation), not a ridge. So we hand
    the algorithm the *negated* elevation: a summit becomes a local
    minimum of `-elevation`, which is exactly where watershed wants a
    seed to be, and the "local maximum between two markers" it floods out
    to is a local *minimum* of true elevation -- the valley floor. That's
    the entire trick.
    """
    h, w = raster.mosaic.shape

    # A peak's lon/lat (from OSM "natural=peak" nodes) is occasionally not
    # the exact raster pixel of the true summit -- at this resolution it
    # can be off by several pixels. When that happens the marker lands on
    # the peak's shoulder instead of its high point, and can end up
    # outside its own basin: the neighboring peak's flood claims the
    # whole hill, and this peak's watershed collapses to a sliver hugging
    # the ridge around the marker instead of a real catchment (reported
    # by a user as "Monte Saetta" rendering as basically a line).
    #
    # Confirmed by inspecting the elevation raster at each affected peak's
    # coordinate: the true local summit was 2-8px away and higher. Fix:
    # snap just these peaks' markers to the local elevation max within a
    # small window. This is deliberately scoped to only the peaks
    # observed to be broken (rather than applied to all 88) -- trying it
    # globally moved at least one already-correct peak's marker onto a
    # neighboring massif's slope instead of its own (Castel Reino's cell
    # shrank from a normal ~0.55km^2 catchment to a ~0.03km^2 sliver), so
    # blind snapping trades one bug for another rather than being a safe
    # universal correction.
    SNAP_PEAK_IDS = {23, 46, 56, 71, 86}  # Monte Bello, Cima di Cornice,
    # Pizzo del Dente, Monte Saetta, Monte San Martino
    SNAP_RADIUS_PX = 10  # ~130-190m at zoom 13; comfortably covers the
    # offsets seen in practice while staying under half the closest
    # peak-to-peak distance in data/peaks.js (~424m), so a snap can't
    # accidentally jump onto a neighboring peak's summit.

    markers = np.zeros((h, w), dtype=np.int32)
    for peak in peaks:
        px, py = raster.lonlat_to_px(peak["lon"], peak["lat"])
        col, row = int(round(px)), int(round(py))
        if 0 <= row < h and 0 <= col < w:
            if peak["id"] in SNAP_PEAK_IDS:
                r0, r1 = max(0, row - SNAP_RADIUS_PX), min(h, row + SNAP_RADIUS_PX + 1)
                c0, c1 = max(0, col - SNAP_RADIUS_PX), min(w, col + SNAP_RADIUS_PX + 1)
                window = raster.mosaic[r0:r1, c0:c1]
                local_row, local_col = np.unravel_index(np.argmax(window), window.shape)
                row, col = r0 + local_row, c0 + local_col
            # 3x3 dilation: a single-pixel seed is fragile against
            # resampling/rounding; a small blob survives reliably.
            markers[max(0, row - 1):row + 2, max(0, col - 1):col + 2] = peak["id"]
        else:
            print(f"[watershed] WARNING: {peak['name']} falls outside the raster", file=sys.stderr)

    mask = np.zeros((h, w), dtype=np.uint8)
    polys = clip_region.geoms if clip_region.geom_type == "MultiPolygon" else [clip_region]
    rings_px = [
        np.array([raster.lonlat_to_px(lon, lat) for lon, lat in poly.exterior.coords], dtype=np.int32)
        for poly in polys
    ]
    cv2.fillPoly(mask, rings_px, 1)
    # Stop the flood at the plain's edge (see PLAIN_ELEVATION_M) rather than
    # letting it run downhill all the way to the province boundary.
    mask &= (raster.mosaic > PLAIN_ELEVATION_M)

    labels = watershed(-raster.mosaic, markers=markers, mask=mask)
    print(f"[watershed] {len(np.unique(labels)) - 1} catchments computed (+background)")
    return labels


# --------------------------------------------------------------------------
# Step 4-5: vectorize + fix up topology.
# --------------------------------------------------------------------------

def vectorize_labels(labels, raster, peaks, clip_region):
    """
    Turn each peak's label mask into a lon/lat polygon.

    THE GAP BUG, AND THE FIX
    -------------------------
    The first version of this pipeline extracted each peak's contour with
    cv2.findContours and then ran Douglas-Peucker simplification on it
    independently, peak by peak. Two neighboring catchments share an
    exact pixel-for-pixel border in raster space -- but simplifying that
    shared border twice, independently, from each side, does not
    generally produce the same simplified line both times. The two
    "simplified" edges drift apart by a pixel or two, leaving a visible
    sliver of unclaimed land between the two mountains (reported by a
    user as "borders are not aligned").

    Fix: don't simplify each polygon on its own. Instead, buffer every
    polygon outward by a small fixed amount (`overlap_px` raster pixels)
    *before* simplifying, so that even if the two simplified edges do
    drift apart, they still overlap rather than gap. The final simplify
    pass uses a tolerance well under that buffer distance, so it can't
    reopen a gap by itself. The result: neighboring cells overlap by a
    negligible, invisible sliver instead of gapping by a visible one.
    (Verified by dense point-sampling a known-bad area: ~3.5% gap rate
    before this fix, 0% after.)
    """
    deg_per_px = (360.0 / (2.0 ** raster.zoom)) / 256.0
    overlap_px = 1.5
    buffer_deg = deg_per_px * overlap_px
    simplify_deg = buffer_deg * 0.6  # comfortably under the buffer, see above

    cells = {}
    for peak in peaks:
        peak_id = peak["id"]
        label_mask = (labels == peak_id).astype(np.uint8)
        if label_mask.sum() < 4:
            print(f"[vectorize] WARNING: {peak['name']} got no catchment pixels, skipping", file=sys.stderr)
            continue

        contours, _ = cv2.findContours(label_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            print(f"[vectorize] WARNING: {peak['name']} produced no contour, skipping", file=sys.stderr)
            continue
        contour = max(contours, key=cv2.contourArea)

        pixel_points = contour.reshape(-1, 2)
        lonlat_points = [raster.px_to_lonlat(float(px), float(py)) for px, py in pixel_points]
        if lonlat_points[0] != lonlat_points[-1]:
            lonlat_points.append(lonlat_points[0])

        try:
            poly = Polygon(lonlat_points)
            if not poly.is_valid:
                poly = make_valid(poly)
            poly = poly.buffer(buffer_deg, join_style=2)  # the overlap-not-gap trick
            poly = poly.intersection(clip_region)
            poly = poly.simplify(simplify_deg, preserve_topology=True)
        except Exception as exc:  # shapely can throw on pathological geometry
            print(f"[vectorize] WARNING: {peak['name']} geometry error: {exc}", file=sys.stderr)
            continue

        poly = _polygonal_parts_only(poly)
        if poly is None or poly.is_empty:
            print(f"[vectorize] WARNING: {peak['name']} ended up empty, skipping", file=sys.stderr)
            continue

        cells[peak_id] = poly

    print(f"[vectorize] {len(cells)}/{len(peaks)} peaks vectorized")
    return cells


def _polygonal_parts_only(geom):
    """Shapely ops can return a GeometryCollection with stray points/lines
    mixed in with the polygon(s) we actually want; keep only the polygons."""
    if geom.geom_type == "GeometryCollection":
        polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        if not polys:
            return None
        return unary_union(polys)
    return geom


# --------------------------------------------------------------------------
# Step 6: subtract lakes.
# --------------------------------------------------------------------------

def fetch_lake_polygon(relation_id, label):
    """Fetch an OSM water relation's outer ways from Overpass and assemble
    them into a polygon. Multipolygon water relations are typically a set
    of way segments that share endpoints but aren't individually closed
    rings, so we merge them into lines and let shapely's `polygonize`
    find the closed ring(s)."""
    query = f"[out:json][timeout:90];relation({relation_id});out geom;"
    headers = {"User-Agent": "anna-orobie-map/1.0 (personal hobby project, cell generator script)"}

    # Overpass's public instance is a shared, rate-limited service and
    # routinely returns 504/timeout under load -- retry with backoff
    # rather than failing the whole run over a transient hiccup.
    element = None
    for attempt in range(5):
        try:
            resp = requests.post(
                "https://overpass-api.de/api/interpreter", data={"data": query}, headers=headers, timeout=120
            )
            resp.raise_for_status()
            element = resp.json()["elements"][0]
            break
        except (requests.RequestException, IndexError, KeyError) as exc:
            wait = 5 * (attempt + 1)
            print(f"[lakes] {label}: Overpass request failed ({exc}), retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
    if element is None:
        raise RuntimeError(f"could not fetch {label} (relation {relation_id}) from Overpass after retries")

    outer_ways = [m for m in element["members"] if m.get("role") == "outer" and m.get("type") == "way"]
    segments = [[(p["lon"], p["lat"]) for p in m["geometry"]] for m in outer_ways if m.get("geometry")]

    merged = unary_union([LineString(s) for s in segments])
    polys = list(polygonize(merged))
    if not polys:
        raise ValueError(f"could not assemble a closed polygon for {label} (relation {relation_id})")

    polys.sort(key=lambda p: -p.area)
    print(f"[lakes] {label}: assembled from {len(segments)} way segments into {len(polys)} ring(s)")
    return unary_union(polys)


def subtract_lakes(cells):
    for relation_id, label in LAKES_TO_EXCLUDE.items():
        lake = fetch_lake_polygon(relation_id, label)
        touched = 0
        for peak_id, poly in list(cells.items()):
            if not poly.intersects(lake):
                continue
            remainder = _polygonal_parts_only(poly.difference(lake))
            if remainder is not None and not remainder.is_empty:
                cells[peak_id] = remainder
                touched += 1
        print(f"[lakes] {label}: subtracted from {touched} cell(s)")
    return cells


# --------------------------------------------------------------------------
# Step 7: write data/cells.js.
# --------------------------------------------------------------------------

def round_coords(coords, ndigits=5):
    if isinstance(coords[0], (list, tuple)):
        return [round_coords(c, ndigits) for c in coords]
    return [round(c, ndigits) for c in coords]


def write_cells_js(cells):
    out = {}
    for peak_id, poly in cells.items():
        geom = mapping(poly)
        geom["coordinates"] = round_coords(geom["coordinates"])
        out[str(peak_id)] = geom

    body = "window.CELLS = " + json.dumps(out, separators=(",", ":")) + ";\n"
    CELLS_JS.write_text(body)
    size_kb = len(body) / 1024
    print(f"[write] {CELLS_JS.relative_to(REPO_ROOT)}: {len(out)} cells, {size_kb:.0f} KB")


# --------------------------------------------------------------------------
# Optional: sanity-check for gaps/overlaps by dense point sampling. Not
# part of the normal run; call with --verify to double check a rebuild
# didn't reintroduce the gap bug.
# --------------------------------------------------------------------------

def verify_no_gaps(cells, clip_region, samples_per_axis=150):
    minlon, minlat, maxlon, maxlat = clip_region.bounds
    from shapely.geometry import Point

    gap = overlap = total = 0
    shapes = list(cells.values())
    for i in range(samples_per_axis):
        lon = minlon + (maxlon - minlon) * i / (samples_per_axis - 1)
        for j in range(samples_per_axis):
            lat = minlat + (maxlat - minlat) * j / (samples_per_axis - 1)
            pt = Point(lon, lat)
            if not clip_region.contains(pt):
                continue
            hits = sum(1 for s in shapes if s.contains(pt))
            total += 1
            if hits == 0:
                gap += 1
            elif hits > 1:
                overlap += 1
    print(f"[verify] {total} in-region samples: gaps={gap} ({100 * gap / total:.2f}%), "
          f"overlaps={overlap} ({100 * overlap / total:.2f}%)")


def main():
    peaks = load_peaks()
    province_union = load_province_union()

    lons = [p["lon"] for p in peaks]
    lats = [p["lat"] for p in peaks]
    peaks_bbox = box(
        min(lons) - BBOX_PAD_DEG, min(lats) - BBOX_PAD_DEG,
        max(lons) + BBOX_PAD_DEG, max(lats) + BBOX_PAD_DEG,
    )
    clip_region = province_union.intersection(peaks_bbox)

    raster = fetch_elevation_raster(clip_region)
    labels = compute_watershed(raster, peaks, clip_region)
    cells = vectorize_labels(labels, raster, peaks, clip_region)
    cells = subtract_lakes(cells)

    if "--verify" in sys.argv:
        verify_no_gaps(cells, clip_region)

    write_cells_js(cells)


if __name__ == "__main__":
    main()
