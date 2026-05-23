// api/fetch-subtitles.js
//
// Il problema core: Vercel (AWS us-east) è in blacklist YouTube per richieste dirette.
// Supadata usa infrastruttura propria non bloccata → risolve il problema.
//
// Strategia 1 (primaria): Supadata API — servizio gratuito dedicato ai transcript YouTube
// Strategia 2: YouTube Data API v3 captions.list + timedtext (torna spesso vuoto)
// Strategia 3+4: InnerTube hardcoded (bloccato da Vercel IPs, ma teniamo come fallback)

export const config = { maxDuration: 30 };

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const DATA_API_KEY  = process.env.YOUTUBE_API_KEY;
const SUPADATA_KEY  = process.env.SUPADATA_API_KEY; // opzionale — più richieste/giorno

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

function offsetToTimestamp(ms) {
    const s = Math.floor((ms||0)/1000);
    return `[${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}]`;
}

function format(items) {
    return items
        .map(({ text, offset }) => `${offsetToTimestamp(offset)} ${text.trim()}`)
        .filter(l => l.length > 8)
        .join('\n');
}

function pickTrack(tracks) {
    return (
        tracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
        tracks.find(t => t.languageCode?.startsWith('en')) ||
        tracks[0]
    );
}

async function downloadXml(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
        }
    });
    if (!res.ok) throw new Error(`download XML HTTP ${res.status}`);
    const xml = await res.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error('XML vuoto o formato sconosciuto');
    return items;
}

// ── 1. Supadata (primaria) ────────────────────────────────────────────────────
// API gratuita dedicata ai transcript YouTube: https://supadata.ai
// Bypass completo del bot detection YouTube — usa proxy IP propri
// Free tier: ~10 req/min senza key, di più con key registrata (gratuita)
async function strategySupadata(videoId) {
    const url = new URL('https://api.supadata.ai/v1/youtube/transcript');
    url.searchParams.set('videoId', videoId);
    url.searchParams.set('lang', 'en');

    const headers = { 'Accept': 'application/json' };
    if (SUPADATA_KEY) headers['x-api-key'] = SUPADATA_KEY;

    const res = await fetch(url.toString(), { headers });

    // Supadata restituisce 404 se non trova il transcript, 402 se quota esaurita
    if (res.status === 404) throw new Error('Supadata: transcript non trovato per questo video');
    if (res.status === 402) throw new Error('Supadata: quota gratuita esaurita, registra SUPADATA_API_KEY');
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Supadata HTTP ${res.status}: ${body.slice(0,120)}`);
    }

    const data = await res.json();

    // Risposta Supadata: { content: [{text, offset, duration}] | string }
    if (typeof data.content === 'string') {
        // Modalità text=true: testo puro senza timestamp
        if (!data.content?.trim()) throw new Error('Supadata: content vuoto');
        return {
            items: [{ text: data.content, offset: 0 }],
            lang: data.lang || 'en',
            auto: false,
            source: 'supadata',
            rawText: true
        };
    }

    const chunks = data.content || data.transcript || [];
    if (!chunks.length) throw new Error('Supadata: nessun chunk restituito');

    const items = chunks.map(c => ({
        text: (c.text || c.content || '').trim(),
        offset: (c.offset ?? c.start ?? 0)
    })).filter(i => i.text);

    if (!items.length) throw new Error('Supadata: items vuoti dopo mapping');
    return { items, lang: data.lang || 'en', auto: false, source: 'supadata' };
}

// ── 2. YouTube Data API v3 captions.list + timedtext ────────────────────────
async function strategyDataAPI(videoId) {
    if (!DATA_API_KEY) throw new Error('YOUTUBE_API_KEY non impostata');

    const listRes = await fetch(
        `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}&key=${DATA_API_KEY}`
    );
    const listData = await listRes.json();
    if (listData.error) throw new Error(`captions.list ${listData.error.code}: ${listData.error.message}`);
    if (!listData.items?.length) throw new Error('captions.list: nessuna traccia');

    const t = listData.items.find(i => i.snippet?.language?.startsWith('en') && i.snippet?.trackKind !== 'asr')
           || listData.items.find(i => i.snippet?.language?.startsWith('en'))
           || listData.items[0];

    const lang = t.snippet?.language || 'en';
    const isAuto = t.snippet?.trackKind === 'asr';

    // Prova tutti i formati XML
    for (const fmt of ['srv3', 'ttml', 'vtt']) {
        const params = new URLSearchParams({ v: videoId, lang, fmt });
        if (isAuto) params.set('kind', 'asr');
        try {
            const items = await downloadXml(`https://www.youtube.com/api/timedtext?${params}`);
            return { items, lang, auto: isAuto, source: 'data-api-timedtext' };
        } catch(e) {
            if (fmt === 'vtt') throw e; // ultimo tentativo fallito
        }
    }
}

// ── 3. InnerTube WEB (hardcoded key, spesso bloccato da Vercel IPs) ──────────
async function strategyInnertubeWEB(videoId) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json', 'User-Agent': UA,
                'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': '2.20240313.05.00',
                'Origin': 'https://www.youtube.com',
                'Referer': `https://www.youtube.com/watch?v=${videoId}`,
                'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
            },
            body: JSON.stringify({ videoId, context: { client: { clientName:'WEB', clientVersion:'2.20240313.05.00', hl:'en', gl:'US' } } })
        }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`InnerTube WEB HTTP ${res.status}: ${text.slice(0,120)}`);
    let data; try { data = JSON.parse(text); } catch { throw new Error('InnerTube WEB: non-JSON'); }
    const status = data?.playabilityStatus?.status;
    if (status && status !== 'OK') throw new Error(`InnerTube WEB: ${data?.playabilityStatus?.reason || status}`);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('InnerTube WEB: nessuna traccia');
    const track = pickTrack(tracks);
    let url = decodeUrl(track.baseUrl || '');
    if (!url.includes('fmt=')) url += '&fmt=srv3';
    const items = await downloadXml(url);
    return { items, lang: track.languageCode, auto: track.kind === 'asr', source: 'innertube-web' };
}

// ── 4. InnerTube TV (hardcoded key) ─────────────────────────────────────────
async function strategyInnertubeTV(videoId) {
    const UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1';
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json', 'User-Agent': UA,
                'X-Youtube-Client-Name': '7', 'X-Youtube-Client-Version': '7.20240101.20.00',
                'Origin': 'https://www.youtube.com',
                'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
            },
            body: JSON.stringify({ videoId, context: { client: { clientName:'TVHTML5', clientVersion:'7.20240101.20.00', hl:'en', gl:'US' } } })
        }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`InnerTube TV HTTP ${res.status}: ${text.slice(0,120)}`);
    let data; try { data = JSON.parse(text); } catch { throw new Error('InnerTube TV: non-JSON'); }
    const status = data?.playabilityStatus?.status;
    if (status && status !== 'OK') throw new Error(`InnerTube TV: ${data?.playabilityStatus?.reason || status}`);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('InnerTube TV: nessuna traccia');
    const track = pickTrack(tracks);
    let url = decodeUrl(track.baseUrl || '');
    if (!url.includes('fmt=')) url += '&fmt=srv3';
    const items = await downloadXml(url);
    return { items, lang: track.languageCode, auto: track.kind === 'asr', source: 'innertube-tv' };
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
    for (const [name, fn] of [
        ['supadata',       strategySupadata],
        ['data-api',       strategyDataAPI],
        ['innertube-web',  strategyInnertubeWEB],
        ['innertube-tv',   strategyInnertubeTV],
    ]) {
        try {
            const r = await fn(videoId);
            console.log(`[subtitles] OK ${r.source} ${videoId} lang=${r.lang} items=${r.items.length}`);
            return res.status(200).json({
                subtitles: r.rawText ? r.items[0].text : format(r.items),
                source: r.source, lang: r.lang,
                isAutoGenerated: r.auto, itemCount: r.items.length
            });
        } catch(e) {
            const msg = e.message.slice(0,120);
            errors.push(`${name}: ${msg}`);
            console.error(`[subtitles] FAIL ${name} ${videoId}: ${msg}`);
        }
    }

    console.error(`[subtitles] ALL_FAILED ${videoId}: ${JSON.stringify(errors)}`);
    return res.status(502).json({ message:'Impossibile recuperare i sottotitoli.', videoId, errors });
}
