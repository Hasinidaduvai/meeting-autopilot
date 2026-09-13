const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

function transcriptText(lines) {
  return lines
    .map((l) => (typeof l.speaker === 'number' ? 'Speaker ' + l.speaker : l.speaker) + ': ' + l.text)
    .join('\n');
}

async function generateNotes(lines) {
  const text = transcriptText(lines);
  try {
    const res = await groq.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a meeting assistant. From a meeting transcript with speakers, produce clear notes. ' +
            'Return valid JSON with EXACTLY this shape: ' +
            '{"summary": "2-3 sentence summary", "topics": ["topic1", "topic2"], ' +
            '"action_items": [{"owner": "Speaker 1 or real name if mentioned", "task": "...", "deadline": "Friday" or null}], ' +
            '"email_draft": "A short ready-to-send email addressing everyone with tasks and their deadlines"} ' +
            'Rules: Every committed action item must be assigned to a specific speaker. ' +
            'If no deadline was mentioned, use null. Do not invent tasks that were not discussed. ' +
            'If speakers mention each other by name, map Speaker numbers to those names.',
        },
        { role: 'user', content: 'Meeting transcript:\n\n' + text },
      ],
    });
    return JSON.parse(res.choices[0].message.content);
  } catch (e) {
    return {
      summary: 'Could not generate notes at this time.',
      topics: [],
      action_items: [],
      email_draft: '',
      _error: e.message,
    };
  }
}

module.exports = { generateNotes };