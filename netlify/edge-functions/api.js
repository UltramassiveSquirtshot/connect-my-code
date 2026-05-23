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

// ─── YouTube subtitle fetcher (direct YouTube API — no third-party services) ───────────────────

async function fetchYouTubeSubtitles(videoId) {
  // Step 1: Get player response to find available caption tracks
  const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    }
  });

  if (!watchRes.ok) throw new Error(`YouTube non raggiungibile: ${watchRes.status}`);

  const html = await watchRes.text();

  // Extract ytInitialPlayerResponse
  const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});\s*<\/script>/);
  if (!playerMatch) throw new Error('Nessun sottotitolo disponibile per questo video');

  let playerResponse;
  try {
    playerResponse = JSON.parse(playerMatch[1]);
  } catch (e) {
    throw new Error('Errore nel parsing della risposta di YouTube');
  }

  const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks || captionTracks.length === 0) {
    throw new Error('Nessun sottotitolo disponibile per questo video');
  }

  // Pick best track: Italian > English > first available
  const track =
    captionTracks.find(t => t.languageCode === 'it') ||
    captionTracks.find(t => t.languageCode === 'en') ||
    captionTracks[0];

  if (!track) throw new Error('Nessuna traccia sottotitoli trovata');

  // Step 2: Build timedtext URL and fetch subtitles
  // The baseUrl from captionTracks already contains the signed URL to timedtext
  let timedTextUrl = track.baseUrl;
  if (!timedTextUrl) {
    // Fallback: build URL manually
    timedTextUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${track.languageCode}&fmt=srv3`;
  }

  // Decode unicode escapes in URL
  timedTextUrl = timedTextUrl.replace(/\\u0026/g, '&').replace(/\\u0027/g, "'");

  const subRes = await fetch(timedTextUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    }
  });

  if (!subRes.ok) throw new Error(`Errore nel download sottotitoli: ${subRes.status}`);

  const xml = await subRes.text();

  // Parse SRV3 XML format (YouTube's native subtitle format)
  const subtitles = parseSrv3Xml(xml);

  if (!subtitles || subtitles.trim().length === 0) {
    throw new Error('Sottotitoli vuoti dopo il parsing');
  }

  return subtitles;
}

// Parse YouTube SRV3 XML subtitle format
function parseSrv3Xml(xml) {
  // Remove XML tags but preserve text content
  // SRV3 format: <text start="..." dur="...">Subtitle text</text>
  // With possible <s> segments for styling (which we strip)

  const textMatches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];

  if (textMatches.length === 0) {
    // Fallback: strip all XML tags and decode entities
    return xml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const lines = textMatches.map(match => {
    let text = match[1];
    // Remove internal <s> styling tags
    text = text.replace(/<s[^>]*>/g, '').replace(/<\/s>/g, '');
    // Decode XML entities
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n/g, ' ')
      .trim();
    return text;
  }).filter(line => line.length > 0);

  return lines.join(' ');
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