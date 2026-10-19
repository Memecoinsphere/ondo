(() => {
  'use strict';

  const PIPED_INSTANCES = [
    'https://pipedapi.ducks.party',
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.leptons.xyz',
    'https://api.piped.yt',
  ];
  const YT_API = 'https://www.googleapis.com/youtube/v3';
  const FETCH_TIMEOUT_MS = 9000;
  const SEARCH_DEBOUNCE_MS = 450;
  const LS = 'ondo:';

  // ---------- Utilities ----------
  const $ = (sel) => document.querySelector(sel);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(LS + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(LS + key, JSON.stringify(value));
    } catch {
      toast('Impossible d\u2019enregistrer (stockage plein ou désactivé).');
    }
  }

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function parseIsoDuration(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
    if (!m) return 0;
    const [, d, h, min, s] = m.map((v) => Number(v) || 0);
    return d * 86400 + h * 3600 + min * 60 + s;
  }

  // The Data API returns HTML-escaped titles (e.g. &#39;); decode without injecting markup.
  function decodeEntities(str) {
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${str || ''}`, 'text/html');
    return doc.body.textContent || '';
  }

  function thumbFor(id) {
    return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
  }

  const THUMB_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#2c2c36"/>'
    + '<text x="160" y="112" font-size="64" text-anchor="middle" fill="#ff6b4a" font-family="sans-serif">\u266a</text></svg>',
  );

  // Piped returns thumbnails through its own image proxy (…?host=i.ytimg.com), which is slow or down
  // when the instance is; point straight back at the original host instead.
  function normalizeThumb(url) {
    if (!url) return '';
    try {
      const u = new URL(url, location.href);
      const host = u.searchParams.get('host');
      if (host && /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com)$/.test(host)) {
        return `https://${host}${u.pathname}`;
      }
      return u.protocol === 'https:' ? u.href : '';
    } catch {
      return '';
    }
  }

  function trackThumb(track) {
    return track.thumb || thumbFor(track.id);
  }

  // Fallback chain: result thumbnail → official ytimg thumbnail → inline placeholder.
  function onThumbError(e) {
    const img = e.currentTarget;
    const fallback = thumbFor(img.dataset.vid || '');
    if (img.dataset.vid && img.src !== fallback && img.dataset.fellBack !== '1') {
      img.dataset.fellBack = '1';
      img.src = fallback;
    } else if (img.src !== THUMB_PLACEHOLDER) {
      img.src = THUMB_PLACEHOLDER;
    }
  }

  function thumbImg(track, eager = false) {
    return el('img', {
      src: trackThumb(track),
      alt: '',
      loading: eager ? 'eager' : 'lazy',
      decoding: 'async',
      dataset: { vid: track.id },
      onerror: onThumbError,
    });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  async function fetchJson(url, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const onOuterAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onOuterAbort);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) {
        const msg = body?.error?.message || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return body;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  let toastTimer;
  function toast(message) {
    const t = $('#toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  const countLabel = (n) => `${n} titre${n > 1 ? 's' : ''}`;

  function makeTrack(raw) {
    return {
      id: String(raw.id),
      title: raw.title || 'Sans titre',
      channel: raw.channel || '',
      duration: Number(raw.duration) > 0 ? Number(raw.duration) : 0,
      thumb: normalizeThumb(raw.thumb),
    };
  }

  // ---------- State ----------
  const state = {
    queue: load('queue', []).map(makeTrack),
    index: load('index', -1),
    volume: load('volume', 80),
    muted: load('muted', false),
    repeat: load('repeat', 'off'), // 'off' | 'all' | 'one'
    shuffle: load('shuffle', false),
    playlists: load('playlists', []),
    videoVisible: load('videoVisible', false),
    apiKey: load('apiKey', ''),
    view: 'search',
    openPlaylistId: null,
    results: [],
    isPlaying: false,
    shuffleHistory: [],
    // Search results after the one the user clicked; used as "up next" once the queue runs out.
    upNext: load('upNext', []).map(makeTrack),
  };
  if (state.index >= state.queue.length) state.index = state.queue.length - 1;

  const persistQueue = () => { save('queue', state.queue); save('index', state.index); save('upNext', state.upNext); };
  const persistPlaylists = () => save('playlists', state.playlists);
  const currentTrack = () => state.queue[state.index] || null;
  const findPlaylist = (id) => state.playlists.find((p) => p.id === id) || null;

  // ---------- YouTube IFrame player ----------
  let player = null;
  let playerReady = false;
  let pendingAutoplay = false;
  let progressTimer = null;
  let seeking = false;
  let loadedVideoId = null;
  // IDs that failed during the current skip chain; cleared as soon as something actually plays.
  const failedIds = new Set();
  let errorHandledFor = null;
  let skipTimer = null;

  function loadYouTubeApi() {
    window.onYouTubeIframeAPIReady = () => {
      player = new YT.Player('ytPlayer', {
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
        events: { onReady, onStateChange, onError },
      });
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => toast('Impossible de charger le lecteur YouTube (connexion ?).');
    document.head.append(s);
  }

  function onReady() {
    playerReady = true;
    applyVolume();
    const track = currentTrack();
    if (track) {
      if (pendingAutoplay) startTrack(true);
      else {
        player.cueVideoById(track.id);
        loadedVideoId = track.id;
      }
    }
    pendingAutoplay = false;
  }

  function onStateChange(e) {
    switch (e.data) {
      case YT.PlayerState.PLAYING:
        failedIds.clear();
        setPlaying(true);
        startProgress();
        break;
      case YT.PlayerState.PAUSED:
        setPlaying(false);
        stopProgress();
        updateProgress();
        break;
      case YT.PlayerState.ENDED:
        setPlaying(false);
        stopProgress();
        handleEnded();
        break;
      case YT.PlayerState.CUED:
        setPlaying(false);
        updateProgress();
        break;
      default:
        break;
    }
  }

  function onError(e) {
    const messages = {
      2: 'Identifiant de vidéo invalide.',
      5: 'Lecture impossible dans le lecteur HTML5.',
      100: 'Vidéo introuvable ou privée.',
      101: 'Le propriétaire n\u2019autorise pas la lecture intégrée.',
      150: 'Le propriétaire n\u2019autorise pas la lecture intégrée.',
    };
    const failedId = loadedVideoId;
    // The player can report the same failure more than once; only skip once per loaded video.
    if (!failedId || errorHandledFor === failedId) return;
    errorHandledFor = failedId;
    failedIds.add(failedId);
    setPlaying(false);
    stopProgress();
    const reason = messages[e.data] || 'Erreur de lecture.';
    if (nextCandidateIndex(true, failedIds) < 0) {
      failedIds.clear();
      toast(`${reason} Aucun autre titre lisible : lecture arrêtée.`);
      return;
    }
    toast(`${reason} Passage au titre suivant.`);
    clearTimeout(skipTimer);
    skipTimer = setTimeout(() => {
      skipTimer = null;
      // Only skip if the user hasn't started something else in the meantime.
      if (loadedVideoId === failedId && !next(true, true)) {
        failedIds.clear();
        toast('Aucun autre titre lisible : lecture arrêtée.');
      }
    }, 700);
  }

  function startTrack(autoplay) {
    const track = currentTrack();
    clearTimeout(skipTimer);
    skipTimer = null;
    errorHandledFor = null;
    renderNowPlaying();
    renderQueue();
    updateResultHighlight();
    renderPlaylistDetail();
    if (!track) return;
    if (!playerReady) {
      pendingAutoplay = autoplay;
      return;
    }
    loadedVideoId = track.id;
    setRangeFill(Object.assign($('#seek'), { value: 0, max: track.duration || 0 }));
    $('#curTime').textContent = '0:00';
    $('#totTime').textContent = formatTime(track.duration);
    if (autoplay) player.loadVideoById(track.id);
    else player.cueVideoById(track.id);
    updateMediaSession();
  }

  function setPlaying(playing) {
    state.isPlaying = playing;
    const btn = $('#playBtn');
    btn.textContent = playing ? '❚❚' : '▶';
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
    btn.title = playing ? 'Pause' : 'Lecture';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function startProgress() {
    stopProgress();
    updateProgress();
    progressTimer = setInterval(updateProgress, 500);
  }

  function stopProgress() {
    clearInterval(progressTimer);
    progressTimer = null;
  }

  function updateProgress() {
    if (!playerReady || seeking) return;
    const track = currentTrack();
    const total = player.getDuration?.() || track?.duration || 0;
    const cur = player.getCurrentTime?.() || 0;
    const seek = $('#seek');
    seek.max = Math.max(0, Math.floor(total));
    seek.value = Math.floor(cur);
    setRangeFill(seek);
    $('#curTime').textContent = formatTime(cur);
    $('#totTime').textContent = formatTime(total);
    if (track && total && !track.duration) {
      track.duration = Math.floor(total);
      persistQueue();
    }
  }

  function setRangeFill(input) {
    const max = Number(input.max) || 0;
    const pct = max > 0 ? (Number(input.value) / max) * 100 : 0;
    input.style.setProperty('--pct', `${pct}%`);
  }

  function applyVolume() {
    const vol = $('#volume');
    vol.value = state.volume;
    setRangeFill(vol);
    $('#muteBtn').textContent = state.muted || state.volume === 0 ? '🔇' : state.volume < 50 ? '🔉' : '🔊';
    $('#muteBtn').setAttribute('aria-label', state.muted ? 'Rétablir le son' : 'Couper le son');
    if (!playerReady) return;
    player.setVolume(state.volume);
    if (state.muted) player.mute(); else player.unMute();
  }

  // ---------- Transport ----------
  function togglePlay() {
    const track = currentTrack();
    if (!track) {
      if (state.queue.length) { state.index = 0; persistQueue(); startTrack(true); }
      else toast('La file d\u2019attente est vide. Lancez une recherche !');
      return;
    }
    if (!playerReady) { pendingAutoplay = true; return; }
    if (loadedVideoId !== track.id) { startTrack(true); return; }
    if (state.isPlaying) player.pauseVideo(); else player.playVideo();
  }

  // Pure lookup: index of the next track to play, or -1. Ids in `exclude` are skipped.
  // An index equal to queue.length means "take the first usable item from upNext".
  function nextCandidateIndex(auto, exclude = new Set()) {
    const q = state.queue;
    const usable = (i) => i !== state.index && !exclude.has(q[i].id);
    const upNextUsable = state.upNext.some((t) => !exclude.has(t.id));
    if (state.shuffle) {
      const played = new Set(state.shuffleHistory);
      const pool = q.map((_, i) => i).filter((i) => usable(i) && !(auto && state.repeat === 'off' && played.has(i)));
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
      return upNextUsable ? q.length : -1;
    }
    for (let i = state.index + 1; i < q.length; i += 1) if (usable(i)) return i;
    if (upNextUsable) return q.length;
    if (state.repeat === 'all' || !auto) {
      for (let i = 0; i < state.index; i += 1) if (usable(i)) return i;
      if (!auto && q[state.index] && !exclude.has(q[state.index].id)) return state.index;
    }
    return -1;
  }

  // auto=true when a track ended or failed (respects repeat modes); skipFailed skips ids in failedIds.
  // Returns true when a new track was loaded.
  function next(auto = false, skipFailed = false) {
    if (!state.queue.length && !state.upNext.length) return false;
    if (auto && !skipFailed && state.repeat === 'one' && currentTrack()) { startTrack(true); return true; }
    const exclude = skipFailed ? failedIds : new Set();
    let target = nextCandidateIndex(auto, exclude);
    if (target < 0) {
      if (auto && state.shuffle) state.shuffleHistory = [];
      return false;
    }
    if (target === state.queue.length) {
      while (state.upNext.length && exclude.has(state.upNext[0].id)) state.upNext.shift();
      state.queue.push(state.upNext.shift());
      target = state.queue.length - 1;
    }
    if (state.shuffle && state.index >= 0) state.shuffleHistory.push(state.index);
    state.index = target;
    persistQueue();
    startTrack(true);
    return true;
  }

  function prev() {
    if (!state.queue.length) return;
    if (playerReady && (player.getCurrentTime?.() || 0) > 3) { player.seekTo(0, true); return; }
    if (state.shuffle && state.shuffleHistory.length) {
      state.index = state.shuffleHistory.pop();
    } else {
      state.index = state.index > 0 ? state.index - 1 : (state.repeat === 'all' ? state.queue.length - 1 : 0);
    }
    persistQueue();
    startTrack(true);
  }

  function handleEnded() {
    if (!next(true)) toast('Fin de la file d’attente');
  }

  // ---------- Queue operations ----------
  function playNow(track) {
    const insertAt = state.index + 1;
    state.queue.splice(insertAt, 0, makeTrack(track));
    state.index = insertAt;
    failedIds.clear();
    persistQueue();
    startTrack(true);
  }

  // Playing a search result also stages the following results as "up next", so that
  // next / auto-advance / skip-on-embed-error always have somewhere to go.
  function playFromResults(i) {
    const track = state.results[i];
    if (!track) return;
    state.upNext = state.results.slice(i + 1).map(makeTrack);
    playNow(track);
  }

  function playNext(track) {
    state.queue.splice(state.index + 1, 0, makeTrack(track));
    persistQueue();
    renderQueue();
    toast('Sera lu ensuite');
  }

  function addToQueue(track) {
    state.queue.push(makeTrack(track));
    if (state.index < 0) state.index = 0;
    persistQueue();
    renderQueue();
    if (state.queue.length === 1) startTrack(false);
    toast('Ajouté à la file d\u2019attente');
  }

  function removeFromQueue(i) {
    if (i < 0 || i >= state.queue.length) return;
    const wasCurrent = i === state.index;
    state.queue.splice(i, 1);
    state.shuffleHistory = [];
    if (i < state.index) state.index -= 1;
    if (state.index >= state.queue.length) state.index = state.queue.length - 1;
    persistQueue();
    if (wasCurrent) {
      if (state.queue.length) startTrack(state.isPlaying);
      else stopPlayback();
    } else {
      renderQueue();
    }
  }

  function moveInQueue(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= state.queue.length) return;
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    if (state.index === i) state.index = j;
    else if (state.index === j) state.index = i;
    persistQueue();
    renderQueue();
  }

  function stopPlayback() {
    if (playerReady) player.stopVideo();
    loadedVideoId = null;
    setPlaying(false);
    stopProgress();
    $('#seek').value = 0;
    $('#seek').max = 0;
    setRangeFill($('#seek'));
    $('#curTime').textContent = '0:00';
    $('#totTime').textContent = '0:00';
    renderNowPlaying();
    renderQueue();
    updateResultHighlight();
  }

  function clearQueue() {
    state.queue = [];
    state.upNext = [];
    state.index = -1;
    state.shuffleHistory = [];
    persistQueue();
    stopPlayback();
  }

  function playList(tracks) {
    if (!tracks.length) { toast('Cette playlist est vide.'); return; }
    state.queue = tracks.map(makeTrack);
    state.upNext = [];
    state.shuffleHistory = [];
    failedIds.clear();
    state.index = state.shuffle ? Math.floor(Math.random() * state.queue.length) : 0;
    persistQueue();
    startTrack(true);
  }

  // ---------- Playlists ----------
  function createPlaylist(name, firstTrack) {
    const pl = { id: uid(), name: name.trim(), tracks: firstTrack ? [makeTrack(firstTrack)] : [] };
    state.playlists.push(pl);
    persistPlaylists();
    renderPlaylists();
    return pl;
  }

  function addToPlaylist(plId, track) {
    const pl = findPlaylist(plId);
    if (!pl) return;
    if (pl.tracks.some((t) => t.id === track.id)) {
      toast(`Déjà dans « ${pl.name} »`);
      return;
    }
    pl.tracks.push(makeTrack(track));
    persistPlaylists();
    renderPlaylists();
    toast(`Ajouté à « ${pl.name} »`);
  }

  function removeFromPlaylist(plId, i) {
    const pl = findPlaylist(plId);
    if (!pl) return;
    pl.tracks.splice(i, 1);
    persistPlaylists();
    renderPlaylists();
  }

  async function promptNewPlaylist(firstTrack) {
    const name = await askText('Nouvelle playlist', `Ma playlist n°${state.playlists.length + 1}`);
    if (!name) return null;
    const pl = createPlaylist(name, firstTrack);
    toast(firstTrack ? `Ajouté à « ${pl.name} »` : `Playlist « ${pl.name} » créée`);
    return pl;
  }

  async function renameOpenPlaylist() {
    const pl = findPlaylist(state.openPlaylistId);
    if (!pl) return;
    const name = await askText('Renommer la playlist', pl.name);
    if (!name) return;
    pl.name = name.trim();
    persistPlaylists();
    renderPlaylists();
  }

  function deleteOpenPlaylist() {
    const pl = findPlaylist(state.openPlaylistId);
    if (!pl) return;
    if (!confirm(`Supprimer la playlist « ${pl.name} » ?`)) return;
    state.playlists = state.playlists.filter((p) => p.id !== pl.id);
    persistPlaylists();
    showView('playlists');
    toast('Playlist supprimée');
  }

  // ---------- Search ----------
  let searchController = null;
  let searchSeq = 0;

  async function searchPiped(query, signal) {
    let lastError = null;
    for (const base of PIPED_INSTANCES) {
      try {
        const data = await fetchJson(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`, signal);
        const items = Array.isArray(data?.items) ? data.items : [];
        const tracks = [];
        for (const it of items) {
          const m = /[?&]v=([\w-]{11})/.exec(it.url || '');
          if (!m) continue;
          tracks.push(makeTrack({
            id: m[1],
            title: it.title,
            channel: it.uploaderName,
            duration: it.duration,
            thumb: it.thumbnail,
          }));
        }
        return { tracks, source: `Piped · ${new URL(base).host}` };
      } catch (err) {
        if (signal.aborted) throw err;
        lastError = err;
      }
    }
    const err = new Error('Toutes les instances Piped sont indisponibles pour le moment.');
    err.cause = lastError;
    throw err;
  }

  async function searchDataApi(query, signal) {
    const key = encodeURIComponent(state.apiKey);
    const search = await fetchJson(
      `${YT_API}/search?part=snippet&type=video&maxResults=25&q=${encodeURIComponent(query)}&key=${key}`,
      signal,
    );
    const items = (search?.items || []).filter((it) => it.id?.videoId);
    if (!items.length) return { tracks: [], source: 'YouTube Data API' };
    const ids = items.map((it) => it.id.videoId).join(',');
    const details = await fetchJson(`${YT_API}/videos?part=contentDetails&id=${ids}&key=${key}`, signal);
    const durations = new Map((details?.items || []).map((v) => [v.id, parseIsoDuration(v.contentDetails?.duration)]));
    const tracks = items.map((it) => makeTrack({
      id: it.id.videoId,
      title: decodeEntities(it.snippet?.title),
      channel: decodeEntities(it.snippet?.channelTitle),
      duration: durations.get(it.id.videoId) || 0,
      thumb: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.high?.url || it.snippet?.thumbnails?.default?.url,
    }));
    return { tracks, source: 'YouTube Data API (officielle)' };
  }

  async function runSearch(rawQuery) {
    const query = rawQuery.trim();
    const status = $('#searchStatus');
    searchController?.abort();
    if (!query) {
      state.results = [];
      renderResults();
      status.className = 'status';
      status.textContent = 'Tapez un titre, un artiste ou une chaîne pour commencer.';
      $('#searchTitle').textContent = 'Recherche';
      $('#sourceTag').textContent = '';
      return;
    }
    const seq = ++searchSeq;
    searchController = new AbortController();
    const { signal } = searchController;
    status.className = 'status';
    status.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Recherche en cours…');
    $('#searchTitle').textContent = `Résultats pour « ${query} »`;

    let result;
    try {
      if (state.apiKey) {
        try {
          result = await searchDataApi(query, signal);
        } catch (err) {
          if (signal.aborted) return;
          toast(`API YouTube : ${err.message}. Essai via Piped…`);
          result = await searchPiped(query, signal);
        }
      } else {
        result = await searchPiped(query, signal);
      }
    } catch (err) {
      if (signal.aborted || seq !== searchSeq) return;
      state.results = [];
      renderResults();
      status.className = 'status error';
      status.textContent = `La recherche a échoué : ${err.message} Réessayez dans un instant, ou ajoutez une clé YouTube Data API dans les paramètres (⚙).`;
      $('#sourceTag').textContent = '';
      return;
    }
    if (seq !== searchSeq) return;
    state.results = result.tracks;
    $('#sourceTag').textContent = `Source : ${result.source}`;
    status.className = 'status';
    status.textContent = result.tracks.length ? '' : 'Aucun résultat.';
    renderResults();
  }

  const debouncedSearch = debounce(runSearch, SEARCH_DEBOUNCE_MS);

  // ---------- Context menu ----------
  const menu = $('#contextMenu');
  let menuAnchor = null;

  function openMenu(anchor, items) {
    menu.replaceChildren(...items.map((item) => {
      if (item === '-') return el('hr');
      if (item.label) return el('div', { class: 'menu-label', text: item.label });
      return el('button', {
        type: 'button',
        role: 'menuitem',
        class: item.danger ? 'danger' : null,
        text: item.text,
        onclick: () => { closeMenu(); item.action(); },
      });
    }));
    menu.hidden = false;
    menuAnchor = anchor;
    const rect = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = rect.right - mw;
    let top = rect.bottom + 4;
    if (left < 8) left = 8;
    if (left + mw > innerWidth - 8) left = innerWidth - 8 - mw;
    if (top + mh > innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector('button')?.focus();
  }

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    menuAnchor?.focus?.();
    menuAnchor = null;
  }

  function playlistMenuItems(track) {
    return [
      { label: 'Ajouter à une playlist' },
      ...state.playlists.map((pl) => ({ text: pl.name, action: () => addToPlaylist(pl.id, track) })),
      { text: '＋ Nouvelle playlist…', action: () => promptNewPlaylist(track) },
    ];
  }

  function trackMenu(anchor, track, context) {
    const items = [];
    if (context.type !== 'queue') {
      items.push({
        text: 'Lire maintenant',
        action: () => (context.type === 'result' ? playFromResults(context.index) : playNow(track)),
      });
      items.push({ text: 'Lire ensuite', action: () => playNext(track) });
      items.push({ text: 'Ajouter à la file', action: () => addToQueue(track) });
    } else {
      items.push({ text: 'Lire', action: () => { state.index = context.index; persistQueue(); startTrack(true); } });
      items.push({ text: 'Ajouter à la file (à la fin)', action: () => addToQueue(track) });
      if (context.index > 0) items.push({ text: 'Monter', action: () => moveInQueue(context.index, -1) });
      if (context.index < state.queue.length - 1) items.push({ text: 'Descendre', action: () => moveInQueue(context.index, 1) });
    }
    items.push('-', ...playlistMenuItems(track), '-');
    items.push({ text: 'Ouvrir sur YouTube', action: () => window.open(`https://www.youtube.com/watch?v=${track.id}`, '_blank', 'noopener') });
    if (context.type === 'queue') {
      items.push({ text: 'Retirer de la file', danger: true, action: () => removeFromQueue(context.index) });
    }
    if (context.type === 'upnext') {
      items.push({
        text: 'Retirer de « À suivre »',
        danger: true,
        action: () => { state.upNext.splice(context.index, 1); persistQueue(); renderQueue(); },
      });
    }
    if (context.type === 'playlist') {
      items.push({ text: 'Retirer de la playlist', danger: true, action: () => removeFromPlaylist(context.playlistId, context.index) });
    }
    openMenu(anchor, items);
  }

  function moreButton(track, context) {
    return el('button', {
      type: 'button',
      class: 'icon-btn small',
      'aria-label': `Plus d\u2019options pour ${track.title}`,
      'aria-haspopup': 'menu',
      title: 'Plus d\u2019options',
      text: '⋯',
      onclick: (e) => { e.stopPropagation(); trackMenu(e.currentTarget, track, context); },
    });
  }

  // ---------- Rendering ----------
  function renderResults() {
    const cur = currentTrack();
    // The whole card plays on click; the thumbnail button has no handler of its own (its click
    // bubbles here) so keyboard users get a focus target without triggering playback twice.
    const cards = state.results.map((track, i) => el('article', {
      class: `card${cur && cur.id === track.id ? ' playing' : ''}`,
      dataset: { vid: track.id },
      onclick: () => playFromResults(i),
    },
      el('button', {
        type: 'button',
        class: 'thumb-wrap',
        'aria-label': `Lire ${track.title}`,
      },
      thumbImg(track, i < 12),
      track.duration ? el('span', { class: 'duration', text: formatTime(track.duration) }) : el('span', { class: 'duration', text: 'Direct' }),
      el('span', { class: 'thumb-play', 'aria-hidden': 'true', text: '▶' })),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-text' },
          el('h3', { class: 'card-title', title: track.title, text: track.title }),
          el('div', { class: 'card-channel', text: track.channel })),
        moreButton(track, { type: 'result', index: i }))));
    $('#results').replaceChildren(...cards);
  }

  // Toggle the "playing" mark without rebuilding the grid (rebuilding re-creates every <img>).
  function updateResultHighlight() {
    const cur = currentTrack();
    document.querySelectorAll('#results .card').forEach((card) => {
      card.classList.toggle('playing', Boolean(cur && card.dataset.vid === cur.id));
    });
  }

  function trackRow(track, i, { playing, onPlay, context }) {
    return el('li', { class: `track${playing ? ' playing' : ''}` },
      el('span', { class: 'track-num', text: playing ? '♪' : String(i + 1) }),
      el('button', { type: 'button', class: 'track-thumb', 'aria-label': `Lire ${track.title}`, onclick: onPlay },
        thumbImg(track)),
      el('button', { type: 'button', class: 'track-main', onclick: onPlay },
        el('div', { class: 'track-title', title: track.title, text: track.title }),
        el('div', { class: 'track-channel', text: track.channel })),
      el('span', { class: 'track-dur', text: track.duration ? formatTime(track.duration) : '' }),
      moreButton(track, context));
  }

  function renderQueue() {
    $('#queueCount').textContent = state.queue.length;
    $('#queueStatus').textContent = state.queue.length ? '' : 'Votre file d\u2019attente est vide. Ajoutez des titres depuis la recherche ou une playlist.';
    $('#clearQueue').hidden = !state.queue.length;
    $('#queueList').replaceChildren(...state.queue.map((track, i) => trackRow(track, i, {
      playing: i === state.index,
      onPlay: () => { state.index = i; persistQueue(); startTrack(true); },
      context: { type: 'queue', index: i },
    })));
    $('#upNextSection').hidden = !state.upNext.length;
    $('#upNextCount').textContent = countLabel(state.upNext.length);
    $('#upNextList').replaceChildren(...state.upNext.map((track, j) => trackRow(track, j, {
      playing: false,
      onPlay: () => {
        const [picked] = state.upNext.splice(j, 1);
        playNow(picked);
      },
      context: { type: 'upnext', index: j },
    })));
  }

  function playlistCover(pl) {
    const thumbs = pl.tracks.slice(0, 4);
    if (!thumbs.length) return el('div', { class: 'pl-cover' }, el('span', { class: 'pl-empty', text: '♫' }));
    const single = thumbs.length < 4;
    const shown = single ? thumbs.slice(0, 1) : thumbs;
    return el('div', { class: `pl-cover${single ? ' single' : ''}` },
      shown.map((t) => thumbImg(t)));
  }


  function renderPlaylists() {
    const side = $('#sidebarPlaylists');
    if (!state.playlists.length) {
      side.replaceChildren(el('li', { class: 'sidebar-empty', text: 'Aucune playlist pour l\u2019instant.' }));
    } else {
      side.replaceChildren(...state.playlists.map((pl) => el('li', {},
        el('button', {
          type: 'button',
          class: state.view === 'playlist' && state.openPlaylistId === pl.id ? 'active' : null,
          title: pl.name,
          text: pl.name,
          onclick: () => openPlaylist(pl.id),
        }))));
    }
    $('#playlistsStatus').textContent = state.playlists.length ? '' : 'Créez votre première playlist, puis ajoutez-y des titres via le menu ⋯ des résultats.';
    $('#playlistGrid').replaceChildren(...state.playlists.map((pl) => el('button', {
      type: 'button',
      class: 'pl-card',
      onclick: () => openPlaylist(pl.id),
    }, playlistCover(pl), el('div', { class: 'pl-name', text: pl.name }), el('div', { class: 'pl-count', text: countLabel(pl.tracks.length) }))));
    renderPlaylistDetail();
  }

  function renderPlaylistDetail() {
    const pl = findPlaylist(state.openPlaylistId);
    if (!pl) return;
    $('#playlistName').textContent = pl.name;
    $('#playlistStatus').textContent = pl.tracks.length ? countLabel(pl.tracks.length) : 'Playlist vide. Utilisez « Ajouter à une playlist » dans le menu ⋯ d\u2019un résultat.';
    const cur = currentTrack();
    $('#playlistTracks').replaceChildren(...pl.tracks.map((track, i) => trackRow(track, i, {
      playing: Boolean(cur && cur.id === track.id),
      onPlay: () => {
        state.queue = pl.tracks.map(makeTrack);
        state.upNext = [];
        state.index = i;
        state.shuffleHistory = [];
        failedIds.clear();
        persistQueue();
        startTrack(true);
      },
      context: { type: 'playlist', playlistId: pl.id, index: i },
    })));
  }

  function renderNowPlaying() {
    const track = currentTrack();
    const thumb = $('#nowThumb');
    if (track) {
      thumb.dataset.vid = track.id;
      delete thumb.dataset.fellBack;
      thumb.src = trackThumb(track);
      thumb.hidden = false;
      $('#nowTitle').textContent = track.title;
      $('#nowTitle').title = track.title;
      $('#nowChannel').textContent = track.channel;
      document.title = `${track.title} · Ondo`;
    } else {
      thumb.hidden = true;
      thumb.removeAttribute('src');
      $('#nowTitle').textContent = 'Aucune lecture';
      $('#nowTitle').title = '';
      $('#nowChannel').textContent = '';
      document.title = 'Ondo — lecteur musique & vidéo';
    }
  }

  function renderToggles() {
    const shuffleBtn = $('#shuffleBtn');
    shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));
    const repeatBtn = $('#repeatBtn');
    repeatBtn.setAttribute('aria-pressed', String(state.repeat !== 'off'));
    const repeatLabels = { off: 'désactivé', all: 'toute la file', one: 'titre en cours' };
    repeatBtn.setAttribute('aria-label', `Répéter : ${repeatLabels[state.repeat]}`);
    repeatBtn.title = `Répéter : ${repeatLabels[state.repeat]}`;
    $('#repeatOne').hidden = state.repeat !== 'one';
    const videoBtn = $('#videoBtn');
    videoBtn.setAttribute('aria-pressed', String(state.videoVisible));
    videoBtn.setAttribute('aria-label', state.videoVisible ? 'Masquer la vidéo' : 'Afficher la vidéo');
    $('#videoPanel').dataset.visible = String(state.videoVisible);
    $('#app').classList.toggle('video-open', state.videoVisible);
  }

  // ---------- Views ----------
  function showView(view) {
    state.view = view;
    for (const v of ['search', 'queue', 'playlists', 'playlist']) {
      $(`#view-${v}`).hidden = v !== view;
    }
    document.querySelectorAll('.nav-item').forEach((btn) => {
      const target = btn.dataset.view;
      btn.classList.toggle('active', target === view || (view === 'playlist' && target === 'playlists'));
    });
    if (view === 'queue') renderQueue();
    renderPlaylists();
    $('#main').scrollTop = 0;
    closeSidebar();
  }

  function openPlaylist(id) {
    state.openPlaylistId = id;
    showView('playlist');
  }

  function openSidebar() {
    $('#app').classList.add('sidebar-open');
    $('#scrim').hidden = false;
  }

  function closeSidebar() {
    $('#app').classList.remove('sidebar-open');
    $('#scrim').hidden = true;
  }

  // ---------- Dialogs ----------
  function askText(title, initial) {
    const modal = $('#promptModal');
    const input = $('#promptInput');
    $('#promptTitle').textContent = title;
    input.value = initial || '';
    return new Promise((resolve) => {
      const finish = (value) => {
        modal.removeEventListener('close', onClose);
        $('#promptForm').removeEventListener('submit', onSubmit);
        $('#promptCancel').removeEventListener('click', onCancel);
        resolve(value);
      };
      const onSubmit = (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        modal.close();
        finish(value);
      };
      const onCancel = () => { modal.close(); };
      const onClose = () => finish(null);
      $('#promptForm').addEventListener('submit', onSubmit);
      $('#promptCancel').addEventListener('click', onCancel);
      modal.addEventListener('close', onClose);
      modal.showModal();
      input.select();
    });
  }

  function openSettings() {
    $('#apiKeyInput').value = state.apiKey;
    $('#settingsModal').showModal();
  }

  // ---------- Media Session (lock screen / hardware keys) ----------
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const track = currentTrack();
    if (!track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.channel,
      album: 'Ondo',
      artwork: [{ src: `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }],
    });
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => { if (!state.isPlaying) togglePlay(); },
      pause: () => { if (state.isPlaying) togglePlay(); },
      previoustrack: prev,
      nexttrack: () => next(false),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
    }
  }

  // ---------- Events ----------
  function bindEvents() {
    document.querySelectorAll('.nav-item').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));
    $('#menuBtn').addEventListener('click', openSidebar);
    $('#sidebarClose').addEventListener('click', closeSidebar);
    $('#scrim').addEventListener('click', closeSidebar);

    const input = $('#searchInput');
    input.addEventListener('input', () => {
      if (state.view !== 'search') showView('search');
      debouncedSearch(input.value);
    });
    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      showView('search');
      runSearch(input.value);
      input.blur();
    });

    $('#playBtn').addEventListener('click', togglePlay);
    $('#nextBtn').addEventListener('click', () => next(false));
    $('#prevBtn').addEventListener('click', prev);
    $('#shuffleBtn').addEventListener('click', () => {
      state.shuffle = !state.shuffle;
      state.shuffleHistory = [];
      save('shuffle', state.shuffle);
      renderToggles();
      toast(state.shuffle ? 'Lecture aléatoire activée' : 'Lecture aléatoire désactivée');
    });
    $('#repeatBtn').addEventListener('click', () => {
      state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat] || 'off';
      save('repeat', state.repeat);
      renderToggles();
    });
    $('#videoBtn').addEventListener('click', () => {
      state.videoVisible = !state.videoVisible;
      save('videoVisible', state.videoVisible);
      renderToggles();
    });

    const seek = $('#seek');
    seek.addEventListener('input', () => {
      seeking = true;
      setRangeFill(seek);
      $('#curTime').textContent = formatTime(seek.value);
    });
    seek.addEventListener('change', () => {
      if (playerReady && currentTrack()) player.seekTo(Number(seek.value), true);
      seeking = false;
      setTimeout(updateProgress, 250);
    });

    const vol = $('#volume');
    vol.addEventListener('input', () => {
      state.volume = Number(vol.value);
      state.muted = false;
      save('volume', state.volume);
      save('muted', false);
      applyVolume();
    });
    $('#muteBtn').addEventListener('click', () => {
      state.muted = !state.muted;
      save('muted', state.muted);
      applyVolume();
    });

    $('#clearQueue').addEventListener('click', () => {
      if (confirm('Vider la file d\u2019attente ?')) clearQueue();
    });
    $('#newPlaylist').addEventListener('click', () => promptNewPlaylist(null));
    $('#sidebarNewPlaylist').addEventListener('click', () => promptNewPlaylist(null));
    $('#backToPlaylists').addEventListener('click', () => showView('playlists'));
    $('#playPlaylist').addEventListener('click', () => playList(findPlaylist(state.openPlaylistId)?.tracks || []));
    $('#queuePlaylist').addEventListener('click', () => {
      const pl = findPlaylist(state.openPlaylistId);
      if (!pl?.tracks.length) { toast('Cette playlist est vide.'); return; }
      const wasEmpty = !state.queue.length;
      state.queue.push(...pl.tracks.map(makeTrack));
      if (state.index < 0) state.index = 0;
      persistQueue();
      renderQueue();
      if (wasEmpty) startTrack(false);
      toast(`${countLabel(pl.tracks.length)} ajouté${pl.tracks.length > 1 ? 's' : ''} à la file`);
    });
    $('#renamePlaylist').addEventListener('click', renameOpenPlaylist);
    $('#deletePlaylist').addEventListener('click', deleteOpenPlaylist);

    $('#settingsBtn').addEventListener('click', openSettings);
    $('#cancelSettings').addEventListener('click', () => $('#settingsModal').close());
    $('#clearKey').addEventListener('click', () => { $('#apiKeyInput').value = ''; });
    $('#settingsForm').addEventListener('submit', () => {
      state.apiKey = $('#apiKeyInput').value.trim();
      save('apiKey', state.apiKey);
      toast(state.apiKey ? 'Clé enregistrée : recherche via l\u2019API officielle' : 'Aucune clé : recherche via Piped');
      if ($('#searchInput').value.trim()) runSearch($('#searchInput').value);
    });

    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target)) closeMenu();
    });
    window.addEventListener('resize', closeMenu);
    $('#main').addEventListener('scroll', closeMenu, { passive: true });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeMenu(); closeSidebar(); return; }
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.code === 'Space' && tag !== 'BUTTON') { e.preventDefault(); togglePlay(); }
      else if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
      else if (e.shiftKey && e.key === 'ArrowRight') next(false);
      else if (e.shiftKey && e.key === 'ArrowLeft') prev();
    });
  }

  // Exposes the open panel's height as --video-h so the scroll area can reserve room for it.
  function observeVideoPanel() {
    const panel = $('#videoPanel');
    const app = $('#app');
    const update = () => app.style.setProperty('--video-h', `${Math.ceil(panel.getBoundingClientRect().height)}px`);
    update();
    if ('ResizeObserver' in window) new ResizeObserver(update).observe(panel);
    else window.addEventListener('resize', update);
  }

  // ---------- Init ----------
  function init() {
    bindEvents();
    $('#nowThumb').addEventListener('error', onThumbError);
    observeVideoPanel();
    renderToggles();
    applyVolume();
    renderNowPlaying();
    renderQueue();
    renderPlaylists();
    renderResults();
    setupMediaSession();
    loadYouTubeApi();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
      });
    }
  }

  init();
})();
