const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'library');
const VIDEOS = path.join(DATA, 'videos');
const STILLS = path.join(DATA, 'stills');
const AUDIO_CACHE = path.join(DATA, 'audio-cache');
const DB = path.join(DATA, 'library.json');
const PORT = Number(process.env.PORT || 4173);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.wmv', '.mpg', '.mpeg', '.ts']);
for (const dir of [PUBLIC, VIDEOS, STILLS, AUDIO_CACHE]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DB)) fs.writeFileSync(DB, JSON.stringify({ shows: [] }, null, 2));

const readDb = () => { try { const db=JSON.parse(fs.readFileSync(DB, 'utf8')); if(!Array.isArray(db.shows))db.shows=[]; if(!db.progress||typeof db.progress!=='object')db.progress={}; return db; } catch { return { shows: [], progress:{} }; } };
const saveDb = db => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
const safe = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 180) || 'Untitled';
const id = () => crypto.randomUUID();
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const mime = file => ({ '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.svg':'image/svg+xml', '.mp4':'video/mp4', '.m4a':'audio/mp4', '.m4v':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime', '.mkv':'video/x-matroska', '.avi':'video/x-msvideo', '.wmv':'video/x-ms-wmv', '.mpg':'video/mpeg', '.mpeg':'video/mpeg', '.ts':'video/mp2t' }[path.extname(file).toLowerCase()] || 'application/octet-stream');
function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let start, end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size === 0) return false;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
const audioCodecsNeedingAac = new Set(['ac3', 'eac3', 'dts', 'dca', 'truehd', 'mlp', 'mp2', 'wmapro']);
const audioProbeCache = new Map(), audioConversionJobs = new Map();
function runMediaTool(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide:true, stdio:['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (stdout.length < 200000) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 200000) stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited with code ${code}`)));
  });
}
function probeAudioCodec(file, stat) {
  const cacheKey = `${file}\0${stat.size}\0${stat.mtimeMs}`;
  if (!audioProbeCache.has(cacheKey)) {
    const ffprobe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    const probe = runMediaTool(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'json', file])
      .then(output => JSON.parse(output).streams?.[0]?.codec_name?.toLowerCase() || null);
    audioProbeCache.set(cacheKey, probe);
  }
  return audioProbeCache.get(cacheKey);
}
async function prepareCompatibleAudio(file, stat) {
  const key = crypto.createHash('sha256').update(`${file}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
  const output = path.join(AUDIO_CACHE, `${key}.m4a`);
  if (fs.existsSync(output)) return key;
  let job = audioConversionJobs.get(key);
  if (!job) {
    const temporary = path.join(AUDIO_CACHE, `${key}.${process.pid}.${crypto.randomUUID()}.tmp.m4a`);
    const ffmpeg = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    job = runMediaTool(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', temporary])
      .then(() => fs.promises.rename(temporary, output))
      .catch(error => { try { fs.unlinkSync(temporary); } catch {} throw error; })
      .finally(() => audioConversionJobs.delete(key));
    audioConversionJobs.set(key, job);
  }
  await job;
  return key;
}
function streamMediaFile(req, res, file, contentType) {
  const stat = fs.statSync(file), range = parseByteRange(req.headers.range, stat.size);
  if (range === false) return res.writeHead(416, { 'Content-Range':`bytes */${stat.size}`, 'Accept-Ranges':'bytes' }).end();
  const start = range?.start ?? 0, end = range?.end ?? stat.size - 1;
  const headers = { 'Accept-Ranges':'bytes', 'Content-Length':range ? end - start + 1 : stat.size, 'Content-Type':contentType };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  return fs.createReadStream(file, range ? { start, end } : undefined).pipe(res);
}
function videoPath(reference) { return path.isAbsolute(reference) ? path.resolve(reference) : path.join(VIDEOS, path.basename(reference)); }
function storedVideoPath(reference) { return path.isAbsolute(reference) ? null : videoPath(reference); }
function showFor(db, title) { let show = db.shows.find(x => x.title.toLowerCase() === title.toLowerCase()); if (!show) { show = { id:id(), title, episodes:[] }; db.shows.push(show); } return show; }
function episodeFor(show, filename, video) { return show.episodes.find(e => e.filename === filename) || { id:id(), filename, title:filename.replace(/\.[^.]+$/, '').replace(/[._]/g,' ').trim(), video, still:null, addedAt:Date.now() }; }
function walk(dir, result = []) { for (const item of fs.readdirSync(dir, { withFileTypes:true })) { const full = path.join(dir,item.name); if (item.isDirectory()) walk(full,result); else if (VIDEO_EXT.has(path.extname(item.name).toLowerCase())) result.push(full); } return result; }
function browseForFolder() {
  return new Promise((resolve, reject) => {
    const command = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = 'Choose a folder containing videos'",
      '$dialog.ShowNewFolderButton = $false',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($dialog.SelectedPath))) }'
    ].join('; ');
    const picker = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-Command', command], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let output = '', error = '';
    picker.stdout.setEncoding('ascii');
    picker.stderr.setEncoding('utf8');
    picker.stdout.on('data', chunk => { output += chunk; });
    picker.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
    picker.once('error', reject);
    picker.once('close', code => {
      if (code !== 0) return reject(new Error(error.trim() || `Folder picker exited with code ${code}`));
      const encoded = output.trim();
      resolve(encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : '');
    });
  });
}
function decorate(db) { return { progress:db.progress||{}, shows: db.shows.map(s => ({ ...s, episodes:s.episodes.map(e => ({...e, url:`/media/${encodeURIComponent(s.id)}/${encodeURIComponent(e.id)}`})) })) }; }

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/library') return json(res,200,decorate(readDb()));
    if (url.pathname.startsWith('/api/audio-compat/')) {
      if (!['GET', 'POST'].includes(req.method)) return res.writeHead(405).end();
      const parts=url.pathname.split('/'), sid=decodeURIComponent(parts[3]||''), eid=decodeURIComponent(parts[4]||'');
      const db=readDb(), show=db.shows.find(item=>item.id===sid), ep=show?.episodes.find(item=>item.id===eid);
      if(!ep)return json(res,404,{error:'Episode not found'});
      const file=videoPath(ep.video); if(!fs.existsSync(file))return json(res,404,{error:'Video file is missing'});
      const stat=fs.statSync(file); let codec;
      try { codec=await probeAudioCodec(file,stat); }
      catch(error) { if(error.code==='ENOENT')return json(res,503,{error:'FFmpeg is needed to prepare audio for this browser.'}); console.error(error); return json(res,500,{error:'Could not inspect the audio track.'}); }
      if(!codec)return json(res,200,{codec:null,hasAudio:false});
      if(!audioCodecsNeedingAac.has(codec))return json(res,200,{codec,hasAudio:true,needsFallback:false});
      if(req.method==='GET')return json(res,200,{codec,hasAudio:true,needsFallback:true});
      try {
        const key=await prepareCompatibleAudio(file,stat);
        return json(res,200,{codec,url:`/compat-audio/${key}.m4a`});
      } catch(error) {
        if(error.code==='ENOENT')return json(res,503,{error:'FFmpeg is needed to prepare audio for this browser.'});
        console.error(error);return json(res,500,{error:'Could not prepare browser-compatible audio.'});
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/compat-audio/')) {
      const match=/^\/compat-audio\/([a-f0-9]{64})\.m4a$/i.exec(url.pathname);
      if(!match)return res.writeHead(404).end();
      const file=path.join(AUDIO_CACHE,`${match[1]}.m4a`);
      if(!fs.existsSync(file))return res.writeHead(404).end();
      return streamMediaFile(req,res,file,'audio/mp4');
    }
    if (req.method === 'POST' && url.pathname === '/api/browse-folder') {
      if (process.platform !== 'win32') return json(res,501,{error:'The folder picker is available when Nebflix runs on Windows. You can paste a folder path instead.'});
      const folder = await browseForFolder();
      return json(res,200,{path:folder});
    }
    if (req.method === 'POST' && url.pathname === '/api/progress') {
      let body=''; for await (const chunk of req) { body+=chunk; if(body.length>4000)return json(res,413,{error:'Progress update is too large'}); }
      const item=JSON.parse(body), time=Number(item.time), duration=Number(item.duration);
      if(!item.episodeId||!Number.isFinite(time)||!Number.isFinite(duration)||duration<=0)return json(res,400,{error:'Invalid playback progress'});
      const db=readDb(); let owner;
      for(const show of db.shows){if(show.episodes.some(e=>e.id===item.episodeId)){owner=show;break;}}
      if(!owner)return json(res,404,{error:'Episode not found'});
      const updatedAt=Number(item.updatedAt)||Date.now(), previous=db.progress[item.episodeId];
      if(!previous||updatedAt>=previous.updatedAt){
        const completed=Boolean(item.completed);
        db.progress[item.episodeId]={time:completed?duration:Math.min(Math.max(time,0),duration),duration,completed,updatedAt};
        owner.lastEpisodeId=item.episodeId; owner.lastPosition=db.progress[item.episodeId].time; owner.lastPlayedAt=updatedAt; saveDb(db);
      }
      return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/import-folder') {
      let body=''; for await (const chunk of req) { body += chunk; if(body.length > 10000) return json(res,413,{error:'Folder path is too long'}); }
      const folder = path.resolve(JSON.parse(body).path || '');
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return json(res,400,{error:'That folder could not be found. Check the path and try again.'});
      const files = walk(folder); if (!files.length) return json(res,400,{error:'I could not find any video files in that folder.'});
      const db=readDb(), title=safe(path.basename(folder)), show=showFor(db,title); let added=0;
      for (const source of files) { const filename=path.basename(source), absolute=path.resolve(source), existing=show.episodes.find(e=>e.filename.toLowerCase()===filename.toLowerCase() || (path.isAbsolute(e.video)&&path.resolve(e.video).toLowerCase()===absolute.toLowerCase())); if(existing) continue;
        show.episodes.push({id:id(),filename,title:filename.replace(/\.[^.]+$/,'').replace(/[._]/g,' ').trim(),video:absolute,still:null,addedAt:Date.now()}); added++;
      }
      saveDb(db); return json(res,200,{added,found:files.length,library:decorate(db)});
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const title=safe(decodeURIComponent(url.searchParams.get('show') || 'My uploads'));
      const original=safe(decodeURIComponent(url.searchParams.get('name') || 'episode.mp4'));
      if (!VIDEO_EXT.has(path.extname(original).toLowerCase())) return json(res,400,{error:'Choose a video file such as MP4, MKV, MOV or WebM.'});
      const stored=`${crypto.randomUUID()}${path.extname(original).toLowerCase()}`;
      await pipeline(req,fs.createWriteStream(path.join(VIDEOS,stored)));
      const db=readDb(), show=showFor(db,title); show.episodes.push({id:id(),filename:original,title:original.replace(/\.[^.]+$/,'').replace(/[._]/g,' ').trim(),video:stored,still:null,addedAt:Date.now()}); saveDb(db);
      return json(res,201,{library:decorate(db)});
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/still/')) {
      const eid=decodeURIComponent(url.pathname.split('/').pop()), chunks=[]; let size=0;
      for await (const chunk of req) { size+=chunk.length; if(size>3*1024*1024) return json(res,413,{error:'Image is too large'}); chunks.push(chunk); }
      const db=readDb(); let found; for(const show of db.shows) { const ep=show.episodes.find(e=>e.id===eid); if(ep){found=ep;break;} }
      if(!found) return json(res,404,{error:'Episode not found'});
      const out=path.join(STILLS,`${eid}.jpg`); fs.writeFileSync(out,Buffer.concat(chunks)); found.still=`/stills/${eid}.jpg`; saveDb(db); return json(res,200,{still:found.still});
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/show/')) {
      const sid=decodeURIComponent(url.pathname.split('/').pop()), db=readDb(), index=db.shows.findIndex(show=>show.id===sid);
      if(index<0) return json(res,404,{error:'Series not found'});
      const [show]=db.shows.splice(index,1);
      for(const ep of show.episodes) delete db.progress[ep.id];
      saveDb(db);
      for(const ep of show.episodes){
        const stored=storedVideoPath(ep.video);
        for(const file of [stored,path.join(STILLS,`${ep.id}.jpg`)]){
          if(!file) continue;
          try{fs.unlinkSync(file);}catch(err){if(err.code!=='ENOENT')console.warn(`Could not remove ${file}:`,err.message);}
        }
      }
      return json(res,200,{library:decorate(db)});
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/episode/')) {
      const eid=decodeURIComponent(url.pathname.split('/').pop()), db=readDb(); let removed=false;
      for(const show of db.shows){const n=show.episodes.findIndex(e=>e.id===eid);if(n>=0){const [ep]=show.episodes.splice(n,1);const stored=storedVideoPath(ep.video);if(stored)try{fs.unlinkSync(stored);}catch{}try{fs.unlinkSync(path.join(STILLS,`${eid}.jpg`));}catch{}removed=true;break;}}
      db.shows=db.shows.filter(s=>s.episodes.length);saveDb(db);return json(res,removed?200:404,{library:decorate(db)});
    }
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const [, , sid, eid] = url.pathname.split('/'); const db=readDb(); const show=db.shows.find(s=>s.id===decodeURIComponent(sid)); const ep=show?.episodes.find(e=>e.id===decodeURIComponent(eid));
      if(!ep) return json(res,404,{error:'Episode not found'}); const file=videoPath(ep.video); if(!fs.existsSync(file))return json(res,404,{error:'Video file is missing'});
      return streamMediaFile(req,res,file,mime(file));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/stills/')) { const file=path.join(STILLS,path.basename(url.pathname)); if(!fs.existsSync(file))return res.writeHead(404).end();res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'public, max-age=31536000, immutable'});return fs.createReadStream(file).pipe(res); }
    const requested=decodeURIComponent(url.pathname);
    const target=requested==='/'?path.join(PUBLIC,'index.html'):path.resolve(PUBLIC,`.${requested}`);
    if(target!==path.join(PUBLIC,'index.html')&&!target.startsWith(PUBLIC+path.sep))return res.writeHead(403).end();
    if(!fs.existsSync(target)||fs.statSync(target).isDirectory())return res.writeHead(404).end('Not found');res.writeHead(200,{'Content-Type':mime(target),'Cache-Control':'no-store'});return fs.createReadStream(target).pipe(res);
  } catch(err) { console.error(err); if(!res.headersSent)json(res,500,{error:err.message || 'Something went wrong'});else res.destroy(); }
});
server.on('request',(req,res)=>{
  if(req.url.startsWith('/api/') || (req.url.startsWith('/media/') && req.headers.range?.startsWith('bytes=0-'))){
    const started=Date.now();
    res.once('finish',()=>console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${req.url.split('?')[0]}  ${res.statusCode}  ${Date.now()-started} ms`));
  }
});
server.on('error',err=>{
  if(err.code==='EADDRINUSE') console.error(`Port ${PORT} is already in use. Stop the other Nebflix window, or start this one with: set PORT=4174 && node server.js`);
  else console.error('Nebflix server error:',err);
  process.exitCode=1;
});
server.listen(PORT,'127.0.0.1',()=>{console.log(`Nebflix is ready at http://localhost:${PORT}`);if(process.env.NEBFLIX_LAUNCH_BROWSER==='1'){const opener=spawn('cmd.exe',['/d','/c','start','',`http://localhost:${PORT}`],{detached:true,stdio:'ignore',windowsHide:true});opener.unref();}});
