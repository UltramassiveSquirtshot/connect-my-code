// api/records/[id]/download.js — download trascrizione o riassunto
import { isDbEnabled, getTranscriptById } from '../../../lib/db.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id mancante' });
    if (!isDbEnabled()) return res.status(503).json({ error: 'Database non configurato' });

    try {
        const record = await getTranscriptById(Number(id));
        if (!record) return res.status(404).json({ error: 'Record non trovato' });

        const type = req.query.type === 'summary' ? 'summary' : 'transcript';
        const content = type === 'summary' ? record.summary : record.transcript;
        const suffix = type === 'summary' ? 'riassunto' : 'trascrizione';

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="youtube_${record.video_id}_${suffix}.txt"`);
        return res.status(200).send(content);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
