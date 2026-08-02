(function () {
  "use strict";

  var LOCAL_KEY = "anna-orobie-climbed";
  var cfg = window.AWS_CONFIG || {};
  var s3Enabled = !!(cfg.region && cfg.identityPoolId && cfg.bucket);

  var climbed = new Set(loadLocal());
  var cellLayers = {};
  var dotLayers = {};

  var map = L.map("map", { zoomControl: true });
  L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
  }).addTo(map);

  // --- Build the 4-province union polygon (Como, Lecco, Sondrio, Bergamo) ---
  var ringsToPoly = function (ring) {
    var coords = ring.slice();
    var first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
    return turf.polygon([coords]);
  };

  var provincePolys = Object.keys(window.PROVINCE_RINGS).map(function (k) {
    return ringsToPoly(window.PROVINCE_RINGS[k]);
  });

  var provinceUnion = provincePolys[0];
  for (var i = 1; i < provincePolys.length; i++) {
    try {
      provinceUnion = turf.union(provinceUnion, provincePolys[i]);
    } catch (e) {
      console.error("union failed", e);
    }
  }

  var bbox = turf.bbox(provinceUnion); // [minLon, minLat, maxLon, maxLat] - full 4-province extent, used for clipping

  // Sondrio province reaches deep into the high Alps (Bernina/Livigno) far north of any
  // peak in our list, so framing the initial view on the full province union zooms out
  // to nearly all of Lombardy. Frame on the peaks themselves instead; the province
  // outline/cells still extend further and are reachable by panning/zooming out.
  var peakLons = PEAKS.map(function (p) { return p.lon; });
  var peakLats = PEAKS.map(function (p) { return p.lat; });
  var peaksBbox = [Math.min.apply(null, peakLons), Math.min.apply(null, peakLats),
                    Math.max.apply(null, peakLons), Math.max.apply(null, peakLats)];

  // Voronoi cells partition whatever polygon they're clipped to. Clipping to the full
  // province union lets edge peaks (e.g. the last summit before Sondrio's empty high-Alps
  // panhandle) inherit huge, geographically meaningless territory with no relation to the
  // actual mountain. Clip to the peaks' area (generously padded) intersected with the
  // province union instead, so cells stay roughly mountain-sized.
  var clipPad = 0.22;
  var clipRect = turf.bboxPolygon([
    peaksBbox[0] - clipPad, peaksBbox[1] - clipPad,
    peaksBbox[2] + clipPad, peaksBbox[3] + clipPad
  ]);
  var clipRegion = turf.intersect(provinceUnion, clipRect) || provinceUnion;

  var viewPad = 0.12;
  map.fitBounds([
    [peaksBbox[1] - viewPad, peaksBbox[0] - viewPad],
    [peaksBbox[3] + viewPad, peaksBbox[2] + viewPad]
  ], { padding: [10, 10] });

  var boundsPad = 0.35;
  map.setMaxBounds([
    [peaksBbox[1] - boundsPad, peaksBbox[0] - boundsPad],
    [peaksBbox[3] + boundsPad, peaksBbox[2] + boundsPad]
  ]);
  map.setMinZoom(9);

  // subtle outline of the mapped area
  L.geoJSON(clipRegion, {
    style: { color: "#3a3a3a", weight: 1.5, opacity: 0.5, fill: false, dashArray: "4,4" }
  }).addTo(map);

  // --- Voronoi cells: each peak "owns" the area closer to it than to any other peak,
  // clipped to the province union. Longitude scaled by cos(latitude) so cells aren't
  // horizontally stretched (lon/lat degrees aren't equal distances on the ground). ---
  var latRad = (bbox[1] + bbox[3]) / 2 * Math.PI / 180;
  var lonScale = Math.cos(latRad);

  var toXY = function (lon, lat) { return [lon * lonScale, lat]; };
  var toLonLat = function (x, y) { return [x / lonScale, y]; };

  var points = PEAKS.map(function (p) { return toXY(p.lon, p.lat); });
  var pad = 0.3;
  var extent = [
    (bbox[0] - pad) * lonScale, bbox[1] - pad,
    (bbox[2] + pad) * lonScale, bbox[3] + pad
  ];

  var delaunay = d3.Delaunay.from(points);
  var voronoi = delaunay.voronoi(extent);

  PEAKS.forEach(function (peak, idx) {
    var cellXY = voronoi.cellPolygon(idx);
    if (!cellXY) return;
    var cellLonLat = cellXY.map(function (pt) { return toLonLat(pt[0], pt[1]); });
    var cellFeature = turf.polygon([cellLonLat]);

    var clipped;
    try {
      clipped = turf.intersect(cellFeature, clipRegion);
    } catch (e) {
      clipped = null;
    }
    if (!clipped) return;

    var layer = L.geoJSON(clipped, { style: cellStyle(peak) })
      .bindPopup(makePopupHtml(peak))
      .addTo(map);

    layer.on("popupopen", function (e) {
      var btn = e.popup.getElement().querySelector("button");
      if (btn) btn.addEventListener("click", function () { toggleClimbed(peak.id); });
    });

    cellLayers[peak.id] = layer;

    var dot = L.circleMarker([peak.lat, peak.lon], {
      radius: 3,
      color: "#222",
      weight: 1,
      fillColor: "#fff",
      fillOpacity: 1
    }).addTo(map);
    dot.bindPopup(makePopupHtml(peak));
    dot.on("popupopen", function (e) {
      var btn = e.popup.getElement().querySelector("button");
      if (btn) btn.addEventListener("click", function () { toggleClimbed(peak.id); });
    });
    dotLayers[peak.id] = dot;
  });

  updateProgress();
  syncStatusText(s3Enabled ? "Sincronizzazione..." : "Salvataggio solo su questo dispositivo");
  if (s3Enabled) loadRemote();

  function cellStyle(peak) {
    var isClimbed = climbed.has(peak.id);
    return {
      color: isClimbed ? "#b85c1f" : "#555",
      weight: isClimbed ? 1.5 : 0.8,
      opacity: isClimbed ? 0.8 : 0.35,
      fillColor: isClimbed ? "#d17b3f" : "#7a7a7a",
      fillOpacity: isClimbed ? 0.45 : 0.12
    };
  }

  function makePopupHtml(peak) {
    var isClimbed = climbed.has(peak.id);
    return (
      '<div class="peak-popup">' +
        "<h3>" + peak.name + "</h3>" +
        '<p class="elevation">' + peak.elevation_m + " m s.l.m. &middot; " + peak.group + "</p>" +
        '<button class="' + (isClimbed ? "unmark" : "mark") + '">' +
          (isClimbed ? "Segna come da salire" : "Segna come salita 🏔️") +
        "</button>" +
      "</div>"
    );
  }

  function toggleClimbed(id) {
    if (climbed.has(id)) climbed.delete(id);
    else climbed.add(id);

    saveLocal();
    updateProgress();

    var peak = PEAKS.find(function (p) { return p.id === id; });
    var layer = cellLayers[id];
    if (layer) {
      layer.setStyle(cellStyle(peak));
      layer.setPopupContent(makePopupHtml(peak));
      rebindPopupButton(layer, id);
    }
    var dot = dotLayers[id];
    if (dot) {
      dot.setPopupContent(makePopupHtml(peak));
      rebindPopupButton(dot, id);
    }

    if (s3Enabled) saveRemote();
  }

  function rebindPopupButton(layer, id) {
    var popup = layer.getPopup();
    var el = popup && popup.getElement();
    if (el) {
      var btn = el.querySelector("button");
      if (btn) btn.addEventListener("click", function () { toggleClimbed(id); });
    }
  }

  function updateProgress() {
    var total = PEAKS.length;
    var done = climbed.size;
    document.getElementById("progress-text").textContent = done + " / " + total + " salite";
    document.getElementById("progress-fill").style.width = (total ? (done / total * 100) : 0) + "%";
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LOCAL_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveLocal() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(Array.from(climbed)));
    } catch (e) { /* ignore */ }
  }

  function publicUrl() {
    return "https://" + cfg.bucket + ".s3." + cfg.region + ".amazonaws.com/" + cfg.key;
  }

  function loadRemote() {
    fetch(publicUrl() + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("no remote file yet (" + res.status + ")");
        return res.json();
      })
      .then(function (data) {
        if (Array.isArray(data.climbed)) {
          climbed = new Set(data.climbed);
          saveLocal();
          PEAKS.forEach(function (peak) {
            var layer = cellLayers[peak.id];
            if (layer) { layer.setStyle(cellStyle(peak)); layer.setPopupContent(makePopupHtml(peak)); }
            var dot = dotLayers[peak.id];
            if (dot) dot.setPopupContent(makePopupHtml(peak));
          });
          updateProgress();
        }
        syncStatusText("Sincronizzato");
      })
      .catch(function () {
        syncStatusText("Nessun dato condiviso trovato ancora — verrà creato al primo salvataggio");
      });
  }

  function saveRemote() {
    if (!window.AWS) {
      syncStatusText("SDK AWS non caricato — salvato solo in locale");
      return;
    }
    syncStatusText("Salvataggio...");
    AWS.config.region = cfg.region;
    AWS.config.credentials = new AWS.CognitoIdentityCredentials({ IdentityPoolId: cfg.identityPoolId });
    var s3 = new AWS.S3({ apiVersion: "2006-03-01" });
    var body = JSON.stringify({ climbed: Array.from(climbed), updatedAt: new Date().toISOString() });

    s3.putObject({
      Bucket: cfg.bucket,
      Key: cfg.key,
      Body: body,
      ContentType: "application/json",
      ACL: "public-read"
    }, function (err) {
      if (err) {
        console.error("S3 sync failed", err);
        syncStatusText("Sincronizzazione fallita — salvato solo in locale");
      } else {
        syncStatusText("Sincronizzato");
      }
    });
  }

  function syncStatusText(text) {
    var el = document.getElementById("sync-status");
    if (el) el.textContent = text;
  }
})();
