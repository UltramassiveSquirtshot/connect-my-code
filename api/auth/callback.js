// api/auth/callback.js
// STEP 2 del flusso OAuth2 — Google reindirizza qui dopo l'autorizzazione
// Scambia il code con i token e mostra il GOOGLE_REFRESH_TOKEN da copiare

export default async function handler(req, res) {
    const { code, error } = req.query;

    if (error) {
        return res.status(400).send(`Autorizzazione negata: ${error}`);
    }
    if (!code) {
        return res.status(400).send('Parametro "code" mancante. Ricomincia da /api/auth');
    }

    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri  = `${process.env.SITE_URL || 'https://connect-my-code.vercel.app'}/api/auth/callback`;

    if (!clientId || !clientSecret) {
        return res.status(500).send('GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET non impostati su Vercel.');
    }

    // Scambia il code per access_token + refresh_token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id:     clientId,
            client_secret: clientSecret,
            redirect_uri:  redirectUri,
            grant_type:    'authorization_code',
        }).toString(),
    });

    const tokens = await tokenRes.json();

    if (!tokenRes.ok || !tokens.refresh_token) {
        const msg = tokens.error_description || tokens.error || `HTTP ${tokenRes.status}`;
        return res.status(500).send(`
            <h2>Errore nello scambio del token</h2>
            <p>${msg}</p>
            <p>Riprova da <a href="/api/auth">/api/auth</a></p>
        `);
    }

    // Mostra le istruzioni per configurare Vercel
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>OAuth2 — Token ottenuto</title>
  <style>
    body { font-family: monospace; max-width: 800px; margin: 40px auto; padding: 20px; background: #0f0f0f; color: #e0e0e0; }
    h2 { color: #4caf50; }
    .token-box { background: #1a1a1a; border: 1px solid #333; padding: 16px; border-radius: 8px; word-break: break-all; margin: 12px 0; }
    .copy-btn { background: #4caf50; color: #000; border: none; padding: 8px 16px; cursor: pointer; border-radius: 4px; font-family: monospace; }
    .step { margin: 20px 0; padding: 16px; border-left: 3px solid #4caf50; background: #111; }
    code { background: #222; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <h2>✅ Autorizzazione completata!</h2>
  <p>Copia il valore qui sotto e aggiungilo su Vercel come variabile d'ambiente.</p>

  <div class="step">
    <strong>GOOGLE_REFRESH_TOKEN</strong>
    <div class="token-box" id="token">${tokens.refresh_token}</div>
    <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('token').textContent).then(()=>this.textContent='Copiato!')">Copia</button>
  </div>

  <div class="step">
    <strong>Passi successivi:</strong>
    <ol>
      <li>Vai su <strong>Vercel → Project → Settings → Environment Variables</strong></li>
      <li>Aggiungi: <code>GOOGLE_REFRESH_TOKEN</code> = il valore sopra</li>
      <li>Clicca <strong>Redeploy</strong> (o fai un push su GitHub)</li>
      <li>I sottotitoli funzioneranno tramite OAuth2 autenticato</li>
    </ol>
  </div>

  <p style="color:#888; font-size:0.85em;">
    Il refresh token non scade (a meno che non revochi l'accesso da Google → Sicurezza → App con accesso).<br>
    Puoi chiudere questa pagina dopo aver copiato il token.
  </p>
</body>
</html>`);
}
