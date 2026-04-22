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

  function setResult(kind, title, body) {
    resultBox.className = "result" + (kind === "error" ? " result--error" : kind === "success" ? " result--success" : "");
    resultBox.innerHTML = "";
    const h = document.createElement("h3");
    h.textContent = title;
    resultBox.appendChild(h);
    const p = document.createElement("p");
    p.textContent = body;
    resultBox.appendChild(p);
    resultBox.hidden = false;
    resultBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
      setResult("error", "Brak treści", "Wpisz swój pomysł w 2-3 zdaniach, zanim klikniesz Sprawdź.");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Sprawdzam...";
    resultBox.hidden = true;

    try {
      const res = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pomysl })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult("error", "Coś poszło nie tak", data.message || ("HTTP " + res.status));
      } else {
        setResult("success", "Twój pomysł został przyjęty",
          data.message || "W kolejnym kroku dodamy Claude który przeanalizuje go wg metodologii Mom Test + CB Insights + 20 lat doświadczeń Artura.");
      }
    } catch (err) {
      setResult("error", "Błąd sieci", "Nie udało się skontaktować z API. Spróbuj ponownie za chwilę.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sprawdź pomysł";
    }
  });
})();
