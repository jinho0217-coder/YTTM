// Keep each popup visually connected to its own header button.
function createAnchoredDialog(dialog, button, { onOpen } = {}) {
  let motion = null;
  let closing = false;
  let backdropPress = false;
  button.setAttribute("aria-controls", dialog.id);
  button.setAttribute("aria-expanded", "false");
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches || !dialog.animate;
  const buttonFrame = () => {
    const source = button.getBoundingClientRect();
    const target = dialog.getBoundingClientRect();
    return {
      transform: `translate(${source.left - target.left}px, ${source.top - target.top}px) scale(${source.width / target.width}, ${source.height / target.height})`,
      opacity: 0,
    };
  };
  const open = () => {
    if (dialog.open) return;
    hideTooltip();
    dialog.showModal();
    onOpen?.();
    button.setAttribute("aria-expanded", "true");
    if (reducedMotion()) return;
    const animation = dialog.animate([buttonFrame(), { transform: "none", opacity: 1 }], {
      duration: 320, easing: "cubic-bezier(.18,.8,.25,1)",
    });
    motion = animation;
    animation.finished.then(() => { if (motion === animation) motion = null; }).catch(() => {});
  };
  const close = async () => {
    if (!dialog.open || closing) return;
    closing = true;
    const style = getComputedStyle(dialog);
    const from = { transform: style.transform, opacity: style.opacity };
    motion?.cancel();
    motion = null;
    if (!reducedMotion()) {
      dialog.classList.add("anchored-closing");
      const animation = dialog.animate([from, buttonFrame()], {
        duration: 240, easing: "cubic-bezier(.4,0,.65,1)", fill: "forwards",
      });
      motion = animation;
      try { await animation.finished; } catch (_) {}
      animation.cancel();
      if (motion === animation) motion = null;
    }
    dialog.close();
    dialog.classList.remove("anchored-closing");
    closing = false;
    button.setAttribute("aria-expanded", "false");
    button.focus({ preventScroll: true });
  };
  const isOutside = event => {
    if (event.target !== dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom;
  };
  button.addEventListener("click", event => { event.preventDefault(); open(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); void close(); });
  dialog.addEventListener("pointerdown", event => { backdropPress = event.button === 0 && isOutside(event); });
  dialog.addEventListener("pointercancel", () => { backdropPress = false; });
  dialog.addEventListener("click", event => {
    const dismiss = backdropPress && isOutside(event);
    backdropPress = false;
    if (dismiss) void close();
  });
  dialog.addEventListener("close", () => {
    backdropPress = false;
    motion?.cancel(); motion = null;
    closing = false;
    dialog.classList.remove("anchored-closing");
    button.setAttribute("aria-expanded", "false");
  });
  return { open, close };
}
