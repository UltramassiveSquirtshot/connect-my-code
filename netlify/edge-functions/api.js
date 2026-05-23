import { callOpenRouter, createSummaryPrompt } from './lib/openrouter.js';
import {
  isDbEnabled,
  saveSubtitles,
  getSubtitles,
  saveTranscript,
  getTranscriptById
} from './lib/db.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

function text(content, filename) {
  return new Response(content, {
    headers: {
      ...cors,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  });
}

// ─── YouTube subtitle fetcher (server-side, no CORS issues) ───────────────────

async function fetchYouTubeSubtitles(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    }
  });

  if (!res.ok) throw new Error(`YouTube non raggiungibile: ${res.status}`);

  const html = await res.text();

  // FIX: Extract captionTracks from ytInitialPlayerResponse instead of broken regex
  const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
  if (!playerMatch) throw new Error('Nessun sottotitolo disponibile per questo video');

  let playerResponse;
  try {
    playerResponse = JSON.parse(playerMatch[1]);
  } catch (e) {
    throw new Error('Errore nel parsing della risposta di YouTube');
  }

  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || !tracks.length) throw new Error('Nessun sottotitolo disponibile per questo video');

  const track =
    tracks.find(t => t.languageCode === 'it') ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks[0];

  if (!track) throw new Error('Nessuna traccia sottotitoli trovata');

  const baseUrl = track.baseUrl.replace(/\\u0026/g, '&');
  const subRes = await fetch(baseUrl);
  if (!subRes.ok) throw new Error(`Errore nel download sottotitoli: ${subRes.status}`);

  const xml = await subRes.text();

  // FIX: Properly decode XML entities (was replacing entities with themselves)
  const subtitles = xml
    .replace(/<[^>]+>/g, ' ')       // Remove XML tags
    .replace(/&amp;/g, '&')          // Decode &amp; → &
    .replace(/&lt;/g, '<')           // Decode &lt; → <
    .replace(/&gt;/g, '>')           // Decode &gt; → >
    .replace(/&#39;/g, "'")          // Decode &#39; → '
    .replace(/&apos;/g, "'")         // Decode &apos; → '
    .replace(/&quot;/g, '"')         // Decode &quot; → "
    .replace(/\s+/g, ' ')            // Collapse whitespace
    .trim();

  if (!subtitles) throw new Error('Sottotitoli vuoti dopo il parsing');

  return subtitles;
}

async function handleFetchSubtitles(url) {
  const videoId = url.searchParams.get('videoId');
  if (!videoId) return json({ message: 'VideoId mancante' }, 400);

  const subtitles = await fetchYouTubeSubtitles(videoId);
  return json({ subtitles });
}

// ─── Existing handlers ────────────────────────────────────────────────────────

async function handleSummarize(request) {
  const { subtitles, length = 'medium', style = 'detailed', videoId } = await request.json();

  if (!subtitles?.trim()) {
    return json({ message: 'Sottotitoli mancanti o vuoti' }, 400);
  }

  const summary = await callOpenRouter(createSummaryPrompt(subtitles, length, style));

  if (videoId && isDbEnabled()) {
    const saved = await saveTranscript({
      videoId,
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
      transcript: subtitles,
      summary
    });
    return json({ summary, recordId: saved.id, saved: true });
  }

  return json({ summary, saved: false });
}

async function handleSubtitlesGet(url) {
  const videoId = url.searchParams.get('videoId');
  if (!videoId) return json({ message: 'VideoId mancante' }, 400);

  if (!isDbEnabled()) {
    return json({ message: 'Cache sottotitoli non disponibile (DB non configurato)' }, 404);
  }

  const subtitles = await getSubtitles(videoId);
  if (!subtitles) return json({ message: 'Sottotitoli non trovati' }, 404);
  return json({ subtitles });
}

async function handleSubtitlesPost(request) {
  const { videoId, subtitles } = await request.json();
  if (!videoId || !subtitles) {
    return json({ message: 'VideoId o sottotitoli mancanti' }, 400);
  }

  if (isDbEnabled()) {
    await saveSubtitles(videoId, subtitles);
  }

  return json({ success: true, persisted: isDbEnabled() });
}

async function handleDownload(url) {
  const match = url.pathname.match(/^\/api\/records\/(\d+)\/download$/);
  if (!match) return json({ error: 'Percorso non valido' }, 404);

  if (!isDbEnabled()) {
    return json({ error: 'Database non configurato.' }, 503);
  }

  const type = url.searchParams.get('type') === 'summary' ? 'summary' : 'transcript';
  const record = await getTranscriptById(Number(match[1]));

  if (!record) return json({ error: 'Record non trovato.' }, 404);

  const content = type === 'summary' ? record.summary : record.transcript;
  const suffix = type === 'summary' ? 'riassunto' : 'trascrizione';
  return text(content, `youtube_${record.video_id}_${suffix}.txt`);
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(request.url);
  const { pathname } = url;

  try {
    if (pathname === '/api' && request.method === 'GET') {
      return json({
        status: 'online',
        name: 'YoutubeTranscriptor',
        db: isDbEnabled(),
        runtime: 'netlify-edge'
      });
    }

    if (pathname === '/api/fetch-subtitles' && request.method === 'GET') {
      return await handleFetchSubtitles(url);
    }

    if (pathname === '/api/summarize' && request.method === 'POST') {
      return await handleSummarize(request);
    }

    if (pathname === '/api/subtitles' && request.method === 'GET') {
      return await handleSubtitlesGet(url);
    }

    if (pathname === '/api/subtitles' && request.method === 'POST') {
      return await handleSubtitlesPost(request);
    }

    if (pathname.match(/^\/api\/records\/\d+\/download$/) && request.method === 'GET') {
      return await handleDownload(url);
    }

    return json({ error: 'Endpoint non trovato' }, 404);
  } catch (error) {
    console.error('API error:', error);
    return json({ message: error.message || 'Errore server' }, 500);
  }
};

export const config = {
  path: '/api/*'
};