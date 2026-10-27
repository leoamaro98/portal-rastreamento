'use strict';
// Turns a day's positions into the timeline the directors read: consecutive fixes in
// the same place become one stop ("parado 14:34–17:26"), the rest are passages.
// Pure and DOM-free, so it runs in the browser (window.Stops) and in Node tests.
(function (root) {
  // Phones report with ~10–50 m of jitter; anything within this radius of where the
  // stop began counts as "still there".
  const STOP_RADIUS_M = 150;

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
    for (const p of positions) {
      const current = stops[stops.length - 1];
      if (current && distanceM(current, p) <= STOP_RADIUS_M) {
        current.to = p.fix_time;
        current.count += 1;
        continue;
      }
      stops.push({
        latitude: p.latitude,
        longitude: p.longitude,
        from: p.fix_time,
        to: p.fix_time,
        count: 1,
        fromPreviousM: current ? distanceM(current, p) : null,
      });
    }
    return stops;
  }

  function totalDistanceM(stops) {
    return stops.reduce((sum, s) => sum + (s.fromPreviousM || 0), 0);
  }

  const api = { STOP_RADIUS_M, distanceM, buildStops, totalDistanceM };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Stops = api;
})(typeof window !== 'undefined' ? window : globalThis);
