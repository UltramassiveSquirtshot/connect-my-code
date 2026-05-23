// api/fetch-subtitles.js
export const config = { maxDuration: 30 };

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const DATA_API_KEY  = process.env.YOUTUBE_API_KEY;
const SUPADATA_KEY  = process.env.SUPADATA_API_KEY;

function extractVideoId(input) {
    const p = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const r of p) { const m = input?.match(r); if (m) return m[1]; }
    return null;
}

function decodeUrl(u) { return (u||'').replace(/\\u0026/g,'&').replace(/\\u0027/g,"'"); }

// Parsa XML timedtext (srv3/ttml)
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

// Parsa WebVTT
function vttToItems(vtt) {
    const items = [];
    const blocks = vtt.split(/\n\n+/);
    for (const block of blocks) {
        const lines = block.trim().split('\n');
        const timeLine = lines.find(l => l.includes('-->'));
        if (!timeLine) continue;
        const [start] = timeLine.split('-->');
        const hms = start.trim().replace(',', '.');
        const parts = hms.split(':');
        let seconds = 0;
        if (parts.length === 3) seconds = +parts[0]*3600 + +parts[1]*60 + parseFloat(parts[2]);
        else if (parts.length === 2) seconds = +parts[0]*60 + parseFloat(parts[1]);
        const text = lines.slice(lines.indexOf(timeLine)+1).join(' ')
            .replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&#39;/g,"'").trim();
        if (text) items.push({ text, offset: Math.round(seconds*1000) });
    }
    return items;
}

// Parsa JSON3 (formato YouTube per auto-generated)
function json3ToItems(body) {
    try {
        const d = JSON.parse(body);
        const events = d?.events || [];
        return events
            .filter(e => e.segs)
            .map(e => ({
                offset: e.tStartMs || 0,
                text: e.segs.map(s => s.utf8 || '').join('').replace(/\n/g,' ').trim()
            }))
            .filter(i => i.text);
    } catch { return []; }
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

async function fetchUrl(url) {
    return fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
        }
    });
}

// ── 1. Supadata ───────────────────────────────────────────────────────────────
async function strategySupadata(videoId) {
    if (!SUPADATA_KEY) throw new Error('SUPADATA_API_KEY non impostata — registrati gratis su supadata.ai');
    const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&lang=en`;
    const res = await fetch(url, { headers: { 'x-api-key': SUPADATA_KEY, 'Accept': 'application/json' } });
    if (res.status === 404) throw new Error('Supadata: transcript non trovato');
    if (res.status === 402) throw new Error('Supadata: quota esaurita');
    if (!res.ok) { const b = await res.text(); throw new Error(`Supadata HTTP ${res.status}: ${b.slice(0,80)}`); }
    const data = await res.json();
    const chunks = data.content || data.transcript || [];
    if (!chunks.length) throw new Error('Supadata: nessun chunk');
    const items = chunks.map(c => ({ text:(c.text||c.content||'').trim(), offset:(c.offset??c.start??0) })).filter(i=>i.text);
    if (!items.length) throw new Error('Supadata: items vuoti');
    return { items, lang: data.lang||'en', auto:false, source:'supadata' };
}

// ── 2. YouTube Data API v3 + timedtext (tutti i formati) ─────────────────────
async function strategyDataAPI(videoId) {
    if (!DATA_API_KEY) throw new Error('YOUTUBE_API_KEY non impostata');
    const listRes = await fetch(`https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}&key=${DATA_API_KEY}`);
    const listData = await listRes.json();
    if (listData.error) throw new Error(`captions.list ${listData.error.code}: ${listData.error.message}`);
    if (!listData.items?.length) throw new Error('captions.list: nessuna traccia');

    const t = listData.items.find(i => i.snippet?.language?.startsWith('en') && i.snippet?.trackKind !== 'asr')
           || listData.items.find(i => i.snippet?.language?.startsWith('en'))
           || listData.items[0];

    const lang = t.snippet?.language || 'en';
    const isAuto = t.snippet?.trackKind === 'asr';
    const trackName = t.snippet?.name || '';

    console.log(`[data-api] track: lang=${lang} kind=${t.snippet?.trackKind} name="${trackName}"`);

    // Prova tutti i formati in cascata
    const formats = [
        { fmt: 'json3', parse: json3ToItems },
        { fmt: 'srv3',  parse: xmlToItems },
        { fmt: 'vtt',   parse: vttToItems },
        { fmt: 'ttml',  parse: xmlToItems },
    ];

    for (const { fmt, parse } of formats) {
        const params = new URLSearchParams({ v: videoId, lang, fmt });
        if (isAuto) params.set('kind', 'asr');
        if (trackName) params.set('name', trackName);

        const timedUrl = `https://www.youtube.com/api/timedtext?${params}`;
        const res = await fetchUrl(timedUrl);
        const body = await res.text();

        console.log(`[data-api] fmt=${fmt} status=${res.status} bodyLen=${body.length} preview="${body.slice(0,60).replace(/\n/g,' ')}"`);

        if (!res.ok || !body.trim()) continue;
        const items = parse(body);
        if (items.length) return { items, lang, auto:isAuto, source:`data-api-${fmt}` };
    }

    throw new Error('data-api: nessun formato ha restituito contenuto');
}

// ── 3. InnerTube WEB ─────────────────────────────────────────────────────────
async function strategyInnertubeWEB(videoId) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        { method:'POST', headers:{'Content-Type':'application/json','User-Agent':UA,'X-Youtube-Client-Name':'1','X-Youtube-Client-Version':'2.20240313.05.00','Origin':'https://www.youtube.com','Referer':`https://www.youtube.com/watch?v=${videoId}`,'Cookie':'SOCS=CAI; CONSENT=YES+cb'},
          body: JSON.stringify({ videoId, context:{ client:{clientName:'WEB',clientVersion:'2.20240313.05.00',hl:'en',gl:'US'} } }) }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`InnerTube WEB HTTP ${res.status}: ${text.slice(0,100)}`);
    let data; try { data=JSON.parse(text); } catch { throw new Error('InnerTube WEB: non-JSON'); }
    const st = data?.playabilityStatus?.status;
    if (st && st!=='OK') throw new Error(`InnerTube WEB: ${data?.playabilityStatus?.reason||st}`);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('InnerTube WEB: nessuna traccia');
    const track = pickTrack(tracks);
    let url = decodeUrl(track.baseUrl||'');
    if (!url.includes('fmt=')) url+='&fmt=srv3';
    const sr = await fetchUrl(url);
    if (!sr.ok) throw new Error(`InnerTube WEB: download XML HTTP ${sr.status}`);
    const xml = await sr.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error('InnerTube WEB: XML vuoto');
    return { items, lang:track.languageCode, auto:track.kind==='asr', source:'innertube-web' };
}

// ── 4. InnerTube TV ──────────────────────────────────────────────────────────
async function strategyInnertubeTV(videoId) {
    const UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1';
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        { method:'POST', headers:{'Content-Type':'application/json','User-Agent':UA,'X-Youtube-Client-Name':'7','X-Youtube-Client-Version':'7.20240101.20.00','Origin':'https://www.youtube.com','Cookie':'SOCS=CAI; CONSENT=YES+cb'},
          body: JSON.stringify({ videoId, context:{ client:{clientName:'TVHTML5',clientVersion:'7.20240101.20.00',hl:'en',gl:'US'} } }) }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`InnerTube TV HTTP ${res.status}: ${text.slice(0,100)}`);
    let data; try { data=JSON.parse(text); } catch { throw new Error('InnerTube TV: non-JSON'); }
    const st = data?.playabilityStatus?.status;
    if (st && st!=='OK') throw new Error(`InnerTube TV: ${data?.playabilityStatus?.reason||st}`);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('InnerTube TV: nessuna traccia');
    const track = pickTrack(tracks);
    let url = decodeUrl(track.baseUrl||'');
    if (!url.includes('fmt=')) url+='&fmt=srv3';
    const sr = await fetchUrl(url);
    if (!sr.ok) throw new Error(`InnerTube TV: download HTTP ${sr.status}`);
    const xml = await sr.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error('InnerTube TV: XML vuoto');
    return { items, lang:track.languageCode, auto:track.kind==='asr', source:'innertube-tv' };
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const videoId = extractVideoId(req.query.videoId);
    if (!videoId) return res.status(400).json({ message:'videoId non valido o mancante' });

    const errors = [];
    for (const [name, fn] of [
        ['supadata',      strategySupadata],
        ['data-api',      strategyDataAPI],
        ['innertube-web', strategyInnertubeWEB],
        ['innertube-tv',  strategyInnertubeTV],
    ]) {
        try {
            const r = await fn(videoId);
            console.log(`[subtitles] OK ${r.source} ${videoId} lang=${r.lang} items=${r.items.length}`);
            return res.status(200).json({ subtitles:format(r.items), source:r.source, lang:r.lang, isAutoGenerated:r.auto, itemCount:r.items.length });
        } catch(e) {
            const msg = e.message.slice(0,120);
            errors.push(`${name}: ${msg}`);
            console.error(`[subtitles] FAIL ${name} ${videoId}: ${msg}`);
        }
    }

    console.error(`[subtitles] ALL_FAILED ${videoId}: ${JSON.stringify(errors)}`);
    return res.status(502).json({ message:'Impossibile recuperare i sottotitoli.', videoId, errors });
}
