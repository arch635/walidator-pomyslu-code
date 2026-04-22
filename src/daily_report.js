"use strict";

// Codzienny raport e-mail z aktywności walidator.racicki.com.
// Wywoływany przez EventBridge Scheduler codziennie 8:00 Europe/Warsaw.

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");

const SESSIONS_TABLE = process.env.SESSIONS_TABLE || "walidator-sessions-prod";
const REGION = process.env.AWS_REGION || "eu-central-1";
const REPORT_TO = process.env.REPORT_TO || "artur@racicki.com";
const REPORT_FROM = process.env.REPORT_FROM || "artur@racicki.com";
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS || "24", 10);
const COST_PER_FINAL_SESSION = parseFloat(process.env.COST_PER_FINAL_SESSION || "0.083");
const COST_PER_DIALOG_TURN = parseFloat(process.env.COST_PER_DIALOG_TURN || "0.0033");
const COST_PER_FINAL_SESSION_MINI = parseFloat(process.env.COST_PER_FINAL_SESSION_MINI || "0.013");
const COST_PER_DIALOG_TURN_MINI = parseFloat(process.env.COST_PER_DIALOG_TURN_MINI || "0.0007");
const COST_INFRA_DAILY = parseFloat(process.env.COST_INFRA_DAILY || "0.0017"); // ~$0.05/mo / 30 dni

// Stare sesje (sprzed wprowadzenia mini) nie maja pola mode - traktuj jak full.
function modeOf(s) {
  return s.mode === "mini" ? "mini" : "full";
}

const ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ses = new SESv2Client({ region: REGION });

// --- agregacja ---

async function scanRecentSessions(sinceIso) {
  let items = [];
  let exclusiveStartKey;
  do {
    const res = await ddbDoc.send(new ScanCommand({
      TableName: SESSIONS_TABLE,
      FilterExpression: "last_activity >= :since",
      ExpressionAttributeValues: { ":since": sinceIso },
      ExclusiveStartKey: exclusiveStartKey
    }));
    if (res.Items) items = items.concat(res.Items);
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

function emojiFromWerdykt(text) {
  if (!text) return null;
  if (text.includes("🟢")) return "🟢";
  if (text.includes("🟡")) return "🟡";
  if (text.includes("🟠")) return "🟠";
  if (text.includes("🔴")) return "🔴";
  return null;
}

function levelNameFromWerdykt(text) {
  if (!text) return "";
  // Usuń emoji + gwiazdki markdown, zostaw 1-3 słowa opisu poziomu.
  const clean = text.replace(/[🟢🟡🟠🔴]/g, "").replace(/\*+/g, "").trim();
  return clean.split(/\s+/).slice(0, 3).join(" ");
}

function extractRedFlags(session) {
  // Raport finalny zawiera sekcję "## Red flagi wykryte w rozmowie" z bulletami
  // **Nazwa flagi**. Szukamy jej w ostatniej wiadomości assistanta tylko jeśli
  // sesja jest zakończona.
  if (!session.is_final || !session.turns || !session.turns.length) return [];
  const last = session.turns[session.turns.length - 1];
  if (!last || last.role !== "assistant") return [];
  const text = last.content;
  const sectionMatch = text.match(/##\s*Red flagi[^\n]*\n([\s\S]*?)(?=\n##|\n$|$)/);
  if (!sectionMatch) return [];
  const section = sectionMatch[1];
  const flags = [];
  const boldRe = /\*\*([^*\n]{3,80})\*\*/g;
  let m;
  while ((m = boldRe.exec(section)) !== null) {
    const label = m[1].trim()
      .replace(/^(🔴|🟠|🟡|🟢)\s*/, "")
      .replace(/[\[\]]/g, "")
      .trim();
    if (label && !/brak/i.test(label)) flags.push(label);
  }
  return flags;
}

function topN(counts, n) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

function estimateCostUsd(sessions) {
  let bedrockFull = 0;
  let bedrockMini = 0;
  for (const s of sessions) {
    const isMini = modeOf(s) === "mini";
    const finalCost = isMini ? COST_PER_FINAL_SESSION_MINI : COST_PER_FINAL_SESSION;
    const turnCost = isMini ? COST_PER_DIALOG_TURN_MINI : COST_PER_DIALOG_TURN;
    let cost;
    if (s.is_final) {
      cost = finalCost;
    } else {
      const userTurns = (s.turns || []).filter((t) => t.role === "user").length;
      cost = userTurns * turnCost;
    }
    if (isMini) bedrockMini += cost; else bedrockFull += cost;
  }
  const bedrock = bedrockFull + bedrockMini;
  return {
    bedrock,
    bedrock_full: bedrockFull,
    bedrock_mini: bedrockMini,
    infra: COST_INFRA_DAILY,
    total: bedrock + COST_INFRA_DAILY
  };
}

function emptyVerdicts() {
  return { "🟢": 0, "🟡": 0, "🟠": 0, "🔴": 0, unknown: 0 };
}

function perModeStats(sessions, sinceIso, modeName) {
  const filtered = sessions.filter((s) => modeOf(s) === modeName);
  const started = filtered.filter((s) => s.started_at >= sinceIso);
  const finals = filtered.filter((s) => s.is_final);
  const verdicts = emptyVerdicts();
  for (const s of finals) {
    const emoji = emojiFromWerdykt(s.werdykt_koncowy);
    if (emoji) verdicts[emoji] += 1;
    else verdicts.unknown += 1;
  }
  return {
    total: filtered.length,
    started: started.length,
    finals: finals.length,
    verdicts
  };
}

function aggregate(sessions, sinceIso) {
  const started = sessions.filter((s) => s.started_at >= sinceIso);
  const finals = sessions.filter((s) => s.is_final);

  const verdicts = emptyVerdicts();
  const verdictLabels = {};
  const redFlagCounts = {};

  for (const s of finals) {
    const emoji = emojiFromWerdykt(s.werdykt_koncowy);
    if (emoji) {
      verdicts[emoji] += 1;
      const label = levelNameFromWerdykt(s.werdykt_koncowy);
      if (label) verdictLabels[emoji] = label;
    } else {
      verdicts.unknown += 1;
    }
    const flags = extractRedFlags(s);
    for (const f of flags) {
      redFlagCounts[f] = (redFlagCounts[f] || 0) + 1;
    }
  }

  const ideas = sessions
    .filter((s) => s.pomysl_initial)
    .sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""))
    .slice(0, 3)
    .map((s) => ({
      excerpt: s.pomysl_initial.slice(0, 110) + (s.pomysl_initial.length > 110 ? "..." : ""),
      session_id: s.session_id,
      mode: modeOf(s),
      werdykt: s.werdykt_koncowy || null
    }));

  const cost = estimateCostUsd(sessions);

  return {
    total_in_window: sessions.length,
    started_in_window: started.length,
    finals: finals.length,
    verdicts,
    verdict_labels: verdictLabels,
    top_red_flags: topN(redFlagCounts, 3),
    top_ideas: ideas,
    cost,
    mini: perModeStats(sessions, sinceIso, "mini"),
    full: perModeStats(sessions, sinceIso, "full")
  };
}

// --- rendering maila ---

function formatDatePl(date) {
  return date.toLocaleDateString("pl-PL", {
    timeZone: "Europe/Warsaw",
    day: "2-digit", month: "long", year: "numeric"
  });
}

function ddbConsoleUrl() {
  return `https://${REGION}.console.aws.amazon.com/dynamodbv2/home?region=${REGION}#table?name=${SESSIONS_TABLE}&tab=items`;
}

function formatCost(v) { return "$" + v.toFixed(4); }

function verdictLine(v) {
  return `🟢 ${v["🟢"]} / 🟡 ${v["🟡"]} / 🟠 ${v["🟠"]} / 🔴 ${v["🔴"]}`
    + (v.unknown ? ` / (bez werdyktu) ${v.unknown}` : "");
}

function renderPlainText(agg, since, now) {
  const lines = [];
  lines.push(`Walidator - raport dzienny (${formatDatePl(now)})`);
  lines.push(`Okno: ostatnie ${LOOKBACK_HOURS}h (od ${since.toISOString()})`);
  lines.push("");
  lines.push(`Sesje w oknie: ${agg.total_in_window}`);
  lines.push(`  - rozpoczete w oknie: ${agg.started_in_window}`);
  lines.push(`  - zakonczone raportem: ${agg.finals}`);
  lines.push("");

  if (agg.total_in_window === 0) {
    lines.push("Zero aktywnosci w ostatnich 24h. Scheduler zyje.");
    lines.push("");
    lines.push(`Koszt szacunkowy dzienny: ${formatCost(agg.cost.total)} (infra-only)`);
    lines.push("");
    lines.push(`DynamoDB console: ${ddbConsoleUrl()}`);
    return lines.join("\n");
  }

  lines.push("Sesje per tryb:");
  lines.push(`  Mini (5 pytan):  ${agg.mini.started} rozpoczetych, ${agg.mini.finals} ukonczonych`);
  lines.push(`  Pelne (25 pytan): ${agg.full.started} rozpoczetych, ${agg.full.finals} ukonczonych`);
  lines.push("");

  if (agg.mini.finals > 0) {
    lines.push(`Werdykty mini: ${verdictLine(agg.mini.verdicts)}`);
  }
  if (agg.full.finals > 0) {
    lines.push(`Werdykty pelne: ${verdictLine(agg.full.verdicts)}`);
  }
  if (agg.mini.finals > 0 || agg.full.finals > 0) lines.push("");

  lines.push("Werdykty (lacznie):");
  const vLabels = agg.verdict_labels;
  const vRows = [
    ["🟢 ZIELONE", agg.verdicts["🟢"], vLabels["🟢"]],
    ["🟡 ZOLTE",   agg.verdicts["🟡"], vLabels["🟡"]],
    ["🟠 POMARANCZOWE", agg.verdicts["🟠"], vLabels["🟠"]],
    ["🔴 CZERWONE", agg.verdicts["🔴"], vLabels["🔴"]]
  ];
  for (const [label, n, ex] of vRows) {
    lines.push(`  ${label}: ${n}${n && ex ? ` (np. "${ex}")` : ""}`);
  }
  if (agg.verdicts.unknown) lines.push(`  (bez werdyktu): ${agg.verdicts.unknown}`);
  lines.push("");

  if (agg.top_red_flags.length) {
    lines.push("Top red flagi:");
    agg.top_red_flags.forEach((f, i) => {
      lines.push(`  ${i + 1}. ${f.name} (x${f.count})`);
    });
    lines.push("");
  }

  if (agg.top_ideas.length) {
    lines.push("Top 3 pomysly (najswiezsze):");
    agg.top_ideas.forEach((idea, i) => {
      lines.push(`  ${i + 1}. [${idea.mode}] "${idea.excerpt}"`);
      if (idea.werdykt) lines.push(`     -> ${idea.werdykt}`);
    });
    lines.push("");
  }

  lines.push("Koszt szacunkowy (dzienny):");
  lines.push(`  Bedrock mini:  ${formatCost(agg.cost.bedrock_mini)}`);
  lines.push(`  Bedrock pelne: ${formatCost(agg.cost.bedrock_full)}`);
  lines.push(`  Bedrock razem: ${formatCost(agg.cost.bedrock)}`);
  lines.push(`  Infra (Lambda/DDB/CW/SES): ${formatCost(agg.cost.infra)}`);
  lines.push(`  RAZEM: ${formatCost(agg.cost.total)}`);
  lines.push("");
  lines.push(`DynamoDB console: ${ddbConsoleUrl()}`);

  return lines.join("\n");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderHtml(agg, since, now) {
  const h = [];
  h.push('<!doctype html><html lang="pl"><body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#111; max-width:680px; margin:0 auto; padding:20px; background:#fafaf7;">');
  h.push(`<h2 style="font-family: Georgia, serif; color:#1a2a4a; margin:0 0 6px;">Walidator - raport dzienny</h2>`);
  h.push(`<p style="color:#4a4a4a; margin:0 0 24px; font-size:14px;">${escapeHtml(formatDatePl(now))} &middot; okno ${LOOKBACK_HOURS}h (od ${escapeHtml(since.toISOString())})</p>`);

  h.push('<table style="width:100%; border-collapse:collapse; margin-bottom:24px;"><tr>');
  h.push(`<td style="padding:12px 16px; background:#fff; border:1px solid #e2e2de; border-radius:6px; width:33%;"><div style="font-size:12px; color:#4a4a4a; text-transform:uppercase; letter-spacing:.05em;">Sesje w oknie</div><div style="font-size:28px; font-weight:600; color:#1a2a4a;">${agg.total_in_window}</div></td>`);
  h.push('<td style="width:12px;"></td>');
  h.push(`<td style="padding:12px 16px; background:#fff; border:1px solid #e2e2de; border-radius:6px; width:33%;"><div style="font-size:12px; color:#4a4a4a; text-transform:uppercase; letter-spacing:.05em;">Rozpoczete</div><div style="font-size:28px; font-weight:600; color:#1a2a4a;">${agg.started_in_window}</div></td>`);
  h.push('<td style="width:12px;"></td>');
  h.push(`<td style="padding:12px 16px; background:#fff; border:1px solid #e2e2de; border-radius:6px; width:33%;"><div style="font-size:12px; color:#4a4a4a; text-transform:uppercase; letter-spacing:.05em;">Ukonczone</div><div style="font-size:28px; font-weight:600; color:#1a5a3e;">${agg.finals}</div></td>`);
  h.push('</tr></table>');

  if (agg.total_in_window === 0) {
    h.push('<p style="background:#fff; padding:16px; border-radius:6px; border:1px solid #e2e2de; color:#4a4a4a;">Zero aktywnosci w oknie 24h. Scheduler zyje, codzienny cron dziala poprawnie.</p>');
    h.push(`<p style="font-size:14px; color:#4a4a4a;">Koszt szacunkowy dzienny: <b>${formatCost(agg.cost.total)}</b> (tylko infra, bez Bedrock).</p>`);
  } else {
    h.push('<h3 style="font-family: Georgia, serif; color:#1a2a4a; margin:24px 0 8px;">Sesje per tryb</h3>');
    h.push('<table style="width:100%; border-collapse:collapse; background:#fff; border:1px solid #e2e2de; border-radius:6px;">');
    h.push('<tr><th style="text-align:left; padding:8px 14px; border-bottom:1px solid #f0efea; font-size:12px; color:#4a4a4a; text-transform:uppercase; letter-spacing:.05em;">Tryb</th><th style="text-align:right; padding:8px 14px; border-bottom:1px solid #f0efea; font-size:12px; color:#4a4a4a; text-transform:uppercase; letter-spacing:.05em;">Rozpoczete</th><th style="text-align:right; padding:8px 14px; border-bottom:1px solid #f0efea; font-size:12px; color:#4a4a4a; text-transform:uppercase; letter-spacing:.05em;">Ukonczone</th><th style="text-align:left; padding:8px 14px; border-bottom:1px solid #f0efea; font-size:12px; color:#4a4a4a; text-transform:uppercase; letter-spacing:.05em;">Werdykty</th></tr>');
    const modeRows = [
      ["Mini (5 pytan)", agg.mini],
      ["Pelne (25 pytan)", agg.full]
    ];
    for (const [label, m] of modeRows) {
      const v = m.verdicts;
      const verdictHtml = m.finals > 0
        ? `🟢 ${v["🟢"]} &middot; 🟡 ${v["🟡"]} &middot; 🟠 ${v["🟠"]} &middot; 🔴 ${v["🔴"]}` + (v.unknown ? ` &middot; ? ${v.unknown}` : "")
        : '<span style="color:#4a4a4a;">—</span>';
      h.push(`<tr><td style="padding:8px 14px; border-bottom:1px solid #f0efea;">${escapeHtml(label)}</td><td style="padding:8px 14px; border-bottom:1px solid #f0efea; text-align:right; font-weight:600;">${m.started}</td><td style="padding:8px 14px; border-bottom:1px solid #f0efea; text-align:right; font-weight:600;">${m.finals}</td><td style="padding:8px 14px; border-bottom:1px solid #f0efea; font-size:14px;">${verdictHtml}</td></tr>`);
    }
    h.push('</table>');

    h.push('<h3 style="font-family: Georgia, serif; color:#1a2a4a; margin:24px 0 8px;">Werdykty (lacznie)</h3>');
    h.push('<table style="width:100%; border-collapse:collapse; background:#fff; border:1px solid #e2e2de; border-radius:6px;">');
    const rows = [
      ["🟢", "ZIELONE", agg.verdicts["🟢"], agg.verdict_labels["🟢"]],
      ["🟡", "ZOLTE", agg.verdicts["🟡"], agg.verdict_labels["🟡"]],
      ["🟠", "POMARANCZOWE", agg.verdicts["🟠"], agg.verdict_labels["🟠"]],
      ["🔴", "CZERWONE", agg.verdicts["🔴"], agg.verdict_labels["🔴"]]
    ];
    for (const [emoji, label, n, ex] of rows) {
      h.push(`<tr><td style="padding:8px 14px; border-bottom:1px solid #f0efea; font-size:18px;">${emoji}</td><td style="padding:8px 14px; border-bottom:1px solid #f0efea;">${escapeHtml(label)}</td><td style="padding:8px 14px; border-bottom:1px solid #f0efea; text-align:right; font-weight:600;">${n}</td><td style="padding:8px 14px; border-bottom:1px solid #f0efea; color:#4a4a4a; font-size:13px;">${n && ex ? "np. &ldquo;" + escapeHtml(ex) + "&rdquo;" : ""}</td></tr>`);
    }
    if (agg.verdicts.unknown) {
      h.push(`<tr><td style="padding:8px 14px;" colspan="2">(bez werdyktu)</td><td style="padding:8px 14px; text-align:right;">${agg.verdicts.unknown}</td><td></td></tr>`);
    }
    h.push('</table>');

    if (agg.top_red_flags.length) {
      h.push('<h3 style="font-family: Georgia, serif; color:#1a2a4a; margin:24px 0 8px;">Top red flagi</h3>');
      h.push('<ol style="background:#fff; padding:14px 14px 14px 36px; border:1px solid #e2e2de; border-radius:6px; margin:0;">');
      for (const f of agg.top_red_flags) {
        h.push(`<li style="margin:4px 0;"><b>${escapeHtml(f.name)}</b> <span style="color:#4a4a4a;">(x${f.count})</span></li>`);
      }
      h.push('</ol>');
    }

    if (agg.top_ideas.length) {
      h.push('<h3 style="font-family: Georgia, serif; color:#1a2a4a; margin:24px 0 8px;">Najswiezsze pomysly</h3>');
      h.push('<ol style="background:#fff; padding:14px 14px 14px 36px; border:1px solid #e2e2de; border-radius:6px; margin:0;">');
      for (const idea of agg.top_ideas) {
        const modeBadge = `<span style="display:inline-block; padding:2px 8px; background:#F4EFE5; border:1px solid #e2e2de; border-radius:10px; font-size:11px; color:#4a4a4a; text-transform:uppercase; letter-spacing:.05em; margin-right:6px;">${escapeHtml(idea.mode)}</span>`;
        h.push(`<li style="margin:8px 0; line-height:1.5;">${modeBadge}&ldquo;${escapeHtml(idea.excerpt)}&rdquo;${idea.werdykt ? `<br><span style="color:#4a4a4a; font-size:13px;">Werdykt: ${escapeHtml(idea.werdykt)}</span>` : ""}</li>`);
      }
      h.push('</ol>');
    }

    h.push('<h3 style="font-family: Georgia, serif; color:#1a2a4a; margin:24px 0 8px;">Koszt szacunkowy</h3>');
    h.push('<table style="width:100%; border-collapse:collapse; background:#fff; border:1px solid #e2e2de; border-radius:6px;">');
    h.push(`<tr><td style="padding:8px 14px; border-bottom:1px solid #f0efea;">Bedrock mini</td><td style="padding:8px 14px; border-bottom:1px solid #f0efea; text-align:right;">${formatCost(agg.cost.bedrock_mini)}</td></tr>`);
    h.push(`<tr><td style="padding:8px 14px; border-bottom:1px solid #f0efea;">Bedrock pelne</td><td style="padding:8px 14px; border-bottom:1px solid #f0efea; text-align:right;">${formatCost(agg.cost.bedrock_full)}</td></tr>`);
    h.push(`<tr><td style="padding:8px 14px; border-bottom:1px solid #f0efea;">Bedrock razem</td><td style="padding:8px 14px; border-bottom:1px solid #f0efea; text-align:right; font-weight:600;">${formatCost(agg.cost.bedrock)}</td></tr>`);
    h.push(`<tr><td style="padding:8px 14px; border-bottom:1px solid #f0efea;">Infra (Lambda/DDB/CW/SES)</td><td style="padding:8px 14px; border-bottom:1px solid #f0efea; text-align:right;">${formatCost(agg.cost.infra)}</td></tr>`);
    h.push(`<tr><td style="padding:8px 14px; font-weight:600;">RAZEM</td><td style="padding:8px 14px; text-align:right; font-weight:600; color:#1a2a4a;">${formatCost(agg.cost.total)}</td></tr>`);
    h.push('</table>');
  }

  h.push(`<p style="margin:32px 0 0; padding-top:16px; border-top:1px solid #e2e2de; font-size:13px; color:#4a4a4a;"><a href="${escapeHtml(ddbConsoleUrl())}" style="color:#1a2a4a;">Sesje w DynamoDB console &rarr;</a></p>`);
  h.push('</body></html>');
  return h.join("");
}

// --- handler ---

exports.handler = async (event) => {
  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  const sinceIso = since.toISOString();

  console.log(JSON.stringify({ event: "daily_report_start", since: sinceIso, to: REPORT_TO }));

  const sessions = await scanRecentSessions(sinceIso);
  const agg = aggregate(sessions, sinceIso);

  console.log(JSON.stringify({
    event: "daily_report_agg",
    total: agg.total_in_window,
    started: agg.started_in_window,
    finals: agg.finals,
    mini: agg.mini,
    full: agg.full,
    verdicts: agg.verdicts,
    red_flags_top: agg.top_red_flags,
    cost_total: agg.cost.total,
    cost_mini: agg.cost.bedrock_mini,
    cost_full: agg.cost.bedrock_full
  }));

  const subject = agg.total_in_window === 0
    ? `Walidator: 0 aktywnosci (${formatDatePl(now)})`
    : `Walidator: ${agg.total_in_window} sesji (mini ${agg.mini.total} / pelne ${agg.full.total}), ${agg.finals} ukonczonych (${formatDatePl(now)})`;

  const plain = renderPlainText(agg, since, now);
  const html = renderHtml(agg, since, now);

  const cmd = new SendEmailCommand({
    FromEmailAddress: REPORT_FROM,
    Destination: { ToAddresses: [REPORT_TO] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: plain, Charset: "UTF-8" },
          Html: { Data: html, Charset: "UTF-8" }
        }
      }
    }
  });

  const res = await ses.send(cmd);

  console.log(JSON.stringify({
    event: "daily_report_sent",
    message_id: res.MessageId,
    to: REPORT_TO
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "ok",
      message_id: res.MessageId,
      sessions: agg.total_in_window,
      finals: agg.finals,
      cost_total_usd: agg.cost.total
    })
  };
};
