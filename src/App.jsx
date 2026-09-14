import { useState, useRef, useEffect } from 'react';

const DEV = import.meta.env.DEV;
const API = import.meta.env.VITE_BACKEND_URL || (DEV ? 'http://localhost:3001' : '');
const WS_URL = (import.meta.env.VITE_BACKEND_URL || (DEV ? 'http://localhost:3001' : location.origin)).replace(/^http/, 'ws') + '/stream';

const SPEAKER_COLORS = ['#4f8cff', '#3ecf8e', '#ff9f43', '#ff5c8a', '#a55eea', '#f6b93b'];

const DEMO_MEETING = [
  { speaker: 0, text: 'Thanks for joining everyone. Can we review the budget deck?' },
  { speaker: 1, text: 'Sure, the numbers look fine, just the vendor pricing is pending.' },
  { speaker: 0, text: 'Priya, can you send the full deck to the team by Friday?' },
  { speaker: 1, text: 'Yes, I will share it Friday morning.' },
  { speaker: 0, text: 'Rahul, could you get a final quote from the vendor?' },
  { speaker: 1, text: 'I can ask the vendor today and send it over.' },
  { speaker: 0, text: 'Great. Let us also fix the next sync for Monday.' },
  { speaker: 1, text: 'Monday at 10 works for me.' },
];

const FEATURES = [
  { title: 'Live speaker-aware captions', desc: 'Every voice separated, labelled, and captioned in real time. No login, no setup.' },
  { title: 'Auto summary of the meeting', desc: 'Topics and decisions extracted automatically from the whole conversation.' },
  { title: 'Action items assigned to people', desc: 'Tasks mapped to the speaker who owns them, plus a ready-to-send email.' },
];

const STEPS = [
  { num: '01', title: 'Start the meeting', desc: 'Click start. The mic listens and separates each voice with Deepgram speaker diarization.' },
  { num: '02', title: 'Talk normally', desc: 'Captions stream live, colour-coded per person. Nobody needs an account.' },
  { num: '03', title: 'End and get notes', desc: 'One click creates a summary, assigned action items, and a drafted email.' },
];

function encodePCM(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm.buffer;
}

function parsePaste(text) {
  return text
    .split('\n')
    .map((l) => {
      const m = l.match(/\[Speaker\s*(\d+)\]\s*(.+)/i);
      if (m) return { speaker: Number(m[1]), text: m[2] };
      const m2 = l.match(/^(\w+):\s*(.+)/);
      if (m2) return { speaker: m2[1], text: m2[2] };
      return null;
    })
    .filter(Boolean);
}

const SECTION_NAMES = ['Demo', 'What it does', 'How it works'];

export default function App() {
  const [tab, setTab] = useState('demo');
  const [activeSlide, setActiveSlide] = useState(0);
  const [meetingOn, setMeetingOn] = useState(false);
  const [transcript, setTranscript] = useState([]);
  const [notes, setNotes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [demoFile, setDemoFile] = useState(null);
  const [liveStatus, setLiveStatus] = useState('');
  const [copied, setCopied] = useState(false);
  const [pasteText, setPasteText] = useState('[Speaker 1] Thanks for joining everyone.\n[Speaker 2] Let us review the budget deck.\n[Speaker 1] Priya, can you send the deck by Friday.\n[Speaker 2] Yes, I will share it.\n[Speaker 1] Rahul, please get the vendor pricing.\n[Speaker 2] I can ask the vendor today.');

  const wsRef = useRef(null);
  const ctxRef = useRef(null);
  const procRef = useRef(null);
  const streamRef = useRef(null);
  const revealRef = useRef(null);
  const scrollRef = useRef(null);
  const demoRef = useRef(null);
  const aboutRef = useRef(null);
  const howRef = useRef(null);

  useEffect(() => {
    const slides = [
      { el: demoRef.current, idx: 0 },
      { el: aboutRef.current, idx: 1 },
      { el: howRef.current, idx: 2 },
    ].filter((s) => s.el);

    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('active');
            const s = slides.find((x) => x.el === e.target);
            if (s) setActiveSlide(s.idx);
          } else {
            e.target.classList.remove('active');
          }
        });
      },
      { threshold: 0.45 }
    );
    slides.forEach((s) => obs.observe(s.el));
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const box = document.getElementById('transcriptBox');
    if (box) box.scrollTop = box.scrollHeight;
  }, [transcript]);

  const goTo = (idx) => {
    const refs = [demoRef, aboutRef, howRef];
    const el = refs[idx] && refs[idx].current;
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  const speakerLabel = (l) =>
    typeof l.speaker === 'number' ? 'Speaker ' + (l.speaker + 1)
    : typeof l.speaker === 'string' ? l.speaker
    : 'Speaker ?';

  const speakerColor = (l) => {
    let idx = 0;
    if (typeof l.speaker === 'number') idx = l.speaker;
    else if (typeof l.speaker === 'string') idx = l.speaker.charCodeAt(0);
    return SPEAKER_COLORS[Math.abs(idx) % SPEAKER_COLORS.length];
  };

  const startLive = async () => {
    setError('');
    setTranscript([]);
    setNotes(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      streamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      procRef.current = proc;
      source.connect(proc);
      proc.connect(ctx.destination);

      const TARGET_RATE = 16000;
      const step = Math.max(1, Math.round(ctx.sampleRate / TARGET_RATE));

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      setLiveStatus('Connecting to server...');
      ws.onopen = () => {
        setLiveStatus('Connecting to Deepgram AI...');
        ws.send(JSON.stringify({ type: 'config', language: 'en-US' }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ready') {
          setLiveStatus('Connected — speak now');
          return;
        }
        if (msg.type === 'error') {
          setError('Live error: ' + msg.message);
          setLiveStatus('Error — see red box');
          return;
        }
        if (msg.type !== 'transcript' || !msg.text.trim()) return;
        setTranscript((t) => {
          const last = t[t.length - 1];
          if (!msg.is_final && last && last.speaker === msg.speaker && last.final === false) {
            return [...t.slice(0, -1), { ...last, text: msg.text }];
          }
          return [...t, { speaker: msg.speaker, text: msg.text, final: msg.is_final, ts: Date.now() + Math.random() }];
        });
      };
      ws.onerror = () => setError('WebSocket error — is the server running?');
      ws.onclose = () => setLiveStatus('Disconnected');

      proc.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        if (step > 1) {
          const out = new Float32Array(Math.ceil(input.length / step));
          for (let i = 0, j = 0; i < input.length; i += step, j++) out[j] = input[i];
          ws.send(encodePCM(out));
        } else {
          ws.send(encodePCM(input));
        }
      };

      setMeetingOn(true);
    } catch (err) {
      setError('Mic error: ' + err.message);
    }
  };

  const stopLive = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'end' }));
      wsRef.current.close();
    }
    if (procRef.current) procRef.current.disconnect();
    if (ctxRef.current) ctxRef.current.close();
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    wsRef.current = null;
    setMeetingOn(false);
    setLiveStatus('');
  };

  const makeNotes = async () => {
    if (transcript.length === 0) {
      setError('No transcript yet — start a meeting and speak first');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(API + '/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Notes failed');
      setNotes(data.notes);
    } catch (e) {
      setError('Notes error: ' + e.message);
    }
    setLoading(false);
  };

  const playLines = async (lines) => {
    for (let i = 0; i < lines.length; i++) {
      await new Promise((r) => setTimeout(r, 450));
      setTranscript((prev) => [...prev, lines[i]]);
    }
  };

  const runBuiltInDemo = async () => {
    if (revealRef.current) return;
    revealRef.current = true;
    setLoading(true);
    setError('');
    setNotes(null);
    setTab('demo');

    const lines = DEMO_MEETING.map((l, idx) => ({
      speaker: typeof l.speaker === 'number' ? l.speaker : 0,
      text: l.text,
      final: true,
      ts: Date.now() + idx,
    }));
    setTranscript([]);
    await playLines(lines);

    try {
      const res = await fetch(API + '/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: lines }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Notes failed');
      setNotes(data.notes);
    } catch (e) {
      setError('Notes error: ' + e.message);
    }
    setLoading(false);
    revealRef.current = false;
  };

  const runDemo = async () => {
    if (revealRef.current) return;
    if (!demoFile) {
      setError('Choose a recording file first');
      return;
    }
    revealRef.current = true;
    setLoading(true);
    setError('');
    setNotes(null);

    const fd = new FormData();
    fd.append('audio', demoFile);
    try {
      const res = await fetch(API + '/api/autopilot', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Transcription failed');
      const lines = (data.transcript || []).map((l, idx) => ({
        speaker: typeof l.speaker === 'number' ? l.speaker : 0,
        text: String(l.text || ''),
        final: true,
        ts: Date.now() + idx,
      }));
      setTranscript([]);
      await playLines(lines);
      setNotes(data.notes);
    } catch (e) {
      setError('Demo error: ' + e.message);
    }
    setLoading(false);
    revealRef.current = false;
  };

  const runPaste = async () => {
    const lines = parsePaste(pasteText);
    if (lines.length === 0) {
      setError('Paste at least one line like [Speaker 1] text');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(API + '/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: lines }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Notes failed');
      setNotes(data.notes);
      setTranscript(lines);
    } catch (e) {
      setError('Notes error: ' + e.message);
    }
    setLoading(false);
  };

  const copyEmail = async () => {
    if (!notes || !notes.email_draft) return;
    try {
      await navigator.clipboard.writeText(notes.email_draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {}
  };

  return (
    <div style={styles.root}>
      <style>{`
        @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(6px); } }
        .reel { height: 100vh; overflow-y: auto; scroll-snap-type: y mandatory; scroll-behavior: smooth; }
        .slide { min-height: 100vh; height: 100vh; scroll-snap-align: start; scroll-snap-stop: always; box-sizing: border-box; display: flex; align-items: center; justify-content: center; overflow-y: auto; padding: 56px 20px 48px; position: relative; }
        .slideInner { max-width: 820px; width: 100%; margin: auto; text-align: center; }
        .anim { opacity: 0; transform: translateY(40px); transition: opacity .8s ease, transform .8s ease; }
        .anim2 { opacity: 0; transform: translateY(30px); transition: opacity .8s ease, transform .8s ease; }
        .slide.active .anim, .slide.active .anim2 { opacity: 1; transform: none; }
        @media (max-width: 700px) {
          .slide { padding: 40px 16px 40px; }
        }
      `}</style>

      <div className="reel" style={styles.reel}>
        <section ref={demoRef} className="slide" style={styles.slide}>
          <div className="slideInner">
            <div className="anim" style={styles.badge}>ONE CLICK DEMO</div>
            <h1 className="anim" style={{ ...styles.title, transitionDelay: '0.1s' }}>Meeting Autopilot</h1>
            <p className="anim2" style={{ ...styles.sub, transitionDelay: '0.2s' }}>
              Attends your meeting. Captions every speaker. Leaves you with a summary, action items assigned to people, and a ready-to-send email.
            </p>

            <div className="anim2" style={{ ...styles.inputArea, justifyContent: 'center', transitionDelay: '0.3s' }}>
              <button style={styles.btnGreen} onClick={runBuiltInDemo} disabled={loading}>
                {loading ? 'Playing...' : 'Play Built-in Demo'}
              </button>
            </div>

            <p className="anim2" style={{ ...styles.hint, transitionDelay: '0.4s' }}>
              No mic, no file — an instant sample meeting. Watch it caption itself, then generate notes.
            </p>

            {error && <div style={styles.error}>{error}</div>}

            {transcript.length > 0 && (
              <div className="anim2" style={{ textAlign: 'left', transitionDelay: '0.1s' }}>
                <div style={styles.panelLabel}>Live Transcript — Speaker Aware</div>
                <div id="transcriptBox" style={styles.transcriptWrap}>
                  {transcript.map((l) => (
                    <div key={l.ts} style={styles.line}>
                      <span style={{ ...styles.speaker, background: speakerColor(l) }}>{speakerLabel(l)}</span>
                      <span style={styles.lineText}>{l.text}{!l.final && <span style={styles.cursor}>▋</span>}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {notes && (
              <div className="anim2" style={{ textAlign: 'left', transitionDelay: '0.15s' }}>
                <h2 style={styles.notesTitle}>Autopilot Notes</h2>
                <div style={styles.card}><div style={styles.cardLabel}>Summary</div><p style={styles.cardText}>{notes.summary}</p></div>
                <div style={styles.card}>
                  <div style={styles.cardLabel}>Topics Covered</div>
                  <div style={styles.tags}>{(notes.topics || []).map((t, i) => <span key={i} style={styles.tag}>{t}</span>)}</div>
                </div>
                <div style={styles.card}>
                  <div style={styles.cardLabel}>Action Items</div>
                  {(notes.action_items || []).map((a, i) => (
                    <div key={i} style={styles.action}>
                      <span style={styles.owner}>{a.owner}</span>
                      <span style={styles.actionTask}>{a.task}</span>
                      {a.deadline && <span style={styles.due}>by {a.deadline}</span>}
                    </div>
                  ))}
                  {(notes.action_items || []).length === 0 && <div style={styles.empty}>No action items detected.</div>}
                </div>
                <div style={styles.card}>
                  <div style={styles.cardHead}>
                    <div style={styles.cardLabel}>Draft Email to Send</div>
                    <button style={styles.copyBtn} onClick={copyEmail}>{copied ? 'Copied!' : 'Copy'}</button>
                  </div>
                  <pre style={styles.email}>{notes.email_draft}</pre>
                </div>
              </div>
            )}

            <div style={styles.moreTabs}>
              <button style={{ ...styles.pill, ...(tab === 'demo' ? styles.pillActive : {}) }} onClick={() => setTab('demo')}>Demo</button>
              <button style={{ ...styles.pill, ...(tab === 'live' ? styles.pillActive : {}) }} onClick={() => setTab('live')}>Live Meeting</button>
              <button style={{ ...styles.pill, ...(tab === 'paste' ? styles.pillActive : {}) }} onClick={() => setTab('paste')}>Paste a Transcript</button>
            </div>

            {tab === 'live' && (
              <div style={styles.card}>
                <div style={styles.inputArea}>
                  {!meetingOn ? (
                    <button style={styles.btnGreen} onClick={startLive}>Start Meeting</button>
                  ) : (
                    <button style={styles.btnRed} onClick={stopLive}>End Meeting</button>
                  )}
                  <button style={styles.btn} onClick={makeNotes} disabled={loading || transcript.length === 0}>
                    {loading ? 'Thinking...' : 'Generate Notes'}
                  </button>
                </div>
                <div style={styles.liveBadge}>{meetingOn ? 'LIVE — ' + (liveStatus || 'speaking...') : 'Speak now, get notes after. Works on a normal laptop mic.'}</div>
              </div>
            )}

            {tab === 'paste' && (
              <div style={styles.card}>
                <textarea style={styles.textarea} value={pasteText} onChange={(e) => setPasteText(e.target.value)} spellCheck={false} />
                <button style={styles.btn} onClick={runPaste} disabled={loading}>{loading ? 'Thinking...' : 'Analyze Transcript'}</button>
              </div>
            )}
          </div>

          <div style={styles.scrollHint}>
            <div>SCROLL</div>
            <div style={styles.scrollArrow}>▾</div>
          </div>
        </section>

        <section ref={aboutRef} className="slide" style={styles.slide}>
          <div className="slideInner">
            <div className="anim" style={styles.badge}>WHAT IT DOES</div>
            <h2 className="anim" style={{ ...styles.sectionTitle, transitionDelay: '0.1s' }}>Two minutes of talking. Zero minutes of note-taking.</h2>
            <p className="anim2" style={{ ...styles.sub, transitionDelay: '0.2s' }}>Recording apps just save audio. Meeting Autopilot understands who said what, what was decided, and who promised to do what.</p>

            <div style={styles.features}>
              {FEATURES.map((f, i) => (
                <div key={i} className="anim2" style={{ ...styles.feature, transitionDelay: 0.15 * (i + 1) + 's' }}>
                  <div style={styles.featureTitle}>{f.title}</div>
                  <div style={styles.featureDesc}>{f.desc}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={styles.scrollHint}>
            <div>SCROLL</div>
            <div style={styles.scrollArrow}>▾</div>
          </div>
        </section>

        <section ref={howRef} className="slide" style={styles.slide}>
          <div className="slideInner">
            <div className="anim" style={styles.badge}>HOW IT WORKS</div>
            <h2 className="anim" style={{ ...styles.sectionTitle, transitionDelay: '0.1s' }}>Three steps. No accounts for anyone.</h2>

            <div style={styles.steps}>
              {STEPS.map((s, i) => (
                <div key={i} className="anim2" style={{ ...styles.step, transitionDelay: 0.15 * (i + 1) + 's' }}>
                  <div style={styles.stepNum}>{s.num}</div>
                  <div style={styles.stepTitle}>{s.title}</div>
                  <div style={styles.stepDesc}>{s.desc}</div>
                </div>
              ))}
            </div>

            <div className="anim2" style={{ marginTop: 28, transitionDelay: '0.6s' }}>
              <button style={styles.btnBack} onClick={() => goTo(0)}>Back to demo</button>
            </div>

            <div style={styles.footer}>Built with Deepgram speaker-aware speech-to-text and Groq LLM.</div>
          </div>
          <div style={styles.scrollHint}>
            <div>SCROLL</div>
            <div style={styles.scrollArrow}>▾</div>
          </div>
        </section>
      </div>

      <div style={styles.rail}>
        {SECTION_NAMES.map((name, i) => (
          <button key={i} onClick={() => goTo(i)} title={name} style={{ ...styles.railDot, ...(activeSlide === i ? styles.railDotActive : {}) }} />
        ))}
      </div>
    </div>
  );
}

const styles = {
  root: { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#e8e8e8' },
  reel: { background: 'radial-gradient(1200px 600px at 50% -100px, #12264a 0%, transparent 60%), radial-gradient(1000px 500px at 100% 100%, #1a1a2e 0%, transparent 60%), #0a0e14' },
  slide: {},

  badge: { display: 'inline-block', fontSize: 12, letterSpacing: '0.25em', color: '#5eead4', border: '1px solid #1f3d4a', borderRadius: 999, padding: '6px 16px', marginBottom: 20 },
  title: { fontSize: 58, fontWeight: 800, margin: '0 0 14px', lineHeight: 1.1, background: 'linear-gradient(120deg, #5eead4, #60a5fa, #c084fc)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' },
  sub: { color: '#9aa7b8', fontSize: 17, lineHeight: 1.7, maxWidth: 620, margin: '0 auto 28px' },
  sectionTitle: { fontSize: 34, fontWeight: 800, margin: '0 0 12px', lineHeight: 1.2 },
  inputArea: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: '#6f7c8c', fontSize: 13, margin: '14px 0 0' },

  moreTabs: { display: 'flex', gap: 8, justifyContent: 'center', margin: '24px 0 14px', flexWrap: 'wrap' },
  pill: { padding: '8px 16px', border: '1px solid #2a3a4d', borderRadius: 999, background: 'transparent', color: '#8b98a9', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  pillActive: { background: 'rgba(94,234,212,0.12)', borderColor: '#5eead4', color: '#5eead4' },

  btn: { padding: '13px 22px', borderRadius: 10, border: 'none', background: 'linear-gradient(120deg, #0ea5e9, #6366f1)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  btnGreen: { padding: '16px 34px', borderRadius: 999, border: 'none', background: 'linear-gradient(120deg, #10b981, #0ea5e9)', color: '#04120c', fontSize: 17, fontWeight: 800, cursor: 'pointer', boxShadow: '0 8px 30px rgba(16,185,129,0.35)' },
  btnRed: { padding: '13px 22px', borderRadius: 10, border: 'none', background: '#ef4444', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  btnBack: { padding: '12px 24px', borderRadius: 999, border: '1px solid #2a3a4d', background: 'transparent', color: '#9aa7b8', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  liveBadge: { fontSize: 13, color: '#8b98a9', minHeight: 18 },

  panelLabel: { fontFamily: 'monospace', fontSize: 12, letterSpacing: '0.15em', color: '#60a5fa', textTransform: 'uppercase', margin: '18px 0 10px' },
  transcriptWrap: { maxHeight: 200, overflow: 'auto', border: '1px solid #1c2836', borderRadius: 12, padding: 16, background: 'rgba(10,15,22,0.8)' },
  line: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 },
  speaker: { flexShrink: 0, fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '3px 8px', marginTop: 1, color: '#04120c' },
  lineText: { fontSize: 15, lineHeight: 1.5, color: '#d6dee8' },
  cursor: { color: '#60a5fa', marginLeft: 2 },

  notesTitle: { fontSize: 24, fontWeight: 700, margin: '24px 0 14px', textAlign: 'left' },
  card: { border: '1px solid #1c2836', borderRadius: 16, padding: 18, marginBottom: 14, background: 'rgba(14,22,34,0.8)', textAlign: 'left' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardLabel: { fontFamily: 'monospace', fontSize: 12, color: '#60a5fa', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 10 },
  cardText: { margin: 0, fontSize: 16, lineHeight: 1.75, color: '#d6dee8' },
  tags: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  tag: { background: 'rgba(96,165,250,0.12)', color: '#7fb0ff', borderRadius: 999, padding: '5px 12px', fontSize: 13 },
  action: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #182434', flexWrap: 'wrap' },
  owner: { background: '#10b981', color: '#04120c', fontWeight: 700, borderRadius: 6, padding: '3px 10px', fontSize: 13, whiteSpace: 'nowrap' },
  actionTask: { flex: 1, fontSize: 15, color: '#d6dee8' },
  due: { color: '#fbbf24', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' },
  empty: { color: '#6f7c8c', fontStyle: 'italic', fontSize: 14 },
  email: { background: 'rgba(10,15,22,0.8)', color: '#c5cede', padding: 14, borderRadius: 10, fontSize: 14, lineHeight: 1.7, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap' },
  copyBtn: { padding: '6px 14px', borderRadius: 8, border: '1px solid #2a3a4d', background: 'transparent', color: '#9aa7b8', fontSize: 12, fontWeight: 600, cursor: 'pointer' },

  textarea: { width: '100%', minHeight: 150, boxSizing: 'border-box', background: 'rgba(10,15,22,0.8)', color: '#e8e8e8', border: '1px solid #2a3a4d', borderRadius: 10, padding: 14, fontFamily: 'monospace', fontSize: 14, marginBottom: 12, outline: 'none' },

  error: { color: '#fca5a5', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 14 },

  features: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginTop: 24 },
  feature: { border: '1px solid #1c2836', borderRadius: 16, padding: '18px 18px', background: 'rgba(14,22,34,0.8)', textAlign: 'left' },
  featureTitle: { fontSize: 15, fontWeight: 700, color: '#5eead4', marginBottom: 6 },
  featureDesc: { fontSize: 13, color: '#8b98a9', lineHeight: 1.55 },

  steps: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 24 },
  step: { border: '1px solid #1c2836', borderRadius: 16, padding: 22, background: 'rgba(14,22,34,0.8)', textAlign: 'left' },
  stepNum: { fontSize: 12, fontWeight: 800, color: '#60a5fa', letterSpacing: '0.15em', marginBottom: 10 },
  stepTitle: { fontSize: 15, fontWeight: 700, marginBottom: 6 },
  stepDesc: { fontSize: 13, color: '#8b98a9', lineHeight: 1.6 },

  footer: { marginTop: 32, color: '#5c6b7d', fontSize: 13 },

  scrollHint: { position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', color: '#5c6b7d', fontSize: 11, letterSpacing: '0.2em', textAlign: 'center' },
  scrollArrow: { fontSize: 18, marginTop: 2, animation: 'bounce 1.5s infinite', WebkitAnimation: 'bounce 1.5s infinite' },

  rail: { position: 'fixed', right: 14, top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: 10, zIndex: 50 },
  railDot: { width: 4, height: 20, borderRadius: 4, border: 'none', background: '#26405a', cursor: 'pointer', transition: 'height .3s ease, background .3s ease' },
  railDotActive: { height: 34, background: '#5eead4' },
};