const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'library');
const VIDEOS = path.join(DATA, 'videos');
const STILLS = path.join(DATA, 'stills');
const AUDIO = path.join(DATA, 'audio');
const DB = path.join(DATA, 'library.json');
const PORT = Number(process.env.PORT || 4173);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.wmv', '.mpg', '.mpeg', '.ts']);
function findFfmpeg() {
  if(process.env.FFMPEG_PATH)return process.env.FFMPEG_PATH;
  const local=process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData','Local');
  const links=path.join(local,'Microsoft','WinGet','Links','ffmpeg.exe');if(fs.existsSync(links))return links;
  const root=path.join(local,'Microsoft','WinGet','Packages','Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe');
  try{for(const build of fs.readdirSync(root).sort().reverse()){const candidate=path.join(root,build,'bin','ffmpeg.exe');if(fs.existsSync(candidate))return candidate;}}catch{}
  return 'ffmpeg';
}
const FFMPEG = findFfmpeg();
const FFMPEG_AVAILABLE = !spawnSync(FFMPEG, ['-version'], { stdio:'ignore' }).error;

for (const dir of [PUBLIC, VIDEOS, STILLS, AUDIO]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DB)) fs.writeFileSync(DB, JSON.stringify({ shows: [] }, null, 2));

const readDb = () => { try { const db=JSON.parse(fs.readFileSync(DB, 'utf8')); if(!Array.isArray(db.shows))db.shows=[]; if(!db.progress||typeof db.progress!=='object')db.progress={}; return db; } catch { return { shows: [], progress:{} }; } };
const saveDb = db => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
const safe = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 180) || 'Untitled';
const id = () => crypto.randomUUID();
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const mime = file => ({ '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.svg':'image/svg+xml', '.mp4':'video/mp4', '.m4v':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime', '.mkv':'video/x-matroska', '.avi':'video/x-msvideo', '.wmv':'video/x-ms-wmv', '.mpg':'video/mpeg', '.mpeg':'video/mpeg', '.ts':'video/mp2t' }[path.extname(file).toLowerCase()] || 'application/octet-stream');
function audioCodec(file) {
  if(path.extname(file).toLowerCase()!=='.mp4'&&path.extname(file).toLowerCase()!=='.m4v') return null;
  let fd; try { fd=fs.openSync(file,'r'); const total=fs.statSync(file).size; let offset=0;
    while(offset+8<total){const header=Buffer.alloc(16);fs.readSync(fd,header,0,8,offset);let size=header.readUInt32BE(0),type=header.toString('ascii',4,8),base=8;if(size===1){fs.readSync(fd,header,8,8,offset+8);size=Number(header.readBigUInt64BE(8));base=16;}if(!size)size=total-offset;if(size<base)break;
      if(type==='moov'&&size-base<=64*1024*1024){const moov=Buffer.alloc(size-base);fs.readSync(fd,moov,0,moov.length,offset+base);for(const code of ['ac-3','ec-3','dtsc','dtsh','dtsl','dtsm'])if(moov.includes(Buffer.from(code)))return code;if(moov.includes(Buffer.from('mp4a')))return 'aac';return null;}offset+=size;
    }
  }catch{}finally{if(fd!==undefined)fs.closeSync(fd);}return null;
}
function transcodeAudio(source,target) { return new Promise((resolve,reject)=>{console.log(`Converting AC-3 audio to AAC: ${path.basename(source)}`);const child=spawn(FFMPEG,['-hide_banner','-loglevel','error','-y','-i',source,'-map','0:a:0','-vn','-c:a','aac','-b:a','192k','-movflags','+faststart',target],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',part=>{stderr=(stderr+part).slice(-3000);});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(stderr||`FFmpeg exited with code ${code}`)));}); }
const audioJobs=new Map();
async function ensureAacAudio(eid,source){const target=path.join(AUDIO,`${eid}.m4a`);if(fs.existsSync(target)&&fs.statSync(target).mtimeMs>=fs.statSync(source).mtimeMs)return target;if(audioJobs.has(eid))return audioJobs.get(eid);const job=(async()=>{const temporary=path.join(AUDIO,`${eid}.${crypto.randomUUID()}.m4a`);try{await transcodeAudio(source,temporary);try{fs.unlinkSync(target);}catch{}await fs.promises.rename(temporary,target);return target;}catch(err){try{fs.unlinkSync(temporary);}catch{}throw err;}})();audioJobs.set(eid,job);try{return await job;}finally{audioJobs.delete(eid);}}
function showFor(db, title) { let show = db.shows.find(x => x.title.toLowerCase() === title.toLowerCase()); if (!show) { show = { id:id(), title, episodes:[] }; db.shows.push(show); } return show; }
function episodeFor(show, filename, video) { return show.episodes.find(e => e.filename === filename) || { id:id(), filename, title:filename.replace(/\.[^.]+$/, '').replace(/[._]/g,' ').trim(), video, still:null, addedAt:Date.now() }; }
function walk(dir, result = []) { for (const item of fs.readdirSync(dir, { withFileTypes:true })) { const full = path.join(dir,item.name); if (item.isDirectory()) walk(full,result); else if (VIDEO_EXT.has(path.extname(item.name).toLowerCase())) result.push(full); } return result; }
function decorate(db) { return { progress:db.progress||{}, shows: db.shows.map(s => ({ ...s, episodes:s.episodes.map(e => ({...e, url:`/media/${encodeURIComponent(s.id)}/${encodeURIComponent(e.id)}`})) })) }; }

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/library') return json(res,200,decorate(readDb()));
    if (req.method === 'GET' && url.pathname.startsWith('/api/playback/')) {
      const eid=decodeURIComponent(url.pathname.split('/').pop()), db=readDb(); let episode;
      for(const show of db.shows){episode=show.episodes.find(e=>e.id===eid);if(episode)break;}
      if(!episode)return json(res,404,{error:'Episode not found'});
      const source=path.join(VIDEOS,path.basename(episode.video)), codec=audioCodec(source);
      if(codec&&codec!=='aac'){
        if(!FFMPEG_AVAILABLE)return json(res,422,{error:`This episode uses ${codec.toUpperCase()} audio, which your browser cannot play. Install FFmpeg in Command Prompt with: winget install --id Gyan.FFmpeg.Shared -e. Then restart Nebflix and try again.`});
        try{await ensureAacAudio(eid,source);}catch(err){console.error(`Audio conversion failed for ${episode.filename}:`,err.message);return json(res,500,{error:'Nebflix could not convert this audio track. Check the Command Prompt for the FFmpeg error.'});}
        return json(res,200,{videoUrl:`/media/${encodeURIComponent((db.shows.find(s=>s.episodes.some(e=>e.id===eid))||{}).id)}/${encodeURIComponent(eid)}`,audioUrl:`/audio/${encodeURIComponent(eid)}.m4a`,separateAudio:true,audioCodec:codec});
      }
      const show=db.shows.find(s=>s.episodes.some(e=>e.id===eid));
      return json(res,200,{videoUrl:`/media/${encodeURIComponent(show.id)}/${encodeURIComponent(eid)}`,separateAudio:false,audioCodec:codec||'unknown'});
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
      for (const source of files) { const filename=path.basename(source), existing=show.episodes.find(e=>e.filename.toLowerCase()===filename.toLowerCase()); if(existing) continue;
        const ext=path.extname(filename), stored=`${crypto.randomUUID()}${ext}`; await fs.promises.copyFile(source,path.join(VIDEOS,stored));
        show.episodes.push({id:id(),filename,title:filename.replace(/\.[^.]+$/,'').replace(/[._]/g,' ').trim(),video:stored,still:null,addedAt:Date.now()}); added++;
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
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/episode/')) {
      const eid=decodeURIComponent(url.pathname.split('/').pop()), db=readDb(); let removed=false;
      for(const show of db.shows){const n=show.episodes.findIndex(e=>e.id===eid);if(n>=0){const [ep]=show.episodes.splice(n,1);try{fs.unlinkSync(path.join(VIDEOS,ep.video));fs.unlinkSync(path.join(STILLS,`${eid}.jpg`));fs.unlinkSync(path.join(AUDIO,`${eid}.m4a`));}catch{}removed=true;break;}}
      db.shows=db.shows.filter(s=>s.episodes.length);saveDb(db);return json(res,removed?200:404,{library:decorate(db)});
    }
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const [, , sid, eid] = url.pathname.split('/'); const db=readDb(); const show=db.shows.find(s=>s.id===decodeURIComponent(sid)); const ep=show?.episodes.find(e=>e.id===decodeURIComponent(eid));
      if(!ep) return json(res,404,{error:'Episode not found'}); const file=path.join(VIDEOS,path.basename(ep.video)); if(!fs.existsSync(file))return json(res,404,{error:'Video file is missing'});
      const stat=fs.statSync(file), range=req.headers.range;
      if(range){const [a,b]=range.replace(/bytes=/,'').split('-');const start=Number(a),end=b?Math.min(Number(b),stat.size-1):stat.size-1;if(start>=stat.size)return res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end();res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Content-Type':mime(file)});return fs.createReadStream(file,{start,end}).pipe(res);}
      res.writeHead(200,{'Content-Length':stat.size,'Accept-Ranges':'bytes','Content-Type':mime(file)});return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/stills/')) { const file=path.join(STILLS,path.basename(url.pathname)); if(!fs.existsSync(file))return res.writeHead(404).end();res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'public, max-age=31536000, immutable'});return fs.createReadStream(file).pipe(res); }
    if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
      const file=path.join(AUDIO,path.basename(url.pathname));if(!fs.existsSync(file))return json(res,404,{error:'Converted audio not found'});
      const stat=fs.statSync(file),range=req.headers.range;
      if(range){const [a,b]=range.replace(/bytes=/,'').split('-'),start=Number(a),end=b?Math.min(Number(b),stat.size-1):stat.size-1;if(start>=stat.size)return res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end();res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Content-Type':'audio/mp4'});return fs.createReadStream(file,{start,end}).pipe(res);}
      res.writeHead(200,{'Content-Length':stat.size,'Accept-Ranges':'bytes','Content-Type':'audio/mp4'});return fs.createReadStream(file).pipe(res);
    }
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
server.listen(PORT,'127.0.0.1',()=>{console.log(`Nebflix is ready at http://localhost:${PORT}`);if(FFMPEG_AVAILABLE)console.log(`FFmpeg audio conversion is ready (${FFMPEG}).`);else console.log('FFmpeg not found. AC-3 audio conversion is unavailable; see README.md for the one-time setup command.');if(process.env.NEBFLIX_LAUNCH_BROWSER==='1'){const opener=spawn('cmd.exe',['/d','/c','start','',`http://localhost:${PORT}`],{detached:true,stdio:'ignore',windowsHide:true});opener.unref();}});
