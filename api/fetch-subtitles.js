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

// SOCS=CAI: cookie consent bypass documentato per GDPR
// Senza questo cookie YouTube restituisce la pagina di consenso
// anche da IP non-EU (comportamento attivo dal 2023)
const CONSENT_COOKIE = 'SOCS=CAI; CONSENT=YES+cb';

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Cookie': CONSENT_COOKIE,
};

// ── Strategia 1: HTML scraping con GDPR bypass ───────────────────────────────
async function htmlScraping(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: BROWSER_HEADERS });
    if (!res.ok) throw new Error(`HTML fetch HTTP ${res.status}`);
    const html = await res.text();

    if (html.includes('consent.youtube.com') || html.includes('before you continue') || html.includes('socs')) {
        throw new Error('Cookie bypass insufficiente: YouTube mostra consent page');
    }

    const player =
        extractJson(html, 'ytInitialPlayerResponse =') ||
        extractJson(html, 'ytInitialPlayerResponse=') ||
        extractJson(html, '"ytInitialPlayerResponse":');

    if (!player) {
        const snippet = html.slice(0,300).replace(/\s+/g,' ');
        throw new Error(`ytInitialPlayerResponse non trovato. HTML inizio: ${snippet}`);
    }

    const status = player?.playabilityStatus?.status;
    if (status && status !== 'OK') {
        throw new Error(`Video non disponibile: ${player?.playabilityStatus?.reason || status}`);
    }

    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('Nessuna traccia sottotitoli nel playerResponse');

    const track =
        tracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
        tracks.find(t => t.languageCode?.startsWith('en')) ||
        tracks[0];

    let trackUrl = decodeUrl(track.baseUrl || '');
    if (!trackUrl.includes('fmt=')) trackUrl += '&fmt=srv3';

    const subRes = await fetch(trackUrl, { headers: BROWSER_HEADERS });
    if (!subRes.ok) throw new Error(`Download XML HTTP ${subRes.status}`);
    const xml = await subRes.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error('XML vuoto dopo parsing');
    return { items, lang: track.languageCode, auto: track.kind === 'asr', source: 'html-gdpr' };
}

// ── Strategia 2/3/4: InnerTube (Android / iOS / TV) ─────────────────────────
// NOTA: nessun ?key= nella URL — la API key è solo per WEB client.
// Android/iOS/TV usano autenticazione diversa.
async function innerTube(videoId, clientName) {
    const clients = {
        ANDROID: {
            num: '3', version: '19.09.37',
            ua: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
            body: { clientName:'ANDROID', clientVersion:'19.09.37', androidSdkVersion:30, hl:'en', gl:'US' }
        },
        IOS: {
            num: '5', version: '19.09.3',
            ua: 'com.google.ios.youtube/19.09.3 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)',
            body: { clientName:'IOS', clientVersion:'19.09.3', deviceModel:'iPhone16,2', hl:'en', gl:'US' }
        },
        TVHTML5: {
            num: '7', version: '7.20240101.20.00',
            ua: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1',
            body: { clientName:'TVHTML5', clientVersion:'7.20240101.20.00', hl:'en', gl:'US' }
        }
    };

    const c = clients[clientName];
    if (!c) throw new Error(`Client ${clientName} sconosciuto`);

    const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': c.ua,
            'X-Youtube-Client-Name': c.num,
            'X-Youtube-Client-Version': c.version,
            'Origin': 'https://www.youtube.com',
            'Cookie': CONSENT_COOKIE,
        },
        body: JSON.stringify({ videoId, context: { client: c.body } })
    });

    const bodyText = await res.text();
    if (!res.ok) throw new Error(`${clientName} HTTP ${res.status}: ${bodyText.slice(0,150)}`);

    let data;
    try { data = JSON.parse(bodyText); }
    catch { throw new Error(`${clientName}: risposta non-JSON`); }

    const status = data?.playabilityStatus?.status;
    if (status && status !== 'OK') throw new Error(`${clientName}: ${data?.playabilityStatus?.reason || status}`);

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error(`${clientName}: nessuna traccia sottotitoli`);

    const track =
        tracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
        tracks.find(t => t.languageCode?.startsWith('en')) ||
        tracks[0];

    let trackUrl = decodeUrl(track.baseUrl || '');
    if (!trackUrl.includes('fmt=')) trackUrl += '&fmt=srv3';

    const subRes = await fetch(trackUrl, { headers: { 'User-Agent': c.ua, 'Cookie': CONSENT_COOKIE } });
    if (!subRes.ok) throw new Error(`${clientName}: download XML HTTP ${subRes.status}`);

    const xml = await subRes.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error(`${clientName}: XML vuoto`);
    return { items, lang: track.languageCode, auto: track.kind === 'asr', source: `innertube-${clientName.toLowerCase()}` };
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
    const strategies = [
        () => htmlScraping(videoId),
        () => innerTube(videoId, 'ANDROID'),
        () => innerTube(videoId, 'IOS'),
        () => innerTube(videoId, 'TVHTML5'),
    ];

    for (const strategy of strategies) {
        try {
            const { items, lang, auto, source } = await strategy();
            console.log(`[fetch-subtitles] OK via ${source}: videoId=${videoId} lang=${lang} items=${items.length}`);
            return res.status(200).json({
                subtitles: format(items),
                source, lang,
                isAutoGenerated: auto,
                itemCount: items.length
            });
        } catch(e) {
            const name = e.message.slice(0,80);
            errors.push(name);
            console.error(`[fetch-subtitles] strategy failed: ${name}`);
        }
    }

    console.error(`[fetch-subtitles] ALL FAILED for ${videoId}:`, JSON.stringify(errors));
    return res.status(502).json({ message: 'Impossibile recuperare i sottotitoli.', videoId, errors });
}
