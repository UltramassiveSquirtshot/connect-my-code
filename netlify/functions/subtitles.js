const { YoutubeTranscript } = require('youtube-transcript');

exports.handler = async (event, context) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  const videoId = event.queryStringParameters?.videoId;
  if (!videoId) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'VideoId mancante' })
    };
  }

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'VideoId non valido' })
    };
  }

  try {
    // Fetch transcript using youtube-transcript npm package
    const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId, {
      lang: 'it'  // Try Italian first
    }).catch(() => 
      // Fallback to English if Italian not available
      YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' })
    ).catch(() =>
      // Fallback to any available language
      YoutubeTranscript.fetchTranscript(videoId)
    );

    if (!transcriptItems || transcriptItems.length === 0) {
      return {
        statusCode: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Nessun sottotitolo disponibile per questo video' })
      };
    }

    // Join all transcript pieces into single text
    const subtitles = transcriptItems
      .map(item => item.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtitles })
    };

  } catch (error) {
    console.error('Transcript error:', error.message);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: error.message || 'Errore nel recupero sottotitoli' })
    };
  }
};