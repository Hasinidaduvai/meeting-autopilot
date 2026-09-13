# Meeting Autopilot

Joins your call, takes notes, assigns action items to people.

- Live mode: open mic, captions stream with speaker colors, hit "Generate Autopilot Notes"
- Demo mode: upload a recorded meeting → auto-transcribe (with speakers) → notes + action items
- Paste mode: paste a transcript → notes instantly

## Run locally
1. `npm install` (project root)
2. `cd server && npm install`
3. copy `server/.env.example` → `server/.env` and add your keys
4. terminal 1: `cd server && node index.js`
5. terminal 2: `npm run dev`
6. open http://localhost:5173

## Deploy (Render, one URL)
- Root directory: empty
- Build: `npm install && npm run build && cd server && npm install`
- Start: `node server/index.js`
- Env vars: DEEPGRAM_API_KEY, GROQ_API_KEY