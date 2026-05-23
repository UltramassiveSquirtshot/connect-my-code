// api/fetch-subtitles.js
// Strategia 1 (primaria): YouTube Data API v3 key dell'utente
//   → captions.list → timedtext URL
// Strategia 2+3 (fallback): InnerTube con chiave hardcoded pubblica
//   → stessa chiave usata da yt-dlp, embedded nel JS di youtube.com

export const config = { maxDuration: 30 };

// Chiave InnerTube hardcoded — è pubblica, embedded nel sorgente YouTube
// Non è la YouTube Data API v3 key: è specifica per /youtubei/v1/ endpoints
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// YouTube Data API v3 key dell'utente (Google Console)
const DATA_API_KEY = process.env.YOUTUBE_API_KEY;

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

function pickTrack(tracks) {
    return (
        tracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
        tracks.find(t => t.languageCode?.startsWith('en')) ||
        tracks[0]
    );
}

async function downloadXml(url, headers) {
    const res = await fetch(url, { headers: { 'Cookie': 'SOCS=CAI; CONSENT=YES+cb', ...headers } });
    if (!res.ok) throw new Error(`download XML HTTP ${res.status}`);
    const xml = await res.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error('XML vuoto o formato sconosciuto');
    return items;
}

// ── 1 (primaria): Data API v3 captions.list + timedtext ─────────────────────
// Usa la YouTube Data API v3 key dell'utente per ottenere l'elenco ufficiale
// delle tracce; poi scarica il contenuto via timedtext (funziona per CC pubblici)
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
    const params = new URLSearchParams({ v: videoId, lang, fmt: 'srv3' });
    if (isAuto) params.set('kind', 'asr');

    const items = await downloadXml(
        `https://www.youtube.com/api/timedtext?${params}`,
        { 'User-Agent': 'Mozilla/5.0' }
    );
    return { items, lang, auto: isAuto, source: 'data-api-timedtext' };
}

// ── 2 (fallback A): InnerTube WEB con chiave hardcoded ──────────────────────
async function strategyInnertubeWEB(videoId) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': UA,
                'X-Youtube-Client-Name': '1',
                'X-Youtube-Client-Version': '2.20240313.05.00',
                'Origin': 'https://www.youtube.com',
                'Referer': `https://www.youtube.com/watch?v=${videoId}`,
                'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
            },
            body: JSON.stringify({
                videoId,
                context: { client: { clientName:'WEB', clientVersion:'2.20240313.05.00', hl:'en', gl:'US' } }
            })
        }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`InnerTube WEB HTTP ${res.status}: ${text.slice(0,120)}`);
    let data; try { data = JSON.parse(text); } catch { throw new Error('InnerTube WEB: risposta non-JSON'); }

    const status = data?.playabilityStatus?.status;
    if (status && status !== 'OK') throw new Error(`InnerTube WEB: ${data?.playabilityStatus?.reason || status}`);

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('InnerTube WEB: nessuna traccia');

    const track = pickTrack(tracks);
    let url = decodeUrl(track.baseUrl || '');
    if (!url.includes('fmt=')) url += '&fmt=srv3';
    const items = await downloadXml(url, { 'User-Agent': UA });
    return { items, lang: track.languageCode, auto: track.kind === 'asr', source: 'innertube-web' };
}

// ── 3 (fallback B): InnerTube TVHTML5 con chiave hardcoded ──────────────────
async function strategyInnertubeTV(videoId) {
    const UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1';
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': UA,
                'X-Youtube-Client-Name': '7',
                'X-Youtube-Client-Version': '7.20240101.20.00',
                'Origin': 'https://www.youtube.com',
                'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
            },
            body: JSON.stringify({
                videoId,
                context: { client: { clientName:'TVHTML5', clientVersion:'7.20240101.20.00', hl:'en', gl:'US' } }
            })
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
    const items = await downloadXml(url, { 'User-Agent': UA });
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
        ['data-api',       strategyDataAPI],
        ['innertube-web',  strategyInnertubeWEB],
        ['innertube-tv',   strategyInnertubeTV],
    ]) {
        try {
            const r = await fn(videoId);
            console.log(`[subtitles] OK ${r.source} videoId=${videoId} lang=${r.lang} items=${r.items.length}`);
            return res.status(200).json({
                subtitles: format(r.items), source: r.source,
                lang: r.lang, isAutoGenerated: r.auto, itemCount: r.items.length
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
