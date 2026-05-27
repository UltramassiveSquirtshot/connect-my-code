export function createSummaryPrompt(subtitles, length = 'medium', style = 'detailed') {
    let lengthInstruction = 'Crea una sintesi di media lunghezza (4-5 paragrafi)';
    if (length === 'short') lengthInstruction = 'Crea una sintesi breve (2-3 paragrafi)';
    if (length === 'long') lengthInstruction = 'Crea una sintesi dettagliata (6-8 paragrafi)';

    let styleInstruction = 'in stile dettagliato';
    if (style === 'concise') styleInstruction = 'in stile conciso e diretto';
    if (style === 'bullet') styleInstruction = 'organizzata in punti elenco';

    return `Di seguito sono riportati i sottotitoli di un video YouTube. ${lengthInstruction} ${styleInstruction}. La sintesi deve essere in italiano.\n\nSOTTOTITOLI:\n${subtitles}`;
}

const FREE_MODELS = [
    'google/gemma-4-31b-it:free',
    'deepseek/deepseek-v4-flash:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
];

async function callModel(apiKey, model, prompt) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.SITE_URL || 'https://connect-my-code.vercel.app'
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'Sei un assistente esperto nella sintesi di contenuti video.' },
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

export async function callOpenRouter(prompt) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY non configurata.');

    // Se impostato env var usa solo quello, altrimenti prova i free in cascata
    if (process.env.AI_MODEL) {
        return callModel(apiKey, process.env.AI_MODEL, prompt);
    }

    let lastErr;
    for (const model of FREE_MODELS) {
        try {
            const result = await callModel(apiKey, model, prompt);
            console.log(`[openrouter] OK model=${model}`);
            return result;
        } catch(e) {
            console.error(`[openrouter] FAIL model=${model}: ${e.message.slice(0, 120)}`);
            lastErr = e;
        }
    }
    throw lastErr;
}
