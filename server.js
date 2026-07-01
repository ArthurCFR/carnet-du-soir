require('dotenv').config();

const express = require('express');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// --- Configuration ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const RECENT_DAYS = 15; // nombre de .md des jours précédents fournis à l'IA

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '.storage');
const DB_PATH = path.join(STORAGE_DIR, 'carnet.db');
fs.mkdirSync(STORAGE_DIR, { recursive: true });

// --- Base de données (sql.js, pur WASM) ------------------------------------
let db;
function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function rowsFrom(res) {
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((c, i) => (obj[c] = row[i]));
    return obj;
  });
}

// Convertit une ligne SQL en objet "entry" exposé au frontend.
function entryFromRow(r) {
  if (!r) return null;
  return {
    dayKey: r.day_key,
    status: r.status,
    transcript: r.transcript ? JSON.parse(r.transcript) : [],
    md: r.md || undefined,
    markedAt: r.marked_at || undefined,
    pendingQuestion: r.pending_question || undefined,
    pendingText: r.pending_text || undefined,
  };
}

function getEntry(dayKey) {
  const res = db.exec('SELECT * FROM entries WHERE day_key = ?', [dayKey]);
  return entryFromRow(rowsFrom(res)[0]);
}

// Upsert d'une entrée complète.
function upsertEntry(e) {
  db.run(
    `INSERT INTO entries (day_key, status, transcript, md, marked_at, pending_question, pending_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day_key) DO UPDATE SET
       status = excluded.status,
       transcript = excluded.transcript,
       md = excluded.md,
       marked_at = excluded.marked_at,
       pending_question = excluded.pending_question,
       pending_text = excluded.pending_text`,
    [
      e.dayKey,
      e.status,
      JSON.stringify(e.transcript || []),
      e.md || null,
      e.markedAt || null,
      e.pendingQuestion || null,
      e.pendingText || null,
    ]
  );
  saveDb();
}

// --- Helpers IA ------------------------------------------------------------
function formatDateFr(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function transcriptToText(transcript) {
  return (transcript || [])
    .map((s) => (s.q ? `> ${s.q}\n` : '') + (s.text || ''))
    .join('\n\n');
}

function isTranscriptEmpty(transcript) {
  return !transcript || transcript.every((s) => !s.text || !s.text.trim());
}

// Récupère les .md des RECENT_DAYS jours marqués précédant dayKey.
function recentMarkedMds(dayKey) {
  const res = db.exec(
    `SELECT day_key, md FROM entries
     WHERE status = 'marked' AND md IS NOT NULL AND day_key < ?
     ORDER BY day_key DESC LIMIT ?`,
    [dayKey, RECENT_DAYS]
  );
  return rowsFrom(res).reverse(); // ordre chronologique
}

async function callAnthropic(system, userContent, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY absente : ajoute ta clé pour activer l’IA.');
    err.code = 'NO_KEY';
    throw err;
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('').trim();
}

const QUESTION_SYSTEM =
  'Propose UNE seule question introspective, pertinente et originale, pour prolonger la réflexion. ' +
  'Elle peut creuser la pensée du jour, ou faire écho à un fil des jours précédents. ' +
  'Tutoiement, une seule phrase, pas de préambule. Réponds uniquement avec la question.';

const MARK_SYSTEM =
  'Transforme ce transcript d’un journal intime du soir en une trace markdown légère : ' +
  'un titre court (# ...) puis quelques lignes de prose à la première personne. ' +
  'Rôle de synthèse strict : couvre chaque idée exprimée sans en omettre, mais n’interprète pas, ' +
  'n’extrapole pas, n’ajoute aucune conclusion ou lecture psychologique absente du transcript. ' +
  'Reste fidèle au vocabulaire et au ton de la personne. 3 à 7 lignes. Réponds uniquement avec le markdown.';

async function generateQuestion(dayKey, transcript) {
  const recents = recentMarkedMds(dayKey);
  let ctx = '';
  if (recents.length) {
    ctx += 'Mes traces des jours précédents :\n\n';
    for (const r of recents) {
      ctx += `### ${formatDateFr(r.day_key)}\n${r.md}\n\n`;
    }
  }
  ctx += 'Mon transcript d’aujourd’hui :\n\n' + transcriptToText(transcript);
  return callAnthropic(QUESTION_SYSTEM, ctx, 200);
}

async function generateMd(transcript) {
  return callAnthropic(MARK_SYSTEM, transcriptToText(transcript), 700);
}

// Ajoute le texte courant comme segment (avec la question en attente attachée).
function commitCurrentText(entry, text) {
  const trimmed = (text || '').trim();
  if (trimmed) {
    entry.transcript.push({
      ...(entry.pendingQuestion ? { q: entry.pendingQuestion } : {}),
      text: trimmed,
    });
    entry.pendingQuestion = undefined;
  }
  entry.pendingText = undefined;
}

// --- App -------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Index dayKey -> status (pour colorer le calendrier sans tout charger).
app.get('/api/index', (req, res) => {
  const rows = rowsFrom(db.exec('SELECT day_key, status FROM entries'));
  const index = {};
  rows.forEach((r) => (index[r.day_key] = r.status));
  res.json({ index });
});

// Récupère une entrée (ou null).
app.get('/api/entry/:dayKey', (req, res) => {
  res.json({ entry: getEntry(req.params.dayKey) });
});

// Autosauvegarde du brouillon (texte en cours + question en attente).
app.put('/api/entry/:dayKey/draft', (req, res) => {
  const { dayKey } = req.params;
  const existing = getEntry(dayKey);
  if (existing && existing.status === 'marked') {
    return res.status(409).json({ error: 'Jour déjà marqué, immuable.' });
  }
  const entry = existing || { dayKey, status: 'draft', transcript: [] };
  entry.pendingText = req.body.pendingText || undefined;
  if ('pendingQuestion' in req.body) {
    entry.pendingQuestion = req.body.pendingQuestion || undefined;
  }
  upsertEntry(entry);
  res.json({ ok: true });
});

// "Pensons" : commit + génération d'une question introspective.
app.post('/api/entry/:dayKey/think', async (req, res) => {
  const { dayKey } = req.params;
  const existing = getEntry(dayKey);
  if (existing && existing.status === 'marked') {
    return res.status(409).json({ error: 'Jour déjà marqué, immuable.' });
  }
  const entry = existing || { dayKey, status: 'draft', transcript: [] };
  commitCurrentText(entry, req.body.text);

  if (isTranscriptEmpty(entry.transcript)) {
    return res.status(400).json({ error: 'Rien à penser : écris d’abord quelque chose.' });
  }

  try {
    const question = await generateQuestion(dayKey, entry.transcript);
    entry.pendingQuestion = question;
    entry.pendingText = undefined;
    upsertEntry(entry);
    res.json({ entry });
  } catch (e) {
    // On conserve le texte commité en brouillon, on remonte l'erreur.
    upsertEntry(entry);
    res.status(502).json({ error: describeError(e), entry });
  }
});

// "Marquer le jour" : commit + génération du .md, verrouillage.
app.post('/api/entry/:dayKey/mark', async (req, res) => {
  const { dayKey } = req.params;
  const existing = getEntry(dayKey);
  if (existing && existing.status === 'marked') {
    return res.status(409).json({ error: 'Jour déjà marqué, immuable.' });
  }
  const entry = existing || { dayKey, status: 'draft', transcript: [] };
  commitCurrentText(entry, req.body.text);

  if (isTranscriptEmpty(entry.transcript)) {
    return res.status(400).json({ error: 'Rien à marquer : écris d’abord quelque chose.' });
  }

  try {
    const md = await generateMd(entry.transcript);
    entry.md = md;
    entry.status = 'marked';
    entry.markedAt = new Date().toISOString();
    entry.pendingQuestion = undefined;
    entry.pendingText = undefined;
    upsertEntry(entry);
    res.json({ entry });
  } catch (e) {
    upsertEntry(entry); // brouillon préservé
    res.status(502).json({ error: describeError(e), entry });
  }
});

function describeError(e) {
  if (e.code === 'NO_KEY') return e.message;
  return 'L’IA n’a pas répondu. Ton texte est conservé, réessaie dans un instant.';
}

// Fallback SPA.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Démarrage ------------------------------------------------------------
async function start() {
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', f),
  });
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS entries (
    day_key TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'draft',
    transcript TEXT NOT NULL DEFAULT '[]',
    md TEXT,
    marked_at TEXT,
    pending_question TEXT,
    pending_text TEXT
  )`);
  saveDb();

  app.listen(PORT, () => {
    console.log(`Carnet du soir — http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('⚠  ANTHROPIC_API_KEY absente : l’app tourne, mais les fonctions IA renverront une erreur.');
    }
  });
}

start().catch((e) => {
  console.error('Démarrage impossible :', e);
  process.exit(1);
});
