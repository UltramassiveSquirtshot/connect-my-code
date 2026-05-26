// lib/db.js
// Supabase Postgres via 'postgres' (node-postgres compatible, serverless-safe)
// Reads: DATABASE_URL -> POSTGRES_URL -> POSTGRES_PRISMA_URL -> NETLIFY_DATABASE_URL

import postgres from 'postgres';

let sql = null;

function getUrl() {
    return (
        process.env.DATABASE_URL ||
        process.env.POSTGRES_URL ||
        process.env.POSTGRES_PRISMA_URL ||
        process.env.NETLIFY_DATABASE_URL ||
        null
    );
}

function getSql() {
    const url = getUrl();
    if (!url) return null;
    if (!sql) sql = postgres(url, { ssl: 'require', max: 1 });
    return sql;
}

export function isDbEnabled() {
    return Boolean(getUrl());
}

let schemaReady = false;

async function ensureSchema() {
    const db = getSql();
    if (!db || schemaReady) return;
    try {
        await db`
            CREATE TABLE IF NOT EXISTS transcripts (
                id SERIAL PRIMARY KEY,
                video_id VARCHAR(11) NOT NULL,
                youtube_url TEXT NOT NULL,
                transcript TEXT NOT NULL,
                summary TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;
        await db`CREATE INDEX IF NOT EXISTS idx_transcripts_video_id ON transcripts (video_id)`;
        await db`
            CREATE TABLE IF NOT EXISTS subtitle_cache (
                video_id VARCHAR(11) PRIMARY KEY,
                subtitles TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;
        schemaReady = true;
    } catch(e) {
        console.error('[db] ensureSchema failed:', e.message);
        throw e;
    }
}

export async function saveSubtitles(videoId, subtitles) {
    const db = getSql();
    if (!db) return false;
    await ensureSchema();
    await db`
        INSERT INTO subtitle_cache (video_id, subtitles)
        VALUES (${videoId}, ${subtitles})
        ON CONFLICT (video_id) DO UPDATE SET
            subtitles = EXCLUDED.subtitles,
            updated_at = NOW()
    `;
    return true;
}

export async function getSubtitles(videoId) {
    const db = getSql();
    if (!db) return null;
    await ensureSchema();
    const rows = await db`SELECT subtitles FROM subtitle_cache WHERE video_id = ${videoId}`;
    return rows[0]?.subtitles || null;
}

export async function saveTranscript({ videoId, youtubeUrl, transcript, summary }) {
    const db = getSql();
    if (!db) throw new Error('Database non configurato — imposta DATABASE_URL su Vercel.');
    await ensureSchema();
    const rows = await db`
        INSERT INTO transcripts (video_id, youtube_url, transcript, summary)
        VALUES (${videoId}, ${youtubeUrl}, ${transcript}, ${summary})
        RETURNING id
    `;
    return rows[0];
}

export async function getTranscriptById(id) {
    const db = getSql();
    if (!db) throw new Error('Database non configurato.');
    await ensureSchema();
    const rows = await db`
        SELECT id, video_id, transcript, summary FROM transcripts WHERE id = ${id}
    `;
    return rows[0] || null;
}
