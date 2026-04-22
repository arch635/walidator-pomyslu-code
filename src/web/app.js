// walidator.racicki.com - frontend chat logic (krok 7)
// Wieloetapowy dialog z Claude Haiku 4.5 przez Bedrock.
// Endpoint API Gateway jest wstrzykiwany podczas deploy (scripts/deploy.sh
// generuje ten plik z szablonu, zamieniajac __API_ENDPOINT__).

(function () {
  "use strict";

  const API_BASE = "__API_ENDPOINT__";
  const TURN_URL = API_BASE + "/walidator/turn";
  const SESSION_URL = (id) => API_BASE + "/walidator/session/" + encodeURIComponent(id);
  const STORAGE_KEY = "walidator.session_id.v1";
  const MODE_PREF_KEY = "walidator.mode_pref.v1";
  const MAX_TURNS_BY_MODE = { mini: 5, full: 25 };
  const MODE_DESCRIPTIONS = {
    mini: "Szybka walidacja 5 kluczowych aspektów - idealna żeby sprawdzić pomysł w 5 minut.",
    full: "Dogłębna analiza 25 pytań - Twój kompleksowy raport z red flagami i planem działania."
  };
  const DEFAULT_MODE = "mini";

  const messagesEl = document.getElementById("messages");
  const form = document.getElementById("chat-form");
  const textarea = document.getElementById("message");
  const counter = document.getElementById("count");
  const sendBtn = document.getElementById("send-btn");
  const resetBtn = document.getElementById("reset-btn");
  const turnCounter = document.getElementById("turn-counter");
  const turnBar = document.getElementById("turn-bar");
  const verdictBox = document.getElementById("verdict-box");
  const errorBox = document.getElementById("error-box");
  const modeToggle = document.getElementById("mode-toggle");
  const modeDesc = document.getElementById("mode-desc");
  const modeMiniBtn = document.getElementById("mode-mini");
  const modeFullBtn = document.getElementById("mode-full");
  const upgradeCta = document.getElementById("upgrade-cta");
  const upgradeBtn = document.getElementById("upgrade-btn");

  let sessionId = null;
  let isFinal = false;
  let userTurnCount = 0;
  let sending = false;
  let mode = DEFAULT_MODE;

  function maxTurns() { return MAX_TURNS_BY_MODE[mode] || MAX_TURNS_BY_MODE.full; }

  // --- helpers ---

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderMarkdown(md) {
    if (typeof window.marked === "undefined") {
      return "<pre>" + escapeHtml(md) + "</pre>";
    }
    try {
      window.marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });
      return window.marked.parse(md);
    } catch (e) {
      return "<pre>" + escapeHtml(md) + "</pre>";
    }
  }

  function updateCount() {
    counter.textContent = textarea.value.length + " / 2000 znaków";
  }

  function setError(msg) {
    if (!msg) { errorBox.hidden = true; errorBox.textContent = ""; return; }
    errorBox.hidden = false;
    errorBox.textContent = msg;
  }

  function updateProgress() {
    const total = maxTurns();
    const shown = Math.min(userTurnCount, total);
    turnCounter.textContent = isFinal
      ? "Rozmowa zakończona - raport poniżej"
      : "Tura " + shown + " z " + total;
    const pct = Math.max(0, Math.min(100, (shown / total) * 100));
    turnBar.style.width = pct + "%";
    resetBtn.hidden = userTurnCount === 0 && !isFinal;
  }

  function setActiveMode(newMode, opts) {
    if (newMode !== "mini" && newMode !== "full") return;
    mode = newMode;
    if (modeMiniBtn && modeFullBtn) {
      modeMiniBtn.classList.toggle("is-active", mode === "mini");
      modeFullBtn.classList.toggle("is-active", mode === "full");
      modeMiniBtn.setAttribute("aria-checked", mode === "mini" ? "true" : "false");
      modeFullBtn.setAttribute("aria-checked", mode === "full" ? "true" : "false");
    }
    if (modeDesc) modeDesc.textContent = MODE_DESCRIPTIONS[mode];
    try { localStorage.setItem(MODE_PREF_KEY, mode); } catch (e) { /* ignore */ }
    if (!(opts && opts.silent)) updateProgress();
  }

  function loadModePref() {
    try {
      const saved = localStorage.getItem(MODE_PREF_KEY);
      if (saved === "mini" || saved === "full") return saved;
    } catch (e) { /* ignore */ }
    return DEFAULT_MODE;
  }

  function hideToggle() {
    if (modeToggle) modeToggle.hidden = true;
    if (modeDesc) modeDesc.hidden = true;
  }

  function showToggle() {
    if (modeToggle) modeToggle.hidden = false;
    if (modeDesc) modeDesc.hidden = false;
  }

  function showUpgradeCta(show) {
    if (!upgradeCta) return;
    upgradeCta.hidden = !show;
  }

  function scrollToBottom() {
    const last = messagesEl.lastElementChild;
    if (last) last.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  function appendUserBubble(text) {
    const el = document.createElement("div");
    el.className = "msg msg--user";
    el.innerHTML = '<div class="msg__role">Ty</div><div class="msg__body">' + escapeHtml(text).replace(/\n/g, "<br>") + "</div>";
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendAssistantBubble(markdown, opts) {
    const el = document.createElement("div");
    el.className = "msg msg--assistant" + (opts && opts.final ? " msg--final" : "");
    const label = opts && opts.final ? "Raport końcowy" : "Walidator";
    el.innerHTML =
      '<div class="msg__role">' + label + '</div>' +
      '<div class="msg__body ' + (opts && opts.final ? "result-md" : "") + '">' +
      renderMarkdown(markdown) +
      '</div>';
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendLoadingBubble() {
    const el = document.createElement("div");
    el.className = "msg msg--assistant msg--loading";
    el.id = "msg-loading";
    el.innerHTML =
      '<div class="msg__role">Walidator</div>' +
      '<div class="msg__body"><span class="dots"><span></span><span></span><span></span></span> myśli...</div>';
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function removeLoadingBubble() {
    const el = document.getElementById("msg-loading");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function showVerdict(werdykt) {
    if (!werdykt) { verdictBox.hidden = true; return; }
    verdictBox.hidden = false;
    verdictBox.innerHTML =
      '<div class="chat__verdict-label">Werdykt</div>' +
      '<div class="chat__verdict-body">' + escapeHtml(werdykt) + '</div>';
  }

  function setInputEnabled(enabled) {
    textarea.disabled = !enabled;
    sendBtn.disabled = !enabled;
  }

  function lockAfterFinal() {
    isFinal = true;
    setInputEnabled(false);
    textarea.value = "";
    updateCount();
    sendBtn.textContent = "Sesja zakończona";
    updateProgress();
  }

  function setPlaceholder() {
    if (isFinal) return;
    if (userTurnCount === 0) {
      textarea.placeholder = "Opisz swój pomysł w 2-3 zdaniach - np. kto ma problem, jaki i jak to rozwiązujesz.";
    } else {
      textarea.placeholder = "Twoja odpowiedź (krótko, konkretnie - liczby, imiona, daty).";
    }
  }

  // --- session lifecycle ---

  function loadStoredSessionId() {
    try { return localStorage.getItem(STORAGE_KEY); }
    catch (e) { return null; }
  }

  function storeSessionId(id) {
    try { localStorage.setItem(STORAGE_KEY, id); }
    catch (e) { /* ignore */ }
  }

  function clearStoredSession() {
    try { localStorage.removeItem(STORAGE_KEY); }
    catch (e) { /* ignore */ }
  }

  async function restoreSession(id) {
    try {
      const res = await fetch(SESSION_URL(id));
      if (res.status === 404) { clearStoredSession(); return false; }
      const data = await res.json();
      if (!res.ok || data.status !== "ok") { clearStoredSession(); return false; }

      sessionId = data.session_id;
      isFinal = !!data.is_final;
      // Tryb sesji jest niezmienny - lock'ujemy go z odpowiedzi backendu
      // (stare sesje bez pola mode = full).
      if (data.mode === "mini" || data.mode === "full") {
        setActiveMode(data.mode, { silent: true });
      }
      hideToggle();

      messagesEl.innerHTML = "";
      (data.turns || []).forEach((t) => {
        if (t.role === "user") appendUserBubble(t.content);
        else appendAssistantBubble(t.content, { final: isFinal && t === data.turns[data.turns.length - 1] });
      });
      userTurnCount = (data.turns || []).filter((t) => t.role === "user").length;

      if (isFinal) {
        showVerdict(data.werdykt);
        lockAfterFinal();
        showUpgradeCta(mode === "mini");
      } else {
        updateProgress();
      }
      return true;
    } catch (e) {
      clearStoredSession();
      return false;
    }
  }

  function resetSession(opts) {
    clearStoredSession();
    sessionId = null;
    isFinal = false;
    userTurnCount = 0;
    messagesEl.innerHTML = "";
    verdictBox.hidden = true;
    verdictBox.innerHTML = "";
    showUpgradeCta(false);
    setError(null);
    setInputEnabled(true);
    sendBtn.textContent = "Wyślij";
    textarea.value = "";
    updateCount();
    if (opts && opts.preferredMode) setActiveMode(opts.preferredMode, { silent: true });
    showToggle();
    updateProgress();
    setPlaceholder();
    textarea.focus();
  }

  // --- send turn ---

  async function sendTurn(message) {
    const body = { message };
    if (sessionId) body.session_id = sessionId;
    else body.mode = mode;

    const res = await fetch(TURN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || ("HTTP " + res.status));
    return data;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending || isFinal) return;

    const message = textarea.value.trim();
    if (!message) {
      setError("Wpisz odpowiedź przed wysłaniem.");
      return;
    }
    setError(null);

    sending = true;
    setInputEnabled(false);
    sendBtn.textContent = "Wysyłam...";

    appendUserBubble(message);
    textarea.value = "";
    updateCount();

    userTurnCount += 1;
    // Po pierwszej wysłanej wiadomości chowamy toggle - tryb sesji jest już zalockowany.
    hideToggle();
    updateProgress();

    appendLoadingBubble();

    try {
      const data = await sendTurn(message);

      if (!sessionId && data.session_id) {
        sessionId = data.session_id;
        storeSessionId(sessionId);
      }
      if (data.mode === "mini" || data.mode === "full") {
        setActiveMode(data.mode, { silent: true });
      }

      if (typeof data.user_turn_number === "number") {
        userTurnCount = data.user_turn_number;
      }

      removeLoadingBubble();

      const finalFlag = !!data.is_final;
      appendAssistantBubble(data.response || "", { final: finalFlag });

      if (finalFlag) {
        showVerdict(data.werdykt);
        lockAfterFinal();
        showUpgradeCta(mode === "mini");
      } else {
        setInputEnabled(true);
        sendBtn.textContent = "Wyślij";
        updateProgress();
        setPlaceholder();
        textarea.focus();
      }
    } catch (err) {
      removeLoadingBubble();
      setError("Nie udało się wysłać: " + (err.message || "błąd sieci") + ". Twoja wiadomość jest wyżej - możesz spróbować ponownie.");
      userTurnCount = Math.max(0, userTurnCount - 1);
      // Jeśli wciąż brak sesji (pierwsza tura padła) - pokazujemy toggle
      // żeby user mógł zmienić tryb przed retry.
      if (!sessionId && userTurnCount === 0) showToggle();
      setInputEnabled(true);
      sendBtn.textContent = "Wyślij";
      updateProgress();
    } finally {
      sending = false;
    }
  });

  resetBtn.addEventListener("click", () => {
    if (!confirm("Porzucić obecną rozmowę i zacząć od nowa?")) return;
    resetSession();
  });

  if (modeMiniBtn) modeMiniBtn.addEventListener("click", () => setActiveMode("mini"));
  if (modeFullBtn) modeFullBtn.addEventListener("click", () => setActiveMode("full"));

  if (upgradeBtn) {
    upgradeBtn.addEventListener("click", () => {
      // Mini się zakończyło - kasujemy sesję, wracamy do startu z preselekcją "full".
      resetSession({ preferredMode: "full" });
    });
  }

  textarea.addEventListener("input", updateCount);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // init
  setActiveMode(loadModePref(), { silent: true });
  updateCount();
  updateProgress();
  setPlaceholder();

  const stored = loadStoredSessionId();
  if (stored) {
    restoreSession(stored).then((ok) => {
      if (!ok) {
        setPlaceholder();
      }
    });
  }
})();
