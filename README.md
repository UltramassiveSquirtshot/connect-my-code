# YoutubeTranscriptor

Tutto su **Netlify**: frontend statico + **Edge Functions** come backend.

## Struttura

```
├── index.html              Frontend (root)
├── styles.css
├── script.js
├── netlify.toml
└── netlify/edge-functions/
    ├── api.js              Router API
    └── lib/
        ├── openrouter.js
        └── db.js           Opzionale (Neon / Netlify DB)
```

## Deploy su Netlify

1. Collega il repository
2. **Publish directory**: `.` (root)
3. **Environment variables** (Site settings → Environment variables):
   - `OPENROUTER_API_KEY` — obbligatoria
   - `AI_MODEL` — opzionale (default: `google/gemini-2.0-pro-exp-02-05:free`)
   - `DATABASE_URL` — opzionale (per salvare riassunti e cache sottotitoli)
4. Deploy

### Database (opzionale) — Supabase

Senza DB l’app funziona: estrazione sottotitoli nel browser + riassunto via Edge Function.

#### Collegare Supabase

1. Vai su [supabase.com](https://supabase.com) → **New project**
2. Scegli nome, password del database (salvala) e regione
3. **Project Settings** → **Database** → **Connection string**
4. Tab **ORM** o **URI**, modalità **Transaction** (pooler, porta **6543**) — adatta a Edge/serverless
5. Copia la stringa e sostituisci `[YOUR-PASSWORD]` con la password del progetto
6. Su **Netlify** → **Site configuration** → **Environment variables**:
   - Nome: `DATABASE_URL`
   - Valore: la connection string copiata
7. **Redeploy** del sito

Le tabelle `transcripts` e `subtitle_cache` si creano automaticamente al primo riassunto salvato.

Puoi verificare i dati in Supabase → **Table Editor**.

#### Altre opzioni DB

- **Netlify DB**: Extensions → Netlify DB (usa `NETLIFY_DATABASE_URL`, già supportata)
- **Neon** o altro Postgres: stessa variabile `DATABASE_URL`

## Sviluppo locale

```bash
npm install
npx netlify dev
```

Apri l’URL indicato da `netlify dev` (di solito `http://localhost:8888`).

## API (Edge)

| Metodo | Path | Descrizione |
|--------|------|-------------|
| POST | `/api/summarize` | Genera riassunto (OpenRouter) |
| GET/POST | `/api/subtitles` | Cache sottotitoli (solo con DB) |
| GET | `/api/records/:id/download` | Download .txt (solo con DB) |
