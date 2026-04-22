"use strict";

// MVP szkielet - endpoint POST /walidator zwraca placeholder.
// W kroku 6 podepniemy Claude (Bedrock) z promptem v2.0.
//
// Lista allowed originów dla CORS. Wartości:
//   - https://walidator.racicki.com          - docelowa subdomena (po wpięciu DNS)
//   - https://d*.cloudfront.net              - tymczasowy URL CloudFront dla testów
//   - http://localhost:*                     - dev lokalny (Live Server / itp.)
// Regex obejmuje oba cloudfront.net (bez wpisywania konkretnego ID) i localhost.
const ALLOW_ORIGIN_REGEX = /^(https:\/\/walidator\.racicki\.com|https:\/\/[a-z0-9]+\.cloudfront\.net|http:\/\/localhost(:\d+)?)$/i;

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

exports.handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "POST";
  const origin = event?.headers?.origin || event?.headers?.Origin || "";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
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

  return json(200, {
    status: "received",
    message: "Walidator w trakcie budowy - tu będzie analiza AI wg metodologii Mom Test.",
    echo: { pomysl_chars: pomysl.length }
  }, origin);
};
