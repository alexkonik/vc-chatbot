require('dotenv').config();
const { runPipeline } = require('./pipeline');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const validator = require('validator');

// --- Discord imports ---
const { Client, GatewayIntentBits } = require('discord.js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing required environment variables. Check .env file.');
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Verify the chatbot table exists
async function checkTable() {
  const { data, error } = await supabase
    .from('chatbot')
    .select('*')
    .limit(1);
  if (error) {
    console.error('❌ Cannot access chatbot table:', error.message);
    console.error('Please create the table with columns: id, region, country, client_type, service, name, email, created_at, opis_problemu');
  } else {
    console.log('✅ chatbot table accessible');
  }
}
checkTable();

// Rate limiting storage
const sessions = new Map();
const sessionMessageCount = new Map();
const ipMessageCount = new Map();

const MAX_MESSAGES_PER_SESSION = 50;
const MAX_MESSAGES_PER_IP = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(sessionId, ip) {
  const now = Date.now();
  const sessionCount = sessionMessageCount.get(sessionId);
  if (sessionCount && sessionCount.count >= MAX_MESSAGES_PER_SESSION) {
    return { allowed: false, reason: 'session_limit' };
  }
  let ipData = ipMessageCount.get(ip);
  if (!ipData) {
    ipData = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    ipMessageCount.set(ip, ipData);
  }
  if (now > ipData.resetTime) {
    ipData.count = 0;
    ipData.resetTime = now + RATE_LIMIT_WINDOW_MS;
  }
  if (ipData.count >= MAX_MESSAGES_PER_IP) {
    return { allowed: false, reason: 'ip_limit' };
  }
  if (!sessionMessageCount.has(sessionId)) {
    sessionMessageCount.set(sessionId, { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS });
  }
  const sessionData = sessionMessageCount.get(sessionId);
  sessionData.count++;
  ipData.count++;
  return { allowed: true };
}

const State = {
  START: 'start',
  AWAITING_REGION: 'awaiting_region',
  AWAITING_COUNTRY: 'awaiting_country',
  AWAITING_CLIENT_TYPE: 'awaiting_client_type',
  AWAITING_SERVICE: 'awaiting_service',
  AWAITING_SERVICE_DESCRIPTION: 'awaiting_service_description', // for "Other"
  AWAITING_DESCRIPTION: 'awaiting_description', // new: general description
  AWAITING_NAME: 'awaiting_name',
  AWAITING_EMAIL: 'awaiting_email',
  COMPLETED: 'completed',
  ENDED: 'ended',
};

const SERVICES = {
  HIRING: 'hladanie zamestnancov',
  INVESTOR: 'hladanie investora',
  SPEAKING: 'moznost speakovat na evente',
  MARKETING: 'marketingova podpora',
  SALES: 'podpora sales',
  CLIENTS: 'hladanie klientov',
  OTHER: 'Other',
};

// English-only prompts
const prompts = {
  start: "Hello! I'm your support bot. To help you better, please tell me your region – Europe or Middle East?",
  regionInvalid: "Please specify either Europe or Middle East (e.g., 'Europe' or 'Middle East'). Use at least 3 letters.",
  countryPrompt: "Which country are you in? (All European and Middle Eastern countries are supported)",
  countryInvalid: "Sorry, we only support countries in Europe and the Middle East. Please enter a valid country name (minimum 3 characters).",
  clientTypePrompt: "Which of the following best describes you?\n- Startup\n- Investor\n- Service Provider\n- Community Member",
  clientTypeInvalid: "Please choose one: startup, investor, service provider, community member.",
  servicePrompt: "What service are you interested in? Please choose from:\n- hladanie zamestnancov (recruitment)\n- hladanie investora (find investor)\n- moznost speakovat na evente (speak at event)\n- marketingova podpora (marketing support)\n- podpora sales (sales support)\n- hladanie klientov (find clients)\n- Other (other)",
  serviceInvalid: "Please choose a valid service from the list. If you're not sure, type 'Other' for other.",
  otherDescriptionPrompt: "Please briefly describe what you need help with.",
  descriptionPrompt: "Please provide a brief description of your issue or request (minimum 5 characters).",
  descriptionInvalid: "Please provide a description of at least 5 characters.",
  namePrompt: "Please provide your full name (first and last name).",
  nameInvalid: "Please enter your full name (at least first and last name, each at least 2 characters).",
  emailPrompt: "Great! Finally, please provide your email address so we can contact you about your request.",
  emailInvalid: "Please enter a valid email address (e.g., name@example.com).",
  thanks: "Thank you! I've recorded your request. Creating a ticket now.",
  error: "I'm having trouble. A human will contact you shortly.",
  ended: "Your request has been submitted. If you need help with another issue, please click the 'New Conversation' button.",
  rateLimitSession: "You have reached the maximum number of messages for this conversation. Please start a new conversation using the button below.",
  rateLimitIp: "You have sent too many messages. Please wait an hour before continuing.",
};

// Helper to capitalize first letter of each word
function toTitleCase(str) {
  if (!str) return str;
  return str.replace(/\b\w/g, char => char.toUpperCase());
}

function isRegionValid(input) {
  const trimmed = input.trim();
  if (trimmed.length < 3) return false;
  const lower = trimmed.toLowerCase();
  if (/^(europe|eu|europa)$/.test(lower)) return 'Europe';
  if (/^(middle\s*east|me|mideast)$/.test(lower)) return 'Middle East';
  return false;
}

// Separate country lists
const europeanCountries = [
  "albania", "andorra", "armenia", "austria", "azerbaijan", "belarus", "belgium", "bosnia and herzegovina", "bulgaria", "croatia", "cyprus", "czech republic", "denmark", "estonia", "finland", "france", "georgia", "germany", "greece", "hungary", "iceland", "ireland", "italy", "kazakhstan", "latvia", "liechtenstein", "lithuania", "luxembourg", "malta", "moldova", "monaco", "montenegro", "netherlands", "north macedonia", "norway", "poland", "portugal", "romania", "russia", "san marino", "serbia", "slovakia", "slovenia", "spain", "sweden", "switzerland", "turkey", "ukraine", "united kingdom", "vatican city"
];

const middleEastCountries = [
  "bahrain", "cyprus", "egypt", "iran", "iraq", "israel", "jordan", "kuwait", "lebanon", "oman", "palestine", "qatar", "saudi arabia", "syria", "turkey", "uae", "yemen"
];

// Combined list for alias mapping
const allCountries = [...europeanCountries, ...middleEastCountries];

// Country aliases
const countryAliases = {
  'czech republic': ['czech republic', 'czechia', 'czech', 'česko'],
  'united kingdom': ['united kingdom', 'uk', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
  'united arab emirates': ['uae', 'united arab emirates'],
  'bosnia and herzegovina': ['bosnia', 'herzegovina'],
  'north macedonia': ['macedonia', 'north macedonia'],
};

function normalizeCountry(input) {
  const normalized = input.trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(countryAliases)) {
    if (aliases.includes(normalized)) return canonical;
  }
  const match = allCountries.find(country => country.includes(normalized) || normalized.includes(country));
  return match || null;
}

function isCountryInRegion(country, region) {
  if (region === 'Europe') {
    return europeanCountries.includes(country);
  } else if (region === 'Middle East') {
    return middleEastCountries.includes(country);
  }
  return false;
}

function isValidCountry(input, region) {
  const normalized = input.trim();
  if (normalized.length < 3) return false;
  const canonical = normalizeCountry(normalized);
  if (!canonical) return false;
  return isCountryInRegion(canonical, region);
}

const clientTypeVariants = {
  startup: /startup|start-up|start up/i,
  investor: /investor/i,
  'service provider': /service\s*provider|provider/i,
  'community member': /community\s*member|member/i,
};
function detectClientType(input) {
  const trimmed = input.trim();
  if (trimmed.length < 3) return null;
  const lower = trimmed.toLowerCase();
  for (const [type, regex] of Object.entries(clientTypeVariants)) {
    if (regex.test(lower)) return type;
  }
  return null;
}

const serviceVariants = {
  [SERVICES.HIRING]: /hladanie\s*zamestnancov|recruitment|hire|staffing/i,
  [SERVICES.INVESTOR]: /hladanie\s*investora|investor|funding|investment/i,
  [SERVICES.SPEAKING]: /moznost\s*speakovat\s*na\s*evente|speak\s*at\s*event|speaker|event/i,
  [SERVICES.MARKETING]: /marketingova\s*podpora|marketing\s*support|marketing/i,
  [SERVICES.SALES]: /podpora\s*sales|sales\s*support|sales/i,
  [SERVICES.CLIENTS]: /hladanie\s*klientov|find\s*clients|client\s*acquisition/i,
  [SERVICES.OTHER]: /Other|other/i,
};
function detectService(input) {
  const trimmed = input.trim();
  if (trimmed.length < 2) return null;
  for (const [service, regex] of Object.entries(serviceVariants)) {
    if (regex.test(trimmed)) return service;
  }
  return null;
}

function isValidName(input) {
  return validator.isAlpha(input.trim().replace(/\s/g, ''), 'en-US', { ignore: ' ' });
}

function isValidEmail(input) {
  return validator.isEmail(input);
}

function isValidDescription(input) {
  const trimmed = input.trim();
  return trimmed.length >= 5;
}

function getSession(sessionId, ip) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      state: State.START,
      collectedData: {},
      ip,
      lastActivity: Date.now(),
    };
    sessions.set(sessionId, session);
  }
  return session;
}

function processMessage(session, userMessage) {
  if (userMessage.trim().toLowerCase() === '/reset') {
    return { response: "Conversation reset.", nextState: State.START, reset: true };
  }
  if (session.state === State.ENDED) {
    return { response: prompts.ended, nextState: State.ENDED, conversationEnded: true };
  }

  const t = prompts;
  const data = session.collectedData;

  switch (session.state) {
    case State.START:
      session.state = State.AWAITING_REGION;
      return { response: t.start, nextState: State.AWAITING_REGION };

    case State.AWAITING_REGION:
      const region = isRegionValid(userMessage);
      if (region) {
        data.region = region;
        session.state = State.AWAITING_COUNTRY;
        return { response: t.countryPrompt, nextState: State.AWAITING_COUNTRY, extractedData: { region } };
      } else {
        return { response: t.regionInvalid, nextState: State.AWAITING_REGION };
      }

    case State.AWAITING_COUNTRY:
      const countryNormalized = normalizeCountry(userMessage);
      if (countryNormalized && isCountryInRegion(countryNormalized, data.region)) {
        data.country = countryNormalized;
        session.state = State.AWAITING_CLIENT_TYPE;
        return { response: t.clientTypePrompt, nextState: State.AWAITING_CLIENT_TYPE, extractedData: { country: countryNormalized } };
      } else {
        const invalidMsg = `Sorry, "${userMessage}" is not in ${data.region}. Please enter a country in ${data.region}.`;
        return { response: invalidMsg, nextState: State.AWAITING_COUNTRY };
      }

    case State.AWAITING_CLIENT_TYPE:
      const clientType = detectClientType(userMessage);
      if (clientType) {
        data.client_type = clientType;
        session.state = State.AWAITING_SERVICE;
        return { response: t.servicePrompt, nextState: State.AWAITING_SERVICE, extractedData: { client_type: clientType } };
      } else {
        return { response: t.clientTypeInvalid, nextState: State.AWAITING_CLIENT_TYPE };
      }

    case State.AWAITING_SERVICE:
      const service = detectService(userMessage);
      if (service) {
        data.service = service;
        if (service === SERVICES.OTHER) {
          session.state = State.AWAITING_SERVICE_DESCRIPTION;
          return { response: t.otherDescriptionPrompt, nextState: State.AWAITING_SERVICE_DESCRIPTION, extractedData: { service } };
        } else {
          // After regular service, ask for description
          session.state = State.AWAITING_DESCRIPTION;
          return { response: t.descriptionPrompt, nextState: State.AWAITING_DESCRIPTION, extractedData: { service } };
        }
      } else {
        return { response: t.serviceInvalid, nextState: State.AWAITING_SERVICE };
      }

    case State.AWAITING_SERVICE_DESCRIPTION:
      data.other_description = userMessage;
      session.state = State.AWAITING_DESCRIPTION;
      return { response: t.descriptionPrompt, nextState: State.AWAITING_DESCRIPTION, extractedData: { other_description: userMessage } };

    case State.AWAITING_DESCRIPTION:
      if (isValidDescription(userMessage)) {
        data.description = userMessage;
        session.state = State.AWAITING_NAME;
        return { response: t.namePrompt, nextState: State.AWAITING_NAME, extractedData: { description: userMessage } };
      } else {
        return { response: t.descriptionInvalid, nextState: State.AWAITING_DESCRIPTION };
      }

    case State.AWAITING_NAME:
      if (isValidName(userMessage)) {
        data.name = userMessage.trim();
        session.state = State.AWAITING_EMAIL;
        return { response: t.emailPrompt, nextState: State.AWAITING_EMAIL, extractedData: { name: userMessage.trim() } };
      } else {
        return { response: t.nameInvalid, nextState: State.AWAITING_NAME };
      }

    case State.AWAITING_EMAIL:
      if (isValidEmail(userMessage)) {
        data.email = userMessage.trim();
        session.state = State.COMPLETED;
        return { response: t.thanks, nextState: State.COMPLETED, extractedData: { email: userMessage.trim() } };
      } else {
        return { response: t.emailInvalid, nextState: State.AWAITING_EMAIL };
      }

    default:
      return { response: t.error, nextState: State.ENDED };
  }
}

async function createSubmission(session, sessionId) {
  const data = session.collectedData;
  console.log('createSubmission called with data:', JSON.stringify(data, null, 2));

  const record = {
    region: data.region,
    country: toTitleCase(data.country),
    client_type: toTitleCase(data.client_type),
    service: data.service === SERVICES.OTHER ? 'Other' : toTitleCase(data.service),
    opis_problemu: data.description || null,
    name: data.name,
    email: data.email,
    created_at: new Date().toISOString(),
  };

  console.log('Inserting into chatbot:', record);

  try {
    const { data: submission, error } = await supabase
      .from('chatbot')
      .insert([record])
      .select();

    if (error) throw error;
    console.log('Submission created successfully:', submission);

    console.log('🚀 Running pipeline...');
    const pipelineResult = await runPipeline({
      region: record.region,
      country: record.country,
      client_type: record.client_type,
      service: record.service,
    });
    console.log('✅ Pipeline result:', pipelineResult);

    return true;
  } catch (error) {
    console.error('Submission creation error:', error);
    return true;
  }
}

// Routes and server start unchanged (keep them as is)
app.post('/reset', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  sessions.delete(sessionId);
  sessionMessageCount.delete(sessionId);
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'VC Support Bot API is running' });
});

app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message || !sessionId) {
    return res.status(400).json({ error: 'Missing message or sessionId' });
  }
  const ip = req.ip || req.connection.remoteAddress;
  const rateLimit = checkRateLimit(sessionId, ip);
  if (!rateLimit.allowed) {
    const session = getSession(sessionId, ip);
    const response = rateLimit.reason === 'session_limit'
      ? prompts.rateLimitSession
      : prompts.rateLimitIp;
    return res.json({ response, ticketCreated: false, rateLimited: true, conversationEnded: true });
  }
  const session = getSession(sessionId, ip);
  session.lastActivity = Date.now();

  let result;
  try {
    result = processMessage(session, message);
  } catch (error) {
    console.error(error);
    return res.json({
      response: prompts.error,
      ticketCreated: false,
      conversationEnded: true,
    });
  }
  if (result.reset) {
    sessions.delete(sessionId);
    sessionMessageCount.delete(sessionId);
    const newSession = getSession(sessionId, ip);
    result = processMessage(newSession, message);
  }
  if (result.nextState) session.state = result.nextState;
  if (result.extractedData) {
    session.collectedData = { ...session.collectedData, ...result.extractedData };
  }
  let ticketCreated = false;
  if (session.state === State.COMPLETED) {
    ticketCreated = await createSubmission(session, sessionId);
    session.state = State.ENDED;
  }
  res.json({
    response: result.response,
    ticketCreated,
    state: session.state,
    conversationEnded: session.state === State.ENDED,
  });
});

setInterval(() => {
  const now = Date.now();
  const SESSION_TIMEOUT = 30 * 60 * 1000;
  let deleted = 0;
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      sessions.delete(id);
      sessionMessageCount.delete(id);
      deleted++;
    }
  }
  if (deleted) console.log(`Cleaned up ${deleted} stale sessions.`);
}, 30 * 60 * 1000);

app.listen(port, () => {
  console.log(`✅ Express server running on http://localhost:${port}`);
});

// Discord bot code remains unchanged
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

discordClient.once('ready', () => {
  console.log(`✅ Discord bot logged in as ${discordClient.user.tag}`);
});

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(discordClient.user)) return;
  try {
    await message.channel.sendTyping();
    const response = "Hello! I'm connected to your Node.js logic.";
    await message.reply(response);
  } catch (error) {
    console.error("Discord message error:", error);
    await message.reply("Internal error. Check the console!");
  }
});

discordClient.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("Failed to login to Discord:", err);
});