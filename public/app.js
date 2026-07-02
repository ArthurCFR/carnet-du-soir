// Carnet du soir — logique frontend (vanilla JS, aucun build).

const appEl = document.getElementById('app');

// --- Règle du jour logique : la journée court jusqu'à 9h le lendemain. ----
function dayKeyFrom(date) {
  const shifted = new Date(date.getTime() - 9 * 3600 * 1000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function currentDayKey() {
  return dayKeyFrom(new Date());
}

function ymdToKey(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function formatDateFr(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// --- API ------------------------------------------------------------------
// Token de session gardé UNIQUEMENT en mémoire → perdu à chaque refresh.
let sessionToken = null;

async function api(method, url, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (sessionToken) headers['x-carnet-token'] = sessionToken;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Erreur');
    err.data = data;
    throw err;
  }
  return data;
}

// --- Mini rendu markdown (titre # + paragraphes, *ital*, **gras**) -------
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function renderMarkdown(md) {
  const lines = (md || '').split('\n');
  let html = '';
  let para = [];
  const flush = () => {
    if (para.length) {
      html += `<p>${para.map(inline).join('<br>')}</p>`;
      para = [];
    }
  };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('# ')) {
      flush();
      html += `<h1>${inline(t.slice(2))}</h1>`;
    } else if (t === '') {
      flush();
    } else {
      para.push(t);
    }
  }
  flush();
  return html;
}

// --- État global ----------------------------------------------------------
const state = {
  view: 'today', // 'today' | 'calendar' | 'detail'
  entry: null,
  detailDayKey: null,
  calMonth: null, // {y, m}
  index: {},
  busy: null, // 'question' | 'mark' | null
  error: null,
};

let saveTimer = null;

// --- Rendu ----------------------------------------------------------------
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function renderNav() {
  const nav = el('nav', { class: 'nav' });
  const today = el('button', {
    class: state.view === 'today' ? 'active' : '',
    onclick: () => {
      state.view = 'today';
      render();
    },
  }, 'ce soir');
  const cal = el('button', {
    class: state.view === 'calendar' || state.view === 'detail' ? 'active' : '',
    onclick: async () => {
      const now = new Date();
      state.calMonth = state.calMonth || { y: now.getFullYear(), m: now.getMonth() };
      await loadIndex();
      state.view = 'calendar';
      render();
    },
  }, 'calendrier');
  nav.append(today, cal);
  return nav;
}

function renderTranscript(transcript, animateLast = false) {
  const wrap = el('div', { class: 'transcript' });
  transcript.forEach((seg) => {
    const s = el('div', { class: 'segment' });
    if (seg.q) s.appendChild(el('p', { class: 'seg-q' }, seg.q));
    s.appendChild(el('p', { class: 'seg-text' }, seg.text));
    wrap.appendChild(s);
  });
  return wrap;
}

function renderToday() {
  const entry = state.entry;
  const frag = document.createDocumentFragment();
  frag.appendChild(renderNav());

  // Jour marqué -> rendu du .md, immuable.
  if (entry && entry.status === 'marked') {
    frag.appendChild(renderMarkedEntry(entry));
    return frag;
  }

  const dayKey = currentDayKey();
  frag.appendChild(el('h1', { class: 'day-title' }, formatDateFr(dayKey)));

  const transcript = (entry && entry.transcript) || [];
  if (transcript.length) frag.appendChild(renderTranscript(transcript));

  const pendingQ = entry && entry.pendingQuestion;
  if (pendingQ) {
    frag.appendChild(el('p', { class: 'pending-question appear' }, pendingQ));
  }

  const textarea = el('textarea', {
    class: 'entry',
    placeholder: pendingQ ? '…' : 'Qu’est-ce qui te traverse ce soir ?',
    id: 'entry-text',
  });
  textarea.value = (entry && entry.pendingText) || '';
  textarea.addEventListener('input', onDraftInput);
  frag.appendChild(textarea);

  const busy = state.busy;
  const actions = el('div', { class: 'actions' });
  const thinkBtn = el('button', {
    class: 'pill pill-outline',
    disabled: !!busy,
    onclick: onThink,
  }, 'pensons');
  const markBtn = el('button', {
    class: 'pill pill-solid',
    disabled: !!busy,
    onclick: onMark,
  }, 'marquer le jour');
  actions.append(thinkBtn, markBtn);
  frag.appendChild(actions);

  const status = el('div', { class: 'status-line' });
  if (busy === 'question') status.className = 'status-line busy', (status.textContent = 'je te lis');
  else if (busy === 'mark') status.className = 'status-line busy', (status.textContent = 'j’encre la trace');
  else if (state.error) {
    status.className = 'status-line';
    status.appendChild(el('span', { class: 'error' }, state.error));
  }
  frag.appendChild(status);

  return frag;
}

function renderMarkedEntry(entry, withBack = false) {
  const frag = document.createDocumentFragment();
  if (withBack) {
    frag.appendChild(el('button', {
      class: 'back-link',
      onclick: () => {
        state.view = 'calendar';
        render();
      },
    }, 'calendrier'));
  }
  frag.appendChild(el('div', { class: 'md', html: renderMarkdown(entry.md) }));

  const disc = el('details', { class: 'disclosure' });
  disc.appendChild(el('summary', {}, 'le transcript'));
  disc.appendChild(renderTranscript(entry.transcript));
  frag.appendChild(disc);
  return frag;
}

function renderCalendar() {
  const frag = document.createDocumentFragment();
  frag.appendChild(renderNav());

  const { y, m } = state.calMonth;
  const monthLabel = new Date(y, m, 1).toLocaleDateString('fr-FR', {
    month: 'long',
    year: 'numeric',
  });

  const header = el('div', { class: 'cal-header' });
  header.appendChild(el('button', {
    class: 'cal-nav',
    'aria-label': 'mois précédent',
    onclick: () => {
      state.calMonth = m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 };
      render();
    },
  }, '‹'));
  header.appendChild(el('div', { class: 'cal-month' }, monthLabel));
  header.appendChild(el('button', {
    class: 'cal-nav',
    'aria-label': 'mois suivant',
    onclick: () => {
      state.calMonth = m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 };
      render();
    },
  }, '›'));
  frag.appendChild(header);

  const grid = el('div', { class: 'cal-grid' });
  ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'].forEach((d) =>
    grid.appendChild(el('div', { class: 'cal-dow' }, d))
  );

  // Lundi = premier jour. getDay(): 0=dim..6=sam.
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayKey = currentDayKey();

  for (let i = 0; i < firstDow; i++) {
    grid.appendChild(el('div', { class: 'cal-cell empty' }));
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = ymdToKey(y, m, d);
    const marked = state.index[key] === 'marked';
    let cls = 'cal-cell';
    if (marked) cls += ' marked';
    if (key === todayKey) cls += ' today';
    const cell = el('div', { class: cls }, String(d));
    if (marked) {
      cell.addEventListener('click', () => openDetail(key));
    }
    grid.appendChild(cell);
  }
  frag.appendChild(grid);
  return frag;
}

function renderDetail() {
  const frag = document.createDocumentFragment();
  frag.appendChild(renderNav());
  if (!state.entry) {
    frag.appendChild(el('p', { class: 'empty-note' }, 'chargement…'));
    return frag;
  }
  frag.appendChild(el('h1', { class: 'day-title' }, formatDateFr(state.detailDayKey)));
  frag.appendChild(renderMarkedEntry(state.entry, true));
  return frag;
}

function render() {
  appEl.innerHTML = '';
  let content;
  if (state.view === 'calendar') content = renderCalendar();
  else if (state.view === 'detail') content = renderDetail();
  else content = renderToday();
  appEl.appendChild(content);
  syncNav();
}

// Header collant : passe en mode réduit dès qu'on scrolle vers le bas.
function syncNav() {
  const nav = appEl.querySelector('.nav');
  if (nav) nav.classList.toggle('reduced', window.scrollY > 8);
}
window.addEventListener('scroll', syncNav, { passive: true });

// --- Actions --------------------------------------------------------------
function currentText() {
  const ta = document.getElementById('entry-text');
  return ta ? ta.value : '';
}

function onDraftInput() {
  clearTimeout(saveTimer);
  const pendingText = currentText();
  saveTimer = setTimeout(() => {
    api('PUT', `/api/entry/${currentDayKey()}/draft`, { pendingText }).catch(() => {});
  }, 600);
}

async function onThink() {
  const text = currentText();
  const entry = state.entry;
  const emptyExisting = !entry || !entry.transcript || entry.transcript.length === 0;
  if (!text.trim() && emptyExisting) {
    state.error = 'Écris d’abord une pensée.';
    return render();
  }
  clearTimeout(saveTimer);
  state.busy = 'question';
  state.error = null;
  render();
  try {
    const { entry: updated } = await api('POST', `/api/entry/${currentDayKey()}/think`, { text });
    state.entry = updated;
    state.busy = null;
    render();
  } catch (e) {
    if (e.data && e.data.entry) state.entry = e.data.entry;
    state.busy = null;
    state.error = e.message;
    render();
  }
}

async function onMark() {
  const text = currentText();
  const entry = state.entry;
  const emptyExisting = !entry || !entry.transcript || entry.transcript.length === 0;
  if (!text.trim() && emptyExisting) {
    state.error = 'Écris d’abord une pensée.';
    return render();
  }
  clearTimeout(saveTimer);
  state.busy = 'mark';
  state.error = null;
  render();
  try {
    const { entry: updated } = await api('POST', `/api/entry/${currentDayKey()}/mark`, { text });
    state.entry = updated;
    state.busy = null;
    render();
  } catch (e) {
    if (e.data && e.data.entry) state.entry = e.data.entry;
    state.busy = null;
    state.error = e.message;
    render();
  }
}

async function openDetail(dayKey) {
  state.detailDayKey = dayKey;
  state.entry = null;
  state.view = 'detail';
  render();
  const { entry } = await api('GET', `/api/entry/${dayKey}`);
  state.entry = entry;
  render();
}

async function loadIndex() {
  const { index } = await api('GET', '/api/index');
  state.index = index;
}

// --- Démarrage ------------------------------------------------------------
async function init() {
  try {
    const { entry } = await api('GET', `/api/entry/${currentDayKey()}`);
    state.entry = entry;
  } catch (e) {
    state.error = 'Connexion impossible.';
  }
  render();
  window.scrollTo(0, 0); // on arrive toujours en haut de page, header non réduit
}

// --- Écran d'accueil verrouillé ------------------------------------------
// La séquence est vérifiée côté serveur : elle n'apparaît nulle part ici.
// Chaque clic donne un feedback IDENTIQUE (aucune fuite juste/faux).
const OK_FLASH_MS = 650;

function pulse(sq) {
  sq.classList.remove('tap');
  void sq.offsetWidth; // relance l'animation à chaque clic
  sq.classList.add('tap');
  if (navigator.vibrate) {
    try {
      navigator.vibrate(12);
    } catch (e) {}
  }
}

function flashOk(squares, lockEl) {
  squares.forEach((s) => s.classList.add('ok'));
  setTimeout(() => {
    lockEl.classList.add('fade-out');
    setTimeout(() => init(), 420);
  }, OK_FLASH_MS);
}

function renderLock() {
  appEl.innerHTML = '';
  const lock = el('div', { class: 'lock' });
  lock.appendChild(el('h1', { class: 'lock-title' }, 'Carnet d’Arthur'));

  const row = el('div', { class: 'lock-squares' });
  const squares = [];
  let seq = [];
  let opening = false;

  for (let i = 1; i <= 5; i++) {
    const n = i;
    const sq = el('button', { class: 'lock-square', 'aria-label': 'ouvrir' });
    sq.addEventListener('click', async () => {
      if (opening) return;
      pulse(sq); // feedback uniforme, systématique
      seq.push(n);
      if (seq.length > 60) seq = seq.slice(-60);
      try {
        const { authenticated, token } = await api('POST', '/api/unlock', { seq });
        if (authenticated && token) {
          sessionToken = token; // gardé en mémoire seulement
          opening = true;
          flashOk(squares, lock);
        }
      } catch (e) {
        // Silencieux : échec réseau et mauvaise séquence sont indiscernables.
      }
    });
    squares.push(sq);
    row.appendChild(sq);
  }
  lock.appendChild(row);
  appEl.appendChild(lock);
}

// À chaque ouverture/refresh : écran d'accueil rejoué (aucune session côté client).
renderLock();
