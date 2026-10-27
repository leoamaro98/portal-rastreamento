'use strict';
// Portal: device list on the left, map on the right. Clicking a device shows where it
// is (latest fix) and the path it made on the chosen day.

const TZ = 'America/Sao_Paulo';
const REFRESH_MS = 5 * 60 * 1000;
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
};

// ---------- formatting ----------

const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // yyyy-mm-dd

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
  const [devices, latest, runs] = await Promise.all([
    db.from('devices').select('id, model, imei, collaborator, mdm_tags, online_status, last_contact_at'),
    db.from('latest_positions').select('device_id, fix_time, latitude, longitude, provider'),
    db.from('collector_runs').select('started_at, error').order('id', { ascending: false }).limit(1),
  ]);
  const failed = [devices, latest, runs].find((r) => r.error);
  if (failed) throw failed.error;

  const byDevice = new Map(latest.data.map((p) => [p.device_id, p]));
  state.devices = devices.data
    .map((d) => ({ ...d, latest: byDevice.get(d.id) || null }))
    .sort((a, b) => deviceName(a).localeCompare(deviceName(b), 'pt-BR', { sensitivity: 'base' }));

  const lastRun = runs.data[0];
  $('collector-status').textContent = lastRun
    ? `Última coleta: ${dateTimeFmt.format(new Date(lastRun.started_at))}${lastRun.error ? ' (com erro)' : ''}`
    : 'Nenhuma coleta registrada ainda.';
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
  else if (points.length > 1) state.map.fitBounds(points, { padding: [40, 40], maxZoom: 17 });
}

function showAll() {
  state.selectedId = null;
  $('toolbar').hidden = true;
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

async function selectDevice(id) {
  state.selectedId = id;
  renderList();
  const d = state.devices.find((x) => x.id === id);
  $('toolbar').hidden = false;
  $('selected-name').textContent = deviceName(d);
  await drawDay(d);
}

async function drawDay(d) {
  const day = $('day').value;
  $('day-summary').textContent = 'Carregando…';
  const positions = await loadDay(d.id, day);
  clearMap();

  if (positions.length === 0) {
    // Nothing that day: still answer "where is it?" with the last known fix.
    $('day-summary').textContent = d.latest
      ? `Nenhuma posição neste dia. Mostrando a última conhecida (${ago(d.latest.fix_time)}).`
      : 'Este aparelho ainda não reportou posição.';
    if (d.latest) {
      const ll = [d.latest.latitude, d.latest.longitude];
      L.marker(ll).bindPopup(() => popupContent(d, d.latest, 'Última posição')).addTo(state.layer).openPopup();
      fit([ll]);
    }
    return;
  }

  const points = positions.map((p) => [p.latitude, p.longitude]);
  L.polyline(points, { color: '#1f5fa8', weight: 3, opacity: 0.7 }).addTo(state.layer);
  positions.forEach((p, i) => {
    const last = i === positions.length - 1;
    const marker = last
      ? L.marker(points[i])
      : L.circleMarker(points[i], { radius: 5, color: '#1f5fa8', fillColor: '#fff', fillOpacity: 1, weight: 2 });
    marker.bindPopup(() => popupContent(d, p, last ? 'Última posição do dia' : 'Posição'))
      .bindTooltip(timeFmt.format(new Date(p.fix_time)))
      .addTo(state.layer);
    if (last) marker.openPopup();
  });
  fit(points);

  const first = timeFmt.format(new Date(positions[0].fix_time));
  const lastTime = timeFmt.format(new Date(positions[positions.length - 1].fix_time));
  $('day-summary').textContent = `${positions.length} posição(ões) entre ${first} e ${lastTime}`;
}

// ---------- session ----------

function showError(err) {
  console.error(err);
  $('devices-status').hidden = false;
  $('devices-status').textContent = `Erro ao carregar os dados: ${err.message || err}`;
}

async function refresh() {
  try {
    await loadDevices();
    renderList();
  } catch (err) {
    showError(err);
  }
}

async function startApp(session) {
  $('login').hidden = true;
  $('app').hidden = false;
  $('user-email').textContent = session.user.email;
  $('day').value = dayFmt.format(new Date());

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
$('day').addEventListener('change', () => {
  const d = state.devices.find((x) => x.id === state.selectedId);
  if (d) drawDay(d).catch(showError);
});

db.auth.onAuthStateChange((_event, session) => {
  if (session) startApp(session);
  else showLogin();
});
