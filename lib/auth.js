// lib/auth.js
// Gestione token OAuth2 Google — usato per autenticare le richieste InnerTube
// in modo che YouTube non triggeri il bot detection sugli IP Vercel/AWS.

const SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl',
].join(' ');

export function getOAuthConfig() {
    return {
        clientId:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    };
}

export function isOAuthConfigured() {
    const { clientId, clientSecret, refreshToken } = getOAuthConfig();
    return Boolean(clientId && clientSecret && refreshToken);
}

// Scambia il refresh token per un access token fresco
export async function getAccessToken() {
    const { clientId, clientSecret, refreshToken } = getOAuthConfig();
    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('OAuth2 non configurato: imposta GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id:     clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type:    'refresh_token',
        }).toString(),
    });

    const data = await res.json();
    if (!res.ok || !data.access_token) {
        throw new Error(`OAuth2 token refresh fallito: ${data.error_description || data.error || res.status}`);
    }
    return data.access_token;
}

export { SCOPES };
