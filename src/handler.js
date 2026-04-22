"use strict";

const fs = require("fs");
const path = require("path");
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

const ALLOW_ORIGIN_REGEX = /^(https:\/\/walidator\.racicki\.com|https:\/\/[a-z0-9]+\.cloudfront\.net|http:\/\/localhost(:\d+)?)$/i;

const PROMPT_PATH = process.env.PROMPT_PATH || "prompts/walidator-v2.md";
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "eu-central-1";
const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || "2000", 10);

const ONE_SHOT_OVERRIDE = `

---

# TRYB JEDNORAZOWY (krok 6 MVP)

**Uwaga: w tym trybie NIE prowadzisz dialogu 25 pytań.** Użytkownik poda krótki opis pomysłu (2-5 zdań), a Ty zwracasz od razu **raport strukturalny w Markdownie** - bez wstępów, bez powitania, bez próśb o doprecyzowanie. Wieloetapową rozmowę zrobimy w kroku 7 (po podpięciu DynamoDB).

Ton bez zmian: sokratejski, szczery, konkretny, bez cheerleadingu. Stosuj 3 żelazne zasady (Mom Test / dowód / czerwone flagi). Cytuj metodologię gdzie to adekwatne.

## Wymagany format odpowiedzi (Markdown, dokładnie te sekcje, dokładnie w tej kolejności)

**Łączny budżet: ~1800-2200 tokenów.** Bądź zwięzły - krótkie zdania, bez rozwodnienia. Lepiej konkret niż akapit.

\`\`\`markdown
## Pierwsza reakcja
**Jedno zdanie** - krótko i szczerze co myślisz o tym pomyśle.

## Czego brakuje w tym opisie
3-5 punktów bulletami. Każdy bullet = 1 zdanie, max 20 słów. Wypisz KONKRETNIE jakich informacji brakuje (np. "brak ICP", "brak liczby rozmów z klientami", "brak modelu przychodów").

## Pytania krytyczne do zadania sobie
3-5 pytań w duchu Mom Test. Każde pytanie = 1 zdanie, max 25 słów. Konkretne, o przeszłe zachowania i dowody - nie o hipotezy.

## Red flagi wykryte w opisie
Lista z tabeli flag w metodologii. Każda flaga: nazwa **pogrubiona** + 1 zdanie uzasadnienia z cytatem lub konkretem z opisu. Jeśli zero flag - jedno zdanie: "Brak widocznych red flag w samym opisie (ale to nie oznacza że ich nie ma - wiele ujawni się dopiero w 25 pytaniach)."

## Potencjalne mocne strony
1-3 punkty bulletami. Każdy bullet = 1 zdanie, max 25 słów. Jeśli nic konkretnego - jedno zdanie: "Za mało informacji żeby wskazać mocne strony".

## 3 kroki na najbliższe 30 dni
1. **Do 7 dni:** [1-2 zdania, konkretne działanie z liczbami]
2. **Do 14 dni:** [1-2 zdania, konkretne działanie z liczbami]
3. **Do 30 dni:** [1-2 zdania, konkretne działanie z liczbami]

## Werdykt
**Jedna linia**: emoji (🟢/🟡/🟠/🔴) + nazwa poziomu **pogrubiona** + 1-2 zdania kluczowe.

Przykład: 🟠 **POMARAŃCZOWE - WIELE DO ZROBIENIA.** Opis jest na etapie pomysłu, nie walidacji - zacznij od 15 rozmów z klientami wg Mom Test.

## Polecana lektura
1-3 pozycje. Format: **Autor, "Tytuł"** - 1 zdanie dlaczego akurat ta książka dla tego pomysłu.
\`\`\`

## Jak wybierac werdykt w trybie jednorazowym

Krotki opis (2-5 zdan) rzadko zaslugujuje na 🟢. Bazuj na tym co widzisz:
- 🟢 Zielone: opis zawiera konkretne liczby, imiona klientow, cytaty, model przychodow - rzadkosc w tym trybie.
- 🟡 Zolte: opis ma jasne ICP i jeden-dwa konkrety, ale brakuje dowodow. Typowe dla przemyslanego pomyslu.
- 🟠 Pomaranczowe: opis jest na poziomie ogolnikow ("aplikacja dla X") bez ICP, bez customer development, bez modelu. Default dla wiekszosci opisow.
- 🔴 Czerwone: opis zdradza fundamentalne problemy ("chce zalozyc biznes ale nie wiem jaki", "rynek ogromny wystarczy 1%", kilka krytycznych red flag).

## ZASADY KONTEKSTU

- Odpowiadaj **po polsku**, naturalnym jezykiem (nie generatorowym).
- Bez powitania, bez "Zrozumialem, oto moja analiza...". Zaczynaj od "## Pierwsza reakcja".
- Bez zamykania typu "Powodzenia!". Ostatnia sekcja to "## Polecana lektura" i na tym koniec.
- Jesli opis jest tak krotki/nieprecyzyjny ze nie da sie nic powiedziec ("chce robic biznes") - **i tak wygeneruj raport** (z szczera reakcja + wieloma brakami + werdykt 🔴). Nie prosisz o doprecyzowanie.
- Nie wymyslaj cytatow klientow ktorych uzytkownik nie podal. Jesli mowisz o braku dowodow - wskazuj ze ich brakuje, nie udawaj ze je masz.

Zaczynaj generowanie raportu od razu po otrzymaniu opisu pomyslu.
`;

// Load prompt once at cold start. If it fails, cache the error — we fail fast on invoke.
let SYSTEM_PROMPT;
let SYSTEM_PROMPT_ERROR;
try {
  const absPath = path.join(__dirname, PROMPT_PATH);
  const base = fs.readFileSync(absPath, "utf8");
  SYSTEM_PROMPT = base + ONE_SHOT_OVERRIDE;
} catch (err) {
  SYSTEM_PROMPT_ERROR = err;
}

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

function corsHeaders(origin) {
  const allow = origin && ALLOW_ORIGIN_REGEX.test(origin)
    ? origin
    : "https://walidator.racicki.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin"
  };
}

function json(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin)
    },
    body: JSON.stringify(body)
  };
}

async function callBedrock(pomysl) {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `OPIS POMYSŁU OD UŻYTKOWNIKA:\n\n${pomysl}\n\nWygeneruj raport zgodnie z wymaganym formatem.`
      }
    ]
  };

  const cmd = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body)
  });

  const res = await bedrock.send(cmd);
  const parsed = JSON.parse(Buffer.from(res.body).toString("utf8"));

  const markdown = (parsed.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    markdown,
    usage: parsed.usage || {},
    stopReason: parsed.stop_reason
  };
}

exports.handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "POST";
  const origin = event?.headers?.origin || event?.headers?.Origin || "";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  if (SYSTEM_PROMPT_ERROR) {
    console.error("Prompt file load failed:", SYSTEM_PROMPT_ERROR);
    return json(500, {
      status: "error",
      message: "Błąd konfiguracji serwera (prompt). Spróbuj ponownie za chwilę."
    }, origin);
  }

  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return json(400, { status: "error", message: "Invalid JSON" }, origin);
  }

  const pomysl = (payload.pomysl || "").trim();
  if (!pomysl) {
    return json(400, {
      status: "error",
      message: "Pole 'pomysl' jest wymagane."
    }, origin);
  }
  if (pomysl.length > 2000) {
    return json(400, {
      status: "error",
      message: "Za długi opis (max 2000 znaków)."
    }, origin);
  }

  const started = Date.now();
  try {
    const { markdown, usage, stopReason } = await callBedrock(pomysl);
    const elapsedMs = Date.now() - started;

    console.log(JSON.stringify({
      event: "bedrock_invoke_ok",
      model: MODEL_ID,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      stop_reason: stopReason,
      elapsed_ms: elapsedMs,
      pomysl_chars: pomysl.length
    }));

    return json(200, {
      status: "ok",
      markdown,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens
      },
      elapsed_ms: elapsedMs
    }, origin);
  } catch (err) {
    const elapsedMs = Date.now() - started;
    console.error(JSON.stringify({
      event: "bedrock_invoke_error",
      model: MODEL_ID,
      name: err.name,
      message: err.message,
      elapsed_ms: elapsedMs
    }));

    if (err.name === "ThrottlingException" || err.name === "ServiceQuotaExceededException") {
      return json(503, {
        status: "error",
        message: "Chwilowo zbyt duże obciążenie. Spróbuj ponownie za chwilę."
      }, origin);
    }
    return json(502, {
      status: "error",
      message: "Nie udało się uzyskać odpowiedzi modelu. Spróbuj ponownie."
    }, origin);
  }
};
