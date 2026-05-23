import { neon } from '@neondatabase/serverless';

let sql = null;
let schemaReady = false;

function getSql() {
    const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
    if (!url) return null;
    if (!sql) sql = neon(url);
    return sql;
}

export function isDbEnabled() {
    return Boolean(process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL);
}

async function ensureSchema() {
    const db = getSql();
    if (!db || schemaReady) return;
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
    if (!db) throw new Error('Database non configurato.');
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
        SELECT id, video_id, transcript, summary
        FROM transcripts WHERE id = ${id}
    `;
    return rows[0] || null;
}
