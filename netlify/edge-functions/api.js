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
