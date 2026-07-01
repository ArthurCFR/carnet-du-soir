# Carnet du soir

Journal de bord personnel du soir, minimaliste. Une pensée par jour, des relances
introspectives par IA, puis la journée est scellée en une trace markdown + le transcript.

## Stack

- **Node.js + Express** — serveur unique, sert le frontend et les routes `/api`.
- **sql.js** (WASM, pur JS) — persistance dans un fichier `.db`.
- **Frontend vanilla JS** — aucun build, servi depuis `public/`.
- **API Anthropic** — appelée côté serveur uniquement (la clé ne touche jamais le navigateur).

## Règle du jour logique

Une journée court jusqu'à 9h le lendemain : `dayKey = date(now - 9h)`. Une saisie
à 2h du matin appartient à la veille. Toute la logique repose sur cette clé.

## Lancer en local

```bash
npm install
# renseigner ANTHROPIC_API_KEY dans .env
npm start
# http://localhost:3000
```

Sans clé, l'app tourne mais les fonctions IA renvoient une erreur discrète.

## Variables d'environnement

| Variable | Rôle |
|----------|------|
| `ANTHROPIC_API_KEY` | Clé API Anthropic (obligatoire pour l'IA) |
| `ANTHROPIC_MODEL` | Modèle (défaut `claude-sonnet-4-6`) |
| `STORAGE_DIR` | Dossier de persistance (`/app/.storage` en prod) |
| `PORT` | Port d'écoute (défaut `3000`) |

## Déploiement

Via le skill `coolify-deploy`. Le volume persistant est monté automatiquement
sur `STORAGE_DIR`. La clé API est injectée via `.env` (`--env-file`).
