/**
 * YouTube Gemini Summarizer — Client-side subtitle fetch via CORS proxy
 */

document.addEventListener('DOMContentLoaded', () => {

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
  
    const BACKEND_URL = window.location.origin;
  
    // Working CORS proxies (updated May 2026)
    const CORS_PROXIES = [
      'https://corsproxy.io/?',
      'https://corsproxy.org/?',
      'https://api.codetabs.com/v1/proxy?quest=',
    ];
    let proxyIndex = 0;
  
    let currentVideoId = null;
    let extractedSubtitles = null;
  
    init();
  
    function init() {
      if (subtitlesContainer) subtitlesContainer.style.display = 'none';
      urlInput.addEventListener('input', debounce(handleUrlInput, 800));
      form.addEventListener('submit', handleFormSubmit);
      copyButton.addEventListener('click', () => handleCopyClick(subtitlesText));
      downloadButton.addEventListener('click', () => handleDownloadClick(subtitlesText, 'sottotitoli'));
      copySummaryButton.addEventListener('click', () => handleCopyClick(summaryText));
      downloadSummaryButton.addEventListener('click', () => handleDownloadClick(summaryText, 'sintesi'));
      if (regenerateButton) regenerateButton.addEventListener('click', handleRegenerateClick);
      tabButtons.forEach(button => {
        button.addEventListener('click', () => switchTab(button.getAttribute('data-tab')));
      });
  
      const modelSelector = document.getElementById('summary-model');
      if (modelSelector) {
        const modelGroup = modelSelector.closest('.option-group');
        if (modelGroup) modelGroup.style.display = 'none';
      }
    }
  
    function getCorsProxy() {
      const proxy = CORS_PROXIES[proxyIndex];
      proxyIndex = (proxyIndex + 1) % CORS_PROXIES.length;
      return proxy;
    }
  
    function switchTab(tabName) {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      document.querySelector(`.tab-button[data-tab="${tabName}"]`).classList.add('active');
      document.getElementById(`${tabName}-tab`).classList.add('active');
    }
  
    async function handleUrlInput() {
      const youtubeUrl = urlInput.value.trim();
      if (!isValidYoutubeUrl(youtubeUrl)) {
        videoContainer.style.display = 'none';
        return;
      }
      const videoId = extractVideoId(youtubeUrl);
      if (videoId) embedYouTubeVideo(videoId);
    }
  
    async function handleFormSubmit(e) {
      e.preventDefault();
      const youtubeUrl = urlInput.value.trim();
  
      if (!isValidYoutubeUrl(youtubeUrl)) {
        showError('Per favore, inserisci un URL YouTube valido.');
        return;
      }
  
      const videoId = extractVideoId(youtubeUrl);
      if (!videoId) {
        showError("Impossibile estrarre l'ID del video dall'URL fornito.");
        return;
      }
  
      currentVideoId = videoId;
      showLoader();
      hideError();
  
      try {
        if (videoContainer.style.display !== 'block') embedYouTubeVideo(videoId);
  
        const subtitles = await fetchSubtitles(videoId);
  
        if (!subtitles || subtitles.trim() === '') {
          throw new Error('Non sono stati trovati sottotitoli per questo video.');
        }
  
        extractedSubtitles = subtitles;
        displaySubtitles(subtitles);
        await generateSummary(subtitles);
      } catch (error) {
        console.error('Errore durante l\'elaborazione:', error);
        showError('Si è verificato un errore: ' + error.message);
      } finally {
        hideLoader();
      }
    }
  
    async function handleRegenerateClick() {
      if (!extractedSubtitles) {
        showError('Non ci sono sottotitoli da elaborare.');
        return;
      }
      showLoader();
      hideError();
      try {
        await generateSummary(extractedSubtitles);
      } catch (error) {
        console.error('Errore durante la rigenerazione:', error);
        showError('Errore durante la rigenerazione: ' + error.message);
      } finally {
        hideLoader();
      }
    }
  
    async function generateSummary(subtitles) {
      try {
        const length = summaryLength.value;
        const style = summaryStyle.value;
  
        summaryText.innerHTML = '<div class="loading-indicator">Generazione della sintesi in corso...</div>';
  
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout: la richiesta ha impiegato troppo tempo')), 30000)
        );
  
        const fetchPromise = fetch(`${BACKEND_URL}/api/summarize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subtitles, length, style, videoId: currentVideoId })
        });
  
        const response = await Promise.race([fetchPromise, timeoutPromise]);
  
        if (!response.ok) {
          let msg = 'Errore nella generazione della sintesi';
          try { msg = (await response.json()).message || msg; } catch (_) {}
          throw new Error(msg);
        }
  
        let data;
        try {
          data = await response.json();
        } catch (e) {
          throw new Error('Errore nel formato della risposta dal server');
        }
  
        if (!data?.summary) throw new Error('La risposta del server non contiene una sintesi valida');
  
        displaySummary(data.summary, data.recordId);
        switchTab('summary');
      } catch (error) {
        console.error('Errore nella generazione della sintesi:', error);
        summaryText.innerHTML = `<div class="error-indicator">Errore nella generazione della sintesi: ${error.message}</div>`;
        hideLoader();
      }
    }
  
    function displaySummary(summary, recordId) {
      summaryText.textContent = summary;
  
      const existing = document.getElementById('db-download-actions');
      if (existing) existing.remove();
  
      if (recordId) {
        const actions = document.createElement('div');
        actions.id = 'db-download-actions';
        actions.className = 'download-actions';
        actions.innerHTML = `
          <a href="/api/records/${recordId}/download?type=transcript" class="action-link">Scarica trascrizione (DB)</a>
          <a href="/api/records/${recordId}/download?type=summary" class="action-link">Scarica riassunto (DB)</a>
        `;
        summaryText.parentElement.appendChild(actions);
      }
    }
  
    // ─── CLIENT-SIDE SUBTITLE FETCHING via CORS proxy ───────────────────
  
    async function fetchSubtitles(videoId) {
      let lastError = null;
  
      for (let attempt = 0; attempt < CORS_PROXIES.length * 2; attempt++) {
        const proxy = getCorsProxy();
  
        try {
          console.log(`Tentativo ${attempt + 1} con proxy: ${proxy}`);
  
          // Step 1: Fetch YouTube watch page via proxy
          const watchUrl = proxy + encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
          const watchRes = await fetch(watchUrl);
  
          if (!watchRes.ok) {
            console.warn(`Proxy ${proxy} ha ricevuto ${watchRes.status}, provo il prossimo...`);
            lastError = new Error(`Proxy ha ricevuto ${watchRes.status}`);
            continue;
          }
  
          const html = await watchRes.text();
  
          // Extract ytInitialPlayerResponse
          const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});\s*<\/script>/);
          if (!playerMatch) {
            throw new Error('Nessun sottotitolo disponibile per questo video');
          }
  
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
  
          // Pick best track
          const track =
            captionTracks.find(t => t.languageCode === 'it') ||
            captionTracks.find(t => t.languageCode === 'en') ||
            captionTracks[0];
  
          if (!track) throw new Error('Nessuna traccia sottotitoli trovata');
  
          // Step 2: Fetch timedtext via proxy
          let timedTextUrl = track.baseUrl;
          if (!timedTextUrl) {
            timedTextUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${track.languageCode}&fmt=srv3`;
          }
          timedTextUrl = timedTextUrl.replace(/\\u0026/g, '&').replace(/\\u0027/g, "'");
  
          const proxyTimedUrl = proxy + encodeURIComponent(timedTextUrl);
          const subRes = await fetch(proxyTimedUrl);
  
          if (!subRes.ok) {
            throw new Error(`Errore nel download sottotitoli: ${subRes.status}`);
          }
  
          const xml = await subRes.text();
          const subtitles = parseSrv3Xml(xml);
  
          if (!subtitles || subtitles.trim().length === 0) {
            throw new Error('Sottotitoli vuoti dopo il parsing');
          }
  
          // Cache to backend DB if available (fire and forget)
          try {
            await fetch(`${BACKEND_URL}/api/subtitles`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoId, subtitles })
            });
          } catch (_) {}
  
          console.log('Sottotitoli recuperati con successo via proxy');
          return subtitles;
  
        } catch (error) {
          lastError = error;
          console.warn(`Proxy ${proxy} fallito:`, error.message);
        }
      }
  
      throw lastError || new Error('Impossibile recuperare i sottotitoli. Tutti i proxy hanno fallito.');
    }
  
    // Parse YouTube SRV3 XML
    function parseSrv3Xml(xml) {
      const textMatches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  
      if (textMatches.length === 0) {
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
        text = text.replace(/<s[^>]*>/g, '').replace(/<\/s>/g, '');
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
  
    // ─── UI helpers ──────────────────────────────────────────────────────────
  
    function isValidYoutubeUrl(url) {
      return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(url);
    }
  
    function extractVideoId(url) {
      const match = url.match(/^.*(youtu\.be\/|v\/|e\/|u\/\w+\/|embed\/|v=)([^#&?]*).*/);
      return (match && match[2].length === 11) ? match[2] : null;
    }
  
    function embedYouTubeVideo(videoId) {
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${videoId}?cc_load_policy=1&cc_lang_pref=it&hl=it`;
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      playerWrapper.innerHTML = '';
      playerWrapper.appendChild(iframe);
      videoContainer.style.display = 'block';
    }
  
    function displaySubtitles(text) {
      subtitlesText.textContent = text;
      subtitlesContainer.style.display = 'block';
    }
  
    function handleCopyClick(element) {
      copyToClipboard(element.textContent);
    }
  
    function handleDownloadClick(element, prefix) {
      const videoId = currentVideoId || extractVideoId(urlInput.value.trim());
      downloadAsTextFile(element.textContent, `${prefix}-${videoId}.txt`);
    }
  
    function copyToClipboard(text) {
      navigator.clipboard.writeText(text)
        .then(() => {
          copyButton.innerHTML = '<i class="fas fa-check"></i> Copiato!';
          setTimeout(() => { copyButton.innerHTML = '<i class="fas fa-copy"></i> Copia'; }, 2000);
        })
        .catch(() => showError('Impossibile copiare il testo negli appunti.'));
    }
  
    function downloadAsTextFile(text, filename) {
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    }
  
    function debounce(func, wait) {
      let timeout;
      return function () {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, arguments), wait);
      };
    }
  
    function showLoader() { loader.classList.add('active'); extractButton.disabled = true; }
    function hideLoader() { loader.classList.remove('active'); extractButton.disabled = false; }
    function showError(message) { errorMessage.textContent = message; errorMessage.style.display = 'block'; }
    function hideError() { errorMessage.style.display = 'none'; }
  
  });