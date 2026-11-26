const gap = 8;
const minimumHeight = 112;
const minimumWidth = 192;

export function createHoverReasons(card, panels, render) {
  let current = null;
  let pending = null;
  let timer = 0;
  let frame = 0;
  let pointer = null;
  let enabled = true;
  let dragging = false;

  function cancelTimer() {
    clearTimeout(timer);
    pending = null;
  }

  function close() {
    cancelTimer();
    current = null;
    card.hidden = true;
  }

  function paragraphAtPointer() {
    if (!enabled || dragging || !pointer) return null;
    const { x, y } = pointer;
    const target = document.elementFromPoint(x, y);
    const panel = panels.find(({ host }) => host === target);
    return panel?.root.elementFromPoint(x, y)?.closest('[data-anchor]') ?? null;
  }

  function place() {
    if (!current?.isConnected) return close();
    const rect = current.getBoundingClientRect();
    const host = current.getRootNode().host.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const left = Math.max(0, host.left, rect.left);
    const right = Math.min(width, host.right, rect.right);
    const top = Math.max(0, host.top, rect.top);
    const bottom = Math.min(height, host.bottom, rect.bottom);
    if (top >= bottom || left >= right) return close();

    const scroll = card.scrollTop;
    card.style.width = '';
    card.style.maxHeight = '';
    card.hidden = false;
    const desired = card.getBoundingClientRect();
    const candidates = [
      { width: width - 2 * gap, height: height - bottom - 2 * gap, x: left, y: bottom + gap },
      { width: width - 2 * gap, height: top - 2 * gap, x: left, y: top - gap, above: true },
      { width: width - right - 2 * gap, height: height - 2 * gap, x: right + gap, y: top },
      { width: left - 2 * gap, height: height - 2 * gap, x: left - gap, y: top, before: true },
    ];
    const fits = candidates.find((space) => space.width >= desired.width && space.height >= desired.height);
    const space = fits ?? candidates.find((space) =>
      space.width >= Math.min(desired.width, minimumWidth) && space.height >= Math.min(desired.height, minimumHeight));
    if (!space) {
      card.hidden = true;
      return;
    }
    card.style.width = Math.min(desired.width, space.width) + 'px';
    card.style.maxHeight = Math.min(height - 2 * gap, space.height) + 'px';
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const x = space.before ? space.x - w : space.x;
    const y = space.above ? space.y - h : space.y;
    card.style.left = Math.max(gap, Math.min(x, width - w - gap)) + 'px';
    card.style.top = Math.max(gap, Math.min(y, height - h - gap)) + 'px';
    card.scrollTop = scroll;
  }

  function update() {
    if (!enabled || dragging || !pointer) return;
    if (card.contains(document.elementFromPoint(pointer.x, pointer.y))) return cancelTimer();
    const block = paragraphAtPointer();
    if (block && block === current) {
      cancelTimer();
      return;
    }
    if (pending && pending.block === block) return;
    cancelTimer();
    if (!block && !current) return;
    pending = { block };
    timer = setTimeout(() => {
      pending = null;
      if (!block || block !== paragraphAtPointer() || !render(block)) return close();
      current = block;
      card.scrollTop = 0;
      place();
    }, block ? 145 : 360);
  }

  document.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    pointer = { x: event.clientX, y: event.clientY };
    if (event.buttons) return;
    update();
  }, { passive: true });
  document.addEventListener('pointerdown', (event) => {
    if (event.composedPath().includes(card)) return;
    dragging = true;
    close();
  }, true);
  window.addEventListener('pointerup', () => { dragging = false; }, true);
  window.addEventListener('pointercancel', () => { dragging = false; }, true);
  document.documentElement.addEventListener('pointerleave', () => {
    pointer = null;
    close();
  });

  function reposition() {
    if (frame || (!current && !pending)) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (current) place();
      update();
    });
  }

  for (const { host } of panels) host.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition);
  card.addEventListener('toggle', reposition, true);
  return {
    close,
    reposition,
    enable(active) {
      enabled = active;
      if (!enabled) close();
    },
  };
}
