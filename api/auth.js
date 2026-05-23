// api/auth.js
// STEP 1 del flusso OAuth2 — visita /api/auth per autorizzare l'app una volta sola
// Dopo l'autorizzazione riceverai il GOOGLE_REFRESH_TOKEN da impostare su Vercel.
//
// PREREQUISITO: In Google Console → OAuth 2.0 → Redirect URI aggiungi:
//   https://connect-my-code.vercel.app/api/auth/callback

import { SCOPES } from '../lib/auth.js';

export default function handler(req, res) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        return res.status(500).send('GOOGLE_CLIENT_ID non impostato su Vercel.');
    }

    const redirectUri = `${process.env.SITE_URL || 'https://connect-my-code.vercel.app'}/api/auth/callback`;

    const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: 'code',
        scope:         SCOPES,
        access_type:   'offline',   // ottieni il refresh_token
        prompt:        'consent',   // forza il consent per ottenere sempre il refresh_token
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
