(() => {
  const input = document.getElementById("q");
  const form = document.getElementById("search-form");
  const results = document.getElementById("results");
  const empty = document.getElementById("no-results");
  if (!input || !results) return;
  const cards = [...results.querySelectorAll(".card")];
  function filter() {
    const q = input.value.trim().toLowerCase();
    let n = 0;
    for (const card of cards) {
      const text = card.textContent.toLowerCase();
      const ok = !q || text.includes(q);
      card.hidden = !ok;
      if (ok) n++;
    }
    if (empty) empty.hidden = n > 0;
  }
  input.addEventListener("input", filter);
  form?.addEventListener("submit", (e) => { e.preventDefault(); filter(); });
  const params = new URLSearchParams(location.search);
  if (params.get("q")) { input.value = params.get("q"); filter(); }
})();