'use strict';
// Administration screen: who may use the portal. Shown to admins only, but every rule
// (who can read or change the list, the last active admin, the history) is enforced by
// the database; this file only presents it. Shares db, $, el and the formatters with
// app.js (loaded before it).

const ROLE_LABEL = { admin: 'Administrador', viewer: 'Visualizador' };
const RUFFINO_DOMAIN = '@ruffinoacabamentos.com';

const admin = {
  users: [],
  editing: null, // e-mail of the user being edited, or null when adding
};

function adminStatus(text, isError = false) {
  const status = $('admin-status');
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function openAdmin(open) {
  $('app').classList.toggle('admin-open', open);
  $('admin').hidden = !open;
  $('admin-toggle').setAttribute('aria-pressed', String(open));
  $('admin-toggle').textContent = open ? 'Voltar ao mapa' : 'Administração';
  if (open) loadAdmin();
  else setTimeout(() => state.map && state.map.invalidateSize(), 0);
}

async function loadAdmin() {
  adminStatus('Carregando…');
  try {
    const [users, changes, access] = await Promise.all([
      db.from('portal_users_overview').select('*').order('name', { nullsFirst: false }),
      db.from('portal_user_changes').select('*').order('id', { ascending: false }).limit(50),
      db.from('portal_access_log').select('*').order('id', { ascending: false }).limit(100),
    ]);
    const failed = [users, changes, access].find((r) => r.error);
    if (failed) throw failed.error;
    admin.users = users.data;
    renderUsers();
    renderChanges(changes.data);
    renderAccess(access.data);
    adminStatus('');
  } catch (err) {
    console.error(err);
    adminStatus('Não foi possível carregar a administração. Tente de novo em instantes.', true);
  }
}

function personLabel(email) {
  if (!email || email === 'sistema') return 'Sistema';
  const user = admin.users.find((u) => u.email === email);
  return user?.name || email;
}

function renderUsers() {
  const body = $('users-body');
  body.replaceChildren();
  for (const u of admin.users) {
    const edit = el('button', { type: 'button', className: 'link-button' }, 'Editar');
    edit.addEventListener('click', () => openUserForm(u));
    const toggle = el('button', { type: 'button', className: 'link-button' }, u.active ? 'Desativar' : 'Reativar');
    toggle.addEventListener('click', () => setActive(u, !u.active));
    body.append(el('tr', { className: u.active ? '' : 'inactive' },
      el('td', {}, u.name || '—'),
      el('td', {}, u.email),
      el('td', {}, el('span', { className: `pill${u.role === 'admin' ? ' admin-role' : ''}` }, ROLE_LABEL[u.role])),
      el('td', {}, el('span', { className: `pill${u.active ? ' ok' : ''}` }, u.active ? 'Ativo' : 'Inativo')),
      el('td', { className: 'num' }, u.last_access_at ? dateTimeFmt.format(new Date(u.last_access_at)) : 'Nunca entrou'),
      el('td', {}, el('div', { className: 'row-actions' }, edit, toggle)),
    ));
  }
}

// A history row in plain words: "Leonardo desativou Fulano".
function describeChange(c) {
  const who = personLabel(c.target_email);
  if (c.action === 'cadastro') return `cadastrou ${who} como ${ROLE_LABEL[c.after.role]}`;
  const parts = [];
  if (c.before.active !== c.after.active) parts.push(c.after.active ? `reativou ${who}` : `desativou ${who}`);
  if (c.before.role !== c.after.role) {
    parts.push(`mudou o perfil de ${who} para ${ROLE_LABEL[c.after.role]}`);
  }
  if (c.before.name !== c.after.name) {
    parts.push(`mudou o nome de ${c.before.name || c.target_email} para ${c.after.name || '—'}`);
  }
  return parts.join(' e ') || `alterou ${who}`;
}

function renderChanges(changes) {
  const list = $('changes-list');
  list.replaceChildren();
  if (!changes.length) list.append(el('li', { className: 'muted' }, 'Nenhuma alteração registrada.'));
  for (const c of changes) {
    list.append(el('li', {},
      el('time', { dateTime: c.changed_at }, dateTimeFmt.format(new Date(c.changed_at))),
      el('span', {}, `${personLabel(c.actor_email)} ${describeChange(c)}`),
    ));
  }
}

function renderAccess(rows) {
  const body = $('access-body');
  body.replaceChildren();
  if (!rows.length) body.append(el('tr', {}, el('td', { colSpan: 3, className: 'muted' }, 'Nenhum acesso registrado.')));
  for (const a of rows) {
    body.append(el('tr', {},
      el('td', { className: 'num' }, dateTimeFmt.format(new Date(a.accessed_at))),
      el('td', {}, personLabel(a.email) === a.email ? a.email : `${personLabel(a.email)} (${a.email})`),
      el('td', {}, el('span', { className: `pill ${a.allowed ? 'ok' : 'denied'}` }, a.allowed ? 'Permitido' : 'Negado')),
    ));
  }
}

// ---------- add / edit ----------

function openUserForm(user = null) {
  admin.editing = user?.email || null;
  $('user-form-title').textContent = user ? `Editar ${user.name || user.email}` : 'Adicionar usuário';
  $('user-name').value = user?.name || '';
  $('user-email-input').value = user?.email || '';
  $('user-email-input').readOnly = !!user; // the e-mail is the identity
  $('user-role').value = user?.role || 'viewer';
  $('user-form-error').hidden = true;
  updateEmailHint();
  $('user-form').hidden = false;
  $('user-name').focus();
}

function closeUserForm() {
  $('user-form').hidden = true;
  admin.editing = null;
}

function updateEmailHint() {
  const email = $('user-email-input').value.trim().toLowerCase();
  const outside = email.includes('@') && !email.endsWith(RUFFINO_DOMAIN);
  $('user-form-hint').hidden = !outside;
  $('user-form-hint').textContent = 'Atenção: só contas da Ruffino conseguem entrar pelo login Microsoft.';
}

function formError(message) {
  $('user-form-error').textContent = message;
  $('user-form-error').hidden = false;
}

// Database errors in the admin's words; the last-admin rule already speaks Portuguese.
function explainDbError(error) {
  if (error.code === '23505') return 'Esse e-mail já está cadastrado.';
  if (error.code === 'P0001') return error.message;
  if (error.code === '42501') return 'Seu usuário não tem permissão de administrador.';
  return 'Não foi possível salvar. Tente de novo em instantes.';
}

async function saveUser(event) {
  event.preventDefault();
  const name = $('user-name').value.trim();
  const email = $('user-email-input').value.trim().toLowerCase();
  const role = $('user-role').value;
  if (!name) return formError('Informe o nome.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return formError('Informe um e-mail válido.');

  $('user-save').disabled = true;
  const { error } = admin.editing
    ? await db.from('portal_users').update({ name, role }).eq('email', admin.editing)
    : await db.from('portal_users').insert({ email, name, role });
  $('user-save').disabled = false;
  if (error) return formError(explainDbError(error));
  closeUserForm();
  loadAdmin();
}

async function setActive(user, active) {
  const { error } = await db.from('portal_users').update({ active }).eq('email', user.email);
  if (error) {
    adminStatus(explainDbError(error), true);
    return;
  }
  loadAdmin();
}

$('admin-toggle').addEventListener('click', () => openAdmin($('admin').hidden));
$('user-add').addEventListener('click', () => openUserForm());
$('user-cancel').addEventListener('click', closeUserForm);
$('user-form').addEventListener('submit', saveUser);
$('user-email-input').addEventListener('input', updateEmailHint);
