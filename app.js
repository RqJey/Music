/* mibbi Music — provider-based playback layer */
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const audio = $("#audio");
const STORAGE_KEY = "mibbi-player-v3";
const SOURCES_KEY = "mibbi-sources-v1";

const state = {
  queue: [], index: -1, volume: 0.8, shuffle: false, repeat: false,
  videoMode: false, theme: localStorage.getItem("mibbi-theme") || "dark",
  sources: { youtube: true, soundcloud: true, local: true }
};
let localTracks = [];
let favorites = {};
try { favorites = JSON.parse(localStorage.getItem("mibbi-favs-v2") || "{}"); } catch { favorites = {}; }
if (Array.isArray(favorites)) favorites = {};
let ytPlayer = null, ytReady = false, scWidget = null, scReady = false;
let activeProvider = null, searchToken = 0, currentTab = "all", progressTimer = null;

function toast(message) {
  const node = $("#toast"); node.textContent = message; node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 2400);
}
function setStatus(message, error = false) {
  $("#playerStatus").textContent = message;
  $("#playerStatus").classList.toggle("error", error);
}
function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2,"0")}`;
}
function currentTrack() { return state.queue[state.index] || null; }

function trackSnapshot(track) {
  if (!track) return null;
  return {
    id:track.id, title:track.title, artist:track.artist, source:track.source,
    videoId:track.videoId || null, permalink_url:track.permalink_url || null,
    artwork:track.artwork || "", duration:Number(track.duration)||0,
    preview:!!track.preview, unavailable:!!track.unavailable,
    objectUrl: null
  };
}
function saveFavorites() {
  localStorage.setItem("mibbi-favs-v2", JSON.stringify(favorites));
  renderFavoriteCount();
}
function isLiked(track) { return !!(track && favorites[track.id]); }
function toggleLike(track) {
  if (!track) return;
  if (isLiked(track)) {
    delete favorites[track.id];
    toast("Убрано из любимых");
  } else {
    favorites[track.id] = { ...trackSnapshot(track), likedAt: Date.now() };
    toast("Добавлено в любимые");
  }
  saveFavorites();
  refreshLikeButtons();
  if (!$("#favoritesView").classList.contains("hidden")) renderFavorites();
}
function refreshLikeButtons() {
  $$("[data-like-id]").forEach(button => {
    const liked = !!favorites[button.dataset.likeId];
    button.classList.toggle("liked", liked);
    button.textContent = liked ? "♥" : "♡";
    button.setAttribute("aria-label", liked ? "Убрать из любимых" : "Добавить в любимые");
  });
  const track = currentTrack();
  $("#likeBtn").textContent = isLiked(track) ? "♥" : "♡";
  $("#likeBtn").classList.toggle("liked", isLiked(track));
}
function renderFavoriteCount() {
  const count = Object.keys(favorites).length;
  if ($("#favoriteCount")) $("#favoriteCount").textContent = count;
  if ($("#favoritesHeadingCount")) $("#favoritesHeadingCount").textContent = `${count} ${count === 1 ? "трек" : count < 5 ? "трека" : "треков"} · Лайки хранятся только на этом устройстве`;
}
function saveState() {
  const queue = state.queue.map(trackSnapshot).filter(Boolean);
  const current = currentTrack();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    queue, currentId: current?.source !== "local" ? current?.id : null,
    index: current?.source !== "local" ? queue.findIndex(t => t.id === current.id) : -1,
    volume: state.volume, shuffle: state.shuffle, repeat: state.repeat,
    videoMode: state.videoMode
  }));
  localStorage.setItem(SOURCES_KEY, JSON.stringify(state.sources));
  renderQueueCount();
}

let pendingResume = null;
function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (Array.isArray(saved.queue)) state.queue = saved.queue;
    if (typeof saved.volume === "number") state.volume = saved.volume;
    state.shuffle = !!saved.shuffle; state.repeat = !!saved.repeat; state.videoMode = !!saved.videoMode;
    if (saved.currentId) {
      const index = state.queue.findIndex(t => t.id === saved.currentId && t.source !== "local");
      if (index >= 0) pendingResume = { index, title: state.queue[index].title };
    }
    const sources = JSON.parse(localStorage.getItem(SOURCES_KEY) || "{}");
    state.sources = { ...state.sources, ...sources };
    state.index = -1; // Never autoplay external sources after a reload.
  } catch { localStorage.removeItem(STORAGE_KEY); }
}

function setTheme(theme) {
  const resolved = theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
  document.documentElement.dataset.theme = resolved;
  state.theme = theme; localStorage.setItem("mibbi-theme", theme);
  $$("[data-theme-choice]").forEach(b => b.classList.toggle("chosen", b.dataset.themeChoice === theme));
}
restoreState(); setTheme(state.theme);

$("#themeBtn").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
$("#settingsBtn").addEventListener("click", () => $("#settingsModal").classList.remove("hidden"));
$("#closeSettings").addEventListener("click", () => $("#settingsModal").classList.add("hidden"));
$("#settingsModal").addEventListener("click", e => { if (e.target === $("#settingsModal")) $("#settingsModal").classList.add("hidden"); });
$$("[data-theme-choice]").forEach(b => b.addEventListener("click", () => setTheme(b.dataset.themeChoice)));

function showView(name) {
  $$(".view").forEach(v => v.classList.add("hidden"));
  $(`#${name}View`).classList.remove("hidden");
  $$(".nav-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === name));
}
$$(".nav-item[data-view]").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
$$("[data-goto]").forEach(b => b.addEventListener("click", () => showView(b.dataset.goto)));
$("#heroSearch").addEventListener("click", () => showView("search"));
$("#backBtn").addEventListener("click", () => history.back());
$("#forwardBtn").addEventListener("click", () => history.forward());

/* Shared provider contract: play(track), pause(), seek(seconds), setVolume(0..1), stop(). */
class YouTubeProvider {
  constructor() { this.name = "youtube"; }
  play(track) {
    if (!ytReady) { setStatus("Подключаем YouTube-плеер…"); return; }
    this.stop();
    ytPlayer.loadVideoById({ videoId: track.videoId, startSeconds: 0 });
  }
  pause() { if (ytReady) ytPlayer.pauseVideo(); }
  seek(sec) { if (ytReady) ytPlayer.seekTo(Math.max(0, sec), true); }
  setVolume(v) { if (ytReady) ytPlayer.setVolume(Math.round(v * 100)); }
  stop() { if (ytReady) ytPlayer.stopVideo(); }
  resume() { if (ytReady) ytPlayer.playVideo(); }
  currentTime() { return ytReady ? ytPlayer.getCurrentTime() : 0; }
  duration() { return ytReady ? ytPlayer.getDuration() : 0; }
}
class SoundCloudProvider {
  constructor() { this.name = "soundcloud"; this.position = 0; this.length = 0; }
  play(track) {
    if (!scReady || !scWidget) { setStatus("Подключаем SoundCloud Widget…"); return; }
    this.stop();
    const url = track.permalink_url;
    if (!url) { setStatus("У SoundCloud-трека нет адреса для встраивания", true); return; }
    scWidget.load(url, { auto_play: true, show_artwork: false, visual: false, buying: false, sharing: false, liking: false, download: false, show_comments: false });
    scWidget.setVolume(Math.round(state.volume * 100));
    setStatus("Загрузка SoundCloud…");
  }
  pause() { if (scWidget) scWidget.pause(); }
  seek(sec) { if (scWidget) scWidget.seekTo(sec * 1000); }
  setVolume(v) { if (scWidget) scWidget.setVolume(Math.round(v * 100)); }
  stop() { if (scWidget) scWidget.pause(); }
  resume() { if (scWidget) scWidget.play(); }
  currentTime() { return 0; }
  duration() { return 0; }
}
class LocalFileProvider {
  constructor() { this.name = "local"; }
  play(track) {
    audio.src = track.objectUrl;
    audio.volume = state.volume;
    audio.play().then(() => setStatus("Воспроизводится локальный файл"))
      .catch(() => setStatus("Не удалось воспроизвести файл", true));
  }
  pause() { audio.pause(); }
  seek(sec) { audio.currentTime = Math.max(0, sec); }
  setVolume(v) { audio.volume = v; }
  stop() { audio.pause(); audio.removeAttribute("src"); audio.load(); }
  resume() { audio.play().catch(() => setStatus("Не удалось продолжить воспроизведение", true)); }
  currentTime() { return audio.currentTime || 0; }
  duration() { return audio.duration || 0; }
}
const providers = {
  youtube: new YouTubeProvider(),
  soundcloud: new SoundCloudProvider(),
  local: new LocalFileProvider()
};

function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player("ytPlayer", {
    width:"1", height:"1", videoId:"",
    playerVars:{ autoplay:0, controls:0, disablekb:1, playsinline:1, rel:0, origin:location.origin },
    events:{
      onReady:() => { ytReady = true; providers.youtube.setVolume(state.volume); if (currentTrack()?.source === "youtube") playCurrent(); },
      onStateChange:onYouTubeStateChange, onError:onYouTubeError
    }
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function initSoundCloudWidget() {
  const iframe = $("#scWidget");
  iframe.src = "https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2F&auto_play=false&hide_related=true&show_comments=false&show_user=false&show_reposts=false&visual=false";
  if (!window.SC || !SC.Widget) return;
  scWidget = SC.Widget(iframe);
  scWidget.bind(SC.Widget.Events.READY, () => {
    scReady = true; providers.soundcloud.setVolume(state.volume);
    if (currentTrack()?.source === "soundcloud") playCurrent();
  });
  scWidget.bind(SC.Widget.Events.PLAY, () => { setStatus("Сейчас играет · SoundCloud"); $("#playBtn").textContent = "Ⅱ"; });
  scWidget.bind(SC.Widget.Events.PAUSE, () => { setStatus("На паузе"); $("#playBtn").textContent = "▶"; });
  scWidget.bind(SC.Widget.Events.FINISH, playNext);
  scWidget.bind(SC.Widget.Events.ERROR, () => setStatus("SoundCloud-трек недоступен для встраивания", true));
  scWidget.bind(SC.Widget.Events.PLAY_PROGRESS, e => {
    if (currentTrack()?.source !== "soundcloud") return;
    const sec = e.currentPosition / 1000, total = e.loadedProgress ? 0 : 0;
    $("#currentTime").textContent = formatTime(sec);
  });
}
if (window.SC?.Widget) initSoundCloudWidget();
else window.addEventListener("load", () => { if (window.SC?.Widget) initSoundCloudWidget(); });

function onYouTubeStateChange(event) {
  if (currentTrack()?.source !== "youtube") return;
  if (event.data === YT.PlayerState.PLAYING) { setStatus("Сейчас играет · YouTube"); $("#playBtn").textContent = "Ⅱ"; }
  else if (event.data === YT.PlayerState.PAUSED) { setStatus("На паузе"); $("#playBtn").textContent = "▶"; }
  else if (event.data === YT.PlayerState.ENDED) state.repeat ? providers.youtube.seek(0) || providers.youtube.resume() : playNext();
  else if (event.data === YT.PlayerState.BUFFERING) setStatus("Буферизация…");
}
function onYouTubeError(event) {
  const messages = {2:"Некорректный идентификатор видео",5:"Видео не поддерживается",100:"Видео удалено или недоступно",101:"Автор запретил встраивание",150:"Автор запретил встраивание",153:"YouTube не получил идентификатор клиента"};
  markUnavailable(currentTrack(), messages[event.data] || "Видео недоступно");
}
function markUnavailable(track, message) {
  if (!track) return;
  track.unavailable = true;
  setStatus(message, true); $("#playBtn").textContent = "▶";
  const row = $(`[data-track-id="${CSS.escape(track.id)}"]`);
  if (row) row.classList.add("unavailable");
}

function renderSkeletons() {
  $("#searchResults").innerHTML = Array.from({length:5}, () => '<div class="skeleton-result"><span></span><div><i></i><i></i></div><b></b></div>').join("");
}
// Keep this list aligned with the public instances documented by Invidious.
// Public instances can rate-limit, block browser CORS, or temporarily go offline.
const invidiousInstances = [
  "https://invidious.nerdvpn.de",
  "https://yt.chocolatemoo53.com",
  "https://invidious.tiekoetter.com",
  "https://inv.nadeko.net"
];
async function fetchWithTimeout(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
      mode: "cors",
      cache: "no-store"
    });
  } finally {
    clearTimeout(timer);
  }
}
async function searchYouTube(query) {
  const failures = [];
  for (const host of invidiousInstances) {
    try {
      const response = await fetchWithTimeout(
        `${host}/api/v1/search?q=${encodeURIComponent(query)}&type=video`
      );
      if (!response.ok) {
        failures.push(`${new URL(host).host}: HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      if (!Array.isArray(data)) {
        failures.push(`${new URL(host).host}: неожиданный ответ API`);
        continue;
      }
      const tracks = data
        .filter(item => item && item.type === "video" && item.videoId)
        .slice(0, 15)
        .map(item => ({
          id: `yt-${item.videoId}`,
          videoId: item.videoId,
          title: item.title || "Без названия",
          artist: item.author || "YouTube",
          duration: Number(item.lengthSeconds) || 0,
          source: "youtube",
          artwork: `https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/hqdefault.jpg`
        }));
      if (tracks.length) return tracks;
      failures.push(`${new URL(host).host}: пустая выдача`);
    } catch (error) {
      failures.push(`${new URL(host).host}: ${error.name === "AbortError" ? "тайм-аут" : "сеть/CORS"}`);
    }
  }
  const error = new Error("Не удалось получить результаты YouTube. Публичные поисковые серверы могут быть недоступны или блокировать запросы с GitHub Pages.");
  error.details = failures;
  throw error;
}
function searchSoundCloud(query) {
  // Widget API can play a known track permalink, but it does not provide anonymous catalogue search.
  return [{
    id: `sc-search-${Date.now()}`,
    title: `Искать «${query}» в SoundCloud`,
    artist: "SoundCloud · откроется страница поиска",
    source: "soundcloud",
    permalink_url: `https://soundcloud.com/search/sounds?q=${encodeURIComponent(query)}`,
    artwork: "",
    searchShortcut: true
  }];
}
function renderSearchFailure(query, details = []) {
  const detailText = details.length
    ? `<details class="search-diagnostics"><summary>Подробности</summary><small>${details.map(escapeHTML).join("<br>")}</small></details>`
    : "";
  $("#searchResults").innerHTML = `
    <div class="search-placeholder search-error">
      <span>!</span><b>Не удалось выполнить поиск</b>
      <p>Публичные поисковые серверы YouTube не ответили. Это не ошибка введённого запроса. Попробуй ещё раз чуть позже.</p>
      <button class="outline-btn" id="retrySearch">Повторить поиск</button>
      ${detailText}
    </div>`;
  $("#retrySearch")?.addEventListener("click", searchTracks);
}
function sourceLabel(track) {
  if (track.preview || track.source === "preview") return "Превью 30с";
  return ({youtube:"YouTube",soundcloud:"SoundCloud",local:"Мои файлы"})[track.source] || track.source;
}
function coverMarkup(track, sizeClass="") {
  const src = track.artwork || "";
  return `<span class="cover-frame ${sizeClass} ${src ? "is-loading" : "is-placeholder"}">${src ? `<img src="${escapeHTML(src)}" alt="" loading="lazy" onload="this.parentElement.classList.remove('is-loading')" onerror="this.remove();this.parentElement.classList.remove('is-loading');this.parentElement.classList.add('is-placeholder')">` : `<span class="vinyl-placeholder"><span>♫</span></span>`}</span>`;
}
async function enrichArtwork(track) {
  if (!track || track.searchShortcut || track.source === "local" || track.artwork) return track;
  if (track.artwork_url) {
    track.artwork = track.artwork_url.replace("-large", "-t500x500");
    updateTrackArtwork(track);
    return track;
  }
  const term = `${track.artist || ""} ${track.title || ""}`.trim();
  if (!term) return track;
  try {
    const response = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`);
    if (response.ok) {
      const data = await response.json(), result = data.results?.[0];
      if (result?.artworkUrl100) {
        track.artwork = result.artworkUrl100.replace(/100x100bb/i, "200x200bb");
        updateTrackArtwork(track);
        return track;
      }
    }
  } catch { /* Try Deezer below. */ }
  try {
    const response = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(term)}`);
    if (response.ok) {
      const data = await response.json(), result = data.data?.[0];
      if (result?.album?.cover_big || result?.album?.cover_medium) {
        track.artwork = result.album.cover_big || result.album.cover_medium;
        updateTrackArtwork(track);
      }
    }
  } catch { /* Use the shared vinyl placeholder when no cover provider responds. */ }
  return track;
}
function updateTrackArtwork(track) {
  $$(`[data-cover-id="${CSS.escape(track.id)}"]`).forEach(node => {
    node.innerHTML = coverMarkup(track);
  });
  if (currentTrack()?.id === track.id) {
    $("#cover").style.backgroundImage = track.artwork ? `url("${track.artwork}")` : "";
    $("#cover").textContent = track.artwork ? "" : "♫";
    $("#cover").classList.toggle("vinyl-cover", !track.artwork);
  }
  renderQueue();
}
function attachLikeActions() {
  $$("[data-like-id]").forEach(button => {
    button.onclick = e => {
      e.stopPropagation();
      toggleLike(findTrack(button.dataset.likeId));
    };
  });
}
function findTrack(id) {
  return state.queue.find(t=>t.id===id) || localTracks.find(t=>t.id===id) ||
    Object.values(favorites).find(t=>t.id===id) || null;
}
function renderTrackRow(track, index, context="search") {
  return `<article class="youtube-result track-row ${track.unavailable ? "unavailable" : ""}" data-track-id="${escapeHTML(track.id)}">
    <span class="track-cover" data-cover-id="${escapeHTML(track.id)}">${coverMarkup(track)}</span>
    <div class="youtube-result-copy"><b>${escapeHTML(track.title)}</b><small>${escapeHTML(track.artist || "")}${track.duration ? " · "+formatTime(track.duration) : ""}</small><span class="source-badge source-${escapeHTML(track.source)}">${sourceLabel(track)}</span></div>
    <button class="queue-add-inline" data-add-queue="${index}" title="Добавить в очередь">＋</button>
    <button class="heart row-heart ${isLiked(track) ? "liked" : ""}" data-like-id="${escapeHTML(track.id)}" title="В избранное">${isLiked(track) ? "♥" : "♡"}</button>
    <button class="result-play" data-row-play="${index}" title="Играть">▶</button>
  </article>`;
}
function wireRows(container, tracks, playHandler) {
  container.querySelectorAll("[data-row-play]").forEach(button => button.addEventListener("click", () => {
    const track=tracks[Number(button.dataset.rowPlay)];
    if(track?.source==="local"&&!track.objectUrl){toast("Загрузи этот локальный файл заново");return;}
    playHandler(track);
  }));
  container.querySelectorAll("[data-add-queue]").forEach(button => button.addEventListener("click", () => addToQueue(tracks[Number(button.dataset.addQueue)])));
  attachLikeActions();
}
function renderQueueCount() {
  const count = state.queue.length;
  if ($("#queueCount")) $("#queueCount").textContent = count;
  if ($("#queueHeadingCount")) $("#queueHeadingCount").textContent = `· ${count} ${count===1?"трек":count<5?"трека":"треков"}`;
}
function renderQueue() {
  const list = $("#queueList");
  if (!list) return;
  if (!state.queue.length) {
    list.innerHTML = '<div class="queue-empty"><span>☷</span><b>Очередь пуста</b><small>Найди трек и добавь его в воспроизведение</small></div>';
    renderQueueCount(); return;
  }
  list.innerHTML = state.queue.map((track,index)=>`
    <article class="queue-row ${index===state.index?"is-current":""}" data-queue-index="${index}" data-queue-id="${escapeHTML(track.id)}">
      <span class="drag-handle" aria-label="Перетащить">⠿</span>
      <span class="queue-cover" data-cover-id="${escapeHTML(track.id)}">${coverMarkup(track)}</span>
      <div class="queue-track-copy"><b>${escapeHTML(track.title)}</b><small>${escapeHTML(track.artist||"")}</small><span class="source-badge source-${escapeHTML(track.source)}">${sourceLabel(track)}</span></div>
      <button class="queue-next" data-queue-next="${index}" title="Играть следующим">↥</button>
      <button class="heart row-heart ${isLiked(track)?"liked":""}" data-like-id="${escapeHTML(track.id)}" title="В избранное">${isLiked(track)?"♥":"♡"}</button>
      <button class="queue-remove" data-queue-remove="${index}" title="Удалить">×</button>
    </article>`).join("");
  list.querySelectorAll("[data-queue-remove]").forEach(button=>button.addEventListener("click",()=>removeQueueItem(Number(button.dataset.queueRemove))));
  list.querySelectorAll("[data-queue-next]").forEach(button=>button.addEventListener("click",()=>moveQueueNext(Number(button.dataset.queueNext))));
  list.querySelectorAll(".queue-row").forEach(row=>wireQueueDrag(row));
  attachLikeActions(); renderQueueCount();
}
function addToQueue(track, playNext=false) {
  if (!track || track.searchShortcut) return;
  const copy={...track};
  if (playNext && state.index>=0) state.queue.splice(state.index+1,0,copy);
  else state.queue.push(copy);
  if (state.index<0 && !playNext) state.index=state.queue.length-1;
  saveState(); renderQueue(); toast(playNext?"Добавлено следующим":"Добавлено в очередь");
}
function removeQueueItem(index) {
  if (index<0 || index>=state.queue.length) return;
  const wasCurrent=index===state.index;
  const removed=state.queue[index];
  state.queue.splice(index,1);
  if (index<state.index) state.index--;
  else if (wasCurrent) {
    if (state.queue.length) {
      state.index=Math.min(index,state.queue.length-1);
      activeProvider?.stop(); playCurrent();
    } else {
      state.index=-1; activeProvider?.stop(); activeProvider=null;
      $("#trackTitle").textContent="Ничего не играет"; $("#trackArtist").textContent="Выбери свой первый трек";
      $("#cover").style.backgroundImage=""; $("#cover").textContent="♫";
    }
  }
  saveState(); renderQueue();
}
function moveQueueNext(index) {
  if(index<0||index>=state.queue.length||index===state.index||index===state.index+1)return;
  const [track]=state.queue.splice(index,1);
  const target=state.index<0?0:state.index+1;
  state.queue.splice(target,0,track);
  saveState();renderQueue();toast("Трек будет следующим");
}
function wireQueueDrag(row) {
  const handle=row.querySelector(".drag-handle");
  if(!handle)return;
  let targetIndex=null, pointerId=null;
  handle.addEventListener("pointerdown",e=>{
    pointerId=e.pointerId;targetIndex=Number(row.dataset.queueIndex);
    row.classList.add("dragging");
    handle.setPointerCapture?.(pointerId);
  });
  handle.addEventListener("pointermove",e=>{
    if(pointerId!==e.pointerId)return;
    const target=document.elementFromPoint(e.clientX,e.clientY)?.closest(".queue-row");
    if(target)targetIndex=Number(target.dataset.queueIndex);
  });
  const finish=e=>{
    if(pointerId!==e.pointerId)return;
    const from=Number(row.dataset.queueIndex),to=targetIndex;
    row.classList.remove("dragging");pointerId=null;
    if(Number.isInteger(from)&&Number.isInteger(to)&&from!==to){
      const playingId=currentTrack()?.id;
      const [item]=state.queue.splice(from,1);state.queue.splice(to,0,item);
      state.index=playingId?state.queue.findIndex(t=>t.id===playingId):-1;
      saveState();renderQueue();
    }
  };
  handle.addEventListener("pointerup",finish);
  handle.addEventListener("pointercancel",()=>{row.classList.remove("dragging");pointerId=null;});
}
function renderFavorites() {
  const tracks=Object.values(favorites).sort((a,b)=>(b.likedAt||0)-(a.likedAt||0));
  const list=$("#favoritesList");
  if(!tracks.length){list.innerHTML='<div class="search-placeholder"><span>♡</span><b>Пока ничего не сохранено</b><p>Отмечай треки сердечком — они появятся здесь.</p></div>';return;}
  list.innerHTML=tracks.map((track,i)=>renderTrackRow(track,i,"favorites")).join("");
  wireRows(list,tracks,track=>{
    if(track.source==="local"&&!localTracks.some(t=>t.id===track.id)){toast("Локальный файл нужно загрузить заново");return;}
    enqueueAndPlay(track,tracks);
  });
}
function renderResults(results) {
  $("#searchResults").innerHTML = results.map((track,index)=>renderTrackRow(track,index)).join("");
  wireRows($("#searchResults"),results,selected=>enqueueAndPlay(selected,results));
  results.forEach(track=>enrichArtwork(track));
}

async function searchTracks() {
  const query = $("#searchInput").value.trim();
  if (!query) return toast("Напиши название трека или исполнителя");
  const token = ++searchToken;
  renderSkeletons();
  const tasks = [];
  let youtubeError = null;

  if ((currentTab === "all" || currentTab === "youtube") && state.sources.youtube) {
    tasks.push(searchYouTube(query).catch(error => {
      youtubeError = error;
      return [];
    }));
  }
  if ((currentTab === "all" || currentTab === "soundcloud") && state.sources.soundcloud) {
    tasks.push(Promise.resolve(searchSoundCloud(query)));
  }
  if ((currentTab === "all" || currentTab === "local") && state.sources.local) {
    tasks.push(Promise.resolve(localTracks.filter(track =>
      `${track.title} ${track.artist}`.toLowerCase().includes(query.toLowerCase())
    )));
  }

  const groups = await Promise.all(tasks);
  if (token !== searchToken) return;
  const results = groups.flat();

  if (!results.length) {
    if (youtubeError) renderSearchFailure(query, youtubeError.details || []);
    else {
      $("#searchResults").innerHTML = '<div class="search-placeholder"><span>⌕</span><b>Ничего не найдено</b><p>Проверь включённые источники или попробуй другой запрос.</p></div>';
    }
    return;
  }
  renderResults(results);
}
$("#searchBtn").addEventListener("click", searchTracks);
$("#searchInput").addEventListener("keydown", e => { if (e.key === "Enter") searchTracks(); });
$("#clearSearch").addEventListener("click", () => { $("#searchInput").value=""; $("#searchInput").focus(); $("#searchResults").innerHTML=""; });
$$("[data-tab]").forEach(b => b.addEventListener("click", () => {
  currentTab = b.dataset.tab;
  $$("[data-tab]").forEach(x => x.classList.toggle("active", x === b));
  if ($("#searchInput").value.trim()) searchTracks();
}));
$$("[data-source]").forEach(b => b.addEventListener("click", () => {
  showView("search"); currentTab = b.dataset.source === "yt" ? "youtube" : b.dataset.source;
  $("#searchInput").focus();
}));

function enqueueAndPlay(track, results) {
  if (!track || track.searchShortcut) return;
  const sourceList = results.filter(item=>!item.searchShortcut);
  const start=sourceList.findIndex(item=>item.id===track.id);
  state.queue=sourceList.map(item=>({...item}));
  state.index=Math.max(0,start);
  $("#searchView").classList.add("hidden");
  saveState(); renderQueue(); playCurrent();
}

function playCurrent() {
  const track = currentTrack();
  if (!track) return;
  if (activeProvider && activeProvider !== providers[track.source]) activeProvider.stop();
  activeProvider = providers[track.source];
  if (!activeProvider) return setStatus("Источник не поддерживается", true);
  if (track.source === "local" && !track.objectUrl) {
    setStatus("Локальный файл нужно загрузить заново", true);
    track.unavailable = true;
    return;
  }
  $("#trackTitle").textContent = track.title;
  $("#trackArtist").textContent = track.artist;
  $("#cover").style.backgroundImage = track.artwork ? `url("${track.artwork}")` : "";
  $("#cover").textContent = track.artwork ? "" : "♫";
  $("#cover").classList.toggle("vinyl-cover", !track.artwork);
  refreshLikeButtons();
  enrichArtwork(track);
  $("#playBtn").textContent = "Ⅱ";
  $("#youtubeStage").classList.toggle("audio-mode", track.source !== "youtube" || !state.videoMode);
  $("#youtubeStage").classList.toggle("video-mode", track.source === "youtube" && state.videoMode);
  $("#soundcloudStage").classList.toggle("active", track.source === "soundcloud");
  setStatus(`Загрузка · ${track.source === "youtube" ? "YouTube" : track.source === "soundcloud" ? "SoundCloud" : "Мои файлы"}`);
  activeProvider.setVolume(state.volume);
  activeProvider.play(track);
  saveState();
}
function playNext() {
  if (!state.queue.length) return;
  if (state.repeat) { playCurrent(); return; }
  if (state.shuffle && state.queue.length > 1) {
    let next = state.index; while (next === state.index) next = Math.floor(Math.random()*state.queue.length);
    state.index = next;
  } else if (state.index < state.queue.length-1) state.index++;
  else { setStatus("Очередь закончилась"); $("#playBtn").textContent="▶"; return; }
  saveState(); playCurrent();
}
function playPrevious() {
  if (activeProvider?.currentTime() > 3) activeProvider.seek(0);
  else { state.index = Math.max(0,state.index-1); playCurrent(); }
}
function togglePlayback() {
  if (!currentTrack()) return toast("Сначала выбери трек");
  if (!activeProvider) return playCurrent();
  if ($("#playBtn").textContent === "Ⅱ") { activeProvider.pause(); $("#playBtn").textContent="▶"; }
  else { activeProvider.resume(); $("#playBtn").textContent="Ⅱ"; }
}
$("#playBtn").addEventListener("click",togglePlayback);
$("#nextBtn").addEventListener("click",playNext);
$("#prevBtn").addEventListener("click",playPrevious);
$("#shuffleBtn").addEventListener("click",() => { state.shuffle=!state.shuffle; $("#shuffleBtn").classList.toggle("selected",state.shuffle); saveState(); });
$("#repeatBtn").addEventListener("click",() => { state.repeat=!state.repeat; $("#repeatBtn").classList.toggle("selected",state.repeat); saveState(); });
$("#volume").value=state.volume;
$("#volume").addEventListener("input",e => { state.volume=Number(e.target.value); activeProvider?.setVolume(state.volume); saveState(); });
$("#videoToggle").addEventListener("click",() => { state.videoMode=!state.videoMode; $("#youtubeStage").classList.toggle("video-mode",state.videoMode && currentTrack()?.source==="youtube"); $("#youtubeStage").classList.toggle("audio-mode",!state.videoMode || currentTrack()?.source!=="youtube"); saveState(); });
$("#seek").addEventListener("input",e => {
  const duration = activeProvider?.duration() || 0;
  if (duration) { const sec=duration*Number(e.target.value)/100; $("#currentTime").textContent=formatTime(sec); }
});
$("#seek").addEventListener("change",e => {
  const duration=activeProvider?.duration()||0;
  if(duration) activeProvider.seek(duration*Number(e.target.value)/100);
});
setInterval(() => {
  if (!activeProvider || !currentTrack()) return;
  const duration=activeProvider.duration(), current=activeProvider.currentTime();
  if (duration>0) {
    $("#seek").value=current/duration*100;
    $("#currentTime").textContent=formatTime(current); $("#duration").textContent=formatTime(duration);
  }
},500);
audio.addEventListener("ended",playNext);
audio.addEventListener("play",() => { if(currentTrack()?.source==="local"){setStatus("Сейчас играет · Мои файлы");$("#playBtn").textContent="Ⅱ";} });
audio.addEventListener("pause",() => { if(currentTrack()?.source==="local") $("#playBtn").textContent="▶"; });
audio.addEventListener("timeupdate",() => { if(currentTrack()?.source==="local" && audio.duration){$("#seek").value=audio.currentTime/audio.duration*100;$("#currentTime").textContent=formatTime(audio.currentTime);$("#duration").textContent=formatTime(audio.duration);} });

function renderLocalTracks() {
  const container=$("#localTracks");
  container.innerHTML=localTracks.map((track,index)=>renderTrackRow(track,index,"local")).join("");
  wireRows(container,localTracks,track=>enqueueAndPlay(track,localTracks));
  localTracks.forEach(track=>enrichArtwork(track));
}
function addFiles(files) {
  [...files].filter(f=>f.type.startsWith("audio/")).forEach(file=>{
    localTracks.push({id:`local-${Date.now()}-${Math.random().toString(36).slice(2)}`,title:file.name.replace(/\.[^.]+$/,""),artist:"Локальный файл",source:"local",objectUrl:URL.createObjectURL(file),artwork:"",file});
  });
  renderLocalTracks(); toast("Файлы добавлены в текущую сессию");
}
$("#chooseFiles").addEventListener("click",()=>$("#fileInput").click());
$("#addLocal").addEventListener("click",()=>{showView("local");$("#fileInput").click();});
$("#libraryAdd").addEventListener("click",()=>{showView("local");$("#fileInput").click();});
$("#fileInput").addEventListener("change",e=>{addFiles(e.target.files);e.target.value="";});
$("#dropzone").addEventListener("dragover",e=>{e.preventDefault();e.currentTarget.classList.add("dragging");});
$("#dropzone").addEventListener("dragleave",e=>e.currentTarget.classList.remove("dragging"));
$("#dropzone").addEventListener("drop",e=>{e.preventDefault();e.currentTarget.classList.remove("dragging");addFiles(e.dataTransfer.files);});
$("#cover").addEventListener("click",()=>{if(currentTrack()?.source==="local") $("#artworkInput").click(); else toast("Своя обложка доступна для локальных треков");});
$("#artworkInput").addEventListener("change",e=>{
  const file=e.target.files[0], track=currentTrack();
  if(file && track?.source==="local" && file.type.startsWith("image/")){
    track.artwork=URL.createObjectURL(file); $("#cover").style.backgroundImage=`url("${track.artwork}")`; $("#cover").textContent="";
    $("#cover").classList.remove("vinyl-cover"); updateTrackArtwork(track);
  }
  e.target.value="";
});
$("#likeBtn").addEventListener("click",()=>toggleLike(currentTrack()));

function openQueue(){renderQueue();$("#queueModal").classList.remove("hidden");}
function closeQueue(){$("#queueModal").classList.add("hidden");}
$("#queueBtn").addEventListener("click",openQueue);
$("#closeQueue").addEventListener("click",closeQueue);
$("#queueDone").addEventListener("click",closeQueue);
$("#queueModal").addEventListener("click",e=>{if(e.target===$("#queueModal"))closeQueue();});
$("#clearQueue").addEventListener("click",()=>{
  state.queue=[];state.index=-1;activeProvider?.stop();activeProvider=null;
  $("#trackTitle").textContent="Ничего не играет";$("#trackArtist").textContent="Выбери свой первый трек";
  $("#cover").style.backgroundImage="";$("#cover").textContent="♫";
  saveState();renderQueue();refreshLikeButtons();toast("Очередь очищена");
});
$("#resumeNotice").classList.toggle("hidden",!pendingResume);
if(pendingResume){
  $("#resumeNotice").innerHTML=`Продолжить с трека: <b>${escapeHTML(pendingResume.title)}</b> <button class="outline-btn" id="resumeTrack">Продолжить</button>`;
  $("#resumeTrack").addEventListener("click",()=>{
    state.index=pendingResume.index;pendingResume=null;$("#resumeNotice").classList.add("hidden");
    playCurrent();renderQueue();
  });
}


$$("[data-source-setting]").forEach(input=>{
  input.checked=state.sources[input.dataset.sourceSetting] !== false;
  input.addEventListener("change",()=>{
    state.sources[input.dataset.sourceSetting]=input.checked;
    saveState();
    if($("#searchInput").value.trim()) searchTracks();
  });
});
$("#videoSetting").checked=state.videoMode;
$("#videoSetting").addEventListener("change",e=>{
  state.videoMode=e.target.checked;
  $("#youtubeStage").classList.toggle("video-mode",state.videoMode && currentTrack()?.source==="youtube");
  $("#youtubeStage").classList.toggle("audio-mode",!state.videoMode || currentTrack()?.source!=="youtube");
  saveState();
});
$("#autoplaySetting").checked=localStorage.getItem("mibbi-auto")!=="false";
$("#autoplaySetting").addEventListener("change",e=>localStorage.setItem("mibbi-auto",e.target.checked));

document.addEventListener("keydown",e=>{
  if(e.key==="Escape"&&!$("#queueModal").classList.contains("hidden")) closeQueue();
  if(e.target.matches("input,textarea,select")||e.target.isContentEditable)return;
  if(e.code==="Space"){e.preventDefault();togglePlayback();}
  else if(e.key==="ArrowLeft"&&activeProvider){e.preventDefault();activeProvider.seek(Math.max(0,activeProvider.currentTime()-5));}
  else if(e.key==="ArrowRight"&&activeProvider){e.preventDefault();activeProvider.seek(activeProvider.currentTime()+5);}
  else if(e.key==="ArrowUp"||e.key==="ArrowDown"){
    e.preventDefault();state.volume=Math.max(0,Math.min(1,state.volume+(e.key==="ArrowUp"?.05:-.05)));
    $("#volume").value=state.volume;activeProvider?.setVolume(state.volume);saveState();
  }
});
$("#shuffleBtn").classList.toggle("selected",state.shuffle);
$("#repeatBtn").classList.toggle("selected",state.repeat);
if(currentTrack()){ $("#trackTitle").textContent=currentTrack().title; $("#trackArtist").textContent=currentTrack().artist; }

renderFavoriteCount();
renderFavorites();
renderQueue();
refreshLikeButtons();
if (pendingResume) {
  $("#resumeNotice").classList.remove("hidden");
}
