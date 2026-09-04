// Visual FX enhancements for the landing page.
// Feeds a cursor-following spotlight position into feature cards so the
// CSS radial-gradient in ::before can track the pointer. Pure decoration —
// gracefully does nothing when the pointer or motion isn't available.
(function () {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) return;

  const cards = document.querySelectorAll(".feature-card");
  if (!cards.length) return;

  cards.forEach((card) => {
    card.addEventListener(
      "pointermove",
      (event) => {
        const rect = card.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * 100;
        const y = ((event.clientY - rect.top) / rect.height) * 100;
        card.style.setProperty("--mx", `${x}%`);
        card.style.setProperty("--my", `${y}%`);
      },
      { passive: true }
    );
  });
})();
