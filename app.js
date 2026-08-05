(function () {
  "use strict";

  var LOCAL_KEY = "anna-orobie-climbed";
  var cfg = window.AWS_CONFIG || {};
  var s3Enabled = !!(cfg.region && cfg.identityPoolId && cfg.bucket);

  var climbed = new Set(loadLocal());
  var cellLayers = {};
  var dotLayers = {};

  var map = L.map("map", { zoomControl: true });
  var TILE_URL = "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png";
  L.tileLayer(TILE_URL, {
    maxZoom: 17,
    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
  }).addTo(map);

  // Second copy of the same tiles, in a pane the grayscale CSS filter doesn't reach
  // (see style.css: the filter targets .leaflet-tile-pane specifically). It's clipped
  // via CSS clip-path to the union of climbed cells, so climbed mountains show the
  // basemap at full, original saturation while everything else stays grayscale.
  map.createPane("saturatedTiles");
  var saturatedPane = map.getPane("saturatedTiles");
  saturatedPane.style.zIndex = 250;
  saturatedPane.style.pointerEvents = "none";
  var saturatedLayer = L.tileLayer(TILE_URL, { maxZoom: 17, pane: "saturatedTiles" }).addTo(map);

  function updateSaturatedMask() {
    var container = saturatedLayer.getContainer();
    if (!container) return;
    var subpaths = [];
    climbed.forEach(function (id) {
      var geom = window.CELLS[id];
      if (!geom) return;
      var polygons = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
      polygons.forEach(function (rings) {
        rings.forEach(function (ring) {
          var d = "";
          ring.forEach(function (coord, i) {
            var lp = map.latLngToLayerPoint([coord[1], coord[0]]);
            d += (i === 0 ? "M" : "L") + lp.x.toFixed(1) + "," + lp.y.toFixed(1) + " ";
          });
          subpaths.push(d + "Z");
        });
      });
    });
    container.style.clipPath = subpaths.length
      ? 'path(evenodd, "' + subpaths.join(" ") + '")'
      : "polygon(0px 0px, 0px 0px, 0px 0px)";
  }

  map.on("moveend zoomend", updateSaturatedMask);
  updateSaturatedMask();

  // Mountain territories (data/cells.js) are precomputed offline: a watershed segmentation
  // seeded at each summit over real SRTM/AWS terrain-tile elevation data, so each cell's
  // border follows the actual valley floor between two mountains rather than an abstract
  // straight bisector line. See data/cells.js generation notes in README.

  var peakLons = PEAKS.map(function (p) { return p.lon; });
  var peakLats = PEAKS.map(function (p) { return p.lat; });
  var peaksBbox = [Math.min.apply(null, peakLons), Math.min.apply(null, peakLats),
                    Math.max.apply(null, peakLons), Math.max.apply(null, peakLats)];

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

  PEAKS.forEach(function (peak) {
    var geom = window.CELLS[peak.id];
    if (!geom) return;

    var layer = L.geoJSON(geom, { style: cellStyle(peak) })
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

  var filters = { group: "all", province: "all" };
  var groupSelect = document.getElementById("filter-group");
  var provinceSelect = document.getElementById("filter-province");
  if (groupSelect) groupSelect.addEventListener("change", function () {
    filters.group = groupSelect.value;
    applyFilters();
  });
  if (provinceSelect) provinceSelect.addEventListener("change", function () {
    filters.province = provinceSelect.value;
    applyFilters();
  });

  function peakMatchesFilters(peak) {
    return (filters.group === "all" || peak.group === filters.group) &&
      (filters.province === "all" || peak.province === filters.province);
  }

  function applyFilters() {
    PEAKS.forEach(function (peak) {
      var match = peakMatchesFilters(peak);
      var layer = cellLayers[peak.id];
      var dot = dotLayers[peak.id];
      if (layer) {
        if (match && !map.hasLayer(layer)) layer.addTo(map);
        else if (!match && map.hasLayer(layer)) map.removeLayer(layer);
      }
      if (dot) {
        if (match && !map.hasLayer(dot)) dot.addTo(map);
        else if (!match && map.hasLayer(dot)) map.removeLayer(dot);
      }
    });
  }

  var randomBtn = document.getElementById("random-peak-btn");
  if (randomBtn) randomBtn.addEventListener("click", pickRandomPeak);

  var randomBtnDefaultText = randomBtn ? randomBtn.textContent : "";

  function pickRandomPeak() {
    var filtered = PEAKS.filter(peakMatchesFilters);
    var remaining = filtered.filter(function (p) { return !climbed.has(p.id); });
    if (!remaining.length) {
      randomBtn.textContent = filtered.length
        ? "Tutte le montagne salite (con questi filtri)! 🎉"
        : "Nessuna montagna con questi filtri";
      return;
    }
    randomBtn.textContent = randomBtnDefaultText;
    var peak = remaining[Math.floor(Math.random() * remaining.length)];
    map.closePopup();
    map.flyTo([peak.lat, peak.lon], 13, { duration: 0.75 });
    var dot = dotLayers[peak.id];
    if (dot) {
      map.once("moveend", function () { dot.openPopup(); });
    }
  }

  function cellStyle(peak) {
    var isClimbed = climbed.has(peak.id);
    return {
      color: isClimbed ? "#b85c1f" : "#555",
      weight: isClimbed ? 1.5 : 0.8,
      opacity: isClimbed ? 0.8 : 0.35,
      fillColor: isClimbed ? "#d17b3f" : "#7a7a7a",
      fillOpacity: isClimbed ? 0.12 : 0.12
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
    updateSaturatedMask();

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
          updateSaturatedMask();
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
