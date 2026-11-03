const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const progress = JSON.parse(localStorage.getItem('nebflix-progress') || '{}');
let library = {shows:[]}, filter='all', activeEpisodes=[], activeIndex=0, toastTimer;
const video = $('#video');
const savedVolume = localStorage.getItem('nebflix-volume');
const initialVolume = savedVolume === null ? 0.8 : Number(savedVolume);
video.volume = Number.isFinite(initialVolume) && initialVolume >= 0 && initialVolume <= 1 ? initialVolume : 0.8;
video.muted = localStorage.getItem('nebflix-muted') === 'true';
video.addEventListener('volumechange', () => {
  localStorage.setItem('nebflix-volume', String(video.volume));
  localStorage.setItem('nebflix-muted', String(video.muted));
});
let activeEpisode = null, lastServerProgressSave = 0;

function saveProgress(){localStorage.setItem('nebflix-progress',JSON.stringify(progress));}
function notify(message){const toast=$('#toast');toast.textContent=message;toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),2600);}
function allEpisodes(){return library.shows.flatMap(s=>s.episodes.map(e=>({...e,showTitle:s.title})));}
function watchedPct(ep){const p=progress[ep.id];return p?.completed?100:p?.duration?Math.min(100,Math.round(p.time/p.duration*100)):0;}
function tile(ep, show) {
  const pct = watchedPct(ep);
  return `<article class="episode-card" data-episode="${escapeHtml(ep.id)}"><div class="tile-art">${ep.still ? `<img src="${escapeHtml(ep.still)}" alt="Still from ${escapeHtml(ep.title)}">` : `<div class="tile-fallback"><span>${escapeHtml(show.title.slice(0, 2).toUpperCase())}</span></div>`}<span class="tile-play">&#9654;</span>${pct > 0 && pct < 95 ? `<span class="tile-progress"><i style="width:${pct}%"></i></span>` : ''}</div><div class="tile-copy"><div class="tile-title">${escapeHtml(ep.title)}</div><div class="tile-subtitle">${escapeHtml(show.title)}${pct > 0 && pct < 95 ? ` &middot; ${pct}% watched` : ''}</div></div></article>`;
}
function collectionCard(show) {
  const cover = show.episodes.find(ep => ep.still)?.still;
  const count = show.episodes.length;
  const artwork = cover ? `<img src="${escapeHtml(cover)}" alt="">` : `<span class="collection-fallback">${escapeHtml(show.title.slice(0, 2).toUpperCase())}</span>`;
  return `<button class="collection-card" type="button" data-show-id="${escapeHtml(show.id)}" aria-label="Open ${escapeHtml(show.title)}"><span class="collection-art">${artwork}<span class="collection-count">${count} episode${count === 1 ? '' : 's'}</span></span><span class="collection-copy"><strong>${escapeHtml(show.title)}</strong><span>${count} episode${count === 1 ? '' : 's'}</span></span></button>`;
}
function visibleShows() {
  let shows = [...library.shows];
  const query = $('#search').value.trim().toLowerCase();
  if (query) shows = shows.map(show => ({ ...show, episodes: show.episodes.filter(ep => `${show.title} ${ep.title}`.toLowerCase().includes(query)) })).filter(show => show.episodes.length);
  if (filter === 'continue') shows = shows.filter(show => show.episodes.some(ep => watchedPct(ep) > 2 && watchedPct(ep) < 95));
  if (filter === 'unwatched') shows = shows.filter(show => show.episodes.some(ep => watchedPct(ep) < 2));
  const sort = $('#sort').value;
  if (sort === 'title') shows.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'progress') shows.sort((a, b) => Math.max(...b.episodes.map(watchedPct)) - Math.max(...a.episodes.map(watchedPct)));
  else shows.sort((a, b) => Math.max(...b.episodes.map(ep => ep.addedAt || 0)) - Math.max(...a.episodes.map(ep => ep.addedAt || 0)));
  return shows;
}
function render() {
  const total = library.shows.reduce((count, show) => count + show.episodes.length, 0);
  $('#countBadge').textContent = total;
  $('#heroCount').textContent = total ? `${total} EPISODES IN YOUR LIBRARY` : 'READY WHEN YOU ARE';
  $('#footerStats').textContent = `${library.shows.length} SERIES | ${total} EPISODES`;
  const featured = library.shows[0];
  const featuredResume = featured?.episodes.find(ep => ep.id === featured.lastEpisodeId && watchedPct(ep) < 95) || featured?.episodes.find(ep => watchedPct(ep) > 1 && watchedPct(ep) < 95);
  const featuredEpisode = featuredResume || featured?.episodes[0];
  $('#heroTitle').innerHTML = featured ? escapeHtml(featured.title.split(' - ')[0]) : 'Your next<br>great watch.';
  $('#heroCopy').textContent = featured ? `${featured.episodes.length} episodes · Continue watching your collection, or settle in with the first episode.` : 'A place for all the shows you love. Add your first series and make tonight a good one.';
  $('#heroPlay').innerHTML = `<span>&#9654;</span> ${featured ? (featuredResume ? 'Continue watching' : 'Play series') : 'Add your first series'}`;
  $('#heroImage').style.backgroundImage = featuredEpisode?.still ? `linear-gradient(90deg,#101010 0%,rgba(16,16,16,.88) 30%,rgba(16,16,16,.22) 70%),linear-gradient(0deg,#101010 0%,transparent 42%),url("${featuredEpisode.still}")` : '';
  $('#heroPlay').dataset.episode = featuredEpisode?.id || '';
  const shows = visibleShows();
  const query = $('#search').value.trim();
  const shelves = [];
  const continuing = shows.flatMap(show => show.episodes.filter(ep => watchedPct(ep) > 2 && watchedPct(ep) < 95).map(ep => ({ ep, show })));
  if (continuing.length && filter !== 'unwatched') shelves.push(`<section class="shelf"><h2>Continue watching <span>&rsaquo;</span></h2><div class="episode-row">${continuing.map(item => tile(item.ep, item.show)).join('')}</div></section>`);
  if (filter === 'continue' && !continuing.length) shelves.push('<div class="no-results">Nothing in progress yet. Start an episode and it will appear here.</div>');
  if (filter !== 'continue' && shows.length) shelves.push(`<section class="shelf"><h2>Shows and movies <span>${shows.length} title${shows.length === 1 ? '' : 's'}</span></h2><div class="collection-row">${shows.map(collectionCard).join('')}</div></section>`);
  if (filter === 'unwatched' && !shows.length) shelves.push('<div class="no-results">Everything in your library has been watched.</div>');
  if (query && !shelves.length) shelves.push('<div class="no-results">No titles found. Try a different search.</div>');
  $('#libraryCaption').textContent = total ? `${library.shows.length} series · ${total} episodes` : 'A little room for your next favourite.';
  $('#emptyState').classList.toggle('visible', total === 0);
  $('#shelves').style.display = total === 0 ? 'none' : 'block';
  $('#shelves').innerHTML = shelves.join('');
  $$('#shelves .episode-card').forEach(card => card.addEventListener('click', () => playEpisode(card.dataset.episode)));
  $$('#shelves .collection-card').forEach(card => card.addEventListener('click', () => openShowDetails(card.dataset.showId)));
  $('#heroPlay').disabled = total === 0;
  $('#heroPlay').style.opacity = total === 0 ? '.9' : '1';
}
function playEpisode(episodeId) {
  const show = library.shows.find(item => item.episodes.some(ep => ep.id === episodeId));
  if (!show) return;
  activeEpisodes = [...show.episodes].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  activeIndex = activeEpisodes.findIndex(ep => ep.id === episodeId);
  closeModals();
  openEpisode(activeEpisodes[activeIndex]);
}
function openShowDetails(showId) {
  const show = library.shows.find(item => item.id === showId);
  if (!show) return;
  $('#showDetailTitle').textContent = show.title;
  $('#showDetailMeta').textContent = `${show.episodes.length} episode${show.episodes.length === 1 ? '' : 's'}`;
  $('#removeShow').dataset.showId = show.id;
  $('#removeError').textContent = '';
  $('#showDetailEpisodes').innerHTML = show.episodes.map(ep => tile(ep, show)).join('');
  showModal('showDetailModal');
  $$('#showDetailEpisodes .episode-card').forEach(card => card.addEventListener('click', () => playEpisode(card.dataset.episode)));
}
async function loadLibrary() {
  const response = await fetch('/api/library', { cache:'no-store' });
  const data = await response.json();
  library = data;
  for (const [episodeId, item] of Object.entries(data.progress || {})) {
    if (!progress[episodeId] || (item.updatedAt || 0) >= (progress[episodeId].updatedAt || 0)) progress[episodeId] = item;
  }
  saveProgress();
  render();
  generateStills();
}
function playShow(show) {
  const episodes = [...show.episodes].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  const resume = episodes.find(ep => ep.id === show.lastEpisodeId && watchedPct(ep) < 95);
  const inProgress = episodes.filter(ep => watchedPct(ep) > 1 && watchedPct(ep) < 95).sort((a, b) => (progress[b.id]?.updatedAt || 0) - (progress[a.id]?.updatedAt || 0))[0];
  const chosen = inProgress && (progress[inProgress.id]?.updatedAt || 0) > (show.lastPlayedAt || 0) ? inProgress : resume || inProgress || episodes.find(ep => watchedPct(ep) < 95) || episodes[0];
  activeEpisodes = episodes;
  activeIndex = episodes.findIndex(ep => ep.id === chosen.id);
  openEpisode(chosen);
}
function persistEpisode(ep, completed = false, beacon = false) {
  if (!ep || !Number.isFinite(video.duration) || video.duration <= 0) return;
  const updatedAt = Date.now(), time = completed ? video.duration : Math.min(video.currentTime, video.duration);
  const item = { time, duration:video.duration, completed, updatedAt };
  progress[ep.id] = item;
  saveProgress();
  const payload = JSON.stringify({ episodeId:ep.id, ...item });
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon('/api/progress', new Blob([payload], { type:'application/json' }));
    lastServerProgressSave = updatedAt;
  } else {
    fetch('/api/progress', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:payload, keepalive:true }).catch(() => {});
    lastServerProgressSave = updatedAt;
  }
}
async function openEpisode(ep) {
  if (!ep) return;
  if (activeEpisode && activeEpisode.id !== ep.id) persistEpisode(activeEpisode, false, true);
  activeEpisode = ep;
  video.onpause = null;
  video.onended = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('#playbackError').textContent = '';
  $('#playerSeries').textContent = (library.shows.find(s => s.episodes.some(e => e.id === ep.id))?.title || 'NEBFLIX').toUpperCase();
  $('#playerTitle').textContent = ep.title;
  $('#player').classList.add('open');
  video.src = ep.url;
  video.onloadedmetadata = () => {
    const p = progress[ep.id];
    if (p?.duration && p.time > 5 && p.time < video.duration - 5) video.currentTime = p.time;
    else if (watchedPct(ep) >= 95) video.currentTime = 0;
    persistEpisode(ep);
    video.play().catch(() => {});
    updateNav();
  };
  video.onerror = () => {
    $('#playbackError').textContent = `This browser couldn't decode the video (media error ${video.error?.code || 'unknown'}).`;
  };
  video.ontimeupdate = () => {
    if (video.duration && video.currentTime > 1) {
      const item = { time: video.currentTime, duration: video.duration, completed: false, updatedAt: Date.now() };
      progress[ep.id] = item;
      saveProgress();
      if (Date.now() - lastServerProgressSave > 8000) persistEpisode(ep);
    }
  };
  video.onpause = () => { if (!video.ended) persistEpisode(ep, false, true); };
  video.onended = () => {
    persistEpisode(ep, true, true);
    activeEpisode = null;
    if (activeIndex < activeEpisodes.length - 1) {
      activeIndex++;
      openEpisode(activeEpisodes[activeIndex]);
    } else {
      render();
      notify('That\u2019s the end of this series.');
    }
  };
  updateNav();
}
function updateNav(){$('#prevEp').disabled=activeIndex<=0;$('#nextEp').disabled=activeIndex>=activeEpisodes.length-1;}
function closePlayer() {
  if (activeEpisode) persistEpisode(activeEpisode, false, true);
  activeEpisode = null;
  video.onpause = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('#player').classList.remove('open');
  render();
}
function showModal(id){$('#'+id).classList.add('open');$('#addFab').classList.remove('open');}
function closeModals(){$$('.modal-backdrop').forEach(x=>x.classList.remove('open'));}
async function generateStills(){for(const show of library.shows){for(const ep of show.episodes){if(ep.still||!ep.url)continue;try{await makeStill(ep);}catch{}}}}
function makeStill(ep) {
  return new Promise((resolve, reject) => {
    const source = document.createElement('video');
    source.muted = true;
    source.preload = 'metadata';
    source.src = ep.url;
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      source.removeAttribute('src');
      source.load();
      ok ? resolve() : reject();
    };
    const timer = setTimeout(() => finish(false), 12000);
    source.onerror = () => { clearTimeout(timer); finish(false); };
    source.onloadedmetadata = () => {
      try { source.currentTime = Math.min(Math.max(source.duration * .18, 1), 18); }
      catch { clearTimeout(timer); finish(false); }
    };
    source.onseeked = async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(source.videoWidth || 640, 960);
        canvas.height = Math.round(canvas.width * (source.videoHeight || 360) / (source.videoWidth || 640));
        canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(doneBlob => canvas.toBlob(doneBlob, 'image/jpeg', .78));
        if (!blob) throw Error('Could not create a still image.');
        const response = await fetch(`/api/still/${encodeURIComponent(ep.id)}`, { method:'POST', headers:{ 'Content-Type':'image/jpeg' }, body:blob });
        if (!response.ok) throw Error('Could not save the still image.');
        const result = await response.json();
        ep.still = result.still;
        const card = $(`[data-episode="${CSS.escape(ep.id)}"] .tile-art`);
        if (card && !card.querySelector('img')) {
          const img = document.createElement('img');
          img.src = ep.still;
          img.alt = `Still from ${ep.title}`;
          card.prepend(img);
          card.querySelector('.tile-fallback')?.remove();
        }
        const show = library.shows.find(item => item.episodes.some(itemEpisode => itemEpisode.id === ep.id));
        const cover = show ? $(`[data-show-id="${CSS.escape(show.id)}"] .collection-art`) : null;
        if (cover && !cover.querySelector('img')) {
          const img = document.createElement('img');
          img.src = ep.still;
          img.alt = '';
          cover.prepend(img);
          cover.querySelector('.collection-fallback')?.remove();
        }
        clearTimeout(timer);
        finish(true);
      } catch {
        clearTimeout(timer);
        finish(false);
      }
    };
  });
}
$('#addFab').addEventListener('click',e=>{if(e.target.closest('.fab-menu'))return;$('#addFab').classList.toggle('open');});$('#fabImport').onclick=()=>showModal('importModal');$('#fabUpload').onclick=()=>showModal('uploadModal');$('#emptyImport').onclick=()=>showModal('importModal');$('#emptyUpload').onclick=()=>showModal('uploadModal');$('#browseButton').onclick=()=>$('#library').scrollIntoView({behavior:'smooth'});
$$('[data-close]').forEach(b=>b.addEventListener('click',closeModals));$$('.modal-backdrop').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModals();}));document.addEventListener('click',e=>{if(!e.target.closest('#addFab'))$('#addFab').classList.remove('open');});
$('#removeShow').onclick = async () => {
  const show = library.shows.find(item => item.id === $('#removeShow').dataset.showId);
  if (!show || !confirm(`Remove "${show.title}" from Nebflix? Videos in their original folders will stay there.`)) return;
  const button = $('#removeShow');
  button.disabled = true;
  $('#removeError').textContent = '';
  try {
    const response = await fetch(`/api/show/${encodeURIComponent(show.id)}`, { method:'DELETE' });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Could not remove this series.');
    for (const episode of show.episodes) delete progress[episode.id];
    saveProgress();
    library = data.library;
    closeModals();
    render();
    notify('Series removed from Nebflix.');
  } catch (error) {
    $('#removeError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$('#browseFolder').onclick = async () => {
  const button = $('#browseFolder');
  $('#importError').textContent = '';
  button.disabled = true;
  button.textContent = 'Opening...';
  try {
    const response = await fetch('/api/browse-folder', { method:'POST' });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Could not open the folder picker.');
    if (data.path) $('#folderPath').value = data.path;
  } catch (error) {
    $('#importError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Browse...';
  }
};
$('#importGo').onclick=async()=>{const button=$('#importGo'),path=$('#folderPath').value.trim();$('#importError').textContent='';if(!path){$('#importError').textContent='Enter the location of a folder to import.';return;}button.disabled=true;button.innerHTML='Importing…';try{const r=await fetch('/api/import-folder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})}),data=await r.json();if(!r.ok)throw Error(data.error);library=data.library;render();generateStills();closeModals();notify(`${data.added} episode${data.added===1?'':'s'} added to your library.`);}catch(e){$('#importError').textContent=e.message;}finally{button.disabled=false;button.innerHTML='Import folder <span>→</span>';}};
$('#chooseFiles').onclick=()=>$('#filePicker').click();$('#filePicker').onchange=()=>{$('#selectedFiles').textContent=[...$('#filePicker').files].map(f=>f.name).join(' · ');};
$('#uploadGo').onclick=async()=>{const files=[...$('#filePicker').files],name=$('#showName').value.trim()||'My uploads';$('#uploadError').textContent='';if(!files.length){$('#uploadError').textContent='Choose at least one video file first.';return;}const button=$('#uploadGo');button.disabled=true;try{for(let i=0;i<files.length;i++){const f=files[i];$('#uploadProgress').textContent=`Adding ${i+1} of ${files.length} · ${f.name}`;const r=await fetch(`/api/upload?show=${encodeURIComponent(name)}&name=${encodeURIComponent(f.name)}`,{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream'},body:f});const data=await r.json();if(!r.ok)throw Error(data.error);library=data.library;}render();generateStills();closeModals();$('#filePicker').value='';$('#selectedFiles').textContent='';$('#uploadProgress').textContent='';notify(`${files.length} episode${files.length===1?'':'s'} added.`);}catch(e){$('#uploadError').textContent=e.message;}finally{button.disabled=false;}};
$('#playerClose').onclick=closePlayer;$('#player').addEventListener('click',e=>{if(e.target===$('#player'))closePlayer();});$('#prevEp').onclick=()=>{if(activeIndex>0){activeIndex--;openEpisode(activeEpisodes[activeIndex]);}};$('#nextEp').onclick=()=>{if(activeIndex<activeEpisodes.length-1){activeIndex++;openEpisode(activeEpisodes[activeIndex]);}};$('#heroPlay').onclick=()=>{if(library.shows.length)playShow(library.shows[0]);};
$('#search').oninput=render;$('#sort').onchange=render;$$('.filter').forEach(b=>b.onclick=()=>{$$('.filter').forEach(x=>x.classList.remove('active'));b.classList.add('active');filter=b.dataset.filter;render();});document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModals();if($('#player').classList.contains('open'))closePlayer();$('#addFab').classList.remove('open');}});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&activeEpisode)persistEpisode(activeEpisode,false,true);});window.addEventListener('pagehide',()=>{if(activeEpisode)persistEpisode(activeEpisode,false,true);});
loadLibrary().catch(()=>notify('Nebflix could not connect to its local library.'));

