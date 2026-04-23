// walidator.racicki.com - frontend chat logic (krok 7)
// Wieloetapowy dialog z Claude Haiku 4.5 przez Bedrock.
// Endpoint API Gateway jest wstrzykiwany podczas deploy (scripts/deploy.sh
// generuje ten plik z szablonu, zamieniajac __API_ENDPOINT__).

(function () {
  "use strict";

  const API_BASE = "__API_ENDPOINT__";
  const TURN_URL = API_BASE + "/walidator/turn";
  const FEEDBACK_URL = API_BASE + "/walidator/feedback";
  const SESSION_URL = (id) => API_BASE + "/walidator/session/" + encodeURIComponent(id);
  const STORAGE_KEY = "walidator.session_id.v1";
  const MODE_PREF_KEY = "walidator.mode_pref.v1";
  const TOPICS_TOTAL_BY_MODE = { mini: 5, full: 25 };
  const MODE_DESCRIPTIONS = {
    mini: "Szybka walidacja 5 kluczowych aspektów - idealna żeby sprawdzić pomysł w 5 minut.",
    full: "Dogłębna analiza 25 tematów - Twój kompleksowy raport z red flagami i planem działania."
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
  const feedbackForm = document.getElementById("feedback-form");
  const feedbackSubmit = document.getElementById("feedback-submit");
  const feedbackError = document.getElementById("feedback-error");
  const feedbackValuable = document.getElementById("feedback-valuable");
  const feedbackMissing = document.getElementById("feedback-missing");
  const feedbackAction = document.getElementById("feedback-action");
  const ratingEl = document.getElementById("rating");
  const ratingValueEl = document.getElementById("rating-value");
  const feedbackThanks = document.getElementById("feedback-thanks");
  const restartBtn = document.getElementById("restart-btn");
  const upgradeBtn = document.getElementById("upgrade-btn");
  const chatHint = document.getElementById("chat-hint");

  let sessionId = null;
  let isFinal = false;
  let topicsCoveredCount = 0;
  let sending = false;
  let feedbackSending = false;
  let mode = DEFAULT_MODE;

  function topicsTotal() { return TOPICS_TOTAL_BY_MODE[mode] || TOPICS_TOTAL_BY_MODE.full; }

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
    const total = topicsTotal();
    const shown = Math.min(topicsCoveredCount, total);
    turnCounter.textContent = isFinal
      ? "Rozmowa zakończona - raport poniżej"
      : "Temat " + shown + "/" + total;
    const pct = Math.max(0, Math.min(100, (shown / total) * 100));
    turnBar.style.width = pct + "%";
    resetBtn.hidden = topicsCoveredCount === 0 && !isFinal;
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

  function showFeedbackForm(show) {
    if (!feedbackForm) return;
    feedbackForm.hidden = !show;
    // Gdy pokazujemy feedback - chowamy hint o sesji
    if (chatHint) chatHint.hidden = !!show;
  }

  function showFeedbackThanks(show) {
    if (!feedbackThanks) return;
    feedbackThanks.hidden = !show;
    if (show && upgradeBtn) upgradeBtn.hidden = mode !== "mini";
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
    // Po raporcie: ukryj form chatu, pokaz feedback box
    if (form) form.hidden = true;
    showFeedbackForm(true);
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
      // topics_covered source-of-truth z backendu. Legacy sesje bez pola = puste.
      topicsCoveredCount = Array.isArray(data.topics_covered) ? data.topics_covered.length : 0;

      if (isFinal) {
        showVerdict(data.werdykt);
        lockAfterFinal();
        // Jesli feedback juz wyslany (user wrocil do sesji po zamknieciu) - pokaz podziekowanie
        if (data.feedback) {
          showFeedbackForm(false);
          showFeedbackThanks(true);
        }
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
    topicsCoveredCount = 0;
    messagesEl.innerHTML = "";
    verdictBox.hidden = true;
    verdictBox.innerHTML = "";
    // Ukryj feedback UI + thanks, przywroc chat form
    showFeedbackForm(false);
    showFeedbackThanks(false);
    resetFeedbackInputs();
    if (form) form.hidden = false;
    if (chatHint) chatHint.hidden = false;
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

  function resetFeedbackInputs() {
    if (feedbackValuable) feedbackValuable.value = "";
    if (feedbackMissing) feedbackMissing.value = "";
    if (feedbackAction) feedbackAction.value = "";
    if (ratingValueEl) ratingValueEl.value = "";
    setRating(0);
    if (feedbackError) { feedbackError.hidden = true; feedbackError.textContent = ""; }
  }

  function setRating(value) {
    if (!ratingEl) return;
    ratingValueEl.value = value ? String(value) : "";
    const stars = ratingEl.querySelectorAll(".rating__star");
    stars.forEach((s) => {
      const v = Number(s.getAttribute("data-value"));
      const filled = value > 0 && v <= value;
      s.textContent = filled ? "★" : "☆";
      s.classList.toggle("is-filled", filled);
      s.setAttribute("aria-checked", v === value ? "true" : "false");
    });
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

    // Po pierwszej wysłanej wiadomości chowamy toggle - tryb sesji jest już zalockowany.
    hideToggle();

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

      // topics_covered jest source of truth - backend wie ile tematów zamknęliśmy
      if (Array.isArray(data.topics_covered)) {
        topicsCoveredCount = data.topics_covered.length;
      }

      removeLoadingBubble();

      const finalFlag = !!data.is_final;
      appendAssistantBubble(data.response || "", { final: finalFlag });

      if (finalFlag) {
        showVerdict(data.werdykt);
        lockAfterFinal();
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
      // Jeśli wciąż brak sesji (pierwsza tura padła) - pokazujemy toggle
      // żeby user mógł zmienić tryb przed retry.
      if (!sessionId && topicsCoveredCount === 0) showToggle();
      setInputEnabled(true);
      sendBtn.textContent = "Wyślij";
      updateProgress();
    } finally {
      sending = false;
    }
  });

  // --- feedback submit ---

  async function sendFeedback(body) {
    const res = await fetch(FEEDBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || ("HTTP " + res.status));
    return data;
  }

  if (feedbackForm) {
    feedbackForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (feedbackSending) return;
      if (!sessionId) {
        feedbackError.hidden = false;
        feedbackError.textContent = "Brak identyfikatora sesji - odśwież stronę.";
        return;
      }

      const rating = Number(ratingValueEl.value) || 0;
      if (!rating || rating < 1 || rating > 5) {
        feedbackError.hidden = false;
        feedbackError.textContent = "Wybierz ocenę 1-5 gwiazdek.";
        return;
      }

      feedbackError.hidden = true;
      feedbackSending = true;
      feedbackSubmit.disabled = true;
      feedbackSubmit.textContent = "Wysyłam...";

      try {
        await sendFeedback({
          session_id: sessionId,
          rating,
          valuable: (feedbackValuable.value || "").trim(),
          missing: (feedbackMissing.value || "").trim(),
          action: (feedbackAction.value || "").trim()
        });
        showFeedbackForm(false);
        showFeedbackThanks(true);
      } catch (err) {
        feedbackError.hidden = false;
        feedbackError.textContent = "Nie udało się wysłać: " + (err.message || "błąd sieci");
      } finally {
        feedbackSending = false;
        feedbackSubmit.disabled = false;
        feedbackSubmit.textContent = "Wyślij feedback";
      }
    });
  }

  if (ratingEl) {
    ratingEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".rating__star");
      if (!btn) return;
      const v = Number(btn.getAttribute("data-value"));
      if (!v) return;
      setRating(v);
    });
  }

  if (restartBtn) {
    restartBtn.addEventListener("click", () => resetSession());
  }

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
