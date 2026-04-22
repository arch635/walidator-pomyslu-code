// walidator.racicki.com - frontend logic
// Endpoint API Gateway jest wstrzykiwany podczas deploy (scripts/deploy.sh
// generuje ten plik z szablonu, zamieniajac __API_ENDPOINT__).

(function () {
  "use strict";

  const API_ENDPOINT = "__API_ENDPOINT__/walidator";

  const form = document.getElementById("walidator-form");
  const textarea = document.getElementById("pomysl");
  const counter = document.getElementById("count");
  const submitBtn = document.getElementById("submit-btn");
  const resultBox = document.getElementById("result");

  function setHtml(kind, html) {
    resultBox.className = "result" + (kind === "error" ? " result--error" : kind === "loading" ? " result--loading" : " result--success");
    resultBox.innerHTML = html;
    resultBox.hidden = false;
    resultBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function setMessage(kind, title, body) {
    const safeTitle = escapeHtml(title);
    const safeBody = escapeHtml(body);
    setHtml(kind, `<h3>${safeTitle}</h3><p>${safeBody}</p>`);
  }

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
      return `<pre>${escapeHtml(md)}</pre>`;
    }
    try {
      window.marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });
      return window.marked.parse(md);
    } catch (e) {
      return `<pre>${escapeHtml(md)}</pre>`;
    }
  }

  function updateCount() {
    const len = textarea.value.length;
    counter.textContent = len + " / 2000 znaków";
  }
  textarea.addEventListener("input", updateCount);
  updateCount();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pomysl = textarea.value.trim();
    if (!pomysl) {
      setMessage("error", "Brak treści", "Wpisz swój pomysł w 2-3 zdaniach, zanim klikniesz Sprawdź.");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Analizuję...";
    setHtml("loading",
      '<h3>Analizuję Twój pomysł...</h3>' +
      '<p class="muted">Claude (AWS Bedrock) czyta opis, sprawdza red flagi wg metodologii Mom Test + CB Insights i buduje raport. Zwykle 5-15 sekund.</p>'
    );

    const started = Date.now();
    try {
      const res = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pomysl })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setMessage("error", "Coś poszło nie tak", data.message || ("HTTP " + res.status));
        return;
      }
      if (!data.markdown) {
        setMessage("error", "Pusta odpowiedź", data.message || "Model nie zwrócił raportu. Spróbuj ponownie.");
        return;
      }

      const elapsed = Math.round((Date.now() - started) / 100) / 10;
      const in_t = data.usage && data.usage.input_tokens;
      const out_t = data.usage && data.usage.output_tokens;
      const meta = (in_t != null && out_t != null)
        ? `<p class="muted result-meta">Analiza wygenerowana w ${elapsed}s · ${in_t} + ${out_t} tokenów (input + output).</p>`
        : `<p class="muted result-meta">Analiza wygenerowana w ${elapsed}s.</p>`;

      setHtml("success", `<div class="result-md">${renderMarkdown(data.markdown)}</div>${meta}`);
    } catch (err) {
      setMessage("error", "Błąd sieci", "Nie udało się skontaktować z API. Spróbuj ponownie za chwilę.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sprawdź pomysł";
    }
  });
})();
