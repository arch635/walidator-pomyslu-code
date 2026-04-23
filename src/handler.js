"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const ALLOW_ORIGIN_REGEX = /^(https:\/\/walidator\.racicki\.com|https:\/\/[a-z0-9]+\.cloudfront\.net|http:\/\/localhost(:\d+)?)$/i;

const PROMPT_PATH = process.env.PROMPT_PATH || "prompts/walidator-v2.md";
const PROMPT_PATH_MINI = process.env.PROMPT_PATH_MINI || "prompts/walidator-mini.md";
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "eu-central-1";
const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || "2500", 10);
const MAX_OUTPUT_TOKENS_REPORT = parseInt(process.env.MAX_OUTPUT_TOKENS_REPORT || "3000", 10);
const MAX_OUTPUT_TOKENS_REPORT_MINI = parseInt(process.env.MAX_OUTPUT_TOKENS_REPORT_MINI || "900", 10);
const SESSIONS_TABLE = process.env.SESSIONS_TABLE || "walidator-sessions-prod";
// MAX_TURNS to safety net. Właściwy warunek zakończenia = pokrycie wszystkich
// TOPICS_* (mini: 5 tematów, full: 25). Bufor ~5 follow-upów + werdykt.
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "30", 10);
const MAX_TURNS_MINI = parseInt(process.env.MAX_TURNS_MINI || "12", 10);
// Ile assistant turn w jednym temacie dopuszczamy zanim Lambda wymusi zmianę.
// 1 pytanie + 1 follow-up = 2, potem MUST move on (hard limit).
const MAX_TURNS_PER_TOPIC = parseInt(process.env.MAX_TURNS_PER_TOPIC || "2", 10);
const PROMPT_CACHE_ENABLED = (process.env.PROMPT_CACHE_ENABLED || "true").toLowerCase() === "true";
const SESSION_TTL_DAYS = 30;
const VALID_MODES = new Set(["mini", "full"]);
const DEFAULT_MODE = "mini";

// Mapowanie tematów per tryb. Claude taguje każdą odpowiedź <topic>nazwa</topic>
// oraz zamyka poprzedni temat tagiem <topic_quality>nazwa:concrete|vague</topic_quality>.
// Lambda egzekwuje kolejność i limity, Claude decyduje o jakości.
const TOPICS_MINI = ["idea", "customer", "competition", "timing", "risk"];
const TOPICS_FULL = [
  "idea_description", "idea_uniqueness",
  "problem_description", "problem_cost", "problem_conversations", "problem_quote", "problem_alternatives",
  "customer_icp", "customer_location", "customer_attempts", "customer_paying", "customer_pipeline",
  "competition_list", "competition_advantage", "market_size", "market_timing",
  "revenue_model", "cac_ltv", "current_spending", "runway",
  "team_composition", "team_experience", "sales_owner",
  "biggest_risk", "first_10_customers"
];

function topicsForMode(mode) {
  return mode === "mini" ? TOPICS_MINI : TOPICS_FULL;
}

const ONE_SHOT_OVERRIDE = `

---

# TRYB JEDNORAZOWY (krok 6 MVP)

**Uwaga: w tym trybie NIE prowadzisz dialogu 25 pytań.** Użytkownik poda krótki opis pomysłu (2-5 zdań), a Ty zwracasz od razu **raport strukturalny w Markdownie** - bez wstępów, bez powitania, bez próśb o doprecyzowanie. Wieloetapową rozmowę obsługujemy osobnym endpointem /walidator/turn (krok 7).

Ton bez zmian: sokratejski, szczery, konkretny, bez cheerleadingu. Stosuj 3 żelazne zasady (Mom Test / dowód / czerwone flagi). Cytuj metodologię gdzie to adekwatne.

## Wymagany format odpowiedzi (Markdown, dokładnie te sekcje, dokładnie w tej kolejności)

**Łączny budżet: ~1800-2200 tokenów.** Bądź zwięzły - krótkie zdania, bez rozwodnienia. Lepiej konkret niż akapit.

\`\`\`markdown
## Pierwsza reakcja
**Jedno zdanie** - krótko i szczerze.

## Czego brakuje w tym opisie
3-5 punktów bulletami, każdy 1 zdanie, max 20 słów.

## Pytania krytyczne do zadania sobie
3-5 pytań w duchu Mom Test, każde 1 zdanie, max 25 słów.

## Red flagi wykryte w opisie
Lista z **nazwą flagi pogrubioną** + 1 zdanie uzasadnienia. Jeśli zero: "Brak widocznych red flag w samym opisie (ale to nie oznacza że ich nie ma - wiele ujawni się dopiero w 25 pytaniach)."

## Potencjalne mocne strony
1-3 bullety, każdy 1 zdanie, max 25 słów. Jeśli nic: "Za mało informacji żeby wskazać mocne strony".

## 3 kroki na najbliższe 30 dni
1. **Do 7 dni:** [1-2 zdania, konkretne, z liczbami]
2. **Do 14 dni:** [1-2 zdania]
3. **Do 30 dni:** [1-2 zdania]

## Werdykt
**Jedna linia**: emoji (🟢/🟡/🟠/🔴) + nazwa poziomu **pogrubiona** + 1-2 zdania kluczowe.

## Polecana lektura
1-3 pozycje. Format: **Autor, "Tytuł"** - 1 zdanie dlaczego.
\`\`\`

Bez powitania, bez "Zrozumiałem...". Zaczynaj od "## Pierwsza reakcja". Odpowiadaj po polsku.
`;

const MULTI_TURN_OVERRIDE = `

---

# TRYB WIELOETAPOWY (krok 7 - 25 pytań z sesją w DynamoDB)

Prowadzisz rzeczywistą rozmowę wieloetapową (sokratejską) zgodnie z sekcją "STRUKTURA ROZMOWY" v2.0. Backend przechowuje historię, Ty dostajesz pełen kontekst każdej tury.

## Jak odpowiadać w trakcie rozmowy (tura 1 do ~24)

- **Jedno pytanie na raz.** Krótkie (1-3 zdania). Po polsku.
- **Bez numerowania** ("Pytanie 5/25:"). Bez nazw etapów ("## ETAP 2: KLIENT"). Bez preambuły ("Świetnie, zapytam teraz o..."). Tylko samo pytanie.
- **Pierwsza wiadomość użytkownika** to już opis pomysłu (odpowiedź na Pytanie 1 v2.0) - nie pytaj o opis ponownie. Od razu przechodzisz do Pytania 2 (konkretny dowód problemu).
- Jeśli odpowiedź jest ogólna ("wiele", "często", "mógłbym") - **dogłębiasz** pytanie zanim przejdziesz dalej: "Rozumiem. Ale potrzebuję konkretu: ..."
- Idź w kolejności etapów v2.0 (Problem → Klient → Konkurencja → Ekonomia → Zespół → Timing), ale elastycznie: jeśli odpowiedź otwiera wątek z innego etapu, możesz pogłębiać.
- Śledź red flagi w tle - **nie komentuj ich w trakcie**, zbierasz do raportu końcowego.
- **Nie dawaj feedbacku w trakcie** ("To dobra odpowiedź", "To jest red flaga"). Tylko pytaj.

## Kiedy generować RAPORT KOŃCOWY (zamiast kolejnego pytania)

Generuj raport finalny w dokładnie jednej z tych sytuacji:
1. Otrzymasz od użytkownika wiadomość zawierającą dokładny ciąg **[WYGENERUJ RAPORT TERAZ]** (to sygnał z backendu że sesja osiągnęła limit 25 tur).
2. Masz **co najmniej 18 odpowiedzi** użytkownika i uznajesz że zebrałeś wystarczająco danych (wszystkie 6 etapów v2.0 przynajmniej dotknięte).

W przeciwnym razie - zadawaj pytanie.

## Format raportu końcowego

Dokładnie te sekcje w tej kolejności (**pierwsza linia musi być** \`## Pierwsza reakcja\` - backend używa tego jako sygnał że to raport, nie pytanie):

\`\`\`markdown
## Pierwsza reakcja
[1-2 zdania - szczerze co myślisz o pomyśle po całej rozmowie]

## Co wiemy o tym pomyśle
[3-5 bulletów z konkretami podanymi przez użytkownika: rozmowy z klientami, CAC/LTV, ICP, płacący early adopterzy, itd. Te konkrety które rzeczywiście padły w rozmowie.]

## Najważniejsze cytaty użytkownika
[2-4 dosłowne cytaty z rozmowy - ich własne słowa opisujące problem, klientów, plany. Tylko konkretne wypowiedzi.]

## Red flagi wykryte w rozmowie
[Lista: **nazwa flagi pogrubiona** + 1-2 zdania uzasadnienia z odniesieniem do konkretnej odpowiedzi. Jeśli zero - napisz szczerze: "Brak krytycznych red flag - rozmowa pokazuje solidne fundamenty."]

## Flagi ostrzegawcze (żółte)
[Lista punktów do poprawy przed startem, 2-5 bulletów. Jeśli zero - "Brak."]

## Potencjalne mocne strony
[1-3 bullety oparte na konkretach z rozmowy]

## 3 kroki na najbliższe 30 dni
1. **Do 7 dni:** [konkretne działanie]
2. **Do 14 dni:** [konkretne działanie]
3. **Do 30 dni:** [konkretne działanie]

## Werdykt
🟢/🟡/🟠/🔴 **[NAZWA POZIOMU]** + 1-2 zdania kluczowe.

## Polecana lektura
1-3 pozycje dopasowane do słabych stron wykrytych **w rozmowie** (nie generycznie). Format: **Autor, "Tytuł"** - 1 zdanie dlaczego.
\`\`\`

**Budżet raportu: maksymalnie 1800 tokenów. Bądź bezwzględnie zwięzły - lepiej raport skończyć niż rozciągnąć.** Każdy bullet max 15-20 słów. Cytaty max 1-2 zdania. Musisz zdążyć w 25s Lambdy - pilnuj długości, zakończ WERDYKTEM i LEKTURĄ nawet jeśli musisz skrócić wcześniejsze sekcje.

## Kryteria werdyktu (oparte na danych z rozmowy, nie na samoocenach)

- **🟢 ZIELONE** - 0 flag krytycznych, max 2 ostrzegawcze, konkrety w 80%+ odpowiedzi, co najmniej 1 płacący early adopter z imienia i nazwiska.
- **🟡 ŻÓŁTE** - 1 flaga krytyczna lub 3-5 ostrzegawczych. Fundament jest, luki są jasne.
- **🟠 POMARAŃCZOWE** - 2-3 flagi krytyczne. Większość odpowiedzi ogólna.
- **🔴 CZERWONE** - 4+ flagi krytyczne LUB brak customer development (<5 rozmów z klientami).

Bądź krytyczny - zielone ma być rzadkie.
`;

const MINI_TURN_OVERRIDE = `

---

# WAŻNE: OBSŁUGA SESJI W BACKENDZIE (nadrzędne wobec sekcji START ROZMOWY)

Backend przechowuje historię rozmowy w DynamoDB. **Pierwsza wiadomość użytkownika TO JUŻ jego odpowiedź na Pytanie 1** (opis pomysłu). NIE pytaj o opis ponownie - od razu zadaj Pytanie 2 (Klient).

Frontend pokazuje licznik "Tura X z 5" na górze - **NIE numeruj pytań w treści wiadomości** ("Pytanie 2/5:" pomiń). Tylko samo pytanie, krótko (1-3 zdania).

Jeśli odpowiedź jest ogólna (np. "z paroma osobami", "duży rynek") - dopytaj o konkret zanim przejdziesz dalej. Maksymalnie 1 follow-up per pytanie.

**Generuj RAPORT KOŃCOWY** gdy spełniony jest jeden warunek:
1. Otrzymałeś co najmniej **5 odpowiedzi merytorycznych** użytkownika (po jednej na każde z 5 pytań), LUB
2. Otrzymałeś sygnał \`[WYGENERUJ RAPORT TERAZ]\` w ostatniej wiadomości użytkownika.

**Pierwsza linia raportu MUSI brzmieć dokładnie**: \`# Twoja walidacja - szybki raport\` (backend wykrywa to jako sygnał końca sesji).

Format raportu zgodnie z sekcją "RAPORT KOŃCOWY" w prompcie głównym - zachowaj wszystkie sekcje (Werdykt z emoji 🟢/🟡/🟠/🔴, Co zauważyłem, 3 kroki na 14 dni, Następny krok). Budżet: maksymalnie 800 tokenów - bądź zwięzły, lepiej zakończyć WERDYKTEM niż rozciągnąć.
`;

let BASE_PROMPT;
let MINI_BASE_PROMPT;
let SYSTEM_PROMPT_ERROR;
try {
  BASE_PROMPT = fs.readFileSync(path.join(__dirname, PROMPT_PATH), "utf8");
} catch (err) {
  SYSTEM_PROMPT_ERROR = err;
}
try {
  MINI_BASE_PROMPT = fs.readFileSync(path.join(__dirname, PROMPT_PATH_MINI), "utf8");
} catch (err) {
  // Mini prompt nieobligatoryjne dla starego kodu (one-shot/full nie używają),
  // ale logujemy żeby wykryć problem deploy'u.
  console.error("Mini prompt load failed:", err.message);
}

const ONE_SHOT_SYSTEM = BASE_PROMPT ? BASE_PROMPT + ONE_SHOT_OVERRIDE : null;
const MULTI_TURN_SYSTEM_FULL = BASE_PROMPT ? BASE_PROMPT + MULTI_TURN_OVERRIDE : null;
const MULTI_TURN_SYSTEM_MINI = MINI_BASE_PROMPT ? MINI_BASE_PROMPT + MINI_TURN_OVERRIDE : null;

function systemForMode(mode) {
  return mode === "mini" ? MULTI_TURN_SYSTEM_MINI : MULTI_TURN_SYSTEM_FULL;
}

function maxTurnsForMode(mode) {
  return mode === "mini" ? MAX_TURNS_MINI : MAX_TURNS;
}

function maxReportTokensForMode(mode) {
  return mode === "mini" ? MAX_OUTPUT_TOKENS_REPORT_MINI : MAX_OUTPUT_TOKENS_REPORT;
}

function normalizeMode(raw) {
  const m = String(raw || "").toLowerCase();
  return VALID_MODES.has(m) ? m : DEFAULT_MODE;
}

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });
const ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: BEDROCK_REGION }));

// --- CORS helpers ---

function corsHeaders(origin) {
  const allow = origin && ALLOW_ORIGIN_REGEX.test(origin)
    ? origin
    : "https://walidator.racicki.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin"
  };
}

function json(statusCode, body, origin) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
    body: JSON.stringify(body)
  };
}

// --- Bedrock helper ---

function buildSystemPayload(systemText) {
  const block = { type: "text", text: systemText };
  if (PROMPT_CACHE_ENABLED) block.cache_control = { type: "ephemeral" };
  return [block];
}

async function invokeClaude({ systemText, messages, maxTokens }) {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    system: buildSystemPayload(systemText),
    messages
  };

  const cmd = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body)
  });

  const res = await bedrock.send(cmd);
  const parsed = JSON.parse(Buffer.from(res.body).toString("utf8"));
  const text = (parsed.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return { text, usage: parsed.usage || {}, stopReason: parsed.stop_reason };
}

// --- DynamoDB session store ---

function newSessionId() {
  return crypto.randomUUID();
}

async function loadSession(sessionId) {
  const res = await ddbDoc.send(new GetCommand({
    TableName: SESSIONS_TABLE,
    Key: { session_id: sessionId }
  }));
  return res.Item || null;
}

async function saveSession(session) {
  await ddbDoc.send(new PutCommand({
    TableName: SESSIONS_TABLE,
    Item: session
  }));
}

function nowIso() { return new Date().toISOString(); }

function createSession(pomyslInitial, mode) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    session_id: newSessionId(),
    started_at: nowIso(),
    last_activity: nowIso(),
    pomysl_initial: pomyslInitial,
    mode: mode,
    turns: [],
    is_final: false,
    werdykt_koncowy: null,
    // Metadane tematów. Claude taguje w output, Lambda parsuje i zapisuje.
    topics_covered: [],           // lista nazw tematów zamkniętych
    topics_quality: {},           // { [topic]: "concrete" | "vague" }
    current_topic: null,          // aktualnie omawiany temat
    assistant_turns_in_current: 0,// ile tur asystenta w current_topic (hard limit = MAX_TURNS_PER_TOPIC)
    feedback: null,               // { rating, valuable, missing, action, submitted_at }
    ttl: nowSec + SESSION_TTL_DAYS * 24 * 3600
  };
}

function touchSession(session) {
  session.last_activity = nowIso();
  session.ttl = Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 24 * 3600;
}

function countAssistantTurns(session) {
  return session.turns.filter((t) => t.role === "assistant").length;
}

function countUserTurns(session) {
  return session.turns.filter((t) => t.role === "user").length;
}

// Parsuje tagi metadanych z odpowiedzi Claude'a i zwraca clean text + metadata.
// Oczekiwane tagi (Claude dodaje wg prompta):
//   <topic>nazwa</topic>              - temat obecnego pytania
//   <topic_quality>nazwa:vague|concrete</topic_quality> - ocena zamykanego tematu
// Tagi są strip'owane z visible text (nie idą do usera, nie idą do turns[].content).
function parseTopicTags(text) {
  const topicMatch = text.match(/<topic>\s*([a-z_]+)\s*<\/topic>/i);
  const qualityMatch = text.match(/<topic_quality>\s*([a-z_]+)\s*:\s*(vague|concrete)\s*<\/topic_quality>/i);
  const topic = topicMatch ? topicMatch[1].toLowerCase() : null;
  const topicQuality = qualityMatch
    ? { topic: qualityMatch[1].toLowerCase(), quality: qualityMatch[2].toLowerCase() }
    : null;
  const cleanText = text
    .replace(/<topic>\s*[a-z_]+\s*<\/topic>/gi, "")
    .replace(/<topic_quality>\s*[a-z_]+\s*:\s*(vague|concrete)\s*<\/topic_quality>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanText, topic, topicQuality };
}

// Aplikuje tagi do stanu sesji. Wywoływane po każdej odpowiedzi asystenta.
// - jeśli topic_quality dotyczy current_topic (lub innego poprzedniego) → zamyka ten temat
// - jeśli topic różny od current_topic → zmienia temat, reset licznika
// - jeśli topic == current_topic → to follow-up, inkrementuje licznik
// Zwraca: { closedTopic, newTopic, forcedClose } dla logów.
function applyTopicMetadata(session, parsed, mode) {
  const valid = new Set(topicsForMode(mode));
  const prevTopic = session.current_topic;
  const result = { closedTopic: null, newTopic: null, forcedClose: false };

  // Claude zamknął temat (tag topic_quality)
  if (parsed.topicQuality && valid.has(parsed.topicQuality.topic)) {
    const t = parsed.topicQuality.topic;
    if (!session.topics_covered.includes(t)) {
      session.topics_covered.push(t);
    }
    session.topics_quality[t] = parsed.topicQuality.quality;
    result.closedTopic = t;
  }

  // Claude ustawił nowy temat
  if (parsed.topic && valid.has(parsed.topic)) {
    if (parsed.topic !== prevTopic) {
      session.current_topic = parsed.topic;
      session.assistant_turns_in_current = 1;
      result.newTopic = parsed.topic;
    } else {
      session.assistant_turns_in_current = (session.assistant_turns_in_current || 0) + 1;
    }
  } else if (prevTopic) {
    // brak <topic> w odpowiedzi - zakładamy kontynuację obecnego tematu
    session.assistant_turns_in_current = (session.assistant_turns_in_current || 0) + 1;
  }

  return result;
}

// Zwraca temat do omówienia jako następny (pierwszy niepokryty z listy).
function nextTopicFor(session, mode) {
  const all = topicsForMode(mode);
  return all.find((t) => !session.topics_covered.includes(t)) || null;
}

// Avoidance detection: ile tematów user'a były ogólne. Używane przy raporcie.
function countVagueTopics(session) {
  return Object.values(session.topics_quality || {}).filter((q) => q === "vague").length;
}

function vagueTopicList(session) {
  return Object.entries(session.topics_quality || {})
    .filter(([, q]) => q === "vague")
    .map(([t]) => t);
}

// Detect final report by looking for the mandatory first header.
// - Full mode: report starts with "## Pierwsza reakcja"
// - Mini mode: report starts with "# Twoja walidacja - szybki raport"
function looksLikeFinalReport(text, mode) {
  const firstLine = text.split("\n", 1)[0].trim();
  if (mode === "mini") {
    return /^#\s+Twoja walidacja\b/i.test(firstLine);
  }
  return /^##\s*Pierwsza reakcja\b/i.test(firstLine);
}

// Extract verdict from final report. Works on full Unicode code points so
// emoji surrogate pairs don't get truncated. Returns e.g. "🟡 ŻÓŁTE".
function extractVerdict(text) {
  const section = text.match(/##\s*Werdykt[^\n]*\n+([^\n]+)/);
  if (!section) return null;
  // Drop markdown emphasis, collapse whitespace, trim.
  const line = section[1].replace(/\*+/g, "").replace(/\s+/g, " ").trim();
  // Keep first ~80 chars (emoji + level + short tail if any).
  return line.length > 80 ? line.slice(0, 80).trim() + "..." : line;
}

// --- Handlers ---

async function handleOneShot(event, origin) {
  let payload;
  try { payload = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return json(400, { status: "error", message: "Invalid JSON" }, origin); }

  const pomysl = (payload.pomysl || "").trim();
  if (!pomysl) return json(400, { status: "error", message: "Pole 'pomysl' jest wymagane." }, origin);
  if (pomysl.length > 2000) return json(400, { status: "error", message: "Za długi opis (max 2000 znaków)." }, origin);

  const started = Date.now();
  const { text, usage, stopReason } = await invokeClaude({
    systemText: ONE_SHOT_SYSTEM,
    messages: [{ role: "user", content: `OPIS POMYSŁU OD UŻYTKOWNIKA:\n\n${pomysl}\n\nWygeneruj raport.` }],
    maxTokens: MAX_OUTPUT_TOKENS
  });
  const elapsed = Date.now() - started;

  console.log(JSON.stringify({
    event: "oneshot_ok",
    elapsed_ms: elapsed,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
    stop_reason: stopReason
  }));

  return json(200, {
    status: "ok",
    markdown: text,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0
    },
    elapsed_ms: elapsed
  }, origin);
}

async function handleTurn(event, origin) {
  let payload;
  try { payload = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return json(400, { status: "error", message: "Invalid JSON" }, origin); }

  const message = (payload.message || "").trim();
  if (!message) return json(400, { status: "error", message: "Pole 'message' jest wymagane." }, origin);
  if (message.length > 2000) return json(400, { status: "error", message: "Za długa wiadomość (max 2000 znaków)." }, origin);

  const requestedSessionId = payload.session_id;
  let session;
  let mode;

  if (requestedSessionId) {
    session = await loadSession(requestedSessionId);
    if (!session) return json(404, { status: "error", message: "Sesja nie istnieje." }, origin);
    if (session.is_final) {
      return json(409, { status: "error", message: "Ta sesja została już zakończona raportem finalnym." }, origin);
    }
    // Tryb sesji jest niezmienny - body.mode ignorowany przy kontynuacji.
    // Stare sesje (sprzed wprowadzenia mini) nie mają mode -> traktuj jak full.
    mode = session.mode || "full";
  } else {
    mode = normalizeMode(payload.mode);
    session = createSession(message, mode);
  }

  // Sprawdź czy prompt dla danego mode się załadował (mini deploy mógł nie zadziałać).
  const systemText = systemForMode(mode);
  if (!systemText) {
    return json(500, { status: "error", message: "Brak skonfigurowanego promptu dla tego trybu." }, origin);
  }

  session.turns.push({ role: "user", content: message, ts: nowIso() });

  const userTurns = countUserTurns(session);
  const maxTurnsThis = maxTurnsForMode(mode);
  const forceFinal = userTurns >= maxTurnsThis;

  const messages = session.turns.map((t) => ({ role: t.role, content: t.content }));
  if (forceFinal) {
    // Nudge the model towards final report by appending to the last user message.
    const last = messages[messages.length - 1];
    last.content = last.content + "\n\n[WYGENERUJ RAPORT TERAZ]";
  }

  const started = Date.now();
  const { text, usage, stopReason } = await invokeClaude({
    systemText,
    messages,
    maxTokens: forceFinal ? maxReportTokensForMode(mode) : MAX_OUTPUT_TOKENS
  });
  const elapsed = Date.now() - started;

  const isFinal = looksLikeFinalReport(text, mode);

  session.turns.push({ role: "assistant", content: text, ts: nowIso() });
  touchSession(session);
  if (isFinal) {
    session.is_final = true;
    session.werdykt_koncowy = extractVerdict(text);
  }

  await saveSession(session);

  const turnNumber = countAssistantTurns(session);

  console.log(JSON.stringify({
    event: "turn_ok",
    session_id: session.session_id,
    mode,
    user_turn: userTurns,
    assistant_turn: turnNumber,
    is_final: isFinal,
    forced_final: forceFinal,
    elapsed_ms: elapsed,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
    stop_reason: stopReason
  }));

  return json(200, {
    status: "ok",
    session_id: session.session_id,
    mode,
    turn_number: turnNumber,
    max_turns: maxTurnsThis,
    user_turn_number: userTurns,
    is_final: isFinal,
    response: text,
    werdykt: session.werdykt_koncowy || null,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0
    },
    elapsed_ms: elapsed
  }, origin);
}

async function handleGetSession(event, origin) {
  const sessionId = event.pathParameters && event.pathParameters.id;
  if (!sessionId) return json(400, { status: "error", message: "Brak session_id w ścieżce." }, origin);

  const session = await loadSession(sessionId);
  if (!session) return json(404, { status: "error", message: "Sesja nie istnieje." }, origin);

  const mode = session.mode || "full";
  return json(200, {
    status: "ok",
    session_id: session.session_id,
    started_at: session.started_at,
    last_activity: session.last_activity,
    pomysl_initial: session.pomysl_initial,
    mode,
    turns: session.turns,
    is_final: session.is_final,
    werdykt: session.werdykt_koncowy || null,
    max_turns: maxTurnsForMode(mode)
  }, origin);
}

// --- Entry point ---

exports.handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "POST";
  const rawPath = event?.rawPath || event?.requestContext?.http?.path || "";
  const origin = event?.headers?.origin || event?.headers?.Origin || "";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  if (SYSTEM_PROMPT_ERROR) {
    console.error("Prompt file load failed:", SYSTEM_PROMPT_ERROR);
    return json(500, { status: "error", message: "Błąd konfiguracji serwera (prompt)." }, origin);
  }

  try {
    if (rawPath.endsWith("/walidator/turn")) {
      return await handleTurn(event, origin);
    }
    if (rawPath.includes("/walidator/session/")) {
      return await handleGetSession(event, origin);
    }
    if (rawPath.endsWith("/walidator")) {
      return await handleOneShot(event, origin);
    }
    return json(404, { status: "error", message: "Unknown route." }, origin);
  } catch (err) {
    console.error(JSON.stringify({
      event: "handler_error",
      route: rawPath,
      name: err.name,
      message: err.message
    }));
    if (err.name === "ThrottlingException" || err.name === "ServiceQuotaExceededException") {
      return json(503, { status: "error", message: "Chwilowo duże obciążenie. Spróbuj ponownie za chwilę." }, origin);
    }
    if (err.name === "ResourceNotFoundException") {
      return json(500, { status: "error", message: "Brak wymaganego zasobu (DynamoDB/Bedrock)." }, origin);
    }
    return json(502, { status: "error", message: "Nie udało się uzyskać odpowiedzi. Spróbuj ponownie." }, origin);
  }
};
