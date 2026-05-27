// api/summarize.js — genera riassunto via OpenRouter
import { callOpenRouter, createSummaryPrompt } from '../lib/openrouter.js';
import { isDbEnabled, saveTranscript } from '../lib/db.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Metodo non consentito' });

    const { subtitles, length = 'medium', style = 'detailed', videoId } = req.body ?? {};
    if (!subtitles?.trim()) return res.status(400).json({ message: 'Sottotitoli mancanti o vuoti' });

    try {
        const summary = await callOpenRouter(createSummaryPrompt(subtitles, length, style));

        if (videoId && isDbEnabled()) {
            const saved = await saveTranscript({
                videoId,
                youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
                transcript: subtitles,
                summary
            });
            return res.status(200).json({ summary, recordId: saved.id, saved: true });
        }

        return res.status(200).json({ summary, saved: false });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}
