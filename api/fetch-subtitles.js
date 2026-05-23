// api/fetch-subtitles.js
// Due tipi di key completamente diversi:
//   INNERTUBE_KEY  = chiave hardcoded interna YouTube, usata da yt-dlp
//                   → endpoint: /youtubei/v1/player
//   YOUTUBE_API_KEY = YouTube Data API v3 key dell'utente (Google Console)
//                   → endpoint: googleapis.com/youtube/v3/captions

export const config = { maxDuration: 30 };

// Chiave InnerTube hardcoded — non è segreta, è embedded nel JS di YouTube
// È quella che usa yt-dlp e tutti i client alternativi
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// YouTube Data API v3 key — quella dell'utente da Google Console
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

// Sceglie la traccia migliore: en nativo > en auto-generated > prima disponibile
function pickTrack(tracks) {
    return (
        tracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
        tracks.find(t => t.languageCode?.startsWith('en')) ||
        tracks[0]
    );
}

async function downloadXml(url, ua) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': ua || 'Mozilla/5.0',
            'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
        }
    });
    if (!res.ok) throw new Error(`download XML HTTP ${res.status}`);
    const xml = await res.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error('XML vuoto o formato non riconosciuto');
    return items;
}

// ── Strategia 1: InnerTube WEB con chiave hardcoded ──────────────────────────
// Questa è la stessa chiave usata da yt-dlp. Non è segreta — è embedded
// nel sorgente JS di youtube.com. Autentica la richiesta come client WEB
// legittimo → nessun bot detection da IP datacenter.
async function innertubeWEB(videoId) {
    const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': WEB_UA,
                'X-Youtube-Client-Name': '1',
                'X-Youtube-Client-Version': '2.20240313.05.00',
                'Origin': 'https://www.youtube.com',
                'Referer': `https://www.youtube.com/watch?v=${videoId}`,
                'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
            },
            body: JSON.stringify({
                videoId,
                context: {
                    client: {
                        clientName: 'WEB',
                        clientVersion: '2.20240313.05.00',
                        hl: 'en', gl: 'US',
                        timeZone: 'UTC', utcOffsetMinutes: 0
                    }
                }
            })
        }
    );

    const text = await res.text();
    if (!res.ok) throw new Error(`InnerTube WEB HTTP ${res.status}: ${text.slice(0,150)}`);
    let data; try { data = JSON.parse(text); } catch { throw new Error('InnerTube WEB: non-JSON'); }

    const status = data?.playabilityStatus?.status;
    if (status && status !== 'OK') throw new Error(`InnerTube WEB: ${data?.playabilityStatus?.reason || status}`);

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('InnerTube WEB: nessuna traccia sottotitoli');

    const track = pickTrack(tracks);
    let url = decodeUrl(track.baseUrl || '');
    if (!url.includes('fmt=')) url += '&fmt=srv3';

    const items = await downloadXml(url, WEB_UA);
    return { items, lang: track.languageCode, auto: track.kind === 'asr', source: 'innertube-web' };
}

// ── Strategia 2: Data API v3 captions.list + timedtext ───────────────────────
// Usa la YouTube Data API v3 key dell'utente per ottenere l'elenco ufficiale
// delle tracce, poi costruisce l'URL timedtext per scaricare il contenuto.
// Il timedtext endpoint risponde a video con CC pubblici senza OAuth.
async function captionsListAPI(videoId) {
    if (!DATA_API_KEY) throw new Error('YOUTUBE_API_KEY non configurata');

    const listRes = await fetch(
        `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}&key=${DATA_API_KEY}`
    );
    const listData = await listRes.json();

    if (listData.error) {
        throw new Error(`captions.list error ${listData.error.code}: ${listData.error.message}`);
    }
    if (!listData.items?.length) throw new Error('captions.list: nessuna traccia disponibile');

    // Trova la traccia migliore dalla lista ufficiale
    const items = listData.items;
    const track = (
        items.find(i => i.snippet?.language?.startsWith('en') && i.snippet?.trackKind !== 'asr') ||
        items.find(i => i.snippet?.language?.startsWith('en')) ||
        items[0]
    );

    const lang = track.snippet?.language || 'en';
    const isAuto = track.snippet?.trackKind === 'asr';

    // Costruisci URL timedtext (funziona per video con CC o auto-generated pubblici)
    const params = new URLSearchParams({ v: videoId, lang, fmt: 'srv3' });
    if (isAuto) params.set('kind', 'asr');

    const xmlItems = await downloadXml(
        `https://www.youtube.com/api/timedtext?${params}`,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    );
    return { items: xmlItems, lang, auto: isAuto, source: 'data-api-timedtext' };
}

// ── Strategia 3: InnerTube TVHTML5 (client TV, meno restrizioni) ─────────────
async function innertubeTV(videoId) {
    const TV_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1';
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': TV_UA,
                'X-Youtube-Client-Name': '7',
                'X-Youtube-Client-Version': '7.20240101.20.00',
                'Origin': 'https://www.youtube.com',
                'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
            },
            body: JSON.stringify({
                videoId,
                context: {
                    client: { clientName:'TVHTML5', clientVersion:'7.20240101.20.00', hl:'en', gl:'US' }
                }
            })
        }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`InnerTube TV HTTP ${res.status}: ${text.slice(0,150)}`);
    let data; try { data = JSON.parse(text); } catch { throw new Error('InnerTube TV: non-JSON'); }

    const status = data?.playabilityStatus?.status;
    if (status && status !== 'OK') throw new Error(`InnerTube TV: ${data?.playabilityStatus?.reason || status}`);

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('InnerTube TV: nessuna traccia');

    const track = pickTrack(tracks);
    let url = decodeUrl(track.baseUrl || '');
    if (!url.includes('fmt=')) url += '&fmt=srv3';

    const items = await downloadXml(url, TV_UA);
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
    const strategies = [
        ['innertube-web',       () => innertubeWEB(videoId)],
        ['data-api-timedtext',  () => captionsListAPI(videoId)],
        ['innertube-tv',        () => innertubeTV(videoId)],
    ];

    for (const [name, fn] of strategies) {
        try {
            const r = await fn();
            console.log(`[subtitles] OK ${r.source}: ${videoId} lang=${r.lang} items=${r.items.length}`);
            return res.status(200).json({
                subtitles: format(r.items),
                source: r.source, lang: r.lang,
                isAutoGenerated: r.auto, itemCount: r.items.length
            });
        } catch(e) {
            const msg = e.message.slice(0, 120);
            errors.push(`${name}: ${msg}`);
            console.error(`[subtitles] FAIL ${name}: ${msg}`);
        }
    }

    console.error(`[subtitles] ALL FAILED ${videoId}: ${JSON.stringify(errors)}`);
    return res.status(502).json({ message: 'Impossibile recuperare i sottotitoli.', videoId, errors });
}
