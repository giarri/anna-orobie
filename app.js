(function () {
  "use strict";

  var LOCAL_KEY = "anna-orobie-climbed";
  var cfg = window.AWS_CONFIG || {};
  var s3Enabled = !!(cfg.region && cfg.identityPoolId && cfg.bucket);

  var climbed = new Set(loadLocal());
  var markers = {};

  var map = L.map("map", { zoomControl: true }).setView([46.02, 9.95], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  var bounds = [];
  PEAKS.forEach(function (peak) {
    var marker = L.marker([peak.lat, peak.lon], { icon: makeIcon(peak) })
      .addTo(map)
      .bindPopup(makePopupHtml(peak), { closeButton: true });

    marker.on("popupopen", function (e) {
      var btn = e.popup.getElement().querySelector("button");
      if (btn) {
        btn.addEventListener("click", function () { toggleClimbed(peak.id); });
      }
    });

    markers[peak.id] = marker;
    bounds.push([peak.lat, peak.lon]);
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });

  updateProgress();
  syncStatusText(s3Enabled ? "Sincronizzazione..." : "Salvataggio solo su questo dispositivo");
  if (s3Enabled) loadRemote();

  function makeIcon(peak) {
    var isClimbed = climbed.has(peak.id);
    return L.divIcon({
      className: "",
      html: '<div class="peak-marker' + (isClimbed ? " climbed" : "") + '"></div>',
      iconSize: [20, 18],
      iconAnchor: [10, 16],
      popupAnchor: [0, -16]
    });
  }

  function makePopupHtml(peak) {
    var isClimbed = climbed.has(peak.id);
    return (
      '<div class="peak-popup">' +
        "<h3>" + peak.name + "</h3>" +
        '<p class="elevation">' + peak.elevation_m + " m s.l.m.</p>" +
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
    var marker = markers[id];
    marker.setIcon(makeIcon(peak));
    marker.setPopupContent(makePopupHtml(peak));
    var el = marker.getPopup().getElement();
    if (el) {
      var btn = el.querySelector("button");
      if (btn) btn.addEventListener("click", function () { toggleClimbed(id); });
    }

    if (s3Enabled) saveRemote();
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
            var marker = markers[peak.id];
            marker.setIcon(makeIcon(peak));
            marker.setPopupContent(makePopupHtml(peak));
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
