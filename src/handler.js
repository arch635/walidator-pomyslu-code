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

# TRYB WIELOETAPOWY (25 TEMATÓW z sesją w DynamoDB)

Prowadzisz rzeczywistą rozmowę wieloetapową wokół **25 tematów** (nie 25 tur). Backend przechowuje historię i stan tematów, Ty dostajesz pełen kontekst każdej tury.

## OBOWIĄZKOWE TAGI METADANYCH (każda Twoja odpowiedź)

Każda Twoja odpowiedź MUSI zaczynać się od tagów w osobnych liniach:
- \`<topic>KOD</topic>\` - temat bieżącego pytania (jeden z 25 kodów z sekcji "STRUKTURA ROZMOWY" promptu głównego)
- \`<topic_quality>KOD:concrete|vague</topic_quality>\` - dodaj tylko gdy user właśnie domknął poprzedni temat (oceń jakość jego odpowiedzi)

Lambda usuwa tagi przed pokazaniem userowi. Bez tagów backend nie wie kiedy zamknąć temat.

25 kodów (zachowaj dokładną kolejność z tabeli w prompcie głównym):
idea_description, idea_uniqueness, problem_description, problem_cost, problem_conversations, problem_quote, problem_alternatives, customer_icp, customer_location, customer_attempts, customer_paying, customer_pipeline, competition_list, competition_advantage, market_size, market_timing, revenue_model, cac_ltv, current_spending, runway, team_composition, team_experience, sales_owner, biggest_risk, first_10_customers.

## LIMIT follow-up per temat

**Max 1 follow-up per temat.** Po 1 follow-upie MUSISZ zamknąć temat (tag topic_quality) i przejść do kolejnego, nawet jeśli user nadal unika konkretu → wtedy zamykasz jako \`vague\`.

Backend wymusza to - jeśli Twoja następna odpowiedź dostanie w user message sygnał \`[WYMUSZONE_ZAMKNIĘCIE temat=X, przejdź do Y]\`, MUSISZ zamknąć X jako vague i rozpocząć Y.

## ZAKAZ SUGEROWANIA ODPOWIEDZI

Nigdy nie podawaj opcji/listy/przykładów w pytaniach. Pytaj o wymiary (branża/wielkość/miasto), nie podsuwaj kategorii. Szczegóły w prompcie głównym (sekcja "ZAKAZ SUGEROWANIA ODPOWIEDZI").

## Jak odpowiadać w trakcie rozmowy

- **Jedno pytanie na raz.** Krótkie (1-3 zdania). Po polsku.
- **Bez numerowania** ("Pytanie 5/25:"). Bez nazw etapów. Bez preambuły ("Świetnie, teraz zapytam..."). Tylko samo pytanie.
- **Pierwsza wiadomość użytkownika** to już opis pomysłu (odpowiedź na idea_description) - nie pytaj o opis ponownie. Zamknij idea_description (\`<topic_quality>idea_description:...\`) i przechodź do idea_uniqueness lub problem_description (zależnie od jakości odpowiedzi).
- Nie dawaj feedbacku w trakcie ("To dobra odpowiedź"). Tylko pytaj.

## Kiedy generować RAPORT KOŃCOWY

Generuj raport finalny TYLKO gdy spełniony jest jeden warunek:
1. Otrzymasz w user message dokładny ciąg \`[WYGENERUJ RAPORT TERAZ]\` (to sygnał z backendu że wszystkie 25 tematów pokryte lub safety net).

W przeciwnym razie - zadawaj pytanie (z tagami).

## Format raportu końcowego

Dokładnie te sekcje w tej kolejności (**pierwsza linia musi być** \`## Pierwsza reakcja\` - backend używa tego jako sygnał że to raport, nie pytanie). Ostatnie \`<topic_quality>\` zamykające ostatni temat ZAWSZE na samym początku, PRZED \`## Pierwsza reakcja\`.

\`\`\`markdown
## Pierwsza reakcja
[1-2 zdania - szczerze co myślisz o pomyśle po całej rozmowie]

## Co wiemy o tym pomyśle
[3-5 bulletów z konkretami podanymi przez użytkownika]

## Najważniejsze cytaty użytkownika
[2-4 dosłowne cytaty z rozmowy]

## Red flagi wykryte w rozmowie
[Lista: **nazwa flagi pogrubiona** + 1-2 zdania uzasadnienia. Jeśli zero - "Brak krytycznych red flag - rozmowa pokazuje solidne fundamenty."]

## Flagi ostrzegawcze (żółte)
[2-5 bulletów. Jeśli zero - "Brak."]

## Potencjalne mocne strony
[1-3 bullety]

## Dlaczego wynik mógł być lepszy
**WSTAW TĘ SEKCJĘ TYLKO gdy co najmniej 2 tematy oznaczyłeś jako vague. Jeśli vague <= 1 - POMIŃ CAŁKOWICIE (sekcja NIE pojawia się).**

Zauważyłem że w [lista 2+ tematów po polsku] odpowiedzi były ogólne. To ograniczyło precyzję walidacji.

Gdy wrócisz z konkretami (liczby, imiona, cytaty, daty), raport będzie dokładniejszy.

- [Temat X po polsku]: odpowiedź "[krótki cytat]", brakuje [co konkretnie]
- [Temat Y po polsku]: odpowiedź "[krótki cytat]", brakuje [co konkretnie]

## 3 kroki na najbliższe 30 dni
1. **Do 7 dni:** [konkretne działanie]
2. **Do 14 dni:** [konkretne działanie]
3. **Do 30 dni:** [konkretne działanie]

## Werdykt
🟢/🟡/🟠/🔴 **[NAZWA POZIOMU]** + 1-2 zdania kluczowe.

## Polecana lektura
1-3 pozycje. Format: **Autor, "Tytuł"** - 1 zdanie dlaczego.
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

Backend przechowuje historię rozmowy w DynamoDB. **Pierwsza wiadomość użytkownika TO JUŻ jego odpowiedź na Temat 1 (idea)**. NIE pytaj o opis ponownie - zamknij idea (\`<topic_quality>idea:concrete|vague</topic_quality>\`) i od razu przechodź do tematu customer.

## OBOWIĄZKOWE TAGI METADANYCH

Każda Twoja odpowiedź MUSI zaczynać się od tagów w osobnych liniach:
- \`<topic>KOD</topic>\` - temat bieżącego pytania (jeden z: idea, customer, competition, timing, risk)
- \`<topic_quality>KOD:concrete|vague</topic_quality>\` - dodaj tylko gdy user właśnie domknął poprzedni temat

Lambda usuwa tagi przed pokazaniem userowi. Bez tagów backend nie wie kiedy zamknąć temat.

## LIMIT follow-up per temat

Max 1 follow-up per temat. Po follow-upie MUSISZ zamknąć temat (tag topic_quality) i przejść do kolejnego. Backend wymusza: jeśli w user message pojawi się \`[WYMUSZONE_ZAMKNIĘCIE temat=X, przejdź do Y]\`, zamknij X jako vague i otwórz Y.

## ZAKAZ SUGEROWANIA ODPOWIEDZI

Nigdy nie podawaj opcji/listy/przykładów w pytaniach. Szczegóły w prompcie głównym.

## Frontend

Frontend pokazuje licznik "Temat X/5" na górze - **NIE numeruj pytań w treści wiadomości** ("Pytanie 2/5:" pomiń). Tylko samo pytanie, krótko (1-3 zdania).

## KIEDY generować RAPORT KOŃCOWY

Generuj raport TYLKO gdy w user message pojawi się dokładny sygnał \`[WYGENERUJ RAPORT TERAZ]\` (backend wysyła to gdy wszystkie 5 tematów pokryte lub safety net MAX_TURNS_MINI=12).

**Pierwsza linia raportu MUSI brzmieć dokładnie**: \`# Twoja walidacja - szybki raport\` (backend wykrywa to jako sygnał końca sesji). Przed nią wstaw \`<topic_quality>\` zamykający ostatni temat.

Format raportu zgodnie z sekcją "RAPORT KOŃCOWY" w prompcie głównym. Uwzględnij sekcję "Dlaczego wynik mógł być lepszy" WYŁĄCZNIE gdy >= 2 tematy były vague. Budżet: maksymalnie 800 tokenów.
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

// Safety net przeciwko halucynacji biograficznej Artura. Claude czasem wymyśla
// nazwy firm i daty z prompta, mimo że prompt już ich nie wymienia. Lista
// ZABRONIONYCH terminów (etap 4 naprawy fakt-checkingowej) - wszystkie
// zastąpione "[usunięto]" + zliczane w logu CW "banned_terms_detected".
const BANNED_TERMS = [
  /\bEnzo\b/gi,
  /\bSport ?24(?:\.pl)?\b/gi,
  /\bSocial\s*WiFi\b/gi,
  /\bFC[.\s]?APP\b/gi,
  /\bFCAPP\b/gi,
  // rok biograficzny + Artur/Racicki w pobliżu (do 60 znaków)
  /\b(?:2004|2010|2021|2024)\b[^\n]{0,60}(?:Artur|Racicki)/gi,
  /(?:Artur|Racicki)[^\n]{0,60}\b(?:2004|2010|2021|2024)\b/gi
];

function sanitizeReport(text) {
  let detected = 0;
  const matched = [];
  let cleaned = text;
  for (const rx of BANNED_TERMS) {
    cleaned = cleaned.replace(rx, (m) => {
      detected++;
      matched.push(m);
      return "[usunięto]";
    });
  }
  return { text: cleaned, detected, matched };
}

// Post-processing: usuwa sugestie odpowiedzi które Claude czasem wrzuca mimo
// reguły ZAKAZ SUGEROWANIA. Zwraca { text, cleaned } gdzie cleaned = liczba
// trafień (dla CloudWatch metric "suggestions_cleaned_per_turn").
// NIE dotyka raportu finalnego - w raporcie przykłady są DOZWOLONE (rekomendacje).
function cleanSuggestions(text, isFinal) {
  if (isFinal) return { text, cleaned: 0 };
  let cleaned = 0;
  // (A) "(np. X, Y, Z)" z nawiasem
  text = text.replace(/\(np\.\s[^)]+\)/gi, () => { cleaned++; return ""; });
  // (B) "(na przykład X)" z nawiasem
  text = text.replace(/\(na przykład\s[^)]+\)/gi, () => { cleaned++; return ""; });
  // (C) BEZ NAWIASU: "Np." / "Np:" / "Np " + reszta do końca zdania
  // Separator po "Np." to [\s:,] żeby złapać "Np. X", "Np.: X", "Np.,X" itd.
  text = text.replace(/\bNp\.[\s:,][^.!?\n]*[.!?\n]/gi, () => { cleaned++; return ""; });
  // (D) BEZ NAWIASU: "Na przykład X" / "Na przykład: X" / "Na przykład, X"
  text = text.replace(/\bNa przykład[\s:,][^.!?\n]*[.!?\n]/gi, () => { cleaned++; return ""; });
  // (E) Pytania retoryczne w nawiasach: (opcja A? opcja B?)
  text = text.replace(/\([^)]*\?[^)]*\?[^)]*\)/g, () => { cleaned++; return ""; });
  // (F) Seria 2+ krótkich pytań retorycznych w jednej linii
  text = text.replace(/(?:[^.!?\n]{1,60}\?\s+){2,}[^.!?\n]{1,60}\?/g, () => { cleaned++; return ""; });
  // (G) "Opcje [any]: [lista]" - obejmuje "Opcje:", "Opcje mogą być:",
  //     "Możliwe opcje:", "Przykładowe opcje:". Max 30 znaków między "Opcj" a ":".
  text = text.replace(/\b(?:Opcje|Opcji|Przykładowe opcje|Możliwe opcje|Możliwe odpowiedzi)[^:\n]{0,30}:[\s\S]*?(?=\n\n|$)/gi, () => { cleaned++; return ""; });
  // (H) "X, Y, czy Z?" - sugestia z 2+ przecinkami i "czy" przed ostatnią opcją.
  //     Np. "mieszkańcy osiedla, studenci, czy inny segment?"
  text = text.replace(/\b[\wąćęłńóśźż\s]+,\s*[\wąćęłńóśźż\s]+,\s*czy\s+[\wąćęłńóśźż\s]+\?/gi, () => { cleaned++; return "?"; });
  // (I) "X czy Y?" - sugestia z dwiema opcjami. Uwaga: łapie też legitymne
  //     pytania wyboru ("miesięcznie czy rocznie?") - Artur zdecydował że
  //     i tak lepiej wymusić otwarte pytanie.
  text = text.replace(/\b[\wąćęłńóśźż\s]+\s+czy\s+[\wąćęłńóśźż\s]+\?/gi, () => { cleaned++; return "?"; });
  // Domknij podwójne spacje i hanging whitespace po usunięciu
  text = text.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?;:])/g, "$1");
  // Puste zdania typu ". ." lub podwójne kropki po wycięciu
  text = text.replace(/\.\s+\./g, ".").replace(/\n{3,}/g, "\n\n");
  return { text: text.trim(), cleaned };
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
    // Legacy sesje (sprzed topics) dostają puste domyślne pola, żeby reszta kodu
    // miała jednolite API. Nowa logika działa od tego momentu wzwyż.
    if (!Array.isArray(session.topics_covered)) session.topics_covered = [];
    if (!session.topics_quality || typeof session.topics_quality !== "object") session.topics_quality = {};
    if (typeof session.assistant_turns_in_current !== "number") session.assistant_turns_in_current = 0;
  } else {
    mode = normalizeMode(payload.mode);
    session = createSession(message, mode);
  }

  const systemText = systemForMode(mode);
  if (!systemText) {
    return json(500, { status: "error", message: "Brak skonfigurowanego promptu dla tego trybu." }, origin);
  }

  session.turns.push({ role: "user", content: message, ts: nowIso() });

  const topics = topicsForMode(mode);
  const covered = session.topics_covered.length;
  const target = topics.length;
  const nextTopic = nextTopicFor(session, mode);
  const assistantTurns = countAssistantTurns(session);
  const maxTurnsThis = maxTurnsForMode(mode);

  // Decyzja o kontroli stanu: raport / wymuszone zamknięcie / idle hint
  // - Główny warunek raportu: wszystkie tematy pokryte
  // - Safety net: osiągnięty MAX_TURNS (ochrona przed pętlą Claude'a)
  // - Wymuszone zamknięcie tematu: zbyt wiele tur w current_topic bez zamknięcia
  const reachedTopics = covered >= target;
  const reachedTurnsSafetyNet = assistantTurns >= maxTurnsThis;
  const forceFinal = reachedTopics || reachedTurnsSafetyNet;
  const forceTopicClose =
    !forceFinal &&
    session.current_topic &&
    session.assistant_turns_in_current >= MAX_TURNS_PER_TOPIC;

  // Klon messages dla Claude'a (modyfikujemy tylko ostatnią user message - nie DDB)
  const messages = session.turns.map((t) => ({ role: t.role, content: t.content }));
  const last = messages[messages.length - 1];

  if (forceFinal) {
    const reason = reachedTopics ? "wszystkie tematy pokryte" : `limit tur ${maxTurnsThis}`;
    last.content = last.content + `\n\n[WYGENERUJ RAPORT TERAZ - ${reason}. Pokryte: ${session.topics_covered.join(", ") || "(brak)"}. Vague: ${vagueTopicList(session).join(", ") || "(brak)"}.]`;
  } else if (forceTopicClose) {
    last.content = last.content + `\n\n[WYMUSZONE_ZAMKNIĘCIE temat=${session.current_topic}, przejdź do ${nextTopic || "(brak)"}. Zamknij jako vague w tagu topic_quality i otwórz nowy temat.]`;
  }

  const started = Date.now();
  const { text, usage, stopReason } = await invokeClaude({
    systemText,
    messages,
    maxTokens: forceFinal ? maxReportTokensForMode(mode) : MAX_OUTPUT_TOKENS
  });
  const elapsed = Date.now() - started;

  // Parse tagi + strip z visible text, zanim zapiszemy do turns / pokażemy userowi
  const parsed = parseTopicTags(text);
  const applied = applyTopicMetadata(session, parsed, mode);

  const isFinal = looksLikeFinalReport(parsed.cleanText, mode);
  // Post-processing: regex-owe czyszczenie sugestii ("np.", "opcje:", pytania
  // retoryczne w nawiasach). Tylko dla pytań - raport finalny ma prawo do
  // przykładów w rekomendacjach.
  let { text: cleanText, cleaned: suggestionsCleaned } = cleanSuggestions(parsed.cleanText, isFinal);
  // Etap 4: sanitize banned terms (firmy/daty Artura) w każdej odpowiedzi.
  // Halucynacje pojawiały się głównie w raportach, ale guard stosujemy wszędzie.
  const sanitized = sanitizeReport(cleanText);
  cleanText = sanitized.text;

  // Etap 4 fallback: raport finalny MUSI zawierać stopkę racicki.com.
  // Claude w testach ignoruje regułę z promptu; backend gwarantuje stopkę.
  let footerInjected = false;
  if (isFinal && !/racicki\.com/i.test(cleanText)) {
    cleanText = cleanText.trimEnd() +
      "\n\n---\nWalidator korzysta z doświadczeń Artura Racickiego. Pełne bio i kontakt: racicki.com\n";
    footerInjected = true;
  }

  session.turns.push({ role: "assistant", content: cleanText, ts: nowIso() });
  touchSession(session);
  if (isFinal) {
    session.is_final = true;
    session.werdykt_koncowy = extractVerdict(cleanText);
    // Jeśli Claude wygenerował raport ale nie zamknął jeszcze ostatniego tematu
    // tagiem topic_quality - backend zamyka current_topic jako fallback (vague).
    if (session.current_topic && !session.topics_covered.includes(session.current_topic)) {
      session.topics_covered.push(session.current_topic);
      session.topics_quality[session.current_topic] = session.topics_quality[session.current_topic] || "vague";
    }
  }

  await saveSession(session);

  const turnNumber = countAssistantTurns(session);
  const vagueCount = countVagueTopics(session);

  console.log(JSON.stringify({
    event: "turn_ok",
    session_id: session.session_id,
    mode,
    user_turn: countUserTurns(session),
    assistant_turn: turnNumber,
    current_topic: session.current_topic,
    topics_covered_count: session.topics_covered.length,
    topics_total: target,
    vague_count: vagueCount,
    // Warstwa C: metric dla CloudWatch filter "suggestions_cleaned_per_turn".
    // >0 = Claude złamał zakaz i regex musiał posprzątać.
    suggestions_cleaned: suggestionsCleaned,
    // Etap 4: sanitize banned terms. >0 = Claude wymyślił firmę/datę Artura.
    banned_terms_detected: sanitized.detected,
    banned_terms_matched: sanitized.matched,
    footer_injected: footerInjected,
    is_final: isFinal,
    forced_final: forceFinal,
    forced_topic_close: forceTopicClose,
    applied_close: applied.closedTopic,
    applied_new: applied.newTopic,
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
    // Dla kompatybilności z obecnym frontendem (zanim go zmienimy):
    turn_number: turnNumber,
    max_turns: maxTurnsThis,
    user_turn_number: countUserTurns(session),
    // Nowe pola tematów:
    topics_covered: session.topics_covered,
    topics_total: target,
    current_topic: session.current_topic,
    vague_count: vagueCount,
    is_final: isFinal,
    response: cleanText,
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

async function handleFeedback(event, origin) {
  let payload;
  try { payload = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return json(400, { status: "error", message: "Invalid JSON" }, origin); }

  const sessionId = (payload.session_id || "").trim();
  if (!sessionId) return json(400, { status: "error", message: "Pole 'session_id' jest wymagane." }, origin);

  const rating = Number(payload.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return json(400, { status: "error", message: "Pole 'rating' musi być liczbą całkowitą 1-5." }, origin);
  }

  // Pozostałe pola opcjonalne, limit długości 500 znaków każde (ochrona przed abuse).
  const clip = (s) => String(s || "").trim().slice(0, 500);
  const valuable = clip(payload.valuable);
  const missing = clip(payload.missing);
  const action = clip(payload.action);

  const session = await loadSession(sessionId);
  if (!session) return json(404, { status: "error", message: "Sesja nie istnieje." }, origin);

  // Feedback ma sens tylko dla sesji zakończonej raportem.
  if (!session.is_final) {
    return json(409, { status: "error", message: "Feedback można wysłać dopiero po wygenerowaniu raportu." }, origin);
  }

  // Jeśli feedback już istnieje - nie nadpisujemy (MVP decyzja; można poluzować później).
  if (session.feedback && session.feedback.submitted_at) {
    return json(409, { status: "error", message: "Feedback dla tej sesji już został wysłany." }, origin);
  }

  session.feedback = {
    rating,
    valuable,
    missing,
    action,
    submitted_at: nowIso()
  };
  touchSession(session);
  await saveSession(session);

  console.log(JSON.stringify({
    event: "feedback_ok",
    session_id: sessionId,
    rating,
    has_valuable: valuable.length > 0,
    has_missing: missing.length > 0,
    has_action: action.length > 0
  }));

  return json(200, {
    status: "ok",
    session_id: sessionId,
    feedback: session.feedback
  }, origin);
}

async function handleGetSession(event, origin) {
  const sessionId = event.pathParameters && event.pathParameters.id;
  if (!sessionId) return json(400, { status: "error", message: "Brak session_id w ścieżce." }, origin);

  const session = await loadSession(sessionId);
  if (!session) return json(404, { status: "error", message: "Sesja nie istnieje." }, origin);

  const mode = session.mode || "full";
  const topics = topicsForMode(mode);
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
    max_turns: maxTurnsForMode(mode),
    // Topics state (legacy sesje bez pól = puste)
    topics_covered: Array.isArray(session.topics_covered) ? session.topics_covered : [],
    topics_total: topics.length,
    current_topic: session.current_topic || null,
    vague_count: session.topics_quality ? Object.values(session.topics_quality).filter((q) => q === "vague").length : 0,
    feedback: session.feedback || null
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
    if (rawPath.endsWith("/walidator/feedback")) {
      return await handleFeedback(event, origin);
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
