// api/fetch-subtitles.js
export const config = { maxDuration: 30 };

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

// Cookie GDPR bypass — documentato, non richiede account.
// SOCS=CAI = consent accettato (infrastruttura).
// CONSENT=YES+cb = vecchio formato di fallback.
const BYPASS_COOKIE = 'SOCS=CAI; CONSENT=YES+cb';

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Cookie': BYPASS_COOKIE,
};

// ── Strategia 1: HTML scraping con GDPR cookie bypass ───────────────────────
async function fetchViaHTMLWithCookie(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: BROWSER_HEADERS });
    if (!res.ok) throw new Error(`HTML fetch: HTTP ${res.status}`);
    const html = await res.text();

    // Verifica che non sia la pagina di consent
    if (html.includes('consent.youtube.com') || html.includes('before you continue')) {
        throw new Error('Cookie bypass non sufficiente: YouTube mostra ancora consent page');
    }

    const player =
        extractJson(html, 'ytInitialPlayerResponse =') ||
        extractJson(html, 'ytInitialPlayerResponse=');

    if (!player) {
        // Log primi 500 chars per debug
        console.error('[html-cookie] ytInitialPlayerResponse not found. HTML preview:', html.slice(0,500));
        throw new Error('ytInitialPlayerResponse non trovato nell\'HTML');
    }

    const status = player?.playabilityStatus?.status;
    if (status && status !== 'OK') throw new Error(`Video non disponibile: ${player?.playabilityStatus?.reason || status}`);

    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('Nessuna traccia sottotitoli nel playerResponse');

    const track =
        tracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
        tracks.find(t => t.languageCode?.startsWith('en')) ||
        tracks[0];

    const url = decodeUrl(track.baseUrl || '') + (track.baseUrl?.includes('fmt=') ? '' : '&fmt=srv3');

    const subRes = await fetch(url, { headers: BROWSER_HEADERS });
    if (!subRes.ok) throw new Error(`Download XML: HTTP ${subRes.status}`);
    const xml = await subRes.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error('XML vuoto dopo parsing');
    return { items, lang: track.languageCode, auto: track.kind === 'asr' };
}

// ── Strategia 2: InnerTube Android ──────────────────────────────────────────
async function fetchViaInnerTube(videoId, clientName, clientVersion, clientNum) {
    const clientConfigs = {
        ANDROID: {
            clientName: 'ANDROID', clientVersion: '19.09.37',
            androidSdkVersion: 30, userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
            hl: 'en', gl: 'US', timeZone: 'UTC', utcOffsetMinutes: 0
        },
        IOS: {
            clientName: 'IOS', clientVersion: '19.09.3',
            deviceModel: 'iPhone16,2',
            userAgent: 'com.google.ios.youtube/19.09.3 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)',
            hl: 'en', gl: 'US', timeZone: 'UTC', utcOffsetMinutes: 0
        },
        TVHTML5: {
            clientName: 'TVHTML5', clientVersion: '7.20240101.20.00',
            hl: 'en', gl: 'US'
        }
    };

    const client = clientConfigs[clientName];
    if (!client) throw new Error(`Client sconosciuto: ${clientName}`);

    const res = await fetch(
        'https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': client.userAgent || 'Mozilla/5.0',
                'X-Youtube-Client-Name': String({ ANDROID: 3, IOS: 5, TVHTML5: 7 }[clientName] || 1),
                'X-Youtube-Client-Version': client.clientVersion,
                'Origin': 'https://www.youtube.com',
                'Cookie': BYPASS_COOKIE,
            },
            body: JSON.stringify({ videoId, context: { client } })
        }
    );

    const body = await res.text();
    if (!res.ok) throw new Error(`InnerTube ${clientName}: HTTP ${res.status} — ${body.slice(0,200)}`);

    let data;
    try { data = JSON.parse(body); } catch { throw new Error(`InnerTube ${clientName}: risposta non JSON`); }

    const status = data?.playabilityStatus?.status;
    if (status && status !== 'OK') throw new Error(`Video non disponibile (${clientName}): ${data?.playabilityStatus?.reason || status}`);

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error(`InnerTube ${clientName}: nessuna traccia sottotitoli`);

    const track =
        tracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
        tracks.find(t => t.languageCode?.startsWith('en')) ||
        tracks[0];

    const url = decodeUrl(track.baseUrl || '') + (track.baseUrl?.includes('fmt=') ? '' : '&fmt=srv3');
    const subRes = await fetch(url, { headers: { 'User-Agent': client.userAgent || 'Mozilla/5.0', 'Cookie': BYPASS_COOKIE } });
    if (!subRes.ok) throw new Error(`InnerTube ${clientName}: download XML HTTP ${subRes.status}`);

    const xml = await subRes.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error(`InnerTube ${clientName}: XML vuoto`);
    return { items, lang: track.languageCode, auto: track.kind === 'asr' };
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

    // 1. HTML scraping + GDPR cookie
    try {
        const { items, lang, auto } = await fetchViaHTMLWithCookie(videoId);
        console.log(`[fetch-subtitles] OK via html-cookie: ${videoId} lang=${lang} items=${items.length}`);
        return res.status(200).json({ subtitles: format(items), source: 'html-cookie', lang, isAutoGenerated: auto });
    } catch(e) { errors.push(`html-cookie: ${e.message}`); console.error(`[fetch-subtitles] html-cookie failed: ${e.message}`); }

    // 2. InnerTube Android
    try {
        const { items, lang, auto } = await fetchViaInnerTube(videoId, 'ANDROID');
        console.log(`[fetch-subtitles] OK via innertube-android: ${videoId} lang=${lang}`);
        return res.status(200).json({ subtitles: format(items), source: 'innertube-android', lang, isAutoGenerated: auto });
    } catch(e) { errors.push(`innertube-android: ${e.message}`); console.error(`[fetch-subtitles] android failed: ${e.message}`); }

    // 3. InnerTube iOS
    try {
        const { items, lang, auto } = await fetchViaInnerTube(videoId, 'IOS');
        console.log(`[fetch-subtitles] OK via innertube-ios: ${videoId} lang=${lang}`);
        return res.status(200).json({ subtitles: format(items), source: 'innertube-ios', lang, isAutoGenerated: auto });
    } catch(e) { errors.push(`innertube-ios: ${e.message}`); console.error(`[fetch-subtitles] ios failed: ${e.message}`); }

    // 4. InnerTube TVHTML5
    try {
        const { items, lang, auto } = await fetchViaInnerTube(videoId, 'TVHTML5');
        console.log(`[fetch-subtitles] OK via innertube-tv: ${videoId} lang=${lang}`);
        return res.status(200).json({ subtitles: format(items), source: 'innertube-tv', lang, isAutoGenerated: auto });
    } catch(e) { errors.push(`innertube-tv: ${e.message}`); console.error(`[fetch-subtitles] tv failed: ${e.message}`); }

    console.error(`[fetch-subtitles] ALL FAILED for ${videoId}:`, errors);
    return res.status(502).json({ message: 'Impossibile recuperare i sottotitoli.', videoId, errors });
}
