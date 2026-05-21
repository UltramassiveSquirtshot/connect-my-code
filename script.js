/**
 * YouTube Gemini Summarizer
 * 
 * Questo script gestisce l'estrazione dei sottotitoli da video YouTube
 * e la generazione di sintesi tramite AI utilizzando OpenRouter con Gemini.
 */

document.addEventListener('DOMContentLoaded', () => {
// Elementi DOM
const form = document.getElementById('youtube-form');
const urlInput = document.getElementById('youtube-url');
const extractButton = document.getElementById('extract-button');
    const subtitlesContainer = document.getElementById('subtitles-container');
const videoContainer = document.getElementById('video-container');
const playerWrapper = document.getElementById('player-wrapper');
    const subtitlesText = document.getElementById('subtitles-text');
const summaryText = document.getElementById('summary-text');
const copyButton = document.getElementById('copy-button');
const downloadButton = document.getElementById('download-button');
    const copySummaryButton = document.getElementById('copy-summary-button');
    const downloadSummaryButton = document.getElementById('download-summary-button');
    const loader = document.getElementById('loader');
    const errorMessage = document.getElementById('error-message');
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    const summaryLength = document.getElementById('summary-length');
    const summaryStyle = document.getElementById('summary-style');
    const regenerateButton = document.getElementById('regenerate-button');

    // Configurazione backend
    const BACKEND_URL = window.location.origin; // Usa l'origine corrente per il backend

    // Variabili di stato
let currentVideoId = null;
let extractedSubtitles = null;

    // Inizializza l'applicazione
    init();

/**
 * Inizializza l'applicazione
 */
    function init() {
        // Nascondi inizialmente il contenitore dei sottotitoli
        subtitlesContainer.style.display = 'none';
        
        // Aggiungi event listener per l'input URL
        urlInput.addEventListener('input', debounce(handleUrlInput, 800));
        
        // Aggiungi event listener per il form
        form.addEventListener('submit', handleFormSubmit);
        
        // Aggiungi event listener per i pulsanti
        copyButton.addEventListener('click', () => handleCopyClick(subtitlesText));
        downloadButton.addEventListener('click', () => handleDownloadClick(subtitlesText, 'sottotitoli'));
        copySummaryButton.addEventListener('click', () => handleCopyClick(summaryText));
        downloadSummaryButton.addEventListener('click', () => handleDownloadClick(summaryText, 'sintesi'));
        regenerateButton.addEventListener('click', handleRegenerateClick);
        
        // Aggiungi event listener per le tabs
        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                const tabName = button.getAttribute('data-tab');
                switchTab(tabName);
            });
        });

        // Nascondi il selettore del modello AI poiché usiamo solo Gemini
        const modelSelector = document.getElementById('summary-model');
        if (modelSelector) {
            const modelGroup = modelSelector.closest('.option-group');
            if (modelGroup) {
                modelGroup.style.display = 'none';
            }
        }
    }

    /**
     * Cambia la tab attiva
     * @param {string} tabName - Nome della tab da attivare
     */
    function switchTab(tabName) {
        // Rimuovi la classe active da tutte le tabs
        tabButtons.forEach(button => button.classList.remove('active'));
        tabContents.forEach(content => content.classList.remove('active'));
        
        // Aggiungi la classe active alla tab selezionata
        document.querySelector(`.tab-button[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`${tabName}-tab`).classList.add('active');
    }

    /**
     * Gestisce l'input dell'URL
     */
    async function handleUrlInput() {
        const youtubeUrl = urlInput.value.trim();
        
        // Verifica che l'URL sia valido
        if (!isValidYoutubeUrl(youtubeUrl)) {
            // Se l'URL non è valido, nascondi il video
            videoContainer.style.display = 'none';
            return;
        }
        
        // Estrai l'ID del video
        const videoId = extractVideoId(youtubeUrl);
        if (!videoId) {
            return;
        }
        
        // Mostra il video
        embedYouTubeVideo(videoId);
}

/**
 * Gestisce l'invio del form
     * @param {Event} e - Evento submit
 */
async function handleFormSubmit(e) {
    e.preventDefault();
    
        // Ottieni l'URL del video
        const youtubeUrl = urlInput.value.trim();
        
        // Verifica che l'URL sia valido
        if (!isValidYoutubeUrl(youtubeUrl)) {
            showError('Per favore, inserisci un URL YouTube valido.');
            return;
        }
        
        // Estrai l'ID del video
        const videoId = extractVideoId(youtubeUrl);
        if (!videoId) {
            showError('Impossibile estrarre l\'ID del video dall\'URL fornito.');
            return;
        }
        
        // Salva l'ID del video corrente
        currentVideoId = videoId;
        
        // Mostra il loader e nascondi eventuali errori precedenti
        showLoader();
        hideError();
        
        try {
            // Mostra il video se non è già visibile
            if (videoContainer.style.display !== 'block') {
                embedYouTubeVideo(videoId);
            }
            
            // Ottieni i sottotitoli
            console.log('Tentativo di recupero sottotitoli per il video:', videoId);
            const subtitles = await fetchSubtitles(videoId);
            
            if (!subtitles || subtitles.trim() === '') {
                throw new Error('Non sono stati trovati sottotitoli per questo video o il formato non è supportato.');
            }
            
            extractedSubtitles = subtitles;
            
            // Mostra i sottotitoli
            displaySubtitles(subtitles);
            
            // Genera la sintesi
            console.log('Generazione sintesi per il video:', videoId);
            await generateSummary(subtitles);
    } catch (error) {
            console.error('Errore durante l\'elaborazione:', error);
            showError('Si è verificato un errore: ' + error.message);
        } finally {
            // Nascondi il loader
        hideLoader();
    }
}

/**
     * Gestisce il click sul pulsante di rigenerazione
     */
    async function handleRegenerateClick() {
        if (!extractedSubtitles) {
            showError('Non ci sono sottotitoli da elaborare. Estrai prima i sottotitoli da un video.');
            return;
        }
        
        showLoader();
        hideError();
        
        try {
            await generateSummary(extractedSubtitles);
    } catch (error) {
            console.error('Errore durante la rigenerazione della sintesi:', error);
            showError('Si è verificato un errore durante la rigenerazione: ' + error.message);
        } finally {
            hideLoader();
    }
}

/**
     * Genera una sintesi dei sottotitoli utilizzando l'API di OpenRouter
     * @param {string} subtitles - Testo dei sottotitoli
     */
    async function generateSummary(subtitles) {
        try {
            // Prepara i parametri per la richiesta
            const length = summaryLength.value;
            const style = summaryStyle.value;
            
            // Mostra un messaggio di caricamento
            summaryText.innerHTML = '<div class="placeholder-text">Generazione della sintesi in corso con Gemini...</div>';
            
            // Imposta un timeout per evitare il caricamento infinito
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Timeout: La richiesta ha impiegato troppo tempo')), 30000);
            });
            
            // Effettua la richiesta al backend con timeout
            const fetchPromise = fetch(`${BACKEND_URL}/api/summarize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
                body: JSON.stringify({
                    subtitles,
                    length,
                    style,
                    videoId: currentVideoId
                })
            });
            
            // Usa Promise.race per implementare il timeout
            const response = await Promise.race([fetchPromise, timeoutPromise]);
            
            // Verifica se la risposta è valida
        if (!response.ok) {
                let errorMessage = 'Errore nella generazione della sintesi';
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.message || errorMessage;
                } catch (e) {
                    // Se non riesce a fare il parsing del JSON, usa il testo della risposta
                    errorMessage = await response.text() || errorMessage;
                }
                throw new Error(errorMessage);
            }
            
            // Tenta di fare il parsing della risposta JSON
            let data;
            try {
                data = await response.json();
            } catch (e) {
                console.error('Errore nel parsing della risposta JSON:', e);
                const responseText = await response.text();
                console.log('Testo della risposta:', responseText);
                throw new Error('Errore nel formato della risposta dal server');
            }
            
            // Verifica che la risposta contenga la sintesi
            if (!data || !data.summary) {
                throw new Error('La risposta del server non contiene una sintesi valida');
            }
            
            displaySummary(data.summary, data.recordId);

            switchTab('summary');
    } catch (error) {
            console.error('Errore nella generazione della sintesi:', error);
            summaryText.innerHTML = `<div class="error-text">Errore nella generazione della sintesi: ${error.message}</div>`;
            
            // Non propagare l'errore per evitare che il loader rimanga visibile
            // Nascondi il loader manualmente in caso di errore
            hideLoader();
    }
}

/**
     * Mostra la sintesi nella pagina
     * @param {string} summary - Testo della sintesi
 */
function displaySummary(summary, recordId) {
        summaryText.textContent = summary;

        const existing = document.getElementById('db-download-actions');
        if (existing) existing.remove();

        if (recordId) {
            const actions = document.createElement('div');
            actions.id = 'db-download-actions';
            actions.className = 'download-actions';
            actions.innerHTML = `
                <a href="/api/records/${recordId}/download?type=transcript" class="btn-download" download>Scarica trascrizione (DB)</a>
                <a href="/api/records/${recordId}/download?type=summary" class="btn-download" download>Scarica riassunto (DB)</a>
            `;
            summaryText.parentElement.appendChild(actions);
        }
    }

    /**
     * Gestisce il click sul pulsante copia
     * @param {HTMLElement} element - Elemento contenente il testo da copiare
     */
    function handleCopyClick(element) {
        const text = element.textContent;
        copyToClipboard(text);
    }

    /**
     * Gestisce il click sul pulsante download
     * @param {HTMLElement} element - Elemento contenente il testo da scaricare
     * @param {string} prefix - Prefisso per il nome del file
     */
    function handleDownloadClick(element, prefix) {
        const text = element.textContent;
        const videoId = currentVideoId || extractVideoId(urlInput.value.trim());
        downloadAsTextFile(text, `${prefix}-${videoId}.txt`);
    }

    /**
     * Funzione di debounce per limitare la frequenza di esecuzione di una funzione
     * @param {Function} func - Funzione da eseguire
     * @param {number} wait - Tempo di attesa in millisecondi
     * @returns {Function} - Funzione con debounce
     */
    function debounce(func, wait) {
        let timeout;
        return function() {
            const context = this;
            const args = arguments;
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                func.apply(context, args);
            }, wait);
        };
    }

    /**
     * Verifica se l'URL è un URL YouTube valido
     * @param {string} url - L'URL da verificare
     * @returns {boolean} - true se l'URL è valido, false altrimenti
     */
    function isValidYoutubeUrl(url) {
        const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
        return youtubeRegex.test(url);
    }

    /**
     * Estrae l'ID del video dall'URL di YouTube
     * @param {string} url - L'URL del video YouTube
     * @returns {string|null} - L'ID del video o null se non trovato
     */
    function extractVideoId(url) {
        // Gestisce diversi formati di URL YouTube
        const regExp = /^.*(youtu.be\/|v\/|e\/|u\/\w+\/|embed\/|v=)([^#\&\?]*).*/;
        const match = url.match(regExp);
        return (match && match[2].length === 11) ? match[2] : null;
    }

    /**
     * Incorpora un video YouTube nella pagina
     * @param {string} videoId - L'ID del video YouTube
     */
    function embedYouTubeVideo(videoId) {
        // Crea l'iframe per il video
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${videoId}?cc_load_policy=1&cc_lang_pref=it&hl=it`;
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
        iframe.allowFullscreen = true;
        
        // Svuota il contenitore e aggiungi l'iframe
        playerWrapper.innerHTML = '';
        playerWrapper.appendChild(iframe);
        
        // Mostra il contenitore del video
        videoContainer.style.display = 'block';
    }

    /**
     * Recupera i sottotitoli dal video YouTube utilizzando un proxy CORS
     * @param {string} videoId - L'ID del video YouTube
     * @returns {Promise<string>} - Promise che restituisce il testo dei sottotitoli
     */
    async function fetchSubtitles(videoId) {
        try {
            // Prima prova a ottenere i sottotitoli dal backend
            try {
                console.log('Tentativo di recupero sottotitoli dal backend...');
                const response = await fetch(`${BACKEND_URL}/api/subtitles?videoId=${videoId}`);
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.subtitles) {
                        console.log('Sottotitoli recuperati dal backend con successo');
                        return data.subtitles;
                    }
                }
                
                console.log('Sottotitoli non disponibili dal backend, provo con i proxy CORS');
            } catch (backendError) {
                console.log('Errore nel recupero sottotitoli dal backend:', backendError);
            }
            
            // Utilizziamo diversi proxy CORS per aumentare le probabilità di successo
            const corsProxies = [
                'https://corsproxy.io/?',
                'https://cors-anywhere.herokuapp.com/',
                'https://api.allorigins.win/raw?url='
            ];
            
            // Prova ciascun proxy fino a quando uno funziona
            for (const corsProxyUrl of corsProxies) {
                try {
                    console.log(`Tentativo con proxy: ${corsProxyUrl}`);
                    const videoPageUrl = `${corsProxyUrl}https://www.youtube.com/watch?v=${videoId}`;
                    
                    const response = await fetch(videoPageUrl);
                    if (!response.ok) {
                        console.log(`Proxy ${corsProxyUrl} ha restituito errore ${response.status}`);
                        continue;
                    }
                    
                    const html = await response.text();
                    
                    // Cerchiamo l'URL dei sottotitoli nella pagina
                    const captionTrackPatterns = [
                        /"captionTracks":\[.*?"baseUrl":"([^"]+)"/,
                        /captionTracks":\[(.*?)\]/,
                        /playerCaptionsTracklistRenderer.*?captionTracks.*?baseUrl":"([^"]+)"/
                    ];
                    
                    let subtitleUrl = null;
                    
                    // Prova diversi pattern per trovare l'URL dei sottotitoli
                    for (const pattern of captionTrackPatterns) {
                        const match = html.match(pattern);
                        if (match && match[1]) {
                            subtitleUrl = match[1].replace(/\\u0026/g, '&');
                            console.log('URL sottotitoli trovato con pattern:', pattern);
                            break;
                        }
                    }
                    
                    if (!subtitleUrl) {
                        // Metodo alternativo: prova a utilizzare l'API di timedtext
                        console.log('Tentativo con API timedtext...');
                        subtitleUrl = `https://www.youtube.com/api/timedtext?lang=it&v=${videoId}`;
                    }
                    
                    if (!subtitleUrl) {
                        console.log('Nessun URL sottotitoli trovato, provo il prossimo proxy');
                        continue;
                    }
                    
                    // Aggiungiamo il proxy CORS all'URL dei sottotitoli
                    const proxiedSubtitleUrl = `${corsProxyUrl}${subtitleUrl}`;
                    
                    // Aggiungiamo parametri per ottenere i sottotitoli in formato testo
                    const finalUrl = proxiedSubtitleUrl.includes('fmt=') ? 
                        proxiedSubtitleUrl : 
                        `${proxiedSubtitleUrl}&fmt=json3`;
                    
                    console.log('Tentativo di recupero sottotitoli da:', finalUrl);
                    const subtitlesResponse = await fetch(finalUrl);
                    
                    if (!subtitlesResponse.ok) {
                        console.log(`Errore nel recupero sottotitoli: ${subtitlesResponse.status}`);
                        continue;
                    }
                    
                    const contentType = subtitlesResponse.headers.get('content-type');
                    
                    // Gestisci diversi formati di risposta
                    if (contentType && contentType.includes('application/json')) {
                        // Formato JSON
                        const subtitlesData = await subtitlesResponse.json();
                        
                        if (subtitlesData && subtitlesData.events) {
                            const formattedSubtitles = formatSubtitles(subtitlesData.events);
                            
                            // Salva i sottotitoli nel backend per uso futuro
                            try {
                                await fetch(`${BACKEND_URL}/api/subtitles`, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({
                                        videoId,
                                        subtitles: formattedSubtitles
                                    })
                                });
                                console.log('Sottotitoli salvati nel backend');
                            } catch (saveError) {
                                console.log('Errore nel salvataggio dei sottotitoli:', saveError);
                            }
                            
                            return formattedSubtitles;
                        }
                    } else if (contentType && contentType.includes('text/xml')) {
                        // Formato XML (timedtext)
                        const xmlText = await subtitlesResponse.text();
                        const formattedSubtitles = formatXmlSubtitles(xmlText);
                        
                        // Salva i sottotitoli nel backend per uso futuro
                        try {
                            await fetch(`${BACKEND_URL}/api/subtitles`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    videoId,
                                    subtitles: formattedSubtitles
                                })
                            });
                            console.log('Sottotitoli salvati nel backend');
                        } catch (saveError) {
                            console.log('Errore nel salvataggio dei sottotitoli:', saveError);
                        }
                        
                        return formattedSubtitles;
                    } else {
                        // Prova a interpretare come JSON
                        try {
                            const text = await subtitlesResponse.text();
                            const jsonData = JSON.parse(text);
                            
                            if (jsonData && jsonData.events) {
                                const formattedSubtitles = formatSubtitles(jsonData.events);
                                
                                // Salva i sottotitoli nel backend per uso futuro
                                try {
                                    await fetch(`${BACKEND_URL}/api/subtitles`, {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json'
                                        },
                                        body: JSON.stringify({
                                            videoId,
                                            subtitles: formattedSubtitles
                                        })
                                    });
                                    console.log('Sottotitoli salvati nel backend');
                                } catch (saveError) {
                                    console.log('Errore nel salvataggio dei sottotitoli:', saveError);
                                }
                                
                                return formattedSubtitles;
                            }
                        } catch (e) {
                            console.log('Errore nel parsing dei sottotitoli, provo il prossimo proxy');
                            continue;
                        }
                    }
                } catch (proxyError) {
                    console.log(`Errore con proxy ${corsProxyUrl}:`, proxyError);
                    // Continua con il prossimo proxy
                }
            }
            
            // Se arriviamo qui, nessun proxy ha funzionato
            throw new Error('Impossibile recuperare i sottotitoli. Prova ad attivare i sottotitoli direttamente nel player YouTube.');
        } catch (error) {
            console.error('Errore nel recupero dei sottotitoli:', error);
            throw error;
    }
}

/**
     * Formatta i sottotitoli XML in un testo leggibile
     * @param {string} xmlText - Testo XML dei sottotitoli
     * @returns {string} - Testo formattato dei sottotitoli
     */
    function formatXmlSubtitles(xmlText) {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, "text/xml");
            const textElements = xmlDoc.getElementsByTagName('text');
            let formattedText = '';
            
            for (let i = 0; i < textElements.length; i++) {
                const element = textElements[i];
                const start = element.getAttribute('start');
                const dur = element.getAttribute('dur');
                const text = element.textContent.trim();
                
                if (text) {
                    // Formatta il timestamp se disponibile
                    if (start) {
                        const timestamp = formatSecondsToTimestamp(parseFloat(start));
                        formattedText += `[${timestamp}] `;
                    }
                    
                    formattedText += text + '\n\n';
                }
            }
            
            return formattedText.trim();
        } catch (error) {
            console.error('Errore nel parsing XML:', error);
            throw new Error('Impossibile interpretare i sottotitoli XML.');
        }
    }

    /**
     * Formatta secondi in formato timestamp (MM:SS)
     * @param {number} seconds - Secondi
     * @returns {string} - Timestamp formattato
     */
    function formatSecondsToTimestamp(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Formatta i sottotitoli in un testo leggibile
     * @param {Array} events - Array di eventi dei sottotitoli
     * @returns {string} - Testo formattato dei sottotitoli
     */
    function formatSubtitles(events) {
        let formattedText = '';
        
        events.forEach(event => {
            if (event.segs) {
                const text = event.segs.map(seg => seg.utf8 || '').join('').trim();
                if (text) {
                    // Aggiungi timestamp se disponibile
                    if (event.tStartMs !== undefined) {
                        const timestamp = formatTimestamp(event.tStartMs);
                        formattedText += `[${timestamp}] `;
                    }
                    
                    formattedText += text + '\n\n';
                }
            }
        });
        
        return formattedText.trim();
    }

    /**
     * Formatta un timestamp in millisecondi in formato leggibile (MM:SS)
     * @param {number} ms - Timestamp in millisecondi
     * @returns {string} - Timestamp formattato
     */
    function formatTimestamp(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    /**
     * Mostra i sottotitoli nella pagina
     * @param {string} text - Testo dei sottotitoli
     */
    function displaySubtitles(text) {
        subtitlesText.textContent = text;
        subtitlesContainer.style.display = 'block';
    }

    /**
     * Copia il testo negli appunti
     * @param {string} text - Testo da copiare
     */
    function copyToClipboard(text) {
        navigator.clipboard.writeText(text)
            .then(() => {
                // Feedback visivo
                const originalText = copyButton.textContent;
                copyButton.innerHTML = '<i class="fas fa-check"></i> Copiato!';
                setTimeout(() => {
                    copyButton.innerHTML = '<i class="fas fa-copy"></i> Copia';
                }, 2000);
            })
            .catch(err => {
                console.error('Errore durante la copia negli appunti:', err);
                showError('Impossibile copiare il testo negli appunti.');
            });
    }

    /**
     * Scarica il testo come file TXT
     * @param {string} text - Testo da scaricare
     * @param {string} filename - Nome del file
     */
    function downloadAsTextFile(text, filename) {
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        
        // Pulizia
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
}

/**
 * Mostra il loader
 */
function showLoader() {
    loader.classList.add('active');
        extractButton.disabled = true;
}

/**
 * Nasconde il loader
 */
function hideLoader() {
    loader.classList.remove('active');
        extractButton.disabled = false;
    }

    /**
     * Mostra un messaggio di errore
     * @param {string} message - Messaggio di errore
     */
    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
    }

    /**
     * Nasconde il messaggio di errore
     */
    function hideError() {
        errorMessage.style.display = 'none';
    }
}); 