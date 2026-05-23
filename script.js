/**
 * YouTube Gemini Summarizer — Backend Node.js for subtitles
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
  
    // ─── BACKEND SUBTITLE FETCHING via Netlify Node Function ───────────────────
  
    async function fetchSubtitles(videoId) {
      // Try cache first (Edge Function DB)
      try {
        const cached = await fetch(`${BACKEND_URL}/api/subtitles?videoId=${videoId}`);
        if (cached.ok) {
          const data = await cached.json();
          if (data.subtitles) {
            console.log('Sottotitoli recuperati dalla cache DB');
            return data.subtitles;
          }
        }
      } catch (_) {
        console.log('Cache DB non disponibile');
      }
  
      // Fetch via Netlify Node Function (no CORS issues)
      console.log('Recupero sottotitoli dal backend Node...');
      const response = await fetch(`${BACKEND_URL}/api/fetch-subtitles?videoId=${videoId}`);
  
      if (!response.ok) {
        let msg = 'Errore nel recupero sottotitoli';
        try { msg = (await response.json()).message || msg; } catch (_) {}
        throw new Error(msg);
      }
  
      const data = await response.json();
      if (!data.subtitles) throw new Error('Nessun sottotitolo restituito dal backend');
  
      // Save to cache DB if available
      try {
        await fetch(`${BACKEND_URL}/api/subtitles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId, subtitles: data.subtitles })
        });
      } catch (_) {}
  
      console.log('Sottotitoli recuperati con successo');
      return data.subtitles;
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