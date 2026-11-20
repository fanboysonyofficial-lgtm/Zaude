// The top bar update button. Shows "Check for updates", then "Update to vX" when a newer release is on GitHub.
// Checks also run every 6 hours in the desktop app (electron/main.cjs). Requires window.zaudeUpdate.

const api = window.zaudeUpdate || null;
const btn = document.getElementById('update-btn');

let state = null;

function render() {
  if (!btn) return;
  if (!api) {
    btn.disabled = true;
    btn.title = 'Updates are available in the desktop app.';
    return;
  }
  const s = state || {};
  btn.classList.toggle('update-ready', Boolean(s.available));
  btn.disabled = Boolean(s.busy);

  if (s.busy) {
    btn.textContent = s.message || 'Working…';
  } else if (s.available) {
    btn.textContent = `Update to ${s.latest}`;
  } else {
    btn.textContent = s.checkedAt && !s.error ? 'Up to date' : 'Check for updates';
  }

  const parts = [`Zaude ${s.current || ''}`.trim()];
  if (s.available) parts.push(`Version ${s.latest} is ready. Click to update.`);
  else if (s.error) parts.push(s.error);
  else if (s.checkedAt) parts.push('You have the newest version.');
  else parts.push('Click to check GitHub for a newer version.');
  btn.title = parts.join('\n');
}

async function onClick() {
  if (!api || !state) return;
  if (state.available) {
    const result = await api.install();
    if (result && result.ok === false) {
      state = { ...state, error: result.error };
    }
  } else {
    await api.check();
  }
  render();
}

if (btn && api) {
  btn.addEventListener('click', onClick);
  api.onStatus((s) => {
    state = s;
    render();
  });
  api.status().then((s) => {
    state = s;
    render();
  });
} else {
  render();
}
