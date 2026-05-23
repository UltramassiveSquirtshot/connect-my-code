// api/fetch-subtitles.js — Vercel Serverless Function (Node.js)
// Primo tentativo: youtube-transcript via InnerTube API (stabile, niente API key)
// Fallback: scraping HTML YouTube (stesso approccio del vecchio edge function)

import { YoutubeTranscript } from 'youtube-transcript';

function extractVideoId(input) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const p of patterns) {
        const m = input?.match(p);
        if (m) return m[1];
    }
    return null;
}

function formatWithTimestamps(items) {
    return items.map(({ text, offset }) => {
        const s = Math.floor((offset ?? 0) / 1000);
        const mm = String(Math.floor(s / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        return `[${mm}:${ss}] ${text.trim()}`;
    }).join('\n');
}

async function fetchViaHTMLScraping(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
        }
    });
    if (!res.ok) throw new Error(`YouTube non raggiungibile: ${res.status}`);
    const html = await res.text();

    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});\s*<\/script>/);
    if (!playerMatch) throw new Error('Struttura HTML YouTube cambiata, parser da aggiornare');

    const playerResponse = JSON.parse(playerMatch[1]);
    const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks?.length) throw new Error('Nessun sottotitolo disponibile per questo video');

    const track =
        captionTracks.find(t => t.languageCode === 'en') ||
        captionTracks.find(t => t.languageCode === 'it') ||
        captionTracks[0];

    let timedTextUrl = (track.baseUrl || '').replace(/\\u0026/g, '&').replace(/\\u0027/g, "'");
    const subRes = await fetch(timedTextUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });
    if (!subRes.ok) throw new Error(`Errore download sottotitoli: ${subRes.status}`);

    const xml = await subRes.text();
    const items = [];
    const re = /<text start="([^"]*)" dur="([^"]*)">([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const offset = Math.round(parseFloat(m[1]) * 1000);
        const text = m[3]
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
        if (text) items.push({ text, offset });
    }

    if (!items.length) throw new Error('Sottotitoli vuoti dopo il parsing');
    return formatWithTimestamps(items);
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const raw = req.query.videoId;
    const videoId = extractVideoId(raw);
    if (!videoId) return res.status(400).json({ message: 'videoId non valido o mancante' });

    // 1. InnerTube API via youtube-transcript (priorità: en, en-US, qualsiasi)
    for (const lang of ['en', 'en-US', null]) {
        try {
            const opts = lang ? { lang } : {};
            const items = await YoutubeTranscript.fetchTranscript(videoId, opts);
            if (items?.length) {
                return res.status(200).json({
                    subtitles: formatWithTimestamps(items),
                    source: 'innertube'
                });
            }
        } catch (_) { /* prossimo tentativo */ }
    }

    // 2. Fallback: scraping HTML (stesso approccio del vecchio edge function)
    try {
        const subtitles = await fetchViaHTMLScraping(videoId);
        return res.status(200).json({ subtitles, source: 'scraping' });
    } catch (err) {
        return res.status(502).json({ message: err.message });
    }
}
