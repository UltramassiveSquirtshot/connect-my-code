// api/fetch-subtitles.js
//
// Strategie in ordine:
// 1. Page scrape  — estrae ytInitialPlayerResponse dalla pagina YT, URL firmati
// 2. Supadata     — servizio terzo con proxy propri (richiede SUPADATA_API_KEY)
// 3. Data API     — captions.list + timedtext (spesso vuoto da IP Vercel)
// 4. InnerTube WEB/TV — fallback hardcoded (spesso bloccato da IP Vercel)

export const config = { maxDuration: 30 };

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const DATA_API_KEY  = process.env.YOUTUBE_API_KEY;
const SUPADATA_KEY  = process.env.SUPADATA_API_KEY;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
    'User-Agent': BROWSER_UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
};

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

function json3ToItems(body) {
    try {
        const d = JSON.parse(body);
        return (d?.events || [])
            .filter(e => e.segs)
            .map(e => ({ offset: e.tStartMs||0, text: e.segs.map(s=>s.utf8||'').join('').replace(/\n/g,' ').trim() }))
            .filter(i => i.text);
    } catch { return []; }
}

function vttToItems(vtt) {
    const items = [];
    for (const block of vtt.split(/\n\n+/)) {
        const lines = block.trim().split('\n');
        const tl = lines.find(l => l.includes('-->'));
        if (!tl) continue;
        const parts = tl.split('-->')[0].trim().replace(',','.').split(':');
        const s = parts.length===3 ? +parts[0]*3600 + +parts[1]*60 + parseFloat(parts[2])
                                   : +parts[0]*60 + parseFloat(parts[1]);
        const text = lines.slice(lines.indexOf(tl)+1).join(' ').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&#39;/g,"'").trim();
        if (text) items.push({ text, offset: Math.round(s*1000) });
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
    return tracks.find(t => t.languageCode?.startsWith('en') && !t.kind)
        || tracks.find(t => t.languageCode?.startsWith('en'))
        || tracks[0];
}

// ── 1. Page scrape ────────────────────────────────────────────────────────────
// Fetches the YouTube watch page, extracts ytInitialPlayerResponse which contains
// signed timedtext URLs that work without OAuth or API key.
async function strategyPageScrape(videoId) {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: BROWSER_HEADERS,
    });
    if (!pageRes.ok) throw new Error(`Page fetch HTTP ${pageRes.status}`);
    const html = await pageRes.text();

    const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (!match) {
        const isConsent = html.includes('consent.youtube.com') || html.includes('CONSENT');
        throw new Error(`ytInitialPlayerResponse non trovato${isConsent ? ' (consent page)' : ''}`);
    }

    let player;
    try { player = JSON.parse(match[1]); } catch { throw new Error('ytInitialPlayerResponse: JSON non valido'); }

    const st = player?.playabilityStatus?.status;
    if (st && st !== 'OK') throw new Error(`Page: ${player?.playabilityStatus?.reason || st}`);

    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('Page: nessuna traccia sottotitoli');

    const track = pickTrack(tracks);
    let url = decodeUrl(track.baseUrl || '') + '&fmt=json3';

    const sr = await fetch(url, {
        headers: { ...BROWSER_HEADERS, 'Referer': `https://www.youtube.com/watch?v=${videoId}` },
    });
    if (!sr.ok) throw new Error(`Page: download HTTP ${sr.status}`);
    const body = await sr.text();
    const items = json3ToItems(body);
    if (!items.length) throw new Error('Page: nessun item (body vuoto o non JSON3)');

    return { items, lang: track.languageCode, auto: track.kind === 'asr', source: 'page-scrape' };
}

// ── 2. Supadata ───────────────────────────────────────────────────────────────
async function strategySupadata(videoId) {
    if (!SUPADATA_KEY) throw new Error('SUPADATA_API_KEY non impostata');
    const res = await fetch(`https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&lang=en`,
        { headers: { 'x-api-key': SUPADATA_KEY, 'Accept': 'application/json' } });
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

// ── 3. YouTube Data API v3 + timedtext ───────────────────────────────────────
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
    for (const { fmt, parse } of [
        { fmt:'json3', parse:json3ToItems },
        { fmt:'srv3',  parse:xmlToItems },
        { fmt:'vtt',   parse:vttToItems },
    ]) {
        const params = new URLSearchParams({ v:videoId, lang, fmt });
        if (isAuto) params.set('kind','asr');
        if (t.snippet?.name) params.set('name', t.snippet.name);
        const sr = await fetch(`https://www.youtube.com/api/timedtext?${params}`, {
            headers: { ...BROWSER_HEADERS },
        });
        const body = await sr.text();
        console.log(`[data-api] fmt=${fmt} status=${sr.status} len=${body.length}`);
        if (sr.ok && body.trim()) {
            const items = parse(body);
            if (items.length) return { items, lang, auto:isAuto, source:`data-api-${fmt}` };
        }
    }
    throw new Error('data-api: nessun formato ha restituito contenuto');
}

// ── 4+5. InnerTube WEB/TV (fallback) ─────────────────────────────────────────
async function strategyInnertube(videoId, clientName) {
    const configs = {
        WEB:     { num:'1', ver:'2.20240313.05.00', ua: BROWSER_UA },
        TVHTML5: { num:'7', ver:'7.20240101.20.00', ua:'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1' },
    };
    const c = configs[clientName];
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        { method:'POST', headers:{'Content-Type':'application/json','User-Agent':c.ua,'X-Youtube-Client-Name':c.num,'X-Youtube-Client-Version':c.ver,'Origin':'https://www.youtube.com','Cookie':'SOCS=CAI; CONSENT=YES+cb'},
          body: JSON.stringify({ videoId, context:{ client:{clientName, clientVersion:c.ver, hl:'en', gl:'US'} } }) }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`InnerTube ${clientName} HTTP ${res.status}: ${text.slice(0,100)}`);
    let data; try { data=JSON.parse(text); } catch { throw new Error(`InnerTube ${clientName}: non-JSON`); }
    const st = data?.playabilityStatus?.status;
    if (st && st!=='OK') throw new Error(`InnerTube ${clientName}: ${data?.playabilityStatus?.reason||st}`);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error(`InnerTube ${clientName}: nessuna traccia`);
    const track = pickTrack(tracks);
    let url = decodeUrl(track.baseUrl||'');
    if (!url.includes('fmt=')) url+='&fmt=srv3';
    const sr = await fetch(url, { headers: { ...BROWSER_HEADERS, 'User-Agent':c.ua } });
    if (!sr.ok) throw new Error(`InnerTube ${clientName}: download HTTP ${sr.status}`);
    const xml = await sr.text();
    const items = xmlToItems(xml);
    if (!items.length) throw new Error(`InnerTube ${clientName}: XML vuoto`);
    return { items, lang:track.languageCode, auto:track.kind==='asr', source:`innertube-${clientName.toLowerCase()}` };
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
        ['page-scrape',      () => strategyPageScrape(videoId)],
        ['supadata',         () => strategySupadata(videoId)],
        ['data-api',         () => strategyDataAPI(videoId)],
        ['innertube-web',    () => strategyInnertube(videoId, 'WEB')],
        ['innertube-tv',     () => strategyInnertube(videoId, 'TVHTML5')],
    ]) {
        try {
            const r = await fn();
            console.log(`[subtitles] OK ${r.source} ${videoId} lang=${r.lang} items=${r.items.length}`);
            return res.status(200).json({ subtitles:format(r.items), source:r.source, lang:r.lang, isAutoGenerated:r.auto, itemCount:r.items.length });
        } catch(e) {
            const msg = e.message.slice(0,200);
            errors.push(`${name}: ${msg}`);
            console.error(`[subtitles] FAIL ${name} ${videoId}: ${msg}`);
        }
    }
    console.error(`[subtitles] ALL_FAILED ${videoId}: ${JSON.stringify(errors)}`);
    return res.status(502).json({ message:'Impossibile recuperare i sottotitoli.', videoId, errors });
}
