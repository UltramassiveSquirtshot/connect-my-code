// api/debug-db.js — temporaneo, verifica connessione DB
import { isDbEnabled } from '../lib/db.js';
import postgres from 'postgres';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
    const dbEnabled = isDbEnabled();

    if (!url) {
        return res.status(200).json({ dbEnabled: false, reason: 'DATABASE_URL non impostata' });
    }

    // Maschera la password nell'URL per sicurezza
    let maskedUrl = 'non leggibile';
    try {
        const u = new URL(url);
        maskedUrl = `${u.protocol}//${u.username}:***@${u.host}${u.pathname}`;
    } catch (_) {}

    try {
        const db = postgres(url, { ssl: 'require', max: 1, connect_timeout: 10 });
        const rows = await db`SELECT COUNT(*) as n FROM transcripts`;
        await db.end();
        return res.status(200).json({
            dbEnabled,
            connected: true,
            transcriptsCount: Number(rows[0].n),
            url: maskedUrl,
        });
    } catch (e) {
        return res.status(200).json({
            dbEnabled,
            connected: false,
            error: e.message,
            url: maskedUrl,
        });
    }
}
