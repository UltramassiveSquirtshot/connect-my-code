// api/fetch-subtitles.js — Vercel Serverless Function (Node.js)
// Tre strategie in cascata per massima affidabilita' sui TED Talk

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
    }).filter(line => line.length > 8).join('\n');
}

// ── Strategia 2: scraping HTML con bracket-counter robusto ──────────────────
// Non usa regex sul JSON (fragile) ma conta le parentesi graffe

function extractNestedJson(html, keyword) {
    const keyIdx = html.indexOf(keyword);
    if (keyIdx === -1) return null;
    const start = html.indexOf('{', keyIdx);
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(html.slice(start, i + 1)); }
                catch { return null; }
            }
        }
    }
    return null;
}

function xmlTimedTextToItems(xml) {
    const items = [];
    const re = /<text[^>]*\bstart="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const offset = Math.round(parseFloat(m[1]) * 1000);
        const text = m[2]
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"')
            .replace(/\n/g, ' ').trim();
        if (text) items.push({ text, offset });
    }
    return items;
}

const YT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function fetchViaHTMLScraping(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: YT_HEADERS });
    if (!res.ok) throw new Error(`YouTube non raggiungibile: ${res.status}`);
    const html = await res.text();

    // Prova ytInitialPlayerResponse (vecchio e nuovo formato)
    const playerData =
        extractNestedJson(html, 'ytInitialPlayerResponse =') ||
        extractNestedJson(html, 'ytInitialPlayerResponse=') ||
        extractNestedJson(html, '"ytInitialPlayerResponse":{');

    if (!playerData) throw new Error('ytInitialPlayerResponse non trovato — YouTube ha cambiato struttura HTML');

    const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks?.length) throw new Error('Nessun sottotitolo disponibile per questo video');

    // Priorita': en nativo → en auto → it → primo disponibile
    const track =
        captionTracks.find(t => t.languageCode === 'en' && !t.kind) ||
        captionTracks.find(t => t.languageCode === 'en') ||
        captionTracks.find(t => t.languageCode === 'it') ||
        captionTracks[0];

    let timedTextUrl = (track.baseUrl || '')
        .replace(/\\u0026/g, '&')
        .replace(/\\u0027/g, "'");

    if (!timedTextUrl) throw new Error('baseUrl mancante nella traccia sottotitoli');

    const subRes = await fetch(timedTextUrl, { headers: YT_HEADERS });
    if (!subRes.ok) throw new Error(`Errore download sottotitoli: ${subRes.status}`);
    const xml = await subRes.text();

    const items = xmlTimedTextToItems(xml);
    if (!items.length) throw new Error('Parsing XML: nessun elemento trovato');
    return items;
}

// ── Strategia 3: timedtext URL diretta (no signed URL, solo per CC pubblici) ─
async function fetchViaTimedtextDirect(videoId) {
    // Prova l'endpoint pubblico timedtext — funziona solo se i sottotitoli
    // sono CC (Creative Commons) o pubblici senza firma. I TED Talk spesso lo sono.
    const langs = ['en', 'it', 'en-US'];
    for (const lang of langs) {
        const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=srv3`;
        try {
            const res = await fetch(url, { headers: YT_HEADERS });
            if (!res.ok) continue;
            const xml = await res.text();
            const items = xmlTimedTextToItems(xml);
            if (items.length) return items;
        } catch { /* continua */ }
    }
    throw new Error('Timedtext diretto: nessun risultato per le lingue provate');
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const videoId = extractVideoId(req.query.videoId);
    if (!videoId) return res.status(400).json({ message: 'videoId non valido o mancante' });

    const errors = [];

    // ── 1. youtube-transcript (InnerTube API) ─────────────────────────────
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
        } catch (e) {
            if (lang === null) errors.push(`innertube: ${e.message}`);
        }
    }

    // ── 2. HTML scraping con JSON bracket-counter ─────────────────────────
    try {
        const items = await fetchViaHTMLScraping(videoId);
        return res.status(200).json({
            subtitles: formatWithTimestamps(items),
            source: 'html-scraping'
        });
    } catch (e) {
        errors.push(`html-scraping: ${e.message}`);
    }

    // ── 3. Timedtext URL diretta ──────────────────────────────────────────
    try {
        const items = await fetchViaTimedtextDirect(videoId);
        return res.status(200).json({
            subtitles: formatWithTimestamps(items),
            source: 'timedtext-direct'
        });
    } catch (e) {
        errors.push(`timedtext-direct: ${e.message}`);
    }

    // Tutti e tre falliti — restituiamo i dettagli per debug
    console.error(`[fetch-subtitles] All strategies failed for ${videoId}:`, errors);
    return res.status(502).json({
        message: 'Impossibile recuperare i sottotitoli.',
        errors
    });
}
