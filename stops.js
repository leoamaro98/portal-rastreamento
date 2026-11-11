'use strict';
// Turns a day's positions into the timeline the directors read: consecutive fixes in
// the same place become one stop ("parado 14:34–17:26"), the rest are passages.
// Pure and DOM-free, so it runs in the browser (window.Stops) and in Node tests.
(function (root) {
  // Phones report with ~10–50 m of jitter; anything within this radius of where the
  // stop began counts as "still there".
  const STOP_RADIUS_M = 150;
  // Farthest a lone fix may stray from a stop and still count as jitter when the next
  // fix comes back (indoor nights showed 150–600 m wobble).
  const WOBBLE_MAX_M = 500;

  function distanceM(a, b) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.latitude - a.latitude);
    const dLng = toRad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // positions: [{ fix_time, latitude, longitude }] ordered by fix_time.
  // Returns [{ latitude, longitude, from, to, count, fromPreviousM }].
  function buildStops(positions) {
    const stops = [];
    positions.forEach((p, i) => {
      const current = stops[stops.length - 1];
      const next = positions[i + 1];
      // A single fix just outside the radius whose next fix is back inside is indoor
      // jitter, not a departure (Marlom 10/11: 151 m out at 00:54, 67 m back at 01:29;
      // anchoring a new stop on it split one night at home into three).
      // Capped: a fix far away and back is a real trip or a misreading (splitOutliers).
      const wobble = current && next && distanceM(current, p) <= WOBBLE_MAX_M
        && distanceM(current, next) <= STOP_RADIUS_M;
      if (current && (distanceM(current, p) <= STOP_RADIUS_M || wobble)) {
        current.to = p.fix_time;
        current.count += 1;
        return;
      }
      stops.push({
        latitude: p.latitude,
        longitude: p.longitude,
        from: p.fix_time,
        to: p.fix_time,
        count: 1,
        fromPreviousM: current ? distanceM(current, p) : null,
      });
    });
    return stops;
  }

  function totalDistanceM(stops) {
    return stops.reduce((sum, s) => sum + (s.fromPreviousM || 0), 0);
  }

  // A phone indoors (home, hotel) loses the GPS fix and Android falls back to cell/Wi-Fi
  // location, which can land kilometres away; the MDM still labels it "GPS". Seen on
  // Marlom's nights in Nov/2026: "hotel → 16 km away → hotel" six minutes apart.
  // A fix is treated as such a misreading when it jumps more than this from both of its
  // neighbours...
  const OUTLIER_MIN_JUMP_M = 1000;
  // ...while the neighbours are much closer to each other than to it (it went out and
  // came straight back). Relative, not a fixed radius, because the neighbours themselves
  // carry indoor jitter of a few hundred metres.
  const OUTLIER_RETURN_RATIO = 0.25;
  // ...and only within a short window: with hours between the neighbours the person may
  // really have gone there and back (real data had 4–16 h gaps doing exactly that).
  const OUTLIER_MAX_SPAN_MS = 60 * 60 * 1000;

  // positions: ordered by fix_time, the whole period (a misreading at 23:59 is judged
  // against the fix after midnight). Each fix is judged against the original
  // neighbours. Returns { kept, outliers }, both in the original order.
  function splitOutliers(positions) {
    const kept = [];
    const outliers = [];
    positions.forEach((p, i) => {
      const prev = positions[i - 1];
      const next = positions[i + 1];
      let outlier = false;
      if (prev && next && new Date(next.fix_time) - new Date(prev.fix_time) <= OUTLIER_MAX_SPAN_MS) {
        const out = distanceM(prev, p);
        const back = distanceM(p, next);
        outlier = out > OUTLIER_MIN_JUMP_M && back > OUTLIER_MIN_JUMP_M
          && distanceM(prev, next) < OUTLIER_RETURN_RATIO * Math.min(out, back);
      }
      (outlier ? outliers : kept).push(p);
    });
    return { kept, outliers };
  }

  const api = {
    STOP_RADIUS_M, OUTLIER_MIN_JUMP_M, distanceM, buildStops, totalDistanceM, splitOutliers,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Stops = api;
})(typeof window !== 'undefined' ? window : globalThis);
