const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { spawn, exec } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

// Supabase Configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zpglwxppgzdjirnvvlfg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwZ2x3eHBwZ3pkamlybnZ2bGZnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTI3ODU1OSwiZXhwIjoyMTA0ODU0NTU5fQ.oV7-HhtrPXD0AhiDyA26SLqQfJWoMJS1lY5JO18TBWs';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let ffmpegProcess = null;
let autoSwitchTimer = null;
let lastRestartTrigger = null;
let currentConfig = null;
let isBusySwitching = false;

const FONT_PATH = path.join(__dirname, 'sindhi.ttf');

console.log("🚀 Live Studio Engine v3.2 (Production Stable) Started!");

// Text Escaping for FFmpeg Drawtext
function sanitizeText(text) {
  if (!text) return '';
  return text
    .toString()
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

// Get Video Duration via FFprobe
function getVideoDuration(url) {
  return new Promise((resolve) => {
    const cmd = `"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${url}"`;
    exec(cmd, (error, stdout) => {
      if (error || !stdout) {
        resolve(null);
      } else {
        const duration = parseFloat(stdout.trim());
        resolve(isNaN(duration) ? null : duration);
      }
    });
  });
}

// Auto Track Switch Logic
async function handleNextTrackAuto() {
  if (isBusySwitching) return;
  isBusySwitching = true;

  try {
    const { data: config, error } = await supabase.from('stream_config').select('*').eq('id', 1).single();
    if (error || !config || !config.is_live || !config.playlist || config.playlist.length === 0) {
      isBusySwitching = false;
      return;
    }

    const playlist = config.playlist;
    const total = playlist.length;
    let currentIdx = Number(config.current_track_index || 0);
    
    let nextIdx = (currentIdx + 1) % total;
    let upcomingIdx = (nextIdx + 1) % total;

    const autoNextText = `Track ${upcomingIdx + 1} of ${total}`;
    const newTrigger = Date.now();
    lastRestartTrigger = newTrigger;

    console.log(`⏱️ [Auto Switch]: Track ${currentIdx} ➔ ${nextIdx}`);

    await supabase.from('stream_config').update({
      current_track_index: nextIdx,
      next_track: autoNextText,
      restart_trigger: newTrigger
    }).eq('id', 1);

    config.current_track_index = nextIdx;
    config.next_track = autoNextText;
    config.restart_trigger = newTrigger;
    currentConfig = config;

    startBroadcaster(config);
  } catch (err) {
    console.error("Auto Switch Error:", err);
  } finally {
    setTimeout(() => { isBusySwitching = false; }, 3000);
  }
}

// Database Listener Loop
async function checkDatabaseState() {
  if (isBusySwitching) return;

  try {
    const { data: config, error } = await supabase.from('stream_config').select('*').eq('id', 1).single();
    if (error || !config) return;

    currentConfig = config;

    if (config.restart_trigger && config.restart_trigger !== lastRestartTrigger) {
      console.log("🔄 Configuration Changed - Restarting Stream!");
      lastRestartTrigger = config.restart_trigger;
      startBroadcaster(config);
      return;
    }

    if (!config.is_live && ffmpegProcess) {
      console.log("⏹️ Stream STOP Signal Received.");
      stopBroadcaster();
    } else if (config.is_live && !ffmpegProcess && !isBusySwitching) {
      console.log("▶️ Stream START Signal Received.");
      if (config.restart_trigger) lastRestartTrigger = config.restart_trigger;
      startBroadcaster(config);
    }
  } catch (err) {
    console.error("Database Check Error:", err);
  }
}

// Main FFmpeg Broadcaster
async function startBroadcaster(config) {
  stopBroadcaster();

  const playlist = (config.playlist && config.playlist.length > 0) 
    ? config.playlist 
    : [{ url: 'https://ia600404.us.archive.org/25/items/mran_20260927_202609/mran.mp4' }];

  let trackIndex = Number(config.current_track_index || 0);
  if (trackIndex >= playlist.length) trackIndex = 0;

  const activeVideoUrl = playlist[trackIndex].url;

  let fbKey = config.fb_key ? config.fb_key.trim() : '';
  let ytKey = config.yt_key ? config.yt_key.trim() : '';

  if (!fbKey && !ytKey) {
    console.log("⚠️ No Stream Key provided for Facebook or YouTube.");
    return;
  }

  // Format Facebook RTMPS Target
  let fbTarget = '';
  if (fbKey) {
    if (fbKey.startsWith('rtmp://') || fbKey.startsWith('rtmps://')) {
      fbTarget = fbKey;
    } else {
      fbTarget = `rtmps://live-api-s.facebook.com:443/rtmp/${fbKey}`;
    }
  }

  // Format YouTube RTMP Target
  let ytTarget = '';
  if (ytKey) {
    if (ytKey.startsWith('rtmp://') || ytKey.startsWith('rtmps://')) {
      ytTarget = ytKey;
    } else {
      ytTarget = `rtmp://a.rtmp.youtube.com/live2/${ytKey}`;
    }
  }

  const program = sanitizeText(config.program_name || '');
  const nextTrk = sanitizeText(config.next_track || '');
  const ticker = sanitizeText(config.ticker_text || '');
  const logoUrl = (config.logo_url && config.logo_url.trim() !== '') ? config.logo_url.trim() : 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/React-icon.svg/1200px-React-icon.svg.png';
  
  const logoSize = config.logo_size || '120';
  const pos = config.logo_position || 'top-right';

  let overlayPos = 'main_w-overlay_w-30:30';
  if (pos === 'top-left') overlayPos = '30:30';
  else if (pos === 'bottom-right') overlayPos = 'main_w-overlay_w-30:main_h-overlay_h-70';
  else if (pos === 'bottom-left') overlayPos = '30:main_h-overlay_h-70';

  let videoFilter = `[1:v]scale=${logoSize}:-1[logo];[0:v][logo]overlay=${overlayPos}[v1]`;
  
  const fontOpt = fs.existsSync(FONT_PATH) 
    ? `fontfile='${FONT_PATH.replace(/\\/g, '/')}'` 
    : `font='DejaVu Sans'`;

  let currentStreamVar = 'v1';

  if (program) {
    videoFilter += `;[${currentStreamVar}]drawtext=text='${program}':x=30:y=30:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6:${fontOpt}[v_prg]`;
    currentStreamVar = 'v_prg';
  }

  if (nextTrk) {
    videoFilter += `;[${currentStreamVar}]drawtext=text='${nextTrk}':x=30:y=75:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.4:boxborderw=4:${fontOpt}[v_nxt]`;
    currentStreamVar = 'v_nxt';
  }

  if (ticker) {
    videoFilter += `;[${currentStreamVar}]drawtext=text='${ticker}':x=-tw+mod(t*140\\,w+tw):y=h-50:fontsize=28:fontcolor=white:box=1:boxcolor=red@0.85:boxborderw=10:${fontOpt}[v_tck]`;
    currentStreamVar = 'v_tck';
  }

  videoFilter += `;[${currentStreamVar}]null[outv]`;

  let ffmpegArgs = [
    '-re',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    '-i', activeVideoUrl,
    '-i', logoUrl,
    '-filter_complex', videoFilter,
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', '2500k',
    '-maxrate', '3000k',
    '-bufsize', '6000k',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-flvflags', 'no_duration_filesize'
  ];

  // Stable Output Handling (Avoids Tee parsing crashes)
  if (fbTarget && ytTarget) {
    // Split output cleanly into two direct FLV output definitions
    ffmpegArgs.push('-f', 'flv', fbTarget);
    ffmpegArgs.push('-map', '[outv]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '2500k', '-c:a', 'aac', '-f', 'flv', ytTarget);
  } else if (fbTarget) {
    ffmpegArgs.push('-f', 'flv', fbTarget);
  } else if (ytTarget) {
    ffmpegArgs.push('-f', 'flv', ytTarget);
  }

  try {
    console.log(`▶ Starting Live Transmission on: ${fbTarget ? 'Facebook' : ''} ${ytTarget ? 'YouTube' : ''}`);
    ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

    if (ffmpegProcess) {
      ffmpegProcess.stderr.on('data', (data) => {
        const str = data.toString();
        if (str.includes('Error') || str.includes('failed') || str.includes('Invalid')) {
          console.error(`[FFmpeg Alert]: ${str.trim()}`);
        }
      });

      const duration = await getVideoDuration(activeVideoUrl);
      if (duration && duration > 10) {
        const switchDelay = (duration - 3) * 1000;
        console.log(`⏱️ Duration: ${duration.toFixed(1)}s. Auto switch in: ${Math.round(switchDelay / 1000)}s.`);
        
        autoSwitchTimer = setTimeout(() => {
          handleNextTrackAuto();
        }, switchDelay);
      }

      ffmpegProcess.on('close', (code) => {
        console.log(`[FFmpeg Closed] Code: ${code}`);
        ffmpegProcess = null;
        if (autoSwitchTimer) {
          clearTimeout(autoSwitchTimer);
          autoSwitchTimer = null;
        }
        
        if (currentConfig && currentConfig.is_live && !isBusySwitching) {
          handleNextTrackAuto();
        }
      });

      ffmpegProcess.on('error', (err) => {
        console.error("FFmpeg Execution Error:", err.message);
        ffmpegProcess = null;
      });
    }

  } catch (e) {
    console.error("Broadcaster Failure Exception:", e.message);
    ffmpegProcess = null;
  }
}

function stopBroadcaster() {
  if (autoSwitchTimer) {
    clearTimeout(autoSwitchTimer);
    autoSwitchTimer = null;
  }
  if (ffmpegProcess) {
    try {
      ffmpegProcess.removeAllListeners('close');
      ffmpegProcess.kill('SIGKILL');
    } catch (e) {}
    ffmpegProcess = null;
  }
}

setInterval(checkDatabaseState, 2000);

// Anti-Sleep Self Ping
setInterval(() => {
  http.get(`http://localhost:${PORT}`, () => {}).on('error', () => {});
}, 3 * 60 * 1000);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Port listener for Docker / Render / Railway
app.listen(PORT, '0.0.0.0', () => console.log(`Server actively running on Port ${PORT}`));
