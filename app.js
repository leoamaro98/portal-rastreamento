'use strict';
// Portal: device list on the left, map on the right. Clicking a device shows where it
// is (latest fix) and the path it made on the chosen day.

const TZ = 'America/Sao_Paulo';
const REFRESH_MS = 5 * 60 * 1000;
// Collector cadence (pg_cron */15) and the silence after which it counts as late; same
// rule as the collector-health endpoint.
const COLLECT_EVERY_MIN = 15;
const COLLECT_LATE_MIN = 35;
// Brazil has had no daylight saving time since 2019, so a day in Brasília is a fixed
// -03:00 window.
const BRASILIA_OFFSET = '-03:00';

const { createClient } = window.supabase;
const db = createClient(window.APP_CONFIG.supabaseUrl, window.APP_CONFIG.supabaseKey);

const $ = (id) => document.getElementById(id);

const state = {
  devices: [],        // rows of devices merged with their latest position
  selectedId: null,
  map: null,
  layer: null,        // markers/paths currently drawn
  refreshTimer: null,
  // Bumped on every draw; a response belonging to an older draw is dropped, so clicking
  // quickly between people never paints one person's day under another's name.
  drawSeq: 0,
  stopMarkers: [],    // map markers, same order as the timeline
  activeStop: null,
};

// ---------- formatting ----------

const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // yyyy-mm-dd
const dayLabelFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit',
});

// "2026-10-20" -> "20/10, segunda-feira". Noon keeps the date safe from the offset.
function dayLabel(day) {
  const parts = dayLabelFmt.formatToParts(new Date(`${day}T12:00:00${BRASILIA_OFFSET}`));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('day')}/${get('month')}, ${get('weekday')}`;
}

function today() {
  return dayFmt.format(new Date());
}

function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} dia(s)`;
}

// Fresh = within two collection cycles; stale = today-ish; old = the phone stopped
// reporting its position.
function freshness(iso) {
  if (!iso) return 'none';
  const min = (Date.now() - new Date(iso).getTime()) / 60000;
  if (min <= 30) return 'fresh';
  if (min <= 24 * 60) return 'stale';
  return 'old';
}

// collaborator is a manual override in the database; normally the name comes from the
// device's tag in the MDM.
function deviceName(d) {
  return d.collaborator || d.mdm_tags || d.model || `Aparelho ${d.id}`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

// ---------- data ----------

async function loadDevices() {
  const [devices, latest, runs, okRuns] = await Promise.all([
    db.from('devices').select('id, model, imei, collaborator, mdm_tags, online_status, last_contact_at'),
    db.from('latest_positions').select('device_id, fix_time, latitude, longitude, provider'),
    db.from('collector_runs').select('started_at, error').order('id', { ascending: false }).limit(1),
    db.from('collector_runs').select('finished_at')
      .is('error', null).not('finished_at', 'is', null)
      .order('finished_at', { ascending: false }).limit(1),
  ]);
  const failed = [devices, latest, runs, okRuns].find((r) => r.error);
  if (failed) throw failed.error;

  const byDevice = new Map(latest.data.map((p) => [p.device_id, p]));
  state.devices = devices.data
    .map((d) => ({ ...d, latest: byDevice.get(d.id) || null }))
    .sort((a, b) => deviceName(a).localeCompare(deviceName(b), 'pt-BR', { sensitivity: 'base' }));

  renderCollectorStatus(runs.data[0], okRuns.data[0]);
}

// Header line that tells the directors whether what they see is current: when the
// collector last ran, when it runs next, and loudly when it is late or failing.
function renderCollectorStatus(lastRun, lastOk) {
  const status = $('collector-status');
  status.className = 'collector-status';
  status.title = `O portal busca as posições no MDM a cada ${COLLECT_EVERY_MIN} minutos.`;
  if (!lastRun) {
    status.textContent = 'Nenhuma coleta registrada ainda';
    status.classList.add('late');
    return;
  }

  const lastOkAt = lastOk ? new Date(lastOk.finished_at) : null;
  const silentMin = lastOkAt ? (Date.now() - lastOkAt.getTime()) / 60000 : Infinity;
  if (silentMin > COLLECT_LATE_MIN) {
    status.textContent = lastOkAt
      ? `Coleta atrasada · última às ${timeFmt.format(lastOkAt)}`
      : 'Coleta sem sucesso até agora';
    status.classList.add('late');
    return;
  }

  const startedAt = new Date(lastRun.started_at);
  if (lastRun.error) {
    status.textContent = `Última coleta com erro · ${timeFmt.format(startedAt)}`;
    status.classList.add('failed');
    return;
  }

  const slot = COLLECT_EVERY_MIN * 60000;
  const next = new Date(Math.floor(startedAt.getTime() / slot) * slot + slot);
  status.textContent = `Coleta às ${timeFmt.format(startedAt)} · próxima ~${timeFmt.format(next)}`;
}

async function loadDay(deviceId, day) {
  const from = new Date(`${day}T00:00:00${BRASILIA_OFFSET}`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const { data, error } = await db
    .from('positions')
    .select('fix_time, latitude, longitude, provider')
    .eq('device_id', deviceId)
    .gte('fix_time', from.toISOString())
    .lt('fix_time', to.toISOString())
    .order('fix_time');
  if (error) throw error;
  return data;
}

// ---------- rendering ----------

function renderList() {
  const list = $('device-list');
  list.replaceChildren();
  $('devices-status').hidden = state.devices.length > 0;
  $('devices-status').textContent = 'Nenhum aparelho coletado ainda.';

  for (const d of state.devices) {
    const fix = d.latest?.fix_time;
    const btn = el('button', { type: 'button', className: `device${d.id === state.selectedId ? ' selected' : ''}` },
      el('span', { className: 'device-name' }, el('span', { className: `dot ${freshness(fix)}` }), deviceName(d)),
      el('span', { className: 'device-meta' },
        fix ? `Posição ${ago(fix)} · ${dateTimeFmt.format(new Date(fix))}` : 'Sem posição reportada'),
      el('span', { className: 'device-meta' },
        [d.model, d.imei && `IMEI final ${d.imei.slice(-4)}`, `ID ${d.id}`].filter(Boolean).join(' · ')),
    );
    btn.addEventListener('click', () => selectDevice(d.id));
    list.append(el('li', {}, btn));
  }
}

function popupContent(d, p, label) {
  return el('div', { className: 'popup' },
    el('strong', {}, deviceName(d)),
    el('div', {}, `${label}: ${dateTimeFmt.format(new Date(p.fix_time))}`),
    el('div', { className: 'muted' }, `Fonte: ${p.provider || '—'} · ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`),
    el('a', {
      href: `https://www.google.com/maps?q=${p.latitude},${p.longitude}`,
      target: '_blank',
      rel: 'noopener',
    }, 'Abrir no Google Maps'),
  );
}

function clearMap() {
  if (state.layer) state.layer.remove();
  state.layer = L.featureGroup().addTo(state.map);
}

function fit(points) {
  if (points.length === 1) state.map.setView(points[0], 16);
  else if (points.length > 1) state.map.fitBounds(points, { padding: [56, 56], maxZoom: 17 });
}

function showNotice(title, text, action) {
  $('map-notice-title').textContent = title;
  $('map-notice-text').textContent = text;
  const button = $('map-notice-action');
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = action.onClick;
  }
  $('map-notice').hidden = false;
  $('map').parentElement.classList.add('dimmed');
}

function hideNotice() {
  $('map-notice').hidden = true;
  $('map').parentElement.classList.remove('dimmed');
}

function showAll() {
  state.selectedId = null;
  state.drawSeq += 1; // a day still loading must not land on the overview
  $('toolbar').hidden = true;
  hideNotice();
  hideTimeline();
  renderList();
  clearMap();
  const points = [];
  for (const d of state.devices) {
    if (!d.latest) continue;
    const ll = [d.latest.latitude, d.latest.longitude];
    points.push(ll);
    L.marker(ll, { title: deviceName(d) })
      .bindPopup(() => popupContent(d, d.latest, 'Última posição'))
      .on('click', () => selectDevice(d.id))
      .addTo(state.layer);
  }
  fit(points);
}

function setSummary(text, isError = false) {
  const summary = $('day-summary');
  summary.textContent = text;
  summary.classList.toggle('error-text', isError);
}

async function selectDevice(id) {
  state.selectedId = id;
  renderList();
  const d = state.devices.find((x) => x.id === id);
  $('toolbar').hidden = false;
  $('selected-name').textContent = deviceName(d);
  await drawDayOrReport(d);
}

async function drawDayOrReport(d, options) {
  try {
    await drawDay(d, options);
  } catch (err) {
    console.error(err);
    setSummary('Não foi possível carregar o trajeto. Tente de novo em instantes.', true);
  }
}

// keepView: background refresh of the day on screen; redraw without moving the map or
// popping a popup over what the director is looking at.
async function drawDay(d, { keepView = false } = {}) {
  const seq = ++state.drawSeq;
  const day = $('day').value;
  if (!keepView) setSummary('Carregando…');
  const positions = await loadDay(d.id, day);
  if (seq !== state.drawSeq) return;
  clearMap();
  hideNotice();

  if (positions.length === 0) {
    hideTimeline();
    drawEmptyDay(d, day);
    return;
  }

  const stops = window.Stops.buildStops(positions);
  const keepActive = keepView && state.activeStop !== null && state.activeStop < stops.length - 1
    ? state.activeStop
    : stops.length - 1;
  renderTimeline(d, stops);
  drawStopsOnMap(d, stops);
  selectStop(keepActive, { pan: false });
  if (!keepView) fit(stops.map((s) => [s.latitude, s.longitude]));

  const first = timeFmt.format(new Date(stops[0].from));
  const lastTime = timeFmt.format(new Date(stops[stops.length - 1].to));
  const km = Math.round(window.Stops.totalDistanceM(stops) / 1000);
  setSummary(stops.length === 1
    ? `1 local · ${first === lastTime ? first : `${first} → ${lastTime}`}`
    : `${stops.length} locais · ${first} → ${lastTime} · ~${km} km em linha reta`);
}

// ---------- timeline ----------

function durationLabel(fromIso, toIso) {
  const min = Math.round((new Date(toIso) - new Date(fromIso)) / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function kmLabel(meters) {
  return `${(meters / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
}

// What happened at a stop, in the directors' words.
function describeStop(stop, index) {
  const parked = stop.count > 1 && stop.to !== stop.from;
  const time = parked
    ? `${timeFmt.format(new Date(stop.from))} – ${timeFmt.format(new Date(stop.to))}`
    : timeFmt.format(new Date(stop.from));
  let what;
  if (parked) {
    what = `Parado ${durationLabel(stop.from, stop.to)} · ${stop.count} posições`;
    if (index === 0) what = `Início do dia · ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
  } else {
    what = index === 0 ? 'Início do dia' : `Passagem · ${kmLabel(stop.fromPreviousM)} do anterior`;
  }
  return { time, what };
}

function renderTimeline(d, stops) {
  const list = $('timeline');
  list.replaceChildren();
  stops.forEach((stop, i) => {
    const { time, what } = describeStop(stop, i);
    const where = el('span', { className: 'stop-where' }, 'Buscando endereço…');
    const button = el('button', { type: 'button', className: 'stop' },
      el('span', { className: 'stop-badge', ariaHidden: 'true' }, String(i + 1)),
      el('span', {},
        el('span', { className: 'stop-time' }, time),
        el('span', { className: 'stop-what' }, what),
        where),
    );
    button.addEventListener('click', () => selectStop(i, { pan: true }));
    list.append(el('li', {}, button));
    fillAddress(where, stop);
  });
  const lastAt = timeFmt.format(new Date(stops[stops.length - 1].to));
  list.append(el('li', { className: 'timeline-end' }, `Sem posições depois de ${lastAt}`));
  list.hidden = false;
  $('day-view').classList.add('with-timeline');
  setTimeout(() => state.map.invalidateSize(), 0);
}

function hideTimeline() {
  $('timeline').hidden = true;
  $('timeline').replaceChildren();
  $('day-view').classList.remove('with-timeline');
  state.stopMarkers = [];
  state.activeStop = null;
  setTimeout(() => state.map && state.map.invalidateSize(), 0);
}

// Straight dashed lines: with fixes minutes apart the real route is unknown, and a solid
// line would suggest one.
function drawStopsOnMap(d, stops) {
  const points = stops.map((s) => [s.latitude, s.longitude]);
  if (points.length > 1) {
    L.polyline(points, { color: '#66727f', weight: 2, opacity: 0.8, dashArray: '6 6' }).addTo(state.layer);
  }
  state.stopMarkers = stops.map((stop, i) => {
    const { time } = describeStop(stop, i);
    const marker = L.marker(points[i], {
      icon: L.divIcon({ className: 'stop-icon', html: `<span>${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      keyboard: false, // the timeline buttons are the keyboard path
      title: `${i + 1} · ${time}`,
    })
      .bindPopup(() => popupContent(d, { ...stop, fix_time: stop.to, provider: null }, time))
      .on('click', () => selectStop(i, { pan: false, scroll: true }))
      .addTo(state.layer);
    return marker;
  });
}

function selectStop(index, { pan = false, scroll = false } = {}) {
  state.activeStop = index;
  const buttons = [...$('timeline').querySelectorAll('.stop')];
  buttons.forEach((b, i) => {
    b.classList.toggle('active', i === index);
    if (i === index) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
  state.stopMarkers.forEach((m, i) => {
    const icon = m.getElement();
    if (icon) icon.classList.toggle('active', i === index);
    m.setZIndexOffset(i === index ? 1000 : 0);
  });
  const marker = state.stopMarkers[index];
  if (pan && marker) state.map.panTo(marker.getLatLng());
  if (scroll && buttons[index]) buttons[index].scrollIntoView({ block: 'nearest' });
}

// ---------- approximate address (OpenStreetMap Nominatim) ----------
// Nominatim's free service allows at most one request per second and asks clients to
// cache, so lookups are queued and remembered per browser.

const GEOCODE_GAP_MS = 1100;
const addressMemory = new Map();
let geocodeQueue = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cachedAddress(key) {
  if (addressMemory.has(key)) return addressMemory.get(key);
  try {
    return localStorage.getItem(`addr:${key}`);
  } catch {
    return null;
  }
}

function rememberAddress(key, text) {
  addressMemory.set(key, text);
  try {
    localStorage.setItem(`addr:${key}`, text);
  } catch {
    // Private mode or full storage: the in-memory copy is enough for this visit.
  }
}

function formatAddress(a) {
  const street = [a.road || a.pedestrian || a.footway, a.house_number].filter(Boolean).join(', ');
  const area = [a.suburb || a.neighbourhood || a.quarter, a.city || a.town || a.village || a.municipality]
    .filter(Boolean).join(', ');
  return [street, area].filter(Boolean).join(' · ');
}

function lookupAddress(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = cachedAddress(key);
  if (hit) return Promise.resolve(hit);
  const job = geocodeQueue.then(async () => {
    const again = cachedAddress(key);
    if (again) return again;
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=pt-BR&lat=${lat}&lon=${lng}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const text = formatAddress(json.address || {}) || json.display_name || '';
    if (text) rememberAddress(key, text);
    return text;
  });
  geocodeQueue = job.then(() => sleep(GEOCODE_GAP_MS), () => sleep(GEOCODE_GAP_MS));
  return job;
}

async function fillAddress(span, stop) {
  try {
    const text = await lookupAddress(stop.latitude, stop.longitude);
    if (span.isConnected) span.textContent = text ? `Aprox. ${text}` : 'Endereço indisponível';
  } catch {
    if (span.isConnected) span.textContent = 'Endereço indisponível';
  }
}

// ---------- day navigation ----------

function shiftDay(delta) {
  const [y, m, dd] = $('day').value.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, dd + delta)).toISOString().slice(0, 10);
  if (next > today()) return;
  $('day').value = next;
  onDayChanged();
}

function updateDayButtons() {
  $('day-next').disabled = $('day').value >= today();
}

function onDayChanged() {
  if (!$('day').value || $('day').value > today()) $('day').value = today();
  updateDayButtons();
  const d = state.devices.find((x) => x.id === state.selectedId);
  if (d) drawDayOrReport(d);
}

// A day without positions must read as "no data for that day". Drawing the last known
// fix as a normal pin would answer "was he there that day?" with a position from another
// date, so it is only shown on request, hollow and labelled with its own date.
function drawEmptyDay(d, day) {
  const isToday = day === today();
  setSummary(isToday ? 'Nenhuma posição hoje até agora' : 'Nenhuma posição neste dia');

  const title = isToday ? 'Nenhuma posição hoje até agora' : `Nenhuma posição em ${dayLabel(day)}`;
  if (!d.latest) {
    showNotice(title, 'Este vendedor ainda não enviou nenhuma posição.');
    return;
  }
  const latestAt = new Date(d.latest.fix_time);
  showNotice(
    title,
    `A última posição conhecida é de ${dateTimeFmt.format(latestAt)} (${ago(d.latest.fix_time)}).`,
    { label: 'Mostrar última posição conhecida', onClick: () => showLastKnown(d) },
  );
}

function showLastKnown(d) {
  hideNotice();
  const latestAt = new Date(d.latest.fix_time);
  const ll = [d.latest.latitude, d.latest.longitude];
  L.circleMarker(ll, {
    radius: 9, color: '#8a929b', weight: 3, fillColor: '#ffffff', fillOpacity: 1, dashArray: '4 3',
  })
    .bindTooltip(`Última conhecida · ${dateTimeFmt.format(latestAt)}`, {
      permanent: true, direction: 'top', offset: [0, -10], className: 'stale-label',
    })
    .bindPopup(() => popupContent(d, d.latest, 'Última posição conhecida'))
    .addTo(state.layer);
  fit([ll]);
  setSummary(`Nenhuma posição neste dia · mostrando a última conhecida, de ${dateTimeFmt.format(latestAt)}`);
}

// ---------- session ----------

function showError(err) {
  console.error(err);
  $('devices-status').hidden = false;
  $('devices-status').textContent = `Erro ao carregar os dados: ${err.message || err}`;
}

// Every 5 min: list, collector status and, when today's path is open, the path too.
// Past days do not change, so they are left alone.
async function refresh() {
  try {
    await loadDevices();
    renderList();
  } catch (err) {
    showError(err);
    return;
  }
  const d = state.devices.find((x) => x.id === state.selectedId);
  if (d && $('day').value === today() && $('map-notice').hidden) {
    await drawDayOrReport(d, { keepView: true });
  }
}

async function startApp(session) {
  $('login').hidden = true;
  $('app').hidden = false;
  $('user-email').textContent = session.user.email;
  $('day').value = today();
  $('day').max = today(); // no positions exist in the future
  updateDayButtons();

  if (!state.map) {
    state.map = L.map('map').setView([-25.43, -49.27], 11);
    // OSM's tile policy requires the attribution and a Referer (origin is enough).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }).addTo(state.map);
  }
  // The map container was hidden until now; Leaflet needs to measure it again.
  setTimeout(() => state.map.invalidateSize(), 0);

  // Anyone in the company's tenant can sign in; without this check someone not yet
  // released would just see an empty list and think the data is missing.
  const { data: allowed, error: accessError } = await db.rpc('is_portal_user');
  if (accessError || !allowed) {
    $('devices-status').hidden = false;
    $('devices-status').textContent = accessError
      ? `Erro ao verificar o acesso: ${accessError.message}`
      : `O usuário ${session.user.email} ainda não tem acesso. Peça a liberação ao responsável pelo portal.`;
    return;
  }

  try {
    await loadDevices();
    showAll();
  } catch (err) {
    showError(err);
  }
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(refresh, REFRESH_MS);
}

function showLogin() {
  clearInterval(state.refreshTimer);
  $('app').hidden = true;
  $('login').hidden = false;
}

function loginError(message) {
  $('login-error').textContent = message;
  $('login-error').hidden = false;
}

$('password-login').hidden = !window.APP_CONFIG.passwordLogin;

// A failed Microsoft login comes back to this page with the reason in the URL (query or
// hash). Without showing it, the person just lands on the login card again, puzzled.
function showReturnedLoginError() {
  const params = new URLSearchParams(window.location.search);
  new URLSearchParams(window.location.hash.slice(1)).forEach((v, k) => params.set(k, v));
  const description = params.get('error_description') || params.get('error');
  if (!description) return;
  loginError(`O login não foi concluído: ${description.replace(/\+/g, ' ')}`);
  history.replaceState(null, '', window.location.pathname);
}
showReturnedLoginError();

// Microsoft returns to this same page; supabase-js reads the session from the URL and
// onAuthStateChange takes it from there. The path matters: on GitHub Pages the portal
// lives under /<repo>/, not at the site root.
$('login-microsoft').addEventListener('click', async () => {
  $('login-error').hidden = true;
  const { error } = await db.auth.signInWithOAuth({
    provider: 'azure',
    options: { scopes: 'email', redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) loginError('Não foi possível iniciar o login Microsoft.');
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  const { error } = await db.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value,
  });
  if (error) loginError('E-mail ou senha inválidos.');
});

$('logout').addEventListener('click', () => db.auth.signOut());
$('show-all').addEventListener('click', showAll);
$('day').addEventListener('change', onDayChanged);
$('day-prev').addEventListener('click', () => shiftDay(-1));
$('day-next').addEventListener('click', () => shiftDay(1));

db.auth.onAuthStateChange((_event, session) => {
  if (session) startApp(session);
  else showLogin();
});
