// renderer.js — coat GUI wiring. Talks only to window.coat (preload bridge).
const HOURS = [0, 1, 3, 6, 12, 24];

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function fillInterval(current) {
  const sel = document.getElementById("interval");
  sel.innerHTML = HOURS.map((h) => `<option value="${h}" ${h === current ? "selected" : ""}>${h === 0 ? "Off" : h + " hour" + (h > 1 ? "s" : "")}</option>`).join("");
  sel.onchange = () => window.coat.setInterval(Number(sel.value)).then(renderStatus);
}

function esc(s){return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}

function ratingClass(r){ return {General:"g",Sensitive:"s",Questionable:"q",Explicit:"e"}[r] || "u"; }

async function renderStatus() {
  const s = await window.coat.status();
  const el = document.getElementById("status");
  if (!s || !s.ok) { el.textContent = "daemon not reachable — start coat"; return; }
  fillInterval(s.data.intervalHours);
  const m = s.data.lastWallMeta;
  const port = s.data.port;
  // Preview via the daemon's local /wall endpoint (localhost, hotlink/CSP-proof),
  // falling back to the CDN sample only if the proxy has nothing yet.
  el.innerHTML = m ? `
    <div class="wall">
      <div class="wallimg">${m.sampleUrl ? `<img src="http://127.0.0.1:${port}/wall" alt="wall" onerror="this.onerror=null;this.src='${esc(m.sampleUrl)}';"/>` : `<div class="noimg">${esc(m.ext||"").toUpperCase()}</div>`}</div>
      <div class="wallmeta">
        <div class="artist">by <b>${esc(m.artist)}</b> <span class="rate ${ratingClass(m.rating)}">${esc(m.rating)}</span></div>
        <div class="scorerow"><span class="score">⬆ ${m.score}</span>${m.id ? `<span class="eid">post #${m.id}</span>` : ""}</div>
        <div class="tags">${m.tags.artist.map(t=>`<span class="tag a">${esc(t)}</span>`).join("")}${m.tags.species.map(t=>`<span class="tag s">${esc(t)}</span>`).join("")}${m.tags.general.map(t=>`<span class="tag g">${esc(t)}</span>`).join("")}</div>
      </div>
    </div>` : `<div class="noimg">no wall yet — hit Rotate now</div>`;
}

document.getElementById("rotate").onclick = async () => {
  const r = await window.coat.rotate();
  if (r.ok) toast(`rotated → ${r.data.wall.split(/[\\/]/).pop()}`); else toast(r.data?.error || "rotate failed");
  renderStatus();
};
document.getElementById("save").onclick = async () => {
  const r = await window.coat.save();
  if (r.ok) toast("saved to history"); else toast(r.data?.error || "save failed");
};
document.getElementById("tags").onclick = async () => {
  const cur = (await window.coat.tags())?.data?.tags || "";
  const next = prompt("e621 tags (search syntax):", cur);
  if (next === null) return;
  await window.coat.setTags(next);
  const go = confirm(`tags set to:\n${next}\n\nRotate now?`);
  if (go) { const r = await window.coat.rotate(); if (r.ok) toast("rotated"); }
  renderStatus();
};
document.getElementById("open").onclick = () => window.coat.openArchive();

async function renderHistory() {
  const el = document.getElementById("history");
  const h = await window.coat.history(20);
  if (!h || !h.ok || !h.data?.entries?.length) { el.textContent = "no history yet — rotate or save a wall"; return; }
  const { port } = (await window.coat.status()).data;
  el.innerHTML = `<div class="hist">${h.data.entries.map((e) => `
    <div class="hist-row">
      <img class="hist-thumb" src="http://127.0.0.1:${port}/history/${e.id}/preview" alt="" onerror="this.remove()"/>
      <div class="hist-info">
        <b>${esc(e.artist || "(unknown)")}</b> <span class="rate ${ratingClass(e.rating || "")}">${esc(e.rating || "?")}</span>
        <div class="sub">${esc((e.filename || "").slice(0, 26))} · ${esc(e.source)} · ${e.score ?? "—"} pts</div>
      </div>
      <button class="hist-restore" data-id="${e.id}">↩ Restore</button>
    </div>`).join("")}</div>`;
  el.querySelectorAll(".hist-restore").forEach((b) => {
    b.onclick = async () => {
      const r = await window.coat.restore(Number(b.dataset.id));
      if (r.ok) {
        toast(`restored → ${r.data.wall.split(/[\\/]/).pop()}`);
        renderStatus();
        renderHistory();
      } else toast(r.data?.error || "restore failed");
    };
  });
}

// live updates pushed from main on each action
window.coat.onDaemonMsg((m) => { if (m && m.type === "changed") { renderStatus(); renderHistory(); } });

renderStatus();
renderHistory();