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
let favorites = new Set(JSON.parse(localStorage.getItem("mibbi-favs") || "[]"));
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

function saveState() {
  const queue = state.queue.filter(t => t.source !== "local").map(t => ({
    id:t.id, title:t.title, artist:t.artist, videoId:t.videoId,
    permalink_url:t.permalink_url, artwork:t.artwork, source:t.source, duration:t.duration
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    queue, index: state.index, volume: state.volume, shuffle: state.shuffle,
    repeat: state.repeat, videoMode: state.videoMode
  }));
  localStorage.setItem(SOURCES_KEY, JSON.stringify(state.sources));
}
function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (Array.isArray(saved.queue)) state.queue = saved.queue;
    if (Number.isInteger(saved.index)) state.index = saved.index;
    if (typeof saved.volume === "number") state.volume = saved.volume;
    state.shuffle = !!saved.shuffle; state.repeat = !!saved.repeat; state.videoMode = !!saved.videoMode;
    const sources = JSON.parse(localStorage.getItem(SOURCES_KEY) || "{}");
    state.sources = { ...state.sources, ...sources };
  } catch { localStorage.removeItem(STORAGE_KEY); }
  if (state.index >= state.queue.length) state.index = -1;
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
  constructor() { this.name = "soundcloud"; }
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
const invidiousInstances = ["https://inv.nadeko.net","https://inv.tux.pizza","https://invidious.nerdvpn.de"];
async function searchYouTube(query) {
  let lastError;
  for (const host of invidiousInstances) {
    try {
      const response = await fetch(`${host}/api/v1/search?q=${encodeURIComponent(query)}&type=video`);
      if (!response.ok) throw new Error("Search unavailable");
      const data = await response.json();
      return data.filter(x => x.type === "video" && x.videoId).slice(0,12).map(x => ({
        id:`yt-${x.videoId}`, videoId:x.videoId, title:x.title || "Без названия",
        artist:x.author || "YouTube", duration:x.lengthSeconds || 0, source:"youtube",
        artwork:`https://i.ytimg.com/vi/${encodeURIComponent(x.videoId)}/mqdefault.jpg`
      }));
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error("Search unavailable");
}
function searchSoundCloud(query) {
  // SoundCloud does not expose anonymous catalogue search through the Widget API.
  // Present a truthful in-app widget-search attempt; actual track playback requires a track permalink.
  return [{
    id:`sc-search-${Date.now()}`, title:`Поиск «${query}» в SoundCloud`,
    artist:"SoundCloud · поиск в виджете", source:"soundcloud",
    permalink_url:`https://soundcloud.com/search/sounds?q=${encodeURIComponent(query)}`,
    artwork:"", searchShortcut:true
  }];
}
function renderResults(results) {
  $("#searchResults").innerHTML = results.map((t,i) => `
    <article class="youtube-result ${t.unavailable ? "unavailable" : ""}" data-track-id="${escapeHTML(t.id)}">
      <img src="${escapeHTML(t.artwork || (t.source === "youtube" ? "" : ""))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="youtube-result-copy"><b>${escapeHTML(t.title)}</b><small>${escapeHTML(t.artist)}${t.duration ? " · "+formatTime(t.duration) : ""}</small>
      <span class="source-badge source-${t.source}">${t.searchShortcut ? "Поиск SoundCloud" : ({youtube:"YouTube",soundcloud:"SoundCloud",local:"Мои файлы"}[t.source] || t.source)}</span></div>
      <button class="result-play" data-result-index="${i}" title="Играть" ${t.unavailable ? "disabled" : ""}>▶</button>
    </article>`).join("");
  $$(".result-play").forEach(b => b.addEventListener("click", () => {
    const selected = results[Number(b.dataset.resultIndex)];
    if (selected.searchShortcut) {
      enqueueAndPlay(selected, results);
      return;
    }
    enqueueAndPlay(selected, results);
  }));
}
async function searchTracks() {
  const query = $("#searchInput").value.trim();
  if (!query) return toast("Напиши название трека или исполнителя");
  const token = ++searchToken; renderSkeletons();
  const tasks = [];
  if (currentTab === "all" || currentTab === "youtube") {
    if (state.sources.youtube) tasks.push(searchYouTube(query).catch(() => []));
  }
  if (currentTab === "all" || currentTab === "soundcloud") {
    if (state.sources.soundcloud) tasks.push(Promise.resolve(searchSoundCloud(query)));
  }
  if (currentTab === "all" || currentTab === "local") {
    if (state.sources.local) tasks.push(Promise.resolve(localTracks.filter(t => `${t.title} ${t.artist}`.toLowerCase().includes(query.toLowerCase()))));
  }
  const groups = await Promise.all(tasks);
  if (token !== searchToken) return;
  const results = groups.flat();
  if (!results.length) {
    $("#searchResults").innerHTML = '<div class="search-placeholder"><span>⌕</span><b>Ничего не найдено</b><p>Проверь включённые источники или попробуй другой запрос.</p></div>';
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
  const start = results.findIndex(x => x.id === track.id);
  state.queue = results.filter(x => !x.searchShortcut || x.id === track.id).map(x => ({...x}));
  state.index = Math.max(0,start);
  $("#searchView").classList.add("hidden");
  saveState(); playCurrent();
}
function playCurrent() {
  const track = currentTrack();
  if (!track) return;
  if (activeProvider && activeProvider !== providers[track.source]) activeProvider.stop();
  activeProvider = providers[track.source];
  if (!activeProvider) return setStatus("Источник не поддерживается", true);
  $("#trackTitle").textContent = track.title;
  $("#trackArtist").textContent = track.artist;
  $("#cover").style.backgroundImage = track.artwork ? `url("${track.artwork}")` : "";
  $("#cover").textContent = track.artwork ? "" : "♫";
  $("#likeBtn").textContent = favorites.has(track.id) ? "♥" : "♡";
  $("#likeBtn").classList.toggle("liked", favorites.has(track.id));
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
  $("#localTracks").innerHTML=localTracks.map(t=>`
    <article class="youtube-result"><div class="local-file-icon">♫</div><div class="youtube-result-copy"><b>${escapeHTML(t.title)}</b><small>Мои файлы · только эта сессия</small><span class="source-badge source-local">Мои файлы</span></div>
    <button class="result-play" data-local-play="${escapeHTML(t.id)}">▶</button></article>`).join("");
  $$("[data-local-play]").forEach(b=>b.addEventListener("click",()=>enqueueAndPlay(localTracks.find(t=>t.id===b.dataset.localPlay),localTracks)));
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
  }
  e.target.value="";
});
$("#likeBtn").addEventListener("click",()=>{
  const t=currentTrack(); if(!t)return;
  favorites.has(t.id)?favorites.delete(t.id):favorites.add(t.id);
  localStorage.setItem("mibbi-favs",JSON.stringify([...favorites]));
  $("#likeBtn").textContent=favorites.has(t.id)?"♥":"♡";
  $("#likeBtn").classList.toggle("liked",favorites.has(t.id));
});
$("#queueBtn").addEventListener("click",()=>toast(`В очереди ${state.queue.length} треков`));

$$("[data-source-setting]").forEach(input=>{
  input.checked=state.sources[input.dataset.sourceSetting] !== false;
  input.addEventListener("change",()=>{
    state.sources[input.dataset.sourceSetting]=input.checked;
    saveState();
    if($("#searchInput").value.trim()) searchTracks();
  });
});
$("#videoSetting").checked=state.videoMode;
$("#videoSetting").addEventListener("change",e=>{state.videoMode=e.target.checked;$("#videoToggle").click();});
$("#autoplaySetting").checked=localStorage.getItem("mibbi-auto")!=="false";
$("#autoplaySetting").addEventListener("change",e=>localStorage.setItem("mibbi-auto",e.target.checked));

document.addEventListener("keydown",e=>{
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
