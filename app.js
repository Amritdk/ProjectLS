// ========== Server / cloud config ==========
const CONFIG = {
  // false = never load/save cached data (always fetch fresh). Set true to allow offline cache.
  USE_CACHE: false,

  // ---- Google Apps Script mode (Drive only: no API key, folder can stay private) ----
  // Deploy Code.gs as a Web app and paste the /exec URL here. Takes priority over everything below.
  SCRIPT_URL: '',

  // ---- GitHub mode (recommended): upload .json files into a public repo's "data" folder ----
  // Every .json file there becomes a dataset automatically. If this app is hosted on GitHub Pages
  // (https://USER.github.io/REPO/) leave owner/repo empty: they are detected from the address.
  // Elsewhere (localhost, other hosting) fill them in. branch '' = the repo's default branch.
  GITHUB: { owner: '', repo: '', branch: '', path: 'data' },

  // ---- Google Drive folder mode (needs an API key) ----
  // Put all your .json files in ONE Drive folder, share it as "Anyone with the link" (Viewer),
  // paste the folder ID here. Every .json file in the folder becomes a dataset automatically.
  // Folder ID = the last part of the folder URL: drive.google.com/drive/folders/<FOLDER_ID>
  DRIVE_FOLDER_ID: '',   // e.g. '1xlodLqDTujMnHkt42C-1R3RoRBv3l7ga' to use your Drive folder (needs DRIVE_API_KEY)
  // Google Cloud API key with "Google Drive API" enabled; restrict it to your site's domain.
  DRIVE_API_KEY: '',

  // Optional nicer names/colors per file (key = file name without ".json").
  // "key" decides the CSS class: key "universe" -> .card.universe-card
  DATASET_META: {
    'universe_questions_nasu_merged': { key: 'universe',  icon: '🌌', label: 'Universe Questions', color: '#38bdf8' },
    'world_geography_questions_nasu': { key: 'geography', icon: '🌍', label: 'World Geography',    color: '#f97316' }
  },

  // ---- Alternative: any CORS-enabled manifest.json URL (GitHub/jsDelivr, R2, Firebase...) ----
  MANIFEST_URL: ''
};

// Each dataset needs a unique key and ONE source: url (any CORS-enabled link), driveId, or file (relative path).
// Optional: icon, label, color (card accent). Same shape is used in the remote manifest.
const DEFAULT_DATASETS = [
  { key: 'universe',  icon: '🌌', label: 'Universe Questions', file: 'universe_questions_nasu_merged.json' }
];
let DATASETS = DEFAULT_DATASETS;
let SCRIPT_DATA = null; // { datasetKey: [questions] } when SCRIPT_URL mode is used

function urlFor(ds) {
  if (ds.url) return ds.url;
  if (ds.driveId) return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(ds.driveId)}?alt=media&key=${CONFIG.DRIVE_API_KEY}`;
  return ds.file;
}

// Lists every .json file in the shared Drive folder and turns each into a dataset
async function listDriveFolder() {
  if (!CONFIG.DRIVE_API_KEY) throw new Error('DRIVE_API_KEY missing');
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${CONFIG.DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: '100',
      orderBy: 'name',
      key: CONFIG.DRIVE_API_KEY
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch('https://www.googleapis.com/drive/v3/files?' + params, { cache: 'no-store' });
    if (!res.ok) throw new Error('Drive ' + res.status);
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  const used = new Set();
  return files
    .filter(f => /\.json$/i.test(f.name) || f.mimeType === 'application/json')
    .map((f, i) => ({ ...datasetFromName(f.name, i, used), driveId: f.id }));
}

// File name -> dataset (key, label, icon, color), using CONFIG.DATASET_META overrides
function datasetFromName(name, i, used) {
  const base = name.replace(/\.json$/i, '');
  const meta = CONFIG.DATASET_META[base] || {};
  let key = meta.key || base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ds' + i;
  while (used.has(key)) key += '-' + i;
  used.add(key);
  return { key, label: meta.label || base.replace(/[_-]+/g, ' '), icon: meta.icon, color: meta.color };
}

// Apps Script mode: one request returns every JSON file in the Drive folder
async function loadFromScript() {
  let payload = null;
  try {
    const res = await fetch(CONFIG.SCRIPT_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    payload = await res.json();
    if (!Array.isArray(payload)) throw new Error('bad payload');
    try { cacheSet('script', payload); } catch (e) {}
  } catch (e) {
    try { payload = cacheGet('script'); } catch (e2) {}
    showToast('Google Script लोड भएन — cache प्रयोग भयो', true);
  }
  if (!Array.isArray(payload)) payload = [];
  const bad = payload.filter(f => f && f.error).map(f => f.name);
  if (bad.length) showToast('JSON त्रुटि: ' + bad.join(', '), true);
  const used = new Set();
  SCRIPT_DATA = {};
  DATASETS = payload.filter(f => f && Array.isArray(f.data)).map((f, i) => {
    const ds = datasetFromName(f.name, i, used);
    SCRIPT_DATA[ds.key] = f.data;
    return ds;
  });
}

// Where to read from on GitHub (configured, or auto-detected when hosted on USER.github.io/REPO/)
function githubTarget() {
  const g = CONFIG.GITHUB || {};
  if (g.owner && g.repo) return { owner: g.owner, repo: g.repo, branch: g.branch || '', path: g.path || 'data' };
  const host = location.hostname || '';
  if (/\.github\.io$/i.test(host)) {
    const seg = (location.pathname || '').split('/').filter(Boolean)[0];
    const repo = seg && !/\.html?$/i.test(seg) ? seg : host;   // USER.github.io/REPO/  or  USER.github.io
    return { owner: host.split('.')[0], repo, branch: g.branch || '', path: g.path || 'data' };
  }
  return null;
}

// Lists every .json file in the repo's data folder (GitHub API, no key needed)
async function listGithubFolder(t) {
  const url = `https://api.github.com/repos/${t.owner}/${t.repo}/contents/${t.path}` +
    (t.branch ? `?ref=${encodeURIComponent(t.branch)}` : '');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('GitHub ' + res.status +
      (res.status === 404 ? ' — repo/"' + t.path + '" folder not found or repo is private' :
       res.status === 403 ? ' — too many requests, try again later' : ''));
  }
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error('GitHub: "' + t.path + '" is not a folder');
  const used = new Set();
  return items
    .filter(f => f.type === 'file' && /\.json$/i.test(f.name) && f.download_url)
    .map((f, i) => ({ ...datasetFromName(f.name, i, used), url: f.download_url }));
}

async function fetchDatasetList() {
  const gh = githubTarget();
  if (gh) return listGithubFolder(gh);
  if (CONFIG.DRIVE_FOLDER_ID) return listDriveFolder();
  const res = await fetch(CONFIG.MANIFEST_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status);
  const list = await res.json();
  return Array.isArray(list) ? list.filter(d => d && d.key && (d.url || d.driveId || d.file)) : [];
}

async function loadManifest() {
  if (CONFIG.SCRIPT_URL) {
    await loadFromScript();
  } else if (githubTarget() || CONFIG.DRIVE_FOLDER_ID || CONFIG.MANIFEST_URL) {
    try {
      const list = await fetchDatasetList();
      if (!list.length) throw new Error('no datasets found');
      DATASETS = list;
      try { cacheSet('manifest', list); } catch (e) {}
    } catch (e) {
      try {
        const cached = cacheGet('manifest');
        if (Array.isArray(cached) && cached.length) DATASETS = cached;
      } catch (e2) {}
      showToast('डेटा सूची लोड भएन: ' + ((e && e.message) || e), true);
    }
  }
  DATASETS = DATASETS.map(d => ({ ...d, icon: d.icon || '📄', label: d.label || d.key }));
}

const USER_KEY = 'loksewa_custom_questions';
const CACHE_PREFIX = 'loksewa_cache_';

// Cache switch: when USE_CACHE is false nothing is read from or saved to the browser cache,
// and any old cached copy is deleted on startup. Your own added questions are NOT affected.
function cacheSet(name, value) {
  if (!CONFIG.USE_CACHE) return;
  try { localStorage.setItem(CACHE_PREFIX + name, JSON.stringify(value)); } catch (e) {}
}
function cacheGet(name) {
  if (!CONFIG.USE_CACHE) return null;
  try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + name)); } catch (e) { return null; }
}
function clearOldCache() {
  if (CONFIG.USE_CACHE) return;
  try {
    Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX)).forEach(k => localStorage.removeItem(k));
  } catch (e) {}
}
const DEFAULT_CAT = 'General';

// ========== State ==========
let fileQuestions = [];
let userQuestions = [];
let allQuestions = [];
let activeSource = 'all';
let activeCategory = 'all';

// ========== DOM ==========
const $ = id => document.getElementById(id);
const searchInput = $('searchInput'), clearSearch = $('clearSearch');
const datasetSelect = $('datasetSelect'), filtersContainer = $('filters');
const listContainer = $('list'), emptyContainer = $('empty');
const totalCountEl = $('totalCount'), shownCountEl = $('shownCount');
const modal = $('modal'), modalTitle = $('modalTitle');
const qInput = $('qInput'), aInput = $('aInput'), catInput = $('catInput'), toastEl = $('toast');

// ========== Helpers ==========
const str = v => (v === undefined || v === null) ? '' : String(v);
const dsOf = key => DATASETS.find(d => d.key === key);

function escapeHtml(v) {
  return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Accepts q/question/प्रश्न, a/answer/उत्तर, cat/category/श्रेणी; always returns strings
function normalize(item, sourceFile, fallbackId, custom) {
  const question = str(item.question ?? item.q ?? item['प्रश्न']).trim();
  const answer = str(item.answer ?? item.a ?? item['उत्तर']).trim();
  if (!question || !answer) return null;
  return {
    id: custom ? fallbackId : `${sourceFile}_${str(item.id) || fallbackId}`,
    question, answer,
    category: str(item.category ?? item.cat ?? item['श्रेणी']).trim() || DEFAULT_CAT,
    sourceFile,
    custom: !!custom
  };
}

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { toastEl.className = 'toast'; }, 2800);
}

// ========== Storage ==========
function loadUserQuestions() {
  try {
    const saved = JSON.parse(localStorage.getItem(USER_KEY)) || [];
    userQuestions = saved
      .map((it, i) => normalize(it, str(it.sourceFile) || 'user', str(it.id) || 'user_' + Date.now() + '_' + i, true))
      .filter(Boolean);
  } catch (e) { userQuestions = []; }
}
function saveUserQuestions() {
  try { localStorage.setItem(USER_KEY, JSON.stringify(userQuestions)); } catch (e) {}
}
function rebuildAll() { allQuestions = [...userQuestions, ...fileQuestions]; }

// ========== Load JSON files (with offline cache fallback) ==========
async function loadDirectJsonFiles() {
  const failed = [];
  const results = await Promise.all(DATASETS.map(async ds => {
    if (SCRIPT_DATA) return (SCRIPT_DATA[ds.key] || []).map((item, i) => normalize(item, ds.key, i, false)).filter(Boolean);
    let raw = null;
    try {
      const res = await fetch(urlFor(ds), { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      raw = await res.json();
      try { cacheSet(ds.key, raw); } catch (e) {}
    } catch (e) {
      try { raw = cacheGet(ds.key); } catch (e2) {}
      if (!Array.isArray(raw) && !isEnvelope(raw)) { failed.push(ds.label); return []; }
    }
    if (isEnvelope(raw)) {                       // password-protected file
      try {
        raw = await decryptEnvelope(raw, PASSWORD);
        if (!Array.isArray(raw)) raw = (raw && (raw.questions || raw.data)) || null;
      } catch (e) { NEED_PASSWORD = true; return []; }
    }
    if (!Array.isArray(raw)) { failed.push(ds.label); return []; }
    return raw.map((item, i) => normalize(item, ds.key, i, false)).filter(Boolean);
  }));
  fileQuestions = results.flat();
  rebuildAll();
  if (failed.length) showToast('लोड भएन: ' + failed.join(', '), true);
}

// ========== Password protection (encrypted JSON files) ==========
// Files made with private-tools/encrypt-json.html look like { fmt:'loksewa-enc-v1', salt, iv, data, ... }.
// Plain (unencrypted) files keep working, so you can mix public and protected datasets.
const PW_KEY = 'loksewa_pw';
let PASSWORD = '';
let REMEMBER = false;
let NEED_PASSWORD = false;

const isEnvelope = o => !!o && !Array.isArray(o) && o.fmt === 'loksewa-enc-v1' && !!o.data;
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function decryptEnvelope(env, password) {
  if (!password) throw new Error('password required');
  if (!window.crypto || !crypto.subtle) throw new Error('Encryption not supported in this browser/page (use https)');
  const iter = Number(env.iter);
  if (!Number.isInteger(iter) || iter < 1000 || iter > 2000000) throw new Error('bad file');
  const mat = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64d(env.salt), iterations: iter, hash: 'SHA-256' },
    mat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(env.iv) }, key, b64d(env.data));
  return JSON.parse(new TextDecoder().decode(buf));
}

function storedPassword() { try { return localStorage.getItem(PW_KEY) || ''; } catch (e) { return ''; } }
function forgetPassword() { try { localStorage.removeItem(PW_KEY); } catch (e) {} }

function askPassword(message) {
  return new Promise(resolve => {
    let ov = document.getElementById('lockOverlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'lockOverlay';
      ov.className = 'modal-overlay';
      document.body.appendChild(ov);
    }
    ov.innerHTML =
      '<div class="modal"><h2>🔒 Password आवश्यक छ</h2>' +
      '<p style="color:var(--muted);font-size:.85rem;margin-bottom:12px">यो डेटा सुरक्षित (encrypted) छ। प्रश्न हेर्न password राख्नुहोस्।</p>' +
      (message ? '<p style="color:var(--danger);font-size:.85rem;margin-bottom:10px">' + escapeHtml(message) + '</p>' : '') +
      '<div class="form-group"><input id="lockPw" type="password" autocomplete="current-password" placeholder="Password" /></div>' +
      '<label style="display:flex;gap:8px;align-items:center;font-size:.85rem;color:var(--muted);margin-bottom:14px">' +
      '<input id="lockRemember" type="checkbox" checked style="width:auto"> यो device मा याद राख्नुहोस्</label>' +
      '<div class="modal-actions"><button class="btn-outline" id="lockSkip">छोड्नुहोस्</button>' +
      '<button class="btn-success" id="lockOk">खोल्नुहोस्</button></div></div>';
    ov.classList.add('open');
    const pw = document.getElementById('lockPw');
    const done = v => { ov.classList.remove('open'); ov.innerHTML = ''; resolve(v); };
    document.getElementById('lockOk').onclick = () => {
      if (!pw.value) return;
      done({ password: pw.value, remember: document.getElementById('lockRemember').checked });
    };
    document.getElementById('lockSkip').onclick = () => done(null);
    pw.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('lockOk').click(); });
    pw.focus();
  });
}

// Loads all datasets; asks for the password when a protected file can't be opened
async function loadWithPassword() {
  PASSWORD = storedPassword();
  REMEMBER = !!PASSWORD;
  let message = '';
  for (;;) {
    NEED_PASSWORD = false;
    await loadDirectJsonFiles();
    if (!NEED_PASSWORD) break;
    if (PASSWORD) { message = 'Password मिलेन — फेरि प्रयास गर्नुहोस्'; forgetPassword(); }
    const answer = await askPassword(message);
    if (!answer) { PASSWORD = ''; showToast('सुरक्षित डेटा खोलिएन', true); return; }
    PASSWORD = answer.password;
    REMEMBER = answer.remember;
  }
  if (PASSWORD && REMEMBER) { try { localStorage.setItem(PW_KEY, PASSWORD); } catch (e) {} }
  addForgetButton();
}

function addForgetButton() {
  try {
    const footer = document.querySelector('footer');
    if (!footer || !storedPassword() || document.getElementById('forgetPw')) return;
    const b = document.createElement('button');
    b.id = 'forgetPw';
    b.className = 'btn-outline';
    b.style.cssText = 'margin-top:10px;font-size:.75rem;padding:6px 12px';
    b.textContent = '🔒 यो device बाट password हटाउनुहोस्';
    b.onclick = () => { forgetPassword(); location.reload(); };
    footer.appendChild(document.createElement('br'));
    footer.appendChild(b);
  } catch (e) {}
}

// ========== UI ==========
function buildDatasetSelect() {
  datasetSelect.innerHTML = '<option value="all">📁 सबै डाटासेटहरू (All Datasets)</option>' +
    DATASETS.map(d => `<option value="${d.key}">${escapeHtml(d.icon + ' ' + d.label)}</option>`).join('');
  datasetSelect.value = activeSource;
}

function handleDatasetChange() {
  activeSource = datasetSelect.value;
  activeCategory = 'all';
  renderFilters();
  renderList();
}

function renderFilters() {
  const cats = new Set();
  allQuestions.forEach(it => {
    if (activeSource === 'all' || it.sourceFile === activeSource) cats.add(it.category);
  });
  if (activeCategory !== 'all' && !cats.has(activeCategory)) activeCategory = 'all';

  filtersContainer.innerHTML = '';
  const makeChip = (value, text) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (activeCategory === value ? ' active' : '');
    chip.textContent = text;
    chip.onclick = () => { activeCategory = value; renderFilters(); renderList(); };
    filtersContainer.appendChild(chip);
  };
  makeChip('all', 'सबै (All Categories)');
  [...cats].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })).forEach(c => makeChip(c, c));
}

// Modal category dropdown: grouped by dataset, value = "datasetKey::category"
function buildModalCats() {
  catInput.innerHTML = DATASETS.map(d => {
    const cats = new Set([DEFAULT_CAT]);
    allQuestions.forEach(it => { if (it.sourceFile === d.key) cats.add(it.category); });
    return `<optgroup label="${escapeHtml(d.icon + ' ' + d.label)}">` +
      [...cats].map(c => `<option value="${escapeHtml(d.key + '::' + c)}">${escapeHtml(c)}</option>`).join('') +
      '</optgroup>';
  }).join('');
}

function renderList() {
  const query = searchInput.value.toLowerCase().trim();
  const filtered = allQuestions.filter(it =>
    (activeSource === 'all' || it.sourceFile === activeSource) &&
    (activeCategory === 'all' || it.category === activeCategory) &&
    (!query ||
      it.question.toLowerCase().includes(query) ||
      it.answer.toLowerCase().includes(query) ||
      it.category.toLowerCase().includes(query)));

  totalCountEl.textContent = allQuestions.length;
  shownCountEl.textContent = filtered.length;
  listContainer.innerHTML = '';

  if (!filtered.length) { emptyContainer.style.display = 'block'; return; }
  emptyContainer.style.display = 'none';

  filtered.forEach(it => {
    const ds = dsOf(it.sourceFile);
    const card = document.createElement('div');
    card.className = 'card ' + (it.custom ? 'user-card' : `${it.sourceFile}-card`);
    if (!it.custom && ds && ds.color) card.style.borderLeft = '4px solid ' + ds.color;
    card.innerHTML = `
      <div class="q">${escapeHtml(it.question)}</div>
      <div class="a">${escapeHtml(it.answer)}</div>
      <div class="meta">
        <div>
          <span class="tag">${escapeHtml(it.category)}</span>
          <span class="source-badge">${it.custom ? '✍️ ' : ''}${escapeHtml(ds ? ds.label : 'Custom')}</span>
        </div>
        ${it.custom ? '<button class="delete-btn" data-del="1">हटाउनुहोस्</button>' : ''}
      </div>`;
    const del = card.querySelector('[data-del]');
    if (del) del.onclick = () => deleteItem(it.id);
    listContainer.appendChild(card);
  });
}

// ========== Add / delete ==========
function openAddModal() {
  buildModalCats();
  modalTitle.textContent = 'नयाँ प्रश्न थप्नुहोस्';
  qInput.value = '';
  aInput.value = '';
  const dsKey = activeSource !== 'all' ? activeSource : DATASETS[0].key;
  const want = dsKey + '::' + (activeCategory !== 'all' ? activeCategory : DEFAULT_CAT);
  const opts = [...catInput.options];
  const pick = opts.find(o => o.value === want) || opts.find(o => o.value.startsWith(dsKey + '::'));
  if (pick) catInput.value = pick.value;
  modal.classList.add('open');
}
function closeModal() { modal.classList.remove('open'); }

function saveItem() {
  const q = qInput.value.trim(), a = aInput.value.trim();
  if (!q || !a) return showToast('कृपया प्रश्न र उत्तर दुवै भर्नुहोस्!', true);
  const [sourceFile, ...rest] = catInput.value.split('::');
  userQuestions.unshift({
    id: 'user_' + Date.now(), question: q, answer: a,
    category: rest.join('::') || DEFAULT_CAT, sourceFile, custom: true
  });
  saveUserQuestions();
  rebuildAll();
  closeModal();
  renderFilters();
  renderList();
  showToast('सफलतापूर्वक थपियो!');
}

function deleteItem(id) {
  if (!confirm('के तपाईं यस प्रश्नलाई हटाउन चाहनुहुन्छ?')) return;
  userQuestions = userQuestions.filter(q => q.id !== id);
  saveUserQuestions();
  rebuildAll();
  renderFilters();
  renderList();
  showToast('हटाइयो!');
}

// ========== Export / Import ==========
function exportData() {
  if (!userQuestions.length) return showToast('निर्यात गर्नका लागि कुनै थपिएको प्रश्न छैन!', true);
  const out = userQuestions.map(({ question, answer, category, sourceFile }) =>
    ({ q: question, a: answer, cat: category, dataset: sourceFile }));
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'loksewa_custom_questions.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('JSON फाइल डाउनलोड गरियो!');
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!Array.isArray(imported)) return showToast('अमान्य JSON ढाँचा!', true);
      const seen = new Set(allQuestions.map(x => x.question.toLowerCase()));
      let added = 0;
      imported.forEach((it, i) => {
        const key = str(it.dataset ?? it.sourceFile);
        const target = dsOf(key) ? key : (activeSource !== 'all' ? activeSource : DATASETS[0].key);
        const n = normalize(it, target, 'user_' + Date.now() + '_' + i, true);
        if (!n || seen.has(n.question.toLowerCase())) return;
        seen.add(n.question.toLowerCase());
        userQuestions.push(n);
        added++;
      });
      saveUserQuestions();
      rebuildAll();
      renderFilters();
      renderList();
      showToast(`${added} नयाँ प्रश्न इम्पोर्ट गरियो!`);
    } catch (err) {
      showToast('फाइल पढ्न सकिएन!', true);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ========== Init ==========
document.addEventListener('DOMContentLoaded', async () => {
  searchInput.addEventListener('input', () => {
    clearSearch.style.display = searchInput.value ? 'block' : 'none';
    renderList();
  });
  clearSearch.addEventListener('click', () => {
    searchInput.value = '';
    clearSearch.style.display = 'none';
    renderList();
  });
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  clearOldCache();
  loadUserQuestions();
  await loadManifest();
  buildDatasetSelect();
  await loadWithPassword();
  renderFilters();
  renderList();
});
