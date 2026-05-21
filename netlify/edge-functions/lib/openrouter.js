export function createSummaryPrompt(subtitles, length = 'medium', style = 'detailed') {
    let lengthInstruction = 'Crea una sintesi di media lunghezza (4-5 paragrafi)';
    if (length === 'short') lengthInstruction = 'Crea una sintesi breve (2-3 paragrafi)';
    if (length === 'long') lengthInstruction = 'Crea una sintesi dettagliata (6-8 paragrafi)';

    let styleInstruction = 'in stile dettagliato';
    if (style === 'concise') styleInstruction = 'in stile conciso e diretto';
    if (style === 'bullet') styleInstruction = 'organizzata in punti elenco';

    return `Di seguito sono riportati i sottotitoli di un video YouTube. ${lengthInstruction} ${styleInstruction}. La sintesi deve essere in italiano.

SOTTOTITOLI:
${subtitles}`;
}

export async function callOpenRouter(prompt) {
    const apiKey = Netlify.env.get('OPENROUTER_API_KEY');
    if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY non configurata su Netlify.');
    }

    const model = Netlify.env.get('AI_MODEL') || 'google/gemini-2.0-pro-exp-02-05:free';

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [
                {
                    role: 'system',
                    content: 'Sei un assistente esperto nella sintesi di contenuti video.'
                },
                { role: 'user', content: prompt }
            ],
            max_tokens: 1500
        })
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenRouter error: ${err}`);
    }

    const data = await response.json();
    const summary = data?.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error('Risposta non valida da OpenRouter.');
    return summary;
}
