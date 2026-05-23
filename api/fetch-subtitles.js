// api/fetch-subtitles.js
// Con YOUTUBE_API_KEY: richieste autenticate → bypass bot detection Vercel IPs
// Senza chiave: fallback non autenticati (spesso bloccati da datacenter)
export const config = { maxDuration: 30 };

const API_KEY = process.env.YOUTUBE_API_KEY;

function extractVideoId(input) {
    const p = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const r of p) { const m = input?.match(r); if (m) return m[1]; }
    return null;
}

function decodeUrl(u) { return (u||'').replace(/\\u0026/g,'&').replace(/\\u0027/g,"'"); }

function xmlToItems(xml) {
    const items = [], re = /<text[^>]*\bstart="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const offset = Math.round(parseFloat(m[1]) * 1000);
        const text = m[2]
            .replace(/<[^>]+>/g,'')
            .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
            .replace(/&#39;/g,"'").replace(/&apos;/g,"'").replace(/&quot;/g,'"')
            .replace(/\n/g,' ').trim();
        if (text) items.push({ text, offset });
    }
    return items;
}

function format(items) {
    return items.map(({ text, offset }) => {
        const s = Math.floor((offset||0)/1000);
        return `[${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}] ${text.trim()}`;
    }).filter(l => l.length > 8).join('\n');
}

function extractJson(html, keyword) {
    const idx = html.indexOf(keyword);
    if (idx === -1) return null;
    const start = html.indexOf('{', idx);
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) {
            try { return JSON.parse(html.slice(start, i+1)); } catch { return null; }
        }
    }
    return null;
}

// ── Strategia 1 (con API key): InnerTube WEB autenticato ─────────────────────
// La chiave WEB di YouTube autentica la richiesta → nessun bot detection
// e restituisce i captionTracks con signed baseUrl direttamente
async function innertubeWebWithKey(videoId) {
    if (!API_KEY) throw new Error('YOUTUBE_API_KEY non configurata');
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${API_KEY}&prettyPrint=false`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'X-Youtube-Client-Name': '1',
                'X-Youtube-Client-Version': '2.20240313.05.00',
                'Origin': 'https://www.youtube.com',
                'Referer': 'https://www.youtube.com/',
            },
            body: JSON.stringify({
                videoId,
                context: {
                    client: {
                        clientName: 'WEB',
                        clientVersion: '2.20240313.05.00',
                        hl: 'en',
                        gl: 'US',
                        timeZone: 'UTC',
                        utcOffsetMinutes: 0
                    }
                }
            })
        }
    );

    const bodyText = await res.text();
    if (!res.ok) throw new Error(`InnerTube WEB HTTP ${res.status}: ${bodyText.slice(0,150)}`);

    let data;
    try { data = JSON.parse(bodyText); }
    catch { throw new Error('InnerTube WEB: risposta non-JSON'); }

    const status = data?.playabilityStatus?.status;
    if (status && status !== 'OK') {
        throw new Error(`InnerTube WEB: ${data?.playabilityStatus?.reason || status}`);
    }

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('InnerTube WEB: nessuna traccia sottotitoli');

    const track =
        tracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
        tracks.find(t => t.languageCode?.startsWith('en')) ||
        tracks[0];

    let trackUrl = decodeUrl(track.baseUrl || '');
    if (!trackUrl.includes('fmt=')) trackUrl += '&fmt=srv3';

    const subRes = await fetch(trackUrl);
    if (!subRes.ok) throw new Error(`InnerTube WEB: download XML HTTP ${subRes.status}`);

    const xml = await subRes.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error('InnerTube WEB: XML vuoto');
    return { items, lang: track.languageCode, auto: track.kind === 'asr', source: 'innertube-web-key' };
}

// ── Strategia 2 (con API key): captions.list → timedtext ────────────────────
// Usa YouTube Data API v3 per listare le tracce, poi timedtext pubblico
async function captionsListWithKey(videoId) {
    if (!API_KEY) throw new Error('YOUTUBE_API_KEY non configurata');

    const listRes = await fetch(
        `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}&key=${API_KEY}`
    );
    if (!listRes.ok) throw new Error(`captions.list HTTP ${listRes.status}`);
    const listData = await listRes.json();

    if (listData.error) throw new Error(`captions.list API error: ${listData.error.message}`);
    if (!listData.items?.length) throw new Error('captions.list: nessuna traccia disponibile');

    // Trova la traccia migliore: en nativo → en auto → prima disponibile
    const track =
        listData.items.find(i => i.snippet?.language?.startsWith('en') && i.snippet?.trackKind !== 'asr') ||
        listData.items.find(i => i.snippet?.language?.startsWith('en')) ||
        listData.items[0];

    const lang = track.snippet?.language || 'en';
    const name = track.snippet?.name || '';
    const isAuto = track.snippet?.trackKind === 'asr';

    // Timedtext URL costruita manualmente — funziona per CC pubblici
    const params = new URLSearchParams({ v: videoId, lang, fmt: 'srv3' });
    if (name) params.set('name', name);
    if (isAuto) params.set('kind', 'asr');

    const timedtextUrl = `https://www.youtube.com/api/timedtext?${params.toString()}`;
    const subRes = await fetch(timedtextUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
        }
    });
    if (!subRes.ok) throw new Error(`timedtext HTTP ${subRes.status}`);

    const xml = await subRes.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error('timedtext: XML vuoto');
    return { items, lang, auto: isAuto, source: 'captions-list-key' };
}

// ── Strategia 3 (senza API key): HTML scraping + GDPR cookie ─────────────────
async function htmlScraping(videoId) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
    };

    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers });
    if (!res.ok) throw new Error(`HTML fetch HTTP ${res.status}`);
    const html = await res.text();

    if (html.includes('Sign in') && html.includes('bot')) {
        throw new Error('Bot detection attivo: richiesta non autenticata bloccata');
    }

    const player =
        extractJson(html, 'ytInitialPlayerResponse =') ||
        extractJson(html, 'ytInitialPlayerResponse=');
    if (!player) throw new Error('ytInitialPlayerResponse non trovato nell\'HTML');

    const status = player?.playabilityStatus?.status;
    if (status && status !== 'OK') throw new Error(`Video non disponibile: ${player?.playabilityStatus?.reason || status}`);

    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('Nessuna traccia sottotitoli nel playerResponse');

    const track =
        tracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
        tracks.find(t => t.languageCode?.startsWith('en')) ||
        tracks[0];

    let trackUrl = decodeUrl(track.baseUrl || '');
    if (!trackUrl.includes('fmt=')) trackUrl += '&fmt=srv3';

    const subRes = await fetch(trackUrl, { headers });
    if (!subRes.ok) throw new Error(`Download XML HTTP ${subRes.status}`);
    const xml = await subRes.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error('XML vuoto dopo parsing');
    return { items, lang: track.languageCode, auto: track.kind === 'asr', source: 'html-scraping' };
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const videoId = extractVideoId(req.query.videoId);
    if (!videoId) return res.status(400).json({ message: 'videoId non valido o mancante' });

    const errors = [];

    // Strategie con API key (priorità — bypassano bot detection)
    for (const [name, fn] of [
        ['innertube-web-key', () => innertubeWebWithKey(videoId)],
        ['captions-list-key', () => captionsListWithKey(videoId)],
    ]) {
        try {
            const result = await fn();
            console.log(`[fetch-subtitles] OK via ${result.source}: ${videoId} lang=${result.lang} items=${result.items.length}`);
            return res.status(200).json({
                subtitles: format(result.items),
                source: result.source,
                lang: result.lang,
                isAutoGenerated: result.auto,
                itemCount: result.items.length
            });
        } catch(e) {
            errors.push(`${name}: ${e.message.slice(0,100)}`);
            console.error(`[fetch-subtitles] ${name} failed: ${e.message}`);
        }
    }

    // Fallback senza API key
    try {
        const result = await htmlScraping(videoId);
        console.log(`[fetch-subtitles] OK via ${result.source}: ${videoId}`);
        return res.status(200).json({
            subtitles: format(result.items),
            source: result.source,
            lang: result.lang,
            isAutoGenerated: result.auto,
            itemCount: result.items.length
        });
    } catch(e) {
        errors.push(`html-scraping: ${e.message.slice(0,100)}`);
        console.error(`[fetch-subtitles] html-scraping failed: ${e.message}`);
    }

    console.error(`[fetch-subtitles] ALL FAILED for ${videoId}:`, JSON.stringify(errors));
    return res.status(502).json({ message: 'Impossibile recuperare i sottotitoli.', videoId, errors, hint: API_KEY ? null : 'Imposta YOUTUBE_API_KEY su Vercel per abilitare le richieste autenticate' });
}
