require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const { generateNotes } = require('./groq');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/stream' });

const distDir = path.join(__dirname, '../dist');
app.use(express.static(distDir));

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

wss.on('connection', (socket) => {
  let dg = null;

  socket.on('message', (raw) => {
    if (typeof raw !== 'string') {
      if (dg) {
        try { dg.send(raw); } catch (e) {}
      }
      return;
    }
    const msg = JSON.parse(raw);

    if (msg.type === 'config') {
      try {
        dg = deepgram.listen.live({
          language: msg.language || 'en-US',
          model: 'nova-3',
          punctuate: true,
          interim_results: true,
          diarize: true,
        });
        dg.on('transcript', (data) => {
          const alt = data.channel && data.channel.alternatives && data.channel.alternatives[0];
          if (!alt || !alt.transcript) return;
          const speaker = alt.words && alt.words[0] ? alt.words[0].speaker : 0;
          socket.send(JSON.stringify({ type: 'transcript', is_final: data.is_final, speaker, text: alt.transcript }));
        });
        dg.on('error', (err) => socket.send(JSON.stringify({ type: 'error', message: err.message })));
        dg.on('close', () => socket.send(JSON.stringify({ type: 'close' })));
      } catch (e) {
        socket.send(JSON.stringify({ type: 'error', message: e.message }));
      }
      return;
    }

    if (msg.type === 'end' && dg) {
      dg.finish();
      dg = null;
    }
  });

  socket.on('close', () => {
    if (dg) dg.finish();
  });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function toLines(result) {
  const words = (result.results && result.results.channels && result.results.channels[0] &&
    result.results.channels[0].alternatives && result.results.channels[0].alternatives[0].words) || [];
  const lines = [];
  let current = null;
  for (const w of words) {
    if (!w.word) continue;
    const spk = typeof w.speaker === 'number' ? w.speaker : 0;
    if (!current || current.speaker !== spk) {
      if (current) lines.push(current);
      current = { speaker: spk, text: '', start: w.start };
    }
    current.text = current.text ? current.text + ' ' + w.word.trim() : w.word.trim();
    current.end = w.end;
  }
  if (current) lines.push(current);
  return lines;
}

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      req.file.buffer,
      { model: 'nova-3', language: req.query.language || 'en-US', diarize: true, punctuate: true }
    );
    if (error) return res.status(500).json({ error: error.message });
    res.json({ transcript: toLines(result) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/autopilot', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      req.file.buffer,
      { model: 'nova-3', language: req.query.language || 'en-US', diarize: true, punctuate: true }
    );
    if (error) return res.status(500).json({ error: error.message });
    const lines = toLines(result);
    const notes = await generateNotes(lines);
    res.json({ transcript: lines, notes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notes', async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ error: 'Transcript is required' });
    }
    res.json({ notes: await generateNotes(transcript) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Meeting Autopilot running on http://localhost:' + PORT));