# YouTube Transcript Summarizer

Frontend statico + API serverless su **Vercel** (Node.js 20).  
Estrae sottotitoli YouTube con timestamp → riassunto AI via OpenRouter → cache su Neon DB.

---

## Struttura

```
├── index.html
├── styles.css
├── script.js
├── vercel.json
├── package.json
├── .env.example
├── api/
│   ├── fetch-subtitles.js   ← GET /api/fetch-subtitles?videoId=...
│   ├── subtitles.js         ← GET/POST /api/subtitles (cache DB)
│   ├── summarize.js         ← POST /api/summarize
│   └── records/
│       └── [id]/
│           └── download.js  ← GET /api/records/:id/download
└── lib/
    ├── openrouter.js
    └── db.js
```

---

## Perché Vercel invece di Netlify

| | Netlify Edge Functions | Vercel Serverless |
|---|---|---|
| Runtime | **Deno** | **Node.js 20** |
| `youtube-transcript` | ❌ Non funziona | ✅ Funziona |
| DB pooling | Problematico | ✅ Stabile |
| Free tier | 125k req/mese | 100k req/mese |

---

## Deploy su Vercel

1. Vai su [vercel.com](https://vercel.com) → **Add New Project**
2. Importa questo repo GitHub
3. **Framework Preset**: Other
4. Aggiungi le variabili d'ambiente (vedi sotto)
5. Deploy

### Variabili d'ambiente

| Nome | Obbligatorio | Note |
|------|-------------|------|
| `OPENROUTER_API_KEY` | ✅ | La tua chiave OpenRouter |
| `AI_MODEL` | No | Default: `google/gemini-2.0-pro-exp-02-05:free` |
| `SITE_URL` | No | URL del sito deployato |
| `DATABASE_URL` | No | Connection string Neon Postgres |

---

## Come funziona il fetching sottotitoli

**Strategia doppia con fallback automatico:**

1. **`youtube-transcript` via InnerTube API** (Android client) — priorità: en → en-US → qualsiasi lingua
2. **HTML scraping** — fallback se InnerTube non risponde

Entrambi restituiscono il testo con timestamp `[MM:SS]`.  
I TED Talk hanno sottotitoli nativi in inglese → funziona sempre con il metodo 1.

---

## Sviluppo locale

```bash
npm install
cp .env.example .env.local
vercel dev   # http://localhost:3000
```
