// api/subtitles.js — cache sottotitoli su DB
import { isDbEnabled, getSubtitles, saveSubtitles } from '../lib/db.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'GET') {
        const videoId = req.query.videoId;
        if (!videoId) return res.status(400).json({ message: 'videoId mancante' });
        if (!isDbEnabled()) return res.status(404).json({ message: 'Cache non disponibile (DB non configurato)' });
        const subtitles = await getSubtitles(videoId);
        if (!subtitles) return res.status(404).json({ message: 'Non trovato in cache' });
        return res.status(200).json({ subtitles });
    }

    if (req.method === 'POST') {
        const { videoId, subtitles } = req.body ?? {};
        if (!videoId || !subtitles) return res.status(400).json({ message: 'videoId o subtitles mancanti' });
        if (isDbEnabled()) await saveSubtitles(videoId, subtitles);
        return res.status(200).json({ success: true, persisted: isDbEnabled() });
    }

    return res.status(405).json({ message: 'Metodo non consentito' });
}
