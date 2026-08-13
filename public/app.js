/* ==========================================================================
   Console llama.cpp - interface
   ========================================================================== */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = {
  models: [], defaults: {}, status: {}, gpu: {}, config: {},
  keys: [], lan: [], stats: {}, activity: [],
  page: 'models', search: '', draft: null, snippetTab: 'url',
  actRange: '30', showKey: false
};

// --------------------------------------------------------------------------
// formats
// --------------------------------------------------------------------------
const nf = new Intl.NumberFormat('fr-FR');

function mb(v) {
  if (!v) return '0 Mo';
  return v >= 1024 ? (v / 1024).toFixed(1).replace('.', ',') + ' Go' : Math.round(v) + ' Mo';
}
function tok(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + ' M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace('.', ',') + ' k';
  return String(Math.round(v || 0));
}
function ctxLabel(v) { return v >= 1024 ? Math.round(v / 1024) + 'k' : String(v); }
function dur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ' + (s % 60) + ' s';
  const h = Math.floor(m / 60);
  return h + ' h ' + (m % 60) + ' min';
}
function ago(t) {
  if (!t) return 'jamais';
  const d = Date.now() - t;
  if (d < 60000) return 'a l\'instant';
  if (d < 3600000) return 'il y a ' + Math.floor(d / 60000) + ' min';
  if (d < 86400000) return 'il y a ' + Math.floor(d / 3600000) + ' h';
  return 'le ' + new Date(t).toLocaleDateString('fr-FR');
}
function hhmm(t) { return new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* Quantification deduite du nom de fichier. */
function quantOf(p) {
  const m = String(p || '').match(/(IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|BF16|F16|F32)/i);
  return m ? m[1].toUpperCase() : '';
}

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

/* Une console arretee, ou figee, laisse la requete en suspens : sans borne, le
 * bouton reste sur « enregistrement... » pour toujours et on ne sait pas
 * pourquoi. On coupe donc, et on le dit. L'installation du tunnel telecharge un
 * binaire : elle a droit a beaucoup plus de temps. */
const API_DELAI = 30000;
const API_DELAI_LONG = 300000;

async function api(path, method, body, delai) {
  const limite = delai || (/tunnel\/install/.test(path) ? API_DELAI_LONG : API_DELAI);
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), limite);
  let r;
  try {
    r = await fetch('/_api' + path, {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('La console n\'a pas repondu en ' + Math.round(limite / 1000)
        + ' s. Elle est peut-etre arretee : relance CONSOLE.bat, puis rafraichis la page.');
    }
    throw new Error('La console est injoignable : ' + e.message);
  } finally {
    clearTimeout(minuteur);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || ('erreur ' + r.status));
    e.status = r.status;   // sert a distinguer un refus d'une console absente
    throw e;
  }
  return j;
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast((label || 'Copie') + ' dans le presse-papier.');
  } catch {
    toast('Copie impossible : le navigateur la bloque hors https.', true);
  }
}

// --------------------------------------------------------------------------
// estimation VRAM - meme calcul que LLAMA.bat
// --------------------------------------------------------------------------
const KVF = { q4_0: 1000, q5_0: 1222, q8_0: 1889, f16: 3556 };

function estimate(model, L) {
  // contexte automatique : on ne sait pas ce que llama.cpp allouera
  const auto = L.ctxSlot === -1;
  const ctxTotal = auto ? 0 : L.ctxSlot * L.slots;
  const kvf = KVF[L.cache] || 1000;
  const kv = auto ? 0
    : Math.round((ctxTotal / 1024) * (Number(model.kv_kb_token) || 20) * kvf / 1000)
      + L.slots * (Number(model.swa_mb) || 0);
  const weights = (model.modelMb || 0)
    + (L.vision === 1 ? (model.mmprojMb || 0) : 0)
    + (L.mtp ? (model.draftMb || 0) : 0)
    + (model.hasLora ? (model.loraMb || 0) : 0);
  const compute = 400 + L.slots * 60;
  const total = kv + weights + compute;
  const gpu = state.gpu || {};
  const reserve = state.config.reserveMb ?? 512;
  // si le serveur tourne deja, sa VRAM est comptee dans usedMb : on l'ignore
  const busy = state.status.running ? 0 : (gpu.usedMb || 0);
  const usable = Math.max(256, (gpu.totalMb || 0) - busy - reserve);
  const nativeCtx = Number(model.native_ctx) || 32768;
  return {
    ctxTotal, kv, weights, compute, total, usable, auto,
    over: total - usable,
    rope: auto ? 1 : Math.max(1, Math.ceil(L.ctxSlot / nativeCtx))
  };
}

// --------------------------------------------------------------------------
// barre haute
// --------------------------------------------------------------------------
function renderTop() {
  const st = state.status, gpu = state.gpu;

  $('#gpuName').textContent = gpu.name || 'GPU';
  $('#gpuStats').textContent = gpu.ok
    ? `${mb(gpu.usedMb)} / ${mb(gpu.totalMb)} · ${gpu.utilPct}% · ${gpu.tempC}°C · ${gpu.powerW} W`
    : 'non detecte';

  const stateEl = $('#reactorState');
  if (st.running && st.ready) { stateEl.textContent = 'en service · ' + dur(st.uptime || 0); stateEl.className = 'reactor-state live'; }
  else if (st.running)        { stateEl.textContent = 'chargement'; stateEl.className = 'reactor-state boot'; }
  else if (st.idleStopped)    { stateEl.textContent = 'libere, faute d\'activite'; stateEl.className = 'reactor-state'; }
  else if (st.exitCode)       { stateEl.textContent = 'arrete, code ' + st.exitCode; stateEl.className = 'reactor-state dead'; }
  else                        { stateEl.textContent = 'a l\'arret'; stateEl.className = 'reactor-state'; }

  $('#reactorModel').textContent = st.running
    ? (st.modelName || st.modelId)
    : 'aucun modele charge';

  // repartition de la VRAM reelle
  const total = gpu.totalMb || 1;
  const model = state.models.find(m => m.id === st.modelId);
  let w = 0, kv = 0, c = 0, other = gpu.usedMb || 0;
  if (st.running && model && st.launch) {
    // contexte laisse a llama.cpp : une fois charge, /slots donne la vraie
    // valeur, on s'en sert plutot que de laisser le cache KV a zero
    let L = st.launch;
    if (L.noCtx && st.slots && st.slots.length && st.slots[0].nCtx) {
      L = Object.assign({}, L, { ctxSlot: st.slots[0].nCtx, slots: st.slots.length });
    }
    const e = estimate(model, L);
    w = Math.min(e.weights, other); kv = Math.min(e.kv, other - w); c = Math.min(e.compute, other - w - kv);
    other = Math.max(0, other - w - kv - c);
  }
  const pc = v => (v / total * 100).toFixed(2) + '%';
  $('#segW').style.width = pc(w);
  $('#segKv').style.width = pc(kv);
  $('#segC').style.width = pc(c);
  $('#segOth').style.width = pc(other);
  $('#vramText').textContent = gpu.ok
    ? `${mb(gpu.usedMb)} occupes sur ${mb(gpu.totalMb)}`
    : 'VRAM inconnue';

  // pastilles d'agents
  const dots = $('#agentDots');
  const n = (st.launch && st.launch.slots) || 0;
  if (dots.childElementCount !== n) {
    dots.innerHTML = Array.from({ length: n }, () => '<i class="agent-dot"></i>').join('');
  }
  const slots = st.slots || [];
  $$('.agent-dot', dots).forEach((d, i) => d.classList.toggle('busy', !!(slots[i] && slots[i].busy)));

  // file d'attente : elle n'apparait que quand elle existe
  const file = Math.max(0, (st.inFlight || 0) - n);
  const chip = $('#queueChip');
  chip.hidden = !file;
  if (file) chip.textContent = file + ' en attente';

  $('#brandMark').classList.toggle('live', !!(st.running && st.ready));
  $('#navLive').hidden = !st.running;
  $('#navModels').textContent = state.models.length || '';
  $('#navKeys').textContent = state.keys.length || '';
}

// --------------------------------------------------------------------------
// page modeles
// --------------------------------------------------------------------------
function modelRow(m) {
  const running = state.status.running && state.status.modelId === m.id;
  const quant = quantOf(m.model);
  const tags = [
    running ? '<span class="tag live">en service</span>' : '',
    !m.hasModel ? '<span class="tag gone">fichier absent</span>' : '',
    !m.hasBin ? '<span class="tag gone">build absent</span>' : '',
    m.hasMmproj ? '<span class="tag vision">vision</span>' : '',
    m.hasMtp ? '<span class="tag draft">' + (m.hasDraft ? 'draft' : 'mtp inclus') + '</span>' : '',
    m.hasLora ? '<span class="tag lora">lora</span>' : ''
  ].join('');
  return `
    <article class="model-row ${running ? 'on' : ''} ${m.hasModel ? '' : 'off'}" data-id="${esc(m.id)}">
      <div>
        <div class="m-title">
          <span class="m-name">${esc(m.name || m.id)}</span>
          <span class="m-id">${esc(m.id)}</span>
          ${tags}
        </div>
        <div class="m-meta">
          ${quant ? `<span>quant <b>${esc(quant)}</b></span>` : ''}
          <span>poids <b>${mb(m.modelMb)}</b></span>
          <span>contexte natif <b>${ctxLabel(m.native_ctx || 0)}</b></span>
          <span>reglage enregistre <b>${m.slots || 1} × ${m.ctx_auto ? 'auto' : ctxLabel(m.ctx || 0)}</b></span>
          <span>KV <b>${esc(m.cache || 'q4_0')}</b></span>
        </div>
      </div>
      <div class="m-actions">
        ${running
          ? '<button class="btn danger" data-act="stop">Arreter</button>'
          : `<button class="btn primary" data-act="open" ${m.hasModel && m.hasBin ? '' : 'disabled'}>Configurer</button>`}
      </div>
    </article>`;
}

/* Un meme reseau decline en cinq quantifications, ce sont cinq lignes pour un
 * seul choix : on n'en montre qu'une, qui s'ouvre sur ses variantes. Le
 * regroupement vient du serveur (champ family). */
function groupModels(list) {
  const fams = [];
  const parCle = new Map();
  for (const m of list) {
    const cle = m.family || m.id;
    let f = parCle.get(cle);
    if (!f) {
      f = { key: cle, name: m.familyName || m.name || m.id, membres: [] };
      parCle.set(cle, f);
      fams.push(f);
    }
    f.membres.push(m);
  }
  return fams;
}

function famBlock(f, ouvertParDefaut) {
  const enCours = f.membres.find(m => state.status.running && state.status.modelId === m.id);
  const poids = f.membres.map(m => m.modelMb).filter(Boolean);
  const min = poids.length ? Math.min(...poids) : 0;
  const max = poids.length ? Math.max(...poids) : 0;
  const absents = f.membres.filter(m => !m.hasModel).length;
  const meta = [
    poids.length ? (min === max ? mb(min) : mb(min) + ' a ' + mb(max)) : '',
    enCours ? esc(enCours.name || enCours.id) : '',
    absents ? absents + ' fichier(s) absent(s)' : ''
  ].filter(Boolean).join(' · ');
  return `
    <details class="model-fam ${enCours ? 'on' : ''}" ${enCours || ouvertParDefaut ? 'open' : ''} data-fam="${esc(f.key)}">
      <summary>
        <span class="fam-name">${esc(f.name)}</span>
        <span class="fam-count">${f.membres.length} variantes</span>
        ${enCours ? '<span class="tag live">en service</span>' : ''}
        ${f.membres.some(m => m.hasMmproj) ? '<span class="tag vision">vision</span>' : ''}
        <span class="fam-meta">${meta}</span>
      </summary>
      <div class="fam-body">${f.membres.map(modelRow).join('')}</div>
    </details>`;
}

function renderModels() {
  const q = state.search.toLowerCase();
  const list = state.models.filter(m =>
    !q || (m.name + ' ' + m.id + ' ' + m.model).toLowerCase().includes(q));

  $('#mjPath').textContent = state.config.modelsJson || 'models.json';
  $('#modelCount').textContent = state.models.length
    ? list.length + ' modele' + (list.length > 1 ? 's' : '')
      + ' en ' + groupModels(list).length + ' famille' + (groupModels(list).length > 1 ? 's' : '')
    : '';

  if (!list.length) {
    $('#modelList').innerHTML = '<p class="empty">Aucun modele ne correspond.</p>';
    return;
  }

  // une recherche en cours ouvre les familles : on cherche un modele, pas un groupe
  $('#modelList').innerHTML = groupModels(list)
    .map(f => (f.membres.length < 2 ? modelRow(f.membres[0]) : famBlock(f, !!q)))
    .join('');
}

$('#modelList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = e.target.closest('.model-row').dataset.id;
  if (btn.dataset.act === 'open') openDrawer(id);
  if (btn.dataset.act === 'stop') { await api('/stop', 'POST'); toast('Serveur arrete.'); }
});

$('#modelSearch').addEventListener('input', e => { state.search = e.target.value; renderModels(); });

// --------------------------------------------------------------------------
// tiroir de lancement
// --------------------------------------------------------------------------
// -1 en premiere position : tout a gauche du curseur = contexte automatique
const CTX_STEPS = [-1, 2048, 4096, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304, 131072, 163840, 196608, 262144, 393216, 524288];

/* Les reglages enregistres du modele font foi. Le dernier lancement ne sert
 * plus a preremplir le tiroir : sinon un essai non enregistre ecrasait
 * visuellement ce que l'utilisateur avait sauvegarde. */
function openDrawer(id) {
  const m = state.models.find(x => x.id === id);
  if (!m) return;
  const d = state.defaults || {};
  const val = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v);

  state.draft = {
    model: m,
    L: {
      slots: m.slots || 1,
      ctxSlot: m.ctx_auto ? -1 : (m.ctx || 32768),
      cache: m.cache || 'q4_0',
      vision: Number(val(m.vision_mode, m.hasMmproj ? 1 : 0)),
      mtp: m.hasMtp && !!val(m.draft_on, true),
      draftN: Number(val(m.spec_n, 2)),
      gpuLayers: Number(val(m.gpu_layers, d.gpu_layers ?? 99)),
      batch: Number(val(m.batch, d.batch ?? 2048)),
      ubatch: Number(val(m.ubatch, d.ubatch ?? 512)),
      // une valeur de session l'emporte, comme cote serveur : le tiroir doit
      // montrer ce qui partira vraiment
      cacheRam: (state.cacheRam && state.cacheRam.session != null)
        ? state.cacheRam.session
        : Number(val(m.cache_ram_mb, d.cache_ram_mb ?? 4096)),
      cacheReuse: Number(val(m.cache_reuse, d.cache_reuse ?? 0)),
      extraArgs: val(m.ui_extra_args, '')
    }
  };

  $('#dName').textContent = m.name || m.id;
  $('#dPath').textContent = m.model;
  $('#dVisionWrap').style.display = m.hasMmproj ? '' : 'none';
  $('#dMtpWrap').style.display = m.hasMtp ? '' : 'none';
  $('#dDraftNWrap').style.display = m.hasMtp ? '' : 'none';
  $('#dErr').textContent = '';

  const L = state.draft.L;
  $('#dCache').value = L.cache;
  $('#dVision').value = String(L.vision);
  $('#dMtp').value = L.mtp ? '1' : '0';
  $('#dDraftN').value = L.draftN;
  $('#dNgl').value = L.gpuLayers;
  $('#dBatch').value = L.batch;
  $('#dUbatch').value = L.ubatch;
  $('#dCram').value = L.cacheRam;
  $('#dReuse').value = L.cacheReuse;
  $('#dExtra').value = L.extraArgs || '';

  // echantillonnage : un champ vide veut dire « laisse le moteur decider »
  const ech = m.sampling || {};
  const met = (sel, v) => { $(sel).value = (v === undefined || v === null || v === '') ? '' : v; };
  met('#dTemp', ech.temp); met('#dTopP', ech.top_p); met('#dTopK', ech.top_k);
  met('#dMinP', ech.min_p); met('#dPres', ech.presence_penalty); met('#dRep', ech.repeat_penalty);
  met('#dSamplers', ech.samplers);

  // reflexion
  const th = m.thinking || {};
  $('#dThinkMode').value = th.mode || '';
  met('#dThinkBudget', th.budget);
  $('#dThinkFormat').value = th.format && th.format !== 'auto' ? th.format : '';
  $('#dThinkKwargs').value = th.kwargs
    ? Object.entries(th.kwargs).map(([k, v]) => k + '=' + v).join(', ') : '';
  $('#dThinkPreserve').checked = th.preserve === true;
  syncEchSum();
  syncThinkSum();
  $('#dSlots').value = Math.min(16, L.slots);

  const native = Number(m.native_ctx) || 32768;
  $('#dPresets').innerHTML = [
    ['SOLO', 1, native], ['DUO', 2, native / 2], ['SQUAD', 4, native / 4],
    ['SWARM', 8, native / 8], ['HIVE', 16, native / 16], ['MINI', 4, 8192]
  ].map(([n, s, c]) =>
    `<button class="preset" data-s="${s}" data-c="${Math.round(c)}"><b>${n}</b><span>${s} × ${ctxLabel(Math.round(c))}</span></button>`
  ).join('');

  const other = state.status.running && state.status.modelId !== id;
  $('#dLaunch').textContent = other ? 'Remplacer le modele en service' : 'Lancer le modele';
  $('#dSwap').hidden = !other;
  if (other) $('#dSwap').textContent = `« ${state.status.modelName} » sera arrete d'abord, les conversations en cours seront coupees.`;

  $('#drawerBack').hidden = false;
  $('#drawer').hidden = false;
  syncDrawer();
  $('#dSlots').focus();
}

function closeDrawer() {
  $('#drawerBack').hidden = true;
  $('#drawer').hidden = true;
  state.draft = null;
}

function nearestStep(v) {
  if (v === -1) return 0;
  let best = 1;
  CTX_STEPS.forEach((s, i) => {
    if (i === 0) return;                              // la position auto ne s'approche pas
    if (Math.abs(s - v) < Math.abs(CTX_STEPS[best] - v)) best = i;
  });
  return best;
}

/* Meme raisonnement que le serveur : dspark impose l'omission de -c, et -1
 * est le choix explicite de laisser llama.cpp decider. */
function ctxReason(m, L) {
  if (L.mtp && m.hasMtp && m.spec_type === 'draft-dspark') return 'dspark';
  if (L.ctxSlot === -1) return 'auto';
  return '';
}

function syncDrawer() {
  if (!state.draft) return;
  const { model: m, L } = state.draft;
  const reason = ctxReason(m, L);
  const noCtx = !!reason;
  const e = estimate(m, L);

  // en dspark le choix est impose, on verrouille ; en -1 il reste modifiable
  $('#dCtx').disabled = reason === 'dspark';
  $('#dCtxNum').disabled = reason === 'dspark';
  $('#ctxField').classList.toggle('off', noCtx);

  $('#dSlotsVal').textContent = L.slots;
  $('#dCtxVal').textContent = L.ctxSlot === -1 ? 'automatique' : nf.format(L.ctxSlot) + ' tokens';
  $('#dCtx').max = String(CTX_STEPS.length - 1);
  $('#dCtx').value = String(nearestStep(L.ctxSlot));
  if (document.activeElement !== $('#dCtxNum')) $('#dCtxNum').value = L.ctxSlot;
  $('#dCtxTotal').textContent = noCtx
    ? 'fixe par llama.cpp'
    : 'contexte total ' + nf.format(e.ctxTotal) + ' tokens';

  $('#dRope').innerHTML =
    reason === 'dspark'
      ? '<b>Le draft dspark impose son contexte.</b> Avec <code>-c</code>, llama.cpp alloue le contexte en double et le chargement echoue : le drapeau ne sera donc pas transmis. Coupe le draft plus bas si tu veux reprendre la main dessus.'
    : reason === 'auto'
      ? '<b>Contexte automatique.</b> <code>-c</code> ne sera pas transmis, llama.cpp prend le contexte natif du modele. Tu ne regles plus que le nombre d\'agents. Remets une valeur pour reprendre la main.'
    : e.rope > 1
      ? `Au-dela de la fenetre native (${ctxLabel(m.native_ctx)}) : yarn ×${e.rope} sera applique, la qualite baisse un peu. Mets <code>-1</code> pour laisser llama.cpp decider.`
      : `Dans la fenetre native du modele (${ctxLabel(m.native_ctx)}), aucun etirement necessaire. Mets <code>-1</code> pour laisser llama.cpp decider.`;

  $$('#dPresets .preset').forEach(b =>
    b.classList.toggle('on', +b.dataset.s === L.slots && +b.dataset.c === L.ctxSlot));

  // Le denominateur est la VRAM disponible : les segments representent une
  // part de ce qu'on peut reellement occuper, pas une part du total estime.
  const denom = Math.max(e.total, e.usable, 1);
  const pc = v => Math.max(0, Math.min(100, v / denom * 100)) + '%';
  $('#eW').style.width  = pc(e.weights);
  $('#eKv').style.width = pc(e.kv);
  $('#eC').style.width  = pc(e.compute);
  // part hachuree : le cache KV qu'on ne sait pas chiffrer
  $('#eU').style.width  = noCtx ? pc(Math.max(0, e.usable - e.total)) : '0%';

  $('#eTotal').innerHTML = noCtx
    ? `${mb(e.total)} <span class="plus">+ cache KV</span> / ${mb(e.usable)}`
    : `${mb(e.total)} / ${mb(e.usable)}`;
  $('#eWv').textContent  = mb(e.weights);
  $('#eKvv').textContent = noCtx ? 'non chiffrable' : mb(e.kv);
  $('#eCv').textContent  = mb(e.compute);

  const warn = $('#eWarn');
  if (e.over > 0) {
    const levers = [];
    if (L.vision === 1 && m.mmprojMb) levers.push(`passer la vision sur CPU libere ${mb(m.mmprojMb)}`);
    if (L.mtp && m.draftMb) levers.push(`couper le draft libere ${mb(m.draftMb)}`);
    if (!noCtx) levers.push('reduire le contexte ou le nombre d\'agents');
    else levers.push('reduire le nombre d\'agents');
    warn.className = 'warn';
    warn.innerHTML = noCtx
      ? `<b>Les poids seuls depassent de ${mb(e.over)}.</b> Le cache KV viendra en plus.<br>${levers.join(' · ')}.`
      : `<b>Depassement de ${mb(e.over)}.</b> Le modele debordera en RAM, ou CUDA echouera.<br>${levers.join(' · ')}.`;
    warn.hidden = false;
  } else if (noCtx) {
    // pas de depassement calculable : on le dit, plutot que d'afficher un
    // total rassurant qui ignore le plus gros poste
    warn.className = 'warn info';
    warn.innerHTML = `<b>Total hors cache KV.</b> C'est llama.cpp qui fixe le contexte au chargement, `
      + `la taille du cache n'est donc pas previsible ici : la VRAM reellement occupee sera plus elevee. `
      + `Le contexte obtenu s'affiche sur la page Serveur des que le modele est charge.`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }

  const flags = [
    noCtx ? '' : `-c ${e.ctxTotal}`,
    `-np ${L.slots}`, `-ngl ${L.gpuLayers}`,
    `-b ${L.batch}`, `-ub ${L.ubatch}`,
    `--cache-type-k ${L.cache} --cache-type-v ${L.cache}`,
    L.vision === 0 ? '--no-mmproj' : '',
    L.vision === 1 && m.mmproj ? '--mmproj ...' : '',
    L.vision === 2 && m.mmproj ? '--mmproj ... --no-mmproj-offload' : '',
    L.mtp && m.draft ? `--model-draft ... --spec-type ${m.spec_type} --spec-draft-n-max ${L.draftN}` : '',
    !noCtx && e.rope > 1 ? `--rope-scaling yarn --rope-scale ${e.rope}` : '',
    `--cache-ram ${L.cacheRam}`,
    L.cacheRam > 0 && L.cacheReuse > 0 ? `--cache-reuse ${L.cacheReuse}` : '',
    (() => {
      const t = lireThink();
      return [t.mode ? '--reasoning ' + t.mode : '',
        t.budget !== undefined ? '--reasoning-budget ' + t.budget : '',
        t.format ? '--reasoning-format ' + t.format : '',
        t.kwargs ? "--chat-template-kwargs '" + JSON.stringify(t.kwargs) + "'" : ''
      ].filter(Boolean).join(' ');
    })(),
    '--flash-attn on --jinja --slots --metrics',
    L.extraArgs || m.extra_args || ''
  ].filter(Boolean).join(' ');
  $('#dCmd').textContent = 'llama-server.exe -m "' + m.model + '" ' + flags;

  // ---- ce que le cache de prompt represente pour CE modele ----
  // un etat garde pese le contexte d'un agent : kv_kb_token x tokens
  const kvKo = Number(m.kv_kb_token) || 20;
  const parEtat = noCtx
    ? (Number(m.native_ctx) || 32768) * kvKo / 1024
    : L.ctxSlot * kvKo / 1024;
  const etats = parEtat > 0 ? L.cacheRam / parEtat : 0;
  $('#dCacheWhy').innerHTML = L.cacheRam === 0
    ? '<b>Cache de prompt coupe.</b> Un agent qui change de conversation perd son etat : le prompt suivant sera reprofile en entier.'
    : `<b>${mb(L.cacheRam)} de RAM systeme</b> (pas de VRAM). Un etat garde pese `
      + `${mb(parEtat)} avec ce reglage, soit <b>${etats < 1 ? 'moins d\'un' : Math.floor(etats)}</b> `
      + `etat${etats >= 2 ? 's' : ''} en reserve. Ca ne rend pas la generation plus rapide : `
      + 'ca evite de recalculer un prompt deja vu quand un agent revient dessus.'
      + (L.cacheReuse > 0
        ? ` La reutilisation par morceaux est active a partir de ${L.cacheReuse} tokens : llama.cpp `
          + 'recuperera aussi ce qui suit une divergence au milieu du prompt, par decalage du KV. '
          + '<b>A verifier modele par modele</b> - tous ne supportent pas ce decalage.'
        : ' La reutilisation par morceaux est inactive (0).');
}

/* Resume de l'echantillonnage dans le titre du bloc replie : sans ca, il faut
 * l'ouvrir pour savoir si le modele a des valeurs ou non. */
function lireEch() {
  const n = sel => {
    const v = $(sel).value.trim();
    return v === '' ? undefined : Number(v);
  };
  const s = {
    temp: n('#dTemp'), top_p: n('#dTopP'), top_k: n('#dTopK'), min_p: n('#dMinP'),
    presence_penalty: n('#dPres'), repeat_penalty: n('#dRep')
  };
  const ord = $('#dSamplers').value.trim();
  if (ord) s.samplers = ord;
  for (const k of Object.keys(s)) if (s[k] === undefined || Number.isNaN(s[k])) delete s[k];
  return s;
}
function syncEchSum() {
  const s = lireEch();
  $('#dEchSum').textContent = s.temp !== undefined
    ? '· temp ' + s.temp + (s.top_p !== undefined ? ' · top_p ' + s.top_p : '')
      + (s.top_k !== undefined ? ' · top_k ' + s.top_k : '')
    : '· valeurs du moteur';
}
['#dTemp', '#dTopP', '#dTopK', '#dMinP', '#dPres', '#dRep', '#dSamplers'].forEach(sel => {
  $(sel).addEventListener('input', syncEchSum);
});

/* Les variables du gabarit s'ecrivent « cle=valeur, cle=valeur » : plus lisible
 * que du JSON a taper a la main, et on accepte le JSON quand meme. */
function lireKwargs() {
  const t = $('#dThinkKwargs').value.trim();
  if (!t) return null;
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch { return null; } }
  const o = {};
  for (const part of t.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (v === 'true') v = true; else if (v === 'false') v = false;
    else if (v !== '' && !Number.isNaN(Number(v))) v = Number(v);
    if (k) o[k] = v;
  }
  return Object.keys(o).length ? o : null;
}

function lireThink() {
  const t = {};
  const mode = $('#dThinkMode').value;
  if (mode) t.mode = mode;
  const b = $('#dThinkBudget').value.trim();
  if (b !== '' && Number.isFinite(Number(b))) t.budget = Math.round(Number(b));
  const f = $('#dThinkFormat').value;
  if (f) t.format = f;
  if ($('#dThinkPreserve').checked) t.preserve = true;
  const k = lireKwargs();
  if (k) t.kwargs = k;
  // Les niveaux ne se saisissent pas ici : ils viennent du catalogue. Les
  // oublier a l'enregistrement les effacerait, et avec eux les variantes
  // « ...:low » que les clients utilisent pour choisir.
  const anciens = state.draft && state.draft.model && state.draft.model.thinking;
  if (anciens && Array.isArray(anciens.levels) && anciens.levels.length) t.levels = anciens.levels;
  return t;
}

/* Les niveaux declares par le modele, en boutons : plus personne n'a a se
 * souvenir qu'on ecrit « xhigh » et pas « very high ». */
function renderNiveaux() {
  const m = state.draft && state.draft.model;
  const niveaux = (m && m.thinking && m.thinking.levels) || [];
  const zone = $('#dThinkLevels');
  if (!niveaux.length) {
    zone.innerHTML = '';
    zone.hidden = true;
    return;
  }
  zone.hidden = false;
  const actuel = lireKwargs() || {};
  zone.innerHTML = '<span class="lbl">niveaux offerts</span>'
    + niveaux.map(n => {
      const pareil = Object.entries(n.kwargs)
        .every(([k, v]) => String(actuel[k]) === String(v));
      return `<button class="mini ${pareil ? 'on' : ''}" data-niveau="${esc(n.name)}">${esc(n.label || n.name)}</button>`;
    }).join('')
    + '<span class="hint">choisis le defaut ; les clients, eux, ajoutent <code class="mono">:'
    + esc(niveaux[0].name) + '</code> au nom du modele</span>';
}

$('#dThinkLevels').addEventListener('click', e => {
  const b = e.target.closest('button[data-niveau]');
  if (!b) return;
  const m = state.draft && state.draft.model;
  const n = ((m && m.thinking && m.thinking.levels) || []).find(x => x.name === b.dataset.niveau);
  if (!n) return;
  $('#dThinkKwargs').value = Object.entries(n.kwargs).map(([k, v]) => k + '=' + v).join(', ');
  syncThinkSum();
});

function syncThinkSum() {
  const t = lireThink();
  const bouts = [];
  if (t.mode) bouts.push(t.mode);
  if (t.budget !== undefined) bouts.push(t.budget === 0 ? 'coupee' : t.budget === -1 ? 'illimitee' : t.budget + ' tokens');
  if (t.kwargs) bouts.push(Object.entries(t.kwargs).map(([k, v]) => k + '=' + v).join(' '));
  $('#dThinkSum').textContent = bouts.length ? '· ' + bouts.join(' · ') : '· defaut du modele';
  renderNiveaux();

  const m = state.draft && state.draft.model;
  const nom = (m && (m.name || m.id) || '').toLowerCase();
  $('#dThinkWhy').innerHTML = /muse|glimmer/.test(nom)
    ? '<b>Muse Glimmer ouvre sa reflexion sans condition</b> : <code>--reasoning off</code> n\'a aucun effet sur lui. Ce qui se regle, c\'est la force — <code>reasoning_strength=low</code>, <code>medium</code>, <code>high</code> ou <code>xhigh</code> (defaut high). Le budget, lui, marche toujours : <code>0</code> coupe net.'
    : /qwen3\.6|bonsai|kat-coder/.test(nom)
      ? 'Qwen3.6 comprend <code>enable_thinking=false</code> pour couper la reflexion, et <code>true</code> pour l\'imposer. Pour le code, ses auteurs recommandent de la garder avec temperature 0.6.'
      : 'Les variables dependent du gabarit du modele. Les plus courantes : <code>enable_thinking=false</code>, <code>reasoning_strength=high</code>. Le <b>budget</b>, lui, marche partout : <code>0</code> coupe la reflexion meme quand le mode reste sans effet.';
}

['#dThinkMode', '#dThinkBudget', '#dThinkFormat', '#dThinkKwargs'].forEach(sel => {
  $(sel).addEventListener('input', syncThinkSum);
  $(sel).addEventListener('change', syncThinkSum);
});

$('#dSlots').addEventListener('input', e => { state.draft.L.slots = +e.target.value; syncDrawer(); });
$('#dCtx').addEventListener('input', e => { state.draft.L.ctxSlot = CTX_STEPS[+e.target.value]; syncDrawer(); });
$('#dCtxNum').addEventListener('change', e => {
  const n = parseInt(e.target.value, 10);
  // -1 ou toute valeur negative : contexte automatique
  state.draft.L.ctxSlot = (Number.isFinite(n) && n < 0) ? -1 : Math.max(512, n || 512);
  syncDrawer();
});
$('#dPresets').addEventListener('click', e => {
  const b = e.target.closest('.preset');
  if (!b) return;
  state.draft.L.slots = +b.dataset.s;
  state.draft.L.ctxSlot = +b.dataset.c;
  $('#dSlots').value = Math.min(16, state.draft.L.slots);
  syncDrawer();
});
[['#dCache', 'cache', String], ['#dVision', 'vision', Number], ['#dMtp', 'mtp', v => v === '1'],
 ['#dDraftN', 'draftN', Number], ['#dNgl', 'gpuLayers', Number], ['#dBatch', 'batch', Number],
 ['#dUbatch', 'ubatch', Number], ['#dCram', 'cacheRam', Number],
 ['#dReuse', 'cacheReuse', Number], ['#dExtra', 'extraArgs', String]
].forEach(([sel, key, cast]) => {
  $(sel).addEventListener('input', e => { state.draft.L[key] = cast(e.target.value); syncDrawer(); });
});

/* Enregistre TOUT le panneau dans models.json, pour ne rien avoir a refaire au
 * prochain lancement.
 *   slots / ctx / cache / spec_n : cles que le .bat lit deja, il en profite
 *   ctx_auto, vision_mode, draft_on, gpu_layers, batch, ubatch, ui_extra_args :
 *     cles qu'il ignore, elles ne servent qu'a la console
 * Le .bat calcule ctx x agents : on n'y ecrit donc jamais -1, la valeur
 * numerique precedente est conservee et l'automatique va dans ctx_auto.
 * extra_args reste intact : c'est le champ du .bat, pas celui du tiroir. */
$('#dSaveDefault').addEventListener('click', async () => {
  const { model, L } = state.draft;
  const auto = L.ctxSlot === -1;
  const btn = $('#dSaveDefault');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'enregistrement...';
  try {
    const r = await api('/models', 'PUT', {
      id: model.id,
      model: {
        slots: L.slots,
        ctx: auto ? (model.ctx || 32768) : L.ctxSlot,
        ctx_auto: auto,
        cache: L.cache,
        vision_mode: L.vision,
        draft_on: L.mtp,
        spec_n: L.draftN,
        gpu_layers: L.gpuLayers,
        batch: L.batch,
        ubatch: L.ubatch,
        cache_ram_mb: L.cacheRam,
        cache_reuse: L.cacheReuse,
        sampling: lireEch(),
        thinking: lireThink(),
        ui_extra_args: L.extraArgs || ''
      }
    });
    state.models = r.models;
    state.draft.model = r.models.find(x => x.id === model.id) || model;
    renderModels();
    $('#dErr').textContent = '';
    toast(auto
      ? 'Reglages enregistres. Contexte automatique retenu ; le .bat, lui, gardera l\'ancienne valeur.'
      : 'Reglages enregistres : ils seront repris a la prochaine ouverture.');
  } catch (e) {
    // la ligne du tiroir garde l'erreur sous les yeux, le toast s'efface
    $('#dErr').textContent = 'Echec : ' + e.message;
    toast('Echec de l\'enregistrement : ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('#dClose').addEventListener('click', closeDrawer);
$('#drawerBack').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#confirmBack').hidden) closeConfirm(false);
  else if (!$('#modalBack').hidden) closeModal();
  else if (!$('#drawer').hidden) closeDrawer();
});

$('#dLaunch').addEventListener('click', async () => {
  const { model, L } = state.draft;
  const btn = $('#dLaunch');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Lancement...';
  try {
    await api('/launch', 'POST', Object.assign({ id: model.id, replace: true }, L));
    closeDrawer();
    go('server');
    toast('Chargement du modele, suis le journal.');
  } catch (err) {
    $('#dErr').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

// --------------------------------------------------------------------------
// page serveur
// --------------------------------------------------------------------------
function renderServer() {
  const st = state.status, m = st.metrics || {}, L = st.launch || {};
  const slots = st.slots || [];
  const busy = slots.filter(s => s.busy).length;

  $('#btnStop').disabled = !st.running;
  $('#btnRestart').disabled = !state.config.lastLaunch;

  const cards = [];
  cards.push(card('etat', st.running ? (st.ready ? 'en service' : 'chargement') : 'arrete',
    '', st.running ? 'pid ' + st.pid + ' · ' + dur(st.uptime || 0) : (st.exitCode != null ? 'dernier code ' + st.exitCode : 'aucun processus'),
    st.running && st.ready ? 'good' : st.running ? 'warn' : ''));
  cards.push(card('agents occupes', slots.length ? `${busy}/${slots.length}` : '--', '',
    L.ctxSlot ? nf.format(L.ctxSlot) + ' tokens chacun' : '', busy && busy === slots.length ? 'warn' : ''));
  cards.push(L.noCtx
    ? card('contexte total', slots.length && slots[0].nCtx ? ctxLabel(slots[0].nCtx * slots.length) : 'auto', '',
        L.ctxReason === 'dspark' ? 'fixe par llama.cpp, draft dspark' : 'fixe par llama.cpp, reglage -1')
    : card('contexte total', L.ctxTotal ? ctxLabel(L.ctxTotal) : '--', '',
        L.rope > 1 ? 'yarn ×' + L.rope : 'fenetre native'));
  // certains builds n'exposent pas kv_cache_usage_ratio : on le deduit des agents
  let kvPct = m.kv_cache_usage_ratio != null ? m.kv_cache_usage_ratio * 100 : null;
  if (kvPct == null && slots.length) {
    const used = slots.reduce((a, s) => a + (s.nPast || 0), 0);
    const cap = slots.reduce((a, s) => a + (s.nCtx || 0), 0);
    if (cap) kvPct = used / cap * 100;
  }
  if (st.running && st.idleUnloadMin) {
    const left = st.idleUnloadMin * 60000 - (st.idleMs || 0);
    const active = busy || st.inFlight;
    cards.push(card('liberation auto',
      active ? 'en travail' : left > 0 ? dur(left) : 'imminente', '',
      `apres ${st.idleUnloadMin} min sans requete`,
      active ? '' : left < 60000 ? 'warn' : ''));
  }
  cards.push(card('cache KV', L.cache || '--', '',
    kvPct != null ? Math.round(kvPct) + ' % rempli' : ''));
  cards.push(card('generation', m.predicted_tokens_seconds ? m.predicted_tokens_seconds.toFixed(1) : '--', 'tok/s',
    m.prompt_tokens_seconds ? 'prompt ' + Math.round(m.prompt_tokens_seconds) + ' tok/s' : ''));
  cards.push(card('tokens generes', m.tokens_predicted_total != null ? tok(m.tokens_predicted_total) : '--', '',
    m.n_decode_total ? nf.format(m.n_decode_total) + ' decodages' : ''));
  if (L.mtp && m.spec_decode_num_draft_tokens_total) {
    const acc = m.spec_decode_num_accepted_tokens_total / m.spec_decode_num_draft_tokens_total * 100;
    cards.push(card('draft accepte', Math.round(acc), '%',
      nf.format(m.spec_decode_num_drafts_total || 0) + ' brouillons',
      acc >= 60 ? 'good' : acc >= 35 ? 'warn' : 'bad'));
  }
  $('#serverCards').innerHTML = cards.join('');

  $('#slotsHint').textContent = slots.length ? `${busy} occupe(s) sur ${slots.length}` : '--';
  $('#slotGrid').innerHTML = slots.length
    ? slots.map(s => {
        const pct = s.nCtx ? Math.min(100, Math.round((s.nPast || 0) / s.nCtx * 100)) : 0;
        return `<div class="slot ${s.busy ? 'busy' : ''}">
          <div class="n">agent ${s.id}</div>
          <div class="st">${s.busy ? 'en cours' : 'libre'}</div>
          <div class="fill"><i style="width:${pct}%"></i></div>
        </div>`;
      }).join('')
    : '<p class="empty">Aucun agent : le serveur est a l\'arret.</p>';
}

function card(k, v, u, s, cls) {
  return `<div class="stat ${cls || ''}"><div class="k">${esc(k)}</div>
    <div class="v">${esc(v)}${u ? `<span class="u">${esc(u)}</span>` : ''}</div>
    ${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`;
}

const logView = $('#logView');
function appendLog(entry) {
  const cls = entry.s === 'err' ? 'l-err' : entry.s === 'sys' ? 'l-sys' : '';
  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = `<span class="t">${hhmm(entry.t)}</span>${esc(entry.m)}`;
  logView.appendChild(div);
  while (logView.childElementCount > 1200) logView.removeChild(logView.firstChild);
  if ($('#autoScroll').checked) logView.scrollTop = logView.scrollHeight;
}

$('#btnStop').addEventListener('click', async () => {
  await api('/stop', 'POST');
  toast('Serveur arrete.');
});
$('#btnRestart').addEventListener('click', async () => {
  try { await api('/restart', 'POST'); toast('Relancement en cours.'); }
  catch (e) { toast(e.message, true); }
});
$('#copyCmd').addEventListener('click', () => copy(state.status.cmdline || '', 'Commande'));

// --------------------------------------------------------------------------
// page cles
// --------------------------------------------------------------------------
/* Toutes les adresses par lesquelles la passerelle repond vraiment, de la plus
 * lointaine a la plus proche. Tailscale apparait des qu'il est connecte : son
 * reseau 100.x est traite comme un reseau prive, il n'a pas besoin de
 * l'interrupteur d'acces distant. */
function addresses() {
  const out = [];
  const r = state.config.remote || {};
  const port = state.config.port || location.port;

  if (r.enabled && r.method === 'cloudflare' && state.tunnel && state.tunnel.url) {
    out.push({ kind: 'tunnel public', url: state.tunnel.url, far: true });
  }
  if (r.enabled && r.method === 'manual' && r.publicUrl) {
    out.push({ kind: 'adresse publique', url: r.publicUrl, far: true });
  }
  const ts = state.tailscale || {};
  if (ts.running && ts.ip) {
    out.push({ kind: 'tailscale', url: `http://${ts.ip}:${port}`, far: true });
  }
  const lan = (state.lan || []).find(a => !/^169\.254\./.test(a.address)) || (state.lan || [])[0];
  out.push({ kind: 'reseau local', url: `http://${lan ? lan.address : location.hostname}:${port}` });
  return out;
}

/* Celle a mettre dans les exemples : la plus utile de la liste. */
function baseUrl() { return addresses()[0].url; }

function renderAddresses() {
  const list = addresses();
  $('#addrBlock').innerHTML = '<span class="lbl">adresses a partager</span>' + list.map((a, i) => `
    <div class="addr ${a.far ? 'far' : ''}">
      <span class="addr-kind">${esc(a.kind)}${i === 0 && list.length > 1 ? ' · recommandee' : ''}</span>
      <code class="mono">${esc(a.url)}/v1</code>
      <button class="mini" data-url="${esc(a.url)}/v1">copier</button>
    </div>`).join('');
}

$('#addrBlock').addEventListener('click', e => {
  const b = e.target.closest('button[data-url]');
  if (b) copy(b.dataset.url, 'Adresse');
});

/* opencode calcule la depense lui-meme, a partir du bloc "cost" de sa propre
 * configuration : il ne lit pas le usage.cost que renvoie la passerelle. Sans
 * ce bloc il affiche 0, quoi qu'on lui envoie. On genere donc la configuration
 * complete, tarifs de models.json compris. */
function opencodeSnippet(url, key) {
  const models = {};
  for (const m of state.models) {
    const p = m.price || {};
    const e = {
      name: m.name || m.id,
      // cache_read : opencode sait facturer a part les tokens relus du cache,
      // et la passerelle les compte au meme tarif
      cost: { input: p.in ?? 0, output: p.out ?? 0, cache_read: p.cache ?? 0 },
      limit: { context: Number(m.native_ctx) || 32768, output: 8192 }
    };
    if (m.hasMmproj) e.modalities = { input: ['text', 'image'], output: ['text'] };
    models[m.id] = e;
  }
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      llamacpp: {
        npm: '@ai-sdk/openai-compatible',
        name: 'llama.cpp maison',
        options: { baseURL: url, apiKey: key },
        models
      }
    }
  };
  return '// ~/.config/opencode/opencode.json\n'
    + '//\n'
    + '// "cost" est en unites par million de tokens. Sans ce bloc, opencode\n'
    + '// affiche 0 : il calcule la depense lui-meme et ne lit pas le champ\n'
    + '// usage.cost renvoye par la passerelle.\n'
    + '//\n'
    + '// "cache_read" est le tarif des tokens relus du cache - le gros d\'une\n'
    + '// conversation qui grandit. Sans lui, opencode surestime largement.\n'
    + '//\n'
    + '// La passerelle sert toujours le modele reellement charge, quel que\n'
    + '// soit le nom demande : choisis dans opencode celui qui correspond,\n'
    + '// sinon le prix affiche sera celui d\'un autre modele.\n\n'
    + JSON.stringify(cfg, null, 2);
}

/* Un quota journalier repart a minuit, une enveloppe non : les deux ne
 * meritent pas la meme etiquette. */
function blockedTag(b) {
  return b.status === 429
    ? '<span class="tag quota">quota du jour atteint</span>'
    : '<span class="tag gone">epuisee</span>';
}

/* Etat de l'enveloppe d'une cle, en une ligne. */
function keyBalance(k) {
  const s = k.status || {};
  const L = s.limits || {};
  const tot = s.total || { cost: k.cost || 0 };
  if (!L.credit) return { text: 'sans plafond', sub: money(tot.cost) + ' consommes', pct: null };
  const left = Math.max(0, L.credit - tot.cost);
  return {
    text: money(left) + ' restants',
    sub: money(tot.cost) + ' / ' + money(L.credit),
    pct: Math.min(100, tot.cost / L.credit * 100)
  };
}

/* Ce qu'un role autorise, dit en clair : c'est la seule chose qui distingue
 * deux cles a l'oeil, autant qu'elle se lise. */
const ROLE_INFO = {
  user:    { nom: 'utilisateur',   quoi: 'se sert du modele charge' },
  trusted: { nom: 'de confiance',  quoi: 'peut charger, remplacer, arreter, regler' },
  admin:   { nom: 'administrateur', quoi: 'tout, deport hors GPU compris' }
};
const ROLE_COURT = { user: 'simple', trusted: 'confiance', admin: 'admin' };
function roleTag(k, court) {
  const r = ROLE_INFO[k.role] ? k.role : 'user';
  const txt = court ? ROLE_COURT[r] : ROLE_INFO[r].nom;
  return `<span class="tag role ${r}" title="${esc(ROLE_INFO[r].nom + ' - ' + ROLE_INFO[r].quoi)}">${esc(txt)}</span>`;
}

function renderKeys() {
  renderAddresses();

  const example = state.keys.find(k => !k.disabled);
  const vraieCle = example ? example.key : 'sk-llama-...';
  // Une cle en clair a l'ecran, c'est une cle sur la prochaine capture d'ecran
  // ou dans le dos de celui qui passe. On la masque ; le bouton copier prend
  // la vraie, c'est lui qui sert.
  const key = state.showKey || !example
    ? vraieCle
    : vraieCle.slice(0, 12) + '•'.repeat(18);
  const url = baseUrl() + '/v1';
  const model = state.status.modelId || 'nom-du-modele';

  const snippets = {
    url: `Adresse de base   ${url}\nCle API           ${key}\nModele            ${model}\n\nA coller dans LM Studio, Open WebUI, Cherry Studio, Chatbox,\nCline, Continue... partout ou on peut choisir "OpenAI compatible".`,
    opencode: opencodeSnippet(url, key),
    curl: `curl ${url}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '{\n    "model": "${model}",\n    "messages": [{"role": "user", "content": "Bonjour"}]\n  }'`,
    py: `from openai import OpenAI\n\nclient = OpenAI(base_url="${url}", api_key="${key}")\n\nr = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Bonjour"}],\n)\nprint(r.choices[0].message.content)`,
    js: `const r = await fetch("${url}/chat/completions", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",\n    Authorization: "Bearer ${key}",\n  },\n  body: JSON.stringify({\n    model: "${model}",\n    messages: [{ role: "user", content: "Bonjour" }],\n  }),\n});\nconsole.log((await r.json()).choices[0].message.content);`
  };
  $('#connectSnippet').textContent = snippets[state.snippetTab];
  $('#revealKey').textContent = state.showKey ? 'masquer la cle' : 'montrer la cle';
  $('#revealKey').disabled = !example;
  state.snippetsReels = example
    ? Object.fromEntries(Object.entries(snippets).map(([k, v]) =>
        [k, v.split(key).join(vraieCle)]))
    : snippets;

  $('#keyList').innerHTML = state.keys.length ? state.keys.map(k => {
    const bal = keyBalance(k);
    const s = k.status || {};
    const L = s.limits || {};
    const quotas = [
      L.reqPerDay ? L.reqPerDay + ' req/jour' : '',
      L.tokensPerDay ? tok(L.tokensPerDay) + ' tokens/jour' : '',
      L.costPerDay ? money(L.costPerDay) + '/jour' : '',
      L.tokensTotal ? tok(L.tokensTotal) + ' tokens au total' : ''
    ].filter(Boolean).join(' · ') || 'aucun plafond journalier';
    return `
    <article class="key-row ${k.disabled ? 'off' : ''}" data-id="${k.id}">
      <div>
        <div class="key-name">${esc(k.name)}
          ${roleTag(k)}
          ${k.disabled ? '<span class="tag gone">desactivee</span>' : ''}
          ${s.blocked && !k.disabled ? blockedTag(s.blocked) : ''}
        </div>
        <div class="key-val">
          <code data-full="${esc(k.key)}">${esc(k.key.slice(0, 12))}${'•'.repeat(14)}</code>
          <button class="mini" data-act="reveal">voir</button>
          <button class="mini" data-act="copy">copier</button>
        </div>
        <div class="key-bal">
          <b class="${bal.pct >= 100 ? 'ko' : ''}">${bal.text}</b>
          ${bal.pct != null ? `<span class="meter thin"><i style="width:${bal.pct}%" class="${bal.pct >= 100 ? 'full' : bal.pct >= 80 ? 'high' : ''}"></i></span>` : ''}
          <span class="hint">${bal.sub}</span>
        </div>
        <div class="key-meta">
          <span>requetes <b>${nf.format(k.requests)}</b></span>
          <span>tokens generes <b>${tok(k.tokensOut)}</b></span>
          <span>aujourd'hui <b>${nf.format((s.today || {}).requests || 0)} req · ${money((s.today || {}).cost || 0)}</b></span>
          <span>limites <b>${esc(quotas)}</b></span>
          <span>hors reseau <b>${k.remoteAllowed === false ? 'non' : 'oui'}</b></span>
          <span>derniere utilisation <b>${esc(ago(k.lastUsed))}</b></span>
          ${k.lastIp ? `<span>depuis <b>${esc(k.lastIp)}</b></span>` : ''}
        </div>
      </div>
      <div class="m-actions">
        <button class="mini" data-act="limits">droits et limites</button>
        <button class="mini" data-act="toggle">${k.disabled ? 'reactiver' : 'suspendre'}</button>
        <button class="mini" data-act="delete">supprimer</button>
      </div>
    </article>`;
  }).join('')
    : '<p class="empty">Aucune cle. Cree-en une par personne a qui tu ouvres l\'acces.</p>';
}

$('#keyList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = e.target.closest('.key-row');
  const k = state.keys.find(x => x.id === row.dataset.id);
  const act = btn.dataset.act;
  if (act === 'reveal') {
    const c = $('code', row);
    c.textContent = c.textContent.includes('•') ? k.key : k.key.slice(0, 12) + '•'.repeat(14);
    btn.textContent = c.textContent.includes('•') ? 'voir' : 'masquer';
    return;
  }
  if (act === 'copy') return copy(k.key, 'Cle');
  if (act === 'limits') return openKeyModal(k);
  if (act === 'toggle') {
    const r = await api('/keys', 'PATCH', { id: k.id, disabled: !k.disabled });
    state.keys = r.keys; renderKeys(); renderTop();
    toast(k.disabled ? 'Cle reactivee.' : 'Cle suspendue, effet immediat.');
  }
  if (act === 'delete') {
    if (!confirm(`Supprimer la cle "${k.name}" ? Les appareils qui l'utilisent perdront l'acces.`)) return;
    const r = await api('/keys', 'DELETE', { id: k.id });
    state.keys = r.keys; renderKeys(); renderTop();
    toast('Cle supprimee.');
  }
});

$('#connectTabs').addEventListener('click', e => {
  const t = e.target.closest('.tab');
  if (!t) return;
  state.snippetTab = t.dataset.t;
  $$('#connectTabs .tab').forEach(x => x.classList.toggle('on', x === t));
  renderKeys();
});
$('#revealKey').addEventListener('click', () => { state.showKey = !state.showKey; renderKeys(); });

/* On copie toujours l'extrait complet, cle comprise : masquer sert a proteger
 * l'ecran, pas a rendre le bouton inutile. */
$('#copySnippet').addEventListener('click', () => {
  const t = (state.snippetsReels || {})[state.snippetTab] || $('#connectSnippet').textContent;
  copy(t, state.showKey ? 'Extrait' : 'Extrait avec la cle en clair');
});

/* Petite boite de confirmation, rendue en promesse. */
let confirmResolve = null;
function askConfirm(title, bodyHtml, okLabel) {
  $('#confirmTitle').textContent = title;
  $('#confirmBody').innerHTML = bodyHtml;
  $('#confirmYes').textContent = okLabel || 'Confirmer';
  $('#confirmBack').hidden = false;
  $('#confirmNo').focus();
  return new Promise(res => { confirmResolve = res; });
}
function closeConfirm(v) {
  $('#confirmBack').hidden = true;
  if (confirmResolve) { confirmResolve(v); confirmResolve = null; }
}
$('#confirmYes').addEventListener('click', () => closeConfirm(true));
$('#confirmNo').addEventListener('click', () => closeConfirm(false));
$('#confirmBack').addEventListener('click', e => { if (e.target === $('#confirmBack')) closeConfirm(false); });

/* Modale des cles : la meme sert a creer et a regler les limites. Un champ
 * vide vaut zero, c'est-a-dire pas de limite. */
let editingKey = null;

function closeModal() { $('#modalBack').hidden = true; editingKey = null; }

function openKeyModal(k) {
  editingKey = k || null;
  const L = (k && k.limits) || {};
  const cur = (state.config.pricing || {}).currency === 'EUR' ? '€' : '$';
  $('#kCur').textContent = cur;
  $$('.kCur').forEach(x => { x.textContent = cur; });
  $('#modalTitle').textContent = k ? 'Cle « ' + k.name + ' »' : 'Creer une cle';
  const role = (k && ROLE_INFO[k.role]) ? k.role : 'user';
  $$('input[name="kRole"]').forEach(r => { r.checked = r.value === role; });
  $('#kCreate').textContent = k ? 'Enregistrer' : 'Creer';
  $('#kName').value = k ? k.name : '';
  $('#kCredit').value = L.credit || '';
  $('#kTokTotal').value = L.tokensTotal || '';
  $('#kReqDay').value = L.reqPerDay || '';
  $('#kTokDay').value = L.tokensPerDay || '';
  $('#kCostDay').value = L.costPerDay || '';
  $('#kRemote').checked = !k || k.remoteAllowed !== false;
  $('#kResetWrap').hidden = !k;
  $('#kReset').checked = false;
  $('#modalBack').hidden = false;
  $('#kName').focus();
}

function readModalLimits() {
  const n = sel => {
    const v = parseFloat($(sel).value);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  return {
    credit: n('#kCredit'),
    tokensTotal: Math.round(n('#kTokTotal')),
    reqPerDay: Math.round(n('#kReqDay')),
    tokensPerDay: Math.round(n('#kTokDay')),
    costPerDay: n('#kCostDay')
  };
}

$('#btnNewKey').addEventListener('click', () => openKeyModal(null));
$('#kCancel').addEventListener('click', closeModal);
$('#modalBack').addEventListener('click', e => { if (e.target === $('#modalBack')) closeModal(); });
$('#kCreate').addEventListener('click', async () => {
  const body = {
    name: $('#kName').value.trim() || 'Sans nom',
    role: ($$('input[name="kRole"]').find(r => r.checked) || {}).value || 'user',
    limits: readModalLimits(),
    remoteAllowed: $('#kRemote').checked
  };
  try {
    if (editingKey) {
      const r = await api('/keys', 'PATCH', Object.assign({ id: editingKey.id, resetUsage: $('#kReset').checked }, body));
      state.keys = r.keys;
      closeModal();
      renderKeys(); renderAdmin(); renderTop();
      toast('Limites enregistrees, effet immediat.');
    } else {
      const r = await api('/keys', 'POST', body);
      state.keys = r.keys;
      closeModal();
      renderKeys(); renderAdmin(); renderTop();
      copy(r.key.key, 'Nouvelle cle');
    }
  } catch (e) { toast(e.message, true); }
});

// --------------------------------------------------------------------------
// page activite
// --------------------------------------------------------------------------
async function loadActivity() {
  const r = await api('/activity');
  state.activity = r.items;
  state.stats = r.stats;
  renderActivity();
}

function renderActivity() {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push([d, state.stats[d] || { requests: 0, tokensIn: 0, tokensOut: 0 }]);
  }
  const max = Math.max(1, ...days.map(([, v]) => v.tokensOut));
  $('#chart').innerHTML = days.map(([d, v]) => `
    <div class="bar ${v.tokensOut ? '' : 'zero'}" title="${d} · ${nf.format(v.requests)} requetes · ${tok(v.tokensOut)} tokens">
      <i style="height:${Math.max(2, v.tokensOut / max * 100)}%"></i>
      <span>${d.slice(8)}</span>
    </div>`).join('');

  const today = state.stats[new Date().toISOString().slice(0, 10)] || { requests: 0, tokensIn: 0, tokensOut: 0 };
  const totals = Object.values(state.stats).reduce((a, v) => ({
    requests: a.requests + v.requests, tokensOut: a.tokensOut + v.tokensOut
  }), { requests: 0, tokensOut: 0 });
  const active = state.keys.filter(k => !k.disabled).length;
  const cost30 = Object.values(state.stats).reduce((a, v) => a + (v.cost || 0), 0);
  // part du prompt qui n'a pas eu besoin d'etre recalculee
  const cachePct = today.tokensIn
    ? Math.round((today.tokensCached || 0) / today.tokensIn * 100) : null;
  $('#activityCards').innerHTML = [
    card('requetes aujourd\'hui', nf.format(today.requests)),
    card('tokens generes aujourd\'hui', tok(today.tokensOut)),
    card('prompt relu du cache', cachePct == null ? '—' : cachePct + ' %',
      '', cachePct == null ? 'aucune requete aujourd\'hui'
        : tok(today.tokensCached || 0) + ' tokens sur ' + tok(today.tokensIn)),
    card('requetes sur 30 jours', nf.format(totals.requests)),
    `<div class="stat saving"><div class="k">aurait coute sur 30 jours</div><div class="v">${money(cost30)}</div><div class="s">tarifs du panneau Admin</div></div>`,
    card('cles actives', active + ' / ' + state.keys.length)
  ].join('');

  // Le journal garde des milliers de lignes : on n'en montre qu'une tranche,
  // choisie par les onglets. « tout » reste borne aux 300 dernieres, c'est ce
  // que le serveur envoie.
  const now = Date.now();
  const minuit = new Date().setHours(0, 0, 0, 0);
  const tranches = {
    30: l => l.slice(0, 30),
    hour: l => l.filter(x => now - x.at < 3600000),
    day: l => l.filter(x => x.at >= minuit),
    all: l => l
  };
  const vue = (tranches[state.actRange] || tranches[30])(state.activity);
  $('#actCount').textContent = state.activity.length
    ? vue.length + ' affichee' + (vue.length > 1 ? 's' : '') + ' sur ' + state.activity.length + ' gardees'
    : '';

  $('#activityTable tbody').innerHTML = vue.length
    ? vue.map(a => `<tr>
        <td class="mono">${hhmm(a.at)}</td>
        <td>${esc(a.keyName)}</td>
        <td class="mono">${esc(a.ip)}</td>
        <td class="mono">${esc(a.path)}</td>
        <td class="num" title="${a.tokensCached ? tok(a.tokensCached) + ' relus depuis le cache' : 'aucun token relu du cache'}">${tok(a.tokensIn)}${a.exact ? '' : '~'}${
          a.tokensCached ? ` <span class="cache-part">${Math.round(a.tokensCached / Math.max(1, a.tokensIn) * 100)}% ⤒</span>` : ''}</td>
        <td class="num">${tok(a.tokensOut)}${a.exact ? '' : '~'}</td>
        <td class="num cost">${a.cost != null ? money(a.cost) : '—'}</td>
        <td class="num">${a.ms < 1000 ? a.ms + ' ms' : (a.ms / 1000).toFixed(1) + ' s'}</td>
        <td class="num ${a.status < 400 ? 'ok' : 'ko'}">${a.status}${a.remote ? ' ↗' : ''}</td>
      </tr>`).join('')
    : `<tr><td colspan="9" class="empty">${state.activity.length
        ? 'Aucune requete sur cette periode.'
        : 'Aucune requete pour l\'instant.'}</td></tr>`;
}

$('#actRange').addEventListener('click', e => {
  const t = e.target.closest('.tab');
  if (!t) return;
  state.actRange = t.dataset.r;
  $$('#actRange .tab').forEach(x => x.classList.toggle('on', x === t));
  renderActivity();
});

$('#refreshActivity').addEventListener('click', loadActivity);

// --------------------------------------------------------------------------
// page admin
// --------------------------------------------------------------------------
/* Les montants sont minuscules : une requete coute des millioniemes d'euro.
 * On garde toujours deux chiffres significatifs plutot qu'un nombre fixe de
 * decimales, sinon 0,000012 s'affiche "0,00" et donne l'impression que le
 * tarif n'est pas pris en compte. */
function money(v) {
  const cur = (state.config.pricing || {}).currency === 'EUR' ? '€' : '$';
  const n = Math.abs(v || 0);
  const trim = x => x.includes('.') ? x.replace(/0+$/, '').replace(/\.$/, '') : x;
  let s;
  if (n === 0) s = '0';
  else if (n >= 100) s = Math.round(n).toString();
  else if (n >= 1) s = n.toFixed(2);
  else if (n >= 0.01) s = trim(n.toFixed(3));
  else s = trim(n.toFixed(Math.min(10, Math.ceil(-Math.log10(n)) + 1)));
  return cur === '€' ? s.replace('.', ',') + ' €' : '$' + s;
}

/* Page Tarifs : les prix, et ce que tout ceci aura coute. Separee de l'admin,
 * qui ne s'occupe plus que des acces et des cles. */
function renderPricing() {
  const pr = state.config.pricing || {};
  $('#pricingOn').checked = pr.enabled !== false;
  $('#pricingLbl').textContent = pr.enabled !== false ? 'actif' : 'desactive';
  $('#pricingCurrency').value = pr.currency || 'USD';
  $('#reportCost').checked = pr.reportCost !== false;
  if (document.activeElement !== $('#priceDefIn')) $('#priceDefIn').value = pr.defaultIn ?? 0.1;
  if (document.activeElement !== $('#priceDefOut')) $('#priceDefOut').value = pr.defaultOut ?? 0.3;
  if (document.activeElement !== $('#priceCacheRatio')) {
    $('#priceCacheRatio').value = Math.round((pr.cacheRatio ?? 0.1) * 100);
  }
  if (document.activeElement !== $('#priceKwh')) $('#priceKwh').value = pr.kwhPrice ?? 0.215;

  const byModel = {};
  for (const day of Object.values(state.stats || {})) {
    for (const [id, v] of Object.entries(day.byModel || {})) {
      const b = byModel[id] || (byModel[id] = { tokensOut: 0, cost: 0 });
      b.tokensOut += v.tokensOut || 0;
      b.cost += v.cost || 0;
    }
  }
  if (!$('#priceTable').dataset.editing) {
    $('#priceTable tbody').innerHTML = state.models.map(m => {
      // pas de prix connu : on laisse vide plutot que d'ecrire 0, qui serait
      // enregistre tel quel au prochain clic
      const p = m.price || {};
      const vin = p.in == null ? '' : p.in;
      const vout = p.out == null ? '' : p.out;
      // le prix de relecture n'est affiche que s'il a ete choisi : sinon on
      // montre en fantome ce que la fraction generale donne
      const vcache = p.cacheSuggested === false ? p.cache : '';
      const auto = p.cache == null ? '—' : money(p.cache);
      const used = byModel[m.id] || { tokensOut: 0, cost: 0 };
      return `<tr data-id="${esc(m.id)}">
        <td>${esc(m.name || m.id)} ${p.suggested ? '<span class="muted">· suggere</span>' : ''}</td>
        <td class="num"><input class="inp mono" data-f="in" type="number" step="0.01" min="0" value="${vin}" placeholder="—"></td>
        <td class="num"><input class="inp mono" data-f="cache" type="number" step="0.001" min="0" value="${vcache}" placeholder="${esc(auto)}"></td>
        <td class="num"><input class="inp mono" data-f="out" type="number" step="0.01" min="0" value="${vout}" placeholder="—"></td>
        <td class="num">${used.tokensOut ? tok(used.tokensOut) : '—'}</td>
        <td class="num cost">${used.cost ? money(used.cost) : '—'}</td>
      </tr>`;
    }).join('');
  }

  // ---- ce que ca aura coute ----
  const today = state.stats[new Date().toISOString().slice(0, 10)] || {};
  const all = Object.values(state.stats || {});
  const total30 = all.reduce((a, v) => a + (v.cost || 0), 0);
  const keyCost = state.keys.reduce((a, k) => a + (k.cost || 0), 0);

  /* La facture reelle : ce que la carte a bu, au prix du kilowattheure. Les
   * watt-heures sont mesures toutes les trois secondes sur la puissance que
   * nvidia-smi rapporte, pas estimes. */
  const prixKwh = pr.kwhPrice ?? 0.215;
  const whJour = today.wh || 0;
  const wh30 = all.reduce((a, v) => a + (v.wh || 0), 0);
  const whCharge30 = all.reduce((a, v) => a + (v.whCharge || 0), 0);
  const euro = v => (v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)).replace('.', ',') + ' €';
  const kwh = wh => (wh >= 1000
    ? (wh / 1000).toFixed(2).replace('.', ',') + ' kWh'
    : Math.round(wh) + ' Wh');
  const bilan = total30 - wh30 / 1000 * prixKwh;

  $('#savingCards').innerHTML = [
    `<div class="stat saving"><div class="k">aurait coute aujourd'hui</div><div class="v">${money(today.cost || 0)}</div><div class="s">${nf.format(today.requests || 0)} requetes</div></div>`,
    `<div class="stat saving"><div class="k">aurait coute sur 30 jours</div><div class="v">${money(total30)}</div><div class="s">${nf.format(all.reduce((a, v) => a + v.requests, 0))} requetes</div></div>`,
    `<div class="stat saving"><div class="k">depuis la premiere cle</div><div class="v">${money(keyCost)}</div><div class="s">cumul par cle, jamais remis a zero</div></div>`,
    `<div class="stat"><div class="k">electricite aujourd'hui</div><div class="v">${euro(whJour / 1000 * prixKwh)}</div><div class="s">${kwh(whJour)} mesures sur la carte</div></div>`,
    `<div class="stat"><div class="k">electricite sur 30 jours</div><div class="v">${euro(wh30 / 1000 * prixKwh)}</div><div class="s">${kwh(wh30)} · dont ${kwh(whCharge30)} modele charge</div></div>`,
    `<div class="stat ${bilan >= 0 ? 'saving' : ''}"><div class="k">${bilan >= 0 ? 'economie nette' : 'surcout'}</div>
       <div class="v">${euro(Math.abs(bilan))}</div>
       <div class="s">${bilan >= 0 ? 'le tarif cloud, moins le courant' : 'le courant coute plus que le tarif cloud'}</div></div>`
  ].join('');
}

/* Les avis venus du portail. Cinq etoiles, une moyenne, et les derniers mots
 * tels qu'ils ont ete ecrits : rien a interpreter. */
function renderRatings() {
  const s = state.ratings || { count: 0, average: null, byStar: [0, 0, 0, 0, 0], last: [] };
  $('#rateHint').textContent = s.count
    ? s.count + ' avis' + (s.count > 1 ? '' : '')
    : 'aucun avis pour l\'instant';

  if (!s.count) {
    $('#ratePanel').innerHTML = '<p class="help">La question est posee dans le portail apres quelques '
      + 'requetes, une fois par mois au plus. Personne n\'a encore repondu.</p>';
    return;
  }

  const max = Math.max(...s.byStar, 1);
  const barres = [5, 4, 3, 2, 1].map(n => {
    const v = s.byStar[n - 1];
    return `<div class="rate-bar"><span>${n} ★</span>
      <span class="meter thin"><i style="width:${v / max * 100}%"></i></span>
      <span>${v}</span></div>`;
  }).join('');

  const etoiles = n => '★'.repeat(n) + '☆'.repeat(5 - n);
  const liste = s.last.map(r => `<li>
      <span class="stars">${etoiles(r.stars)}</span>
      <span class="who">${esc(r.keyName)}</span>
      <span>${esc(r.comment || '')}</span>
      <span class="when">${esc(ago(r.at))}</span>
    </li>`).join('');

  $('#ratePanel').innerHTML = `
    <div class="rate-sum">
      <div class="rate-big">${String(s.average).replace('.', ',')}<small> / 5</small></div>
      <div class="rate-bars">${barres}</div>
    </div>
    <ul class="rate-list">${liste}</ul>`;
}

function renderAdmin() {
  renderRatings();
  const c = state.config, r = c.remote || {};

  // ---- acces distant ----
  $('#remoteOn').checked = !!r.enabled;
  $('#remoteLbl').textContent = r.enabled ? 'actif' : 'desactive';
  $('#remoteWhy').innerHTML = r.enabled
    ? 'Les requetes venant de l\'exterieur sont acceptees, si la cle le permet. Tout passe par la passerelle : chaque appel reste visible dans Activite.'
    : 'Tant que c\'est desactive, une requete venant d\'ailleurs que du reseau local est refusee, meme avec une cle valide.';
  $('#navPublic').hidden = !r.enabled;

  $$('#methodGrid .method').forEach(b => b.classList.toggle('on', b.dataset.m === r.method));
  $('#panelTailscale').hidden = r.method !== 'tailscale';
  $('#panelCloudflare').hidden = r.method !== 'cloudflare';
  $('#panelManual').hidden = r.method !== 'manual';

  const ts = state.tailscale || {};
  $('#stTs').textContent = !ts.installed ? 'a installer' : ts.running ? 'connecte' : 'non connecte';
  $('#stTs').className = 'method-state ' + (ts.running ? 'ok' : 'ko');
  $('#tsState').textContent = !ts.installed ? 'Tailscale n\'est pas installe'
    : ts.running ? 'connecte au reseau ' + (ts.tailnet || '') : 'installe mais pas connecte (' + (ts.state || '?') + ')';
  $('#tsIp').textContent = ts.ip || '--';
  const online = (ts.peers || []).filter(p => p.online).length;
  $('#tsPeers').textContent = ts.peers ? `${online} en ligne sur ${ts.peers.length}` : '--';
  $('#tsUrl').textContent = ts.ip ? `http://${ts.ip}:${c.port}/v1` : '--';

  const tu = state.tunnel || {};
  $('#stCf').textContent = tu.state === 'up' ? 'tunnel ouvert' : tu.installed ? 'pret' : 'a installer';
  $('#stCf').className = 'method-state ' + (tu.state === 'up' ? 'ok' : 'ko');
  $('#cfInstall').disabled = !!tu.installed;
  $('#cfInstall').textContent = tu.installed ? 'cloudflared installe' : 'Installer cloudflared';
  $('#cfStart').disabled = !tu.installed || tu.state === 'up' || tu.state === 'starting';
  $('#cfStop').disabled = tu.state !== 'up' && tu.state !== 'starting';
  $('#cfUrlBox').hidden = !tu.url;
  $('#cfUrl').textContent = tu.url ? tu.url + '/v1' : '';
  $('#cfLog').textContent = (tu.logs || []).map(l => l.m).join('\n');
  $('#cfLog').scrollTop = $('#cfLog').scrollHeight;

  $('#manualPort').textContent = c.port;
  if (document.activeElement !== $('#manualUrl')) $('#manualUrl').value = r.method === 'manual' ? (r.publicUrl || '') : '';

  // ---- toutes les cles ----
  $('#adminKeyTable tbody').innerHTML = state.keys.length ? state.keys.map(k => {
    const bal = keyBalance(k);
    const s = k.status || {};
    const d = s.today || {};
    const L = s.limits || {};
    const dayTxt = [
      L.reqPerDay ? `${d.requests || 0}/${L.reqPerDay} req` : `${d.requests || 0} req`,
      L.costPerDay ? `${money(d.cost || 0)} / ${money(L.costPerDay)}` : money(d.cost || 0)
    ].join(' · ');
    return `
    <tr data-id="${k.id}" class="${k.disabled ? 'muted' : ''}">
      <td>${esc(k.name)} ${roleTag(k, true)}${k.disabled ? ' <span class="tag gone">suspendue</span>'
        : s.blocked ? ' ' + blockedTag(s.blocked) : ''}</td>
      <td class="mono">${esc(k.key.slice(0, 11))}…</td>
      <td class="mid"><input type="checkbox" data-act="remote" ${k.remoteAllowed !== false ? 'checked' : ''}></td>
      <td>
        <div class="cell-bal">
          <b class="${bal.pct >= 100 ? 'ko' : ''}">${bal.text}</b>
          ${bal.pct != null ? `<span class="meter thin"><i style="width:${bal.pct}%" class="${bal.pct >= 100 ? 'full' : bal.pct >= 80 ? 'high' : ''}"></i></span>` : ''}
        </div>
      </td>
      <td class="mono">${esc(dayTxt)}</td>
      <td class="num">${nf.format(k.requests)} req · ${tok((k.tokensIn || 0) + (k.tokensOut || 0))}</td>
      <td class="num cost">${money(k.cost || 0)}</td>
      <td>${esc(ago(k.lastUsed))}</td>
      <td class="num">
        <button class="mini" data-act="limits">droits</button>
        <button class="mini" data-act="copy">copier</button>
        <button class="mini" data-act="toggle">${k.disabled ? 'reactiver' : 'suspendre'}</button>
        <button class="mini" data-act="delete">supprimer</button>
      </td>
    </tr>`;
  }).join('')
    : '<tr><td colspan="9" class="empty">Aucune cle.</td></tr>';
}

$('#remoteOn').addEventListener('change', async e => {
  const on = e.target.checked;
  try {
    const r = await api('/remote', 'PUT', { enabled: on });
    state.config.remote = r.remote;
    renderAdmin();
    toast(on ? 'Acces distant actif.' : 'Acces distant coupe.');
  } catch (err) {
    e.target.checked = !on;
    toast(err.message, true);
  }
});

$('#methodGrid').addEventListener('click', async e => {
  const b = e.target.closest('.method');
  if (!b) return;
  const r = await api('/remote', 'PUT', { method: b.dataset.m });
  state.config.remote = r.remote;
  renderAdmin();
});

$('#cfInstall').addEventListener('click', async () => {
  $('#cfHint').textContent = 'telechargement en cours, environ 70 Mo...';
  $('#cfInstall').disabled = true;
  try {
    state.tunnel = await api('/tunnel/install', 'POST');
    $('#cfHint').textContent = 'installe.';
  } catch (e) { $('#cfHint').textContent = e.message; }
  renderAdmin();
});
$('#cfStart').addEventListener('click', async () => {
  $('#cfHint').textContent = 'ouverture...';
  try { state.tunnel = await api('/tunnel/start', 'POST'); $('#cfHint').textContent = ''; }
  catch (e) { $('#cfHint').textContent = e.message; }
  renderAdmin();
});
$('#cfStop').addEventListener('click', async () => {
  state.tunnel = await api('/tunnel/stop', 'POST');
  renderAdmin();
});
$('#cfCopy').addEventListener('click', () => copy($('#cfUrl').textContent, 'Adresse publique'));

$('#manualSave').addEventListener('click', async () => {
  const r = await api('/remote', 'PUT', { method: 'manual', publicUrl: $('#manualUrl').value });
  state.config.remote = r.remote;
  renderAdmin();
  toast('Adresse enregistree.');
});

$('#pricingOn').addEventListener('change', async e => {
  const r = await api('/pricing', 'PUT', { enabled: e.target.checked });
  state.config.pricing = r.pricing;
  renderPricing();
});

$('#reportCost').addEventListener('change', async e => {
  const r = await api('/pricing', 'PUT', { reportCost: e.target.checked });
  state.config.pricing = r.pricing;
  toast(e.target.checked
    ? 'Le cout est renvoye dans usage.cost.'
    : 'Le cout n\'est plus renvoye aux clients.');
});

/* ---- chargement a la demande ---- */
$('#alOn').addEventListener('change', async e => {
  const r = await api('/autoload', 'PUT', { enabled: e.target.checked });
  state.config.autoLoad = r.autoLoad;
  renderSettings();
  toast(e.target.checked
    ? 'Le modele demande par son nom sera charge au besoin.'
    : 'Les clients devront demander le modele deja en service.');
});
$('#alSwap').addEventListener('change', async e => {
  const r = await api('/autoload', 'PUT', { swap: e.target.checked });
  state.config.autoLoad = r.autoLoad;
  toast(e.target.checked
    ? 'Un modele inactif sera remplace a la demande.'
    : 'Le modele en service ne sera plus remplace automatiquement.');
});
$('#alSave').addEventListener('click', async () => {
  try {
    const r = await api('/autoload', 'PUT', {
      swapIdleS: +$('#alIdle').value, waitS: +$('#alWait').value
    });
    state.config.autoLoad = r.autoLoad;
    $('#alHint').textContent = 'Enregistre.';
    renderSettings();
  } catch (e) { $('#alHint').textContent = e.message; }
});

/* ---- espace utilisateur ---- */
$('#portalOn').addEventListener('change', async e => {
  const r = await api('/portal', 'PUT', { enabled: e.target.checked });
  state.config.portal = r.portal;
  renderSettings();
  toast(e.target.checked ? 'Espace utilisateur ouvert.' : 'Espace utilisateur ferme.');
});
$('#portalToKeys').addEventListener('click', () => go('keys'));
$('#portalCopy').addEventListener('click', () => copy($('#portalUrl').textContent, 'Adresse du portail'));
$('#portalOpen').addEventListener('click', () => window.open('/portal', '_blank'));

/* Le tableau est reconstruit a chaque battement temps reel. Tant qu'il porte
 * des modifications non enregistrees, on n'y touche plus : sinon les chiffres
 * tapes disparaissent des qu'on sort d'un champ - un clic ailleurs suffisait -
 * et le bouton ne trouve plus rien a enregistrer. La marque ne tombe qu'apres
 * un enregistrement reussi. */
$('#priceTable').addEventListener('focusin', () => { $('#priceTable').dataset.editing = '1'; });
$('#priceTable').addEventListener('input', () => {
  $('#priceTable').dataset.editing = '1';
  $('#priceTable').dataset.touche = '1';
  $('#priceHint').textContent = 'modifications non enregistrees';
});

$('#savePricing').addEventListener('click', async () => {
  const rows = [];
  const diffs = [];
  for (const tr of $$('#priceTable tbody tr')) {
    const vin = $('[data-f="in"]', tr).value.trim();
    const vout = $('[data-f="out"]', tr).value.trim();
    const vcache = $('[data-f="cache"]', tr).value.trim();
    const m = state.models.find(x => x.id === tr.dataset.id) || {};
    const old = m.price || {};
    // un prix de relecture efface repasse au calcul automatique : c'est un
    // changement comme un autre, il faut donc le transmettre
    const avaitCache = old.cacheSuggested === false;
    const chCache = vcache === '' ? avaitCache : Number(vcache) !== Number(old.cache);
    if (vin === '' && vout === '' && !chCache) continue;   // laisse tel quel
    rows.push({ id: tr.dataset.id, price_in: vin, price_out: vout, price_cache: vcache });
    const chIn = vin !== '' && Number(vin) !== Number(old.in);
    const chOut = vout !== '' && Number(vout) !== Number(old.out);
    if (chIn || chOut || chCache) {
      const relu = v => (v === '' ? 'auto' : v);
      diffs.push({
        nom: m.name || tr.dataset.id,
        avant: `${old.in ?? '—'} / ${avaitCache ? old.cache : 'auto'} / ${old.out ?? '—'}`,
        apres: `${vin || old.in} / ${relu(vcache)} / ${vout || old.out}`,
        zero: (chIn && Number(vin) === 0) || (chOut && Number(vout) === 0)
      });
    }
  }

  // les valeurs generales comptent aussi comme un changement : sans ca, regler
  // la monnaie ou la fraction de relecture ne s'enregistrait jamais
  const pr = state.config.pricing || {};
  const generalChange = $('#pricingCurrency').value !== (pr.currency || 'USD')
    || +$('#priceDefIn').value !== (pr.defaultIn ?? 0.1)
    || +$('#priceDefOut').value !== (pr.defaultOut ?? 0.3)
    || (+$('#priceCacheRatio').value || 0) / 100 !== (pr.cacheRatio ?? 0.1)
    || +$('#priceKwh').value !== (pr.kwhPrice ?? 0.215);

  if (!diffs.length && !generalChange) {
    $('#priceHint').textContent = 'Aucun changement a enregistrer.';
    return;
  }
  if (!diffs.length) {
    try {
      const r = await api('/pricing', 'PUT', {
        currency: $('#pricingCurrency').value,
        defaultIn: +$('#priceDefIn').value,
        defaultOut: +$('#priceDefOut').value,
        cacheRatio: (+$('#priceCacheRatio').value || 0) / 100,
      kwhPrice: +$('#priceKwh').value
      });
      state.config.pricing = r.pricing;
      state.models = r.models;
      $('#priceHint').textContent = 'Valeurs par defaut enregistrees.';
      renderPricing();
    } catch (e) { $('#priceHint').textContent = e.message; }
    return;
  }

  const zeros = diffs.filter(d => d.zero).length;
  const liste = diffs.slice(0, 8).map(d =>
    `<li><b>${esc(d.nom)}</b><span class="mono">${esc(d.avant)} → ${esc(d.apres)}</span></li>`).join('');
  const reste = diffs.length > 8 ? `<li class="muted">et ${diffs.length - 8} autre(s)…</li>` : '';
  const alerte = zeros
    ? `<p class="warn">${zeros > 1 ? `${zeros} tarifs passent` : 'Un tarif passe'} a 0 : ${zeros > 1 ? 'ces modeles n\'auront' : 'ce modele n\'aura'} plus aucun cout affiche.</p>`
    : '';

  const ok = await askConfirm(
    `Enregistrer ${diffs.length} tarif${diffs.length > 1 ? 's' : ''} ?`,
    `<p>Ces valeurs seront ecrites dans <code class="mono">models.json</code>, en unites par million de tokens.</p>
     <ul class="diff-list">${liste}${reste}</ul>${alerte}`,
    'Enregistrer');
  if (!ok) { $('#priceHint').textContent = 'Annule, rien n\'a change.'; return; }

  try {
    const r = await api('/pricing', 'PUT', {
      currency: $('#pricingCurrency').value,
      defaultIn: +$('#priceDefIn').value,
      defaultOut: +$('#priceDefOut').value,
      cacheRatio: (+$('#priceCacheRatio').value || 0) / 100,
      kwhPrice: +$('#priceKwh').value,
      models: rows
    });
    state.config.pricing = r.pricing;
    state.models = r.models;
    delete $('#priceTable').dataset.editing;
    delete $('#priceTable').dataset.touche;
    $('#priceHint').textContent = 'Tarifs ecrits dans models.json.';
    renderPricing();
  } catch (e) {
    // l'erreur reste a l'ecran : un toast de quatre secondes se rate
    $('#priceHint').textContent = 'Echec : ' + e.message;
    toast('Tarifs non enregistres : ' + e.message, true);
  }
});

$('#adminKeyTable').addEventListener('change', async e => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const act = e.target.dataset.act;
  if (act === 'remote') {
    const r = await api('/keys', 'PATCH', { id: tr.dataset.id, remoteAllowed: e.target.checked });
    state.keys = r.keys;
    toast(e.target.checked ? 'Cle autorisee hors reseau.' : 'Cle limitee au reseau local.');
  }
});

$('#adminKeyTable').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = e.target.closest('tr');
  const k = state.keys.find(x => x.id === tr.dataset.id);
  if (btn.dataset.act === 'copy') return copy(k.key, 'Cle');
  if (btn.dataset.act === 'limits') return openKeyModal(k);
  if (btn.dataset.act === 'toggle') {
    const r = await api('/keys', 'PATCH', { id: k.id, disabled: !k.disabled });
    state.keys = r.keys; renderAdmin(); renderKeys();
  }
  if (btn.dataset.act === 'delete') {
    if (!confirm(`Supprimer la cle "${k.name}" ?`)) return;
    const r = await api('/keys', 'DELETE', { id: k.id });
    state.keys = r.keys; renderAdmin(); renderKeys();
  }
});

$('#adminNewKey').addEventListener('click', () => $('#btnNewKey').click());
$('#adminSuspendAll').addEventListener('click', async () => {
  if (!confirm('Suspendre toutes les cles ? Personne ne pourra plus se connecter.')) return;
  for (const k of state.keys.filter(x => !x.disabled)) {
    const r = await api('/keys', 'PATCH', { id: k.id, disabled: true });
    state.keys = r.keys;
  }
  renderAdmin(); renderKeys();
  toast('Toutes les cles sont suspendues.');
});

// --------------------------------------------------------------------------
// page reglages
// --------------------------------------------------------------------------
/* Les deux blocs de reglages sont des div, pas des form : l'acces par nom
 * (form.champ) n'existe pas ici, il faut passer par un selecteur. */
function field(rootSel, name) { return $(`${rootSel} [name="${name}"]`); }

function renderSettings() {
  const c = state.config;
  field('#formConfig', 'modelsJson').value = c.modelsJson || '';
  field('#formConfig', 'port').value = c.port || '';
  field('#formConfig', 'upstreamPort').value = c.upstreamPort || '';
  field('#formConfig', 'reserveMb').value = c.reserveMb ?? 512;
  field('#formConfig', 'idleUnloadMin').value = c.idleUnloadMin ?? 0;
  $('#idleWhy').textContent = c.idleUnloadMin
    ? `Le modele est arrete apres ${c.idleUnloadMin} min sans la moindre requete, et la VRAM est rendue. Un agent occupe ou une reponse en cours remet le compteur a zero. 0 = jamais.`
    : 'Le modele reste charge indefiniment, meme si personne ne s\'en sert. '
      + 'Mets une valeur en minutes pour qu\'il se decharge tout seul.';
  field('#formConfig', 'adminPassword').placeholder = c.hasAdminPassword
    ? 'defini - saisis une nouvelle valeur pour le changer'
    : 'vide = console accessible seulement depuis cette machine';

  // ---- chargement a la demande ----
  const al = c.autoLoad || {};
  $('#alOn').checked = al.enabled !== false;
  $('#alLbl').textContent = al.enabled !== false ? 'actif' : 'desactive';
  $('#alSwap').checked = !!al.swap;
  if (document.activeElement !== $('#alIdle')) $('#alIdle').value = al.swapIdleS ?? 60;
  if (document.activeElement !== $('#alWait')) $('#alWait').value = al.waitS ?? 180;

  // ---- cache de prompt ----
  renderCacheRam();

  // ---- echantillonnage, partage des agents, question du moment ----
  const sm = ((c.sampling || {}).mode) || 'fill';
  $$('input[name="samplingMode"]').forEach(r => { r.checked = r.value === sm; });
  renderOverload();
  renderPoll();

  // ---- espace utilisateur ----
  const po = c.portal || {};
  $('#portalOn').checked = po.enabled !== false;
  $('#portalLbl').textContent = po.enabled !== false ? 'actif' : 'desactive';
  $('#portalTopup').checked = !!po.topupEnabled;
  $('#portalUrl').textContent = baseUrl() + '/portal';

  const dv = state.defaults || {};
  field('#formDefaults', 'gpu_layers').value = dv.gpu_layers ?? 99;
  field('#formDefaults', 'batch').value = dv.batch ?? 2048;
  field('#formDefaults', 'ubatch').value = dv.ubatch ?? 512;
  field('#formDefaults', 'cache_ram_mb').value = dv.cache_ram_mb ?? 4096;
  field('#formDefaults', 'cache_reuse').value = dv.cache_reuse ?? 0;

  $('#secNotes').innerHTML = `
    <li><b>llama-server n'est jamais expose directement.</b> Il ecoute sur <code>127.0.0.1:${c.upstreamPort}</code> avec une cle interne tiree au hasard a chaque demarrage. Le reseau passe forcement par cette console, donc suspendre une cle coupe l'acces immediatement.</li>
    <li><b>Les cles sont stockees en clair</b> dans <code>keys.json</code>, a cote de <code>server.js</code>, pour pouvoir les relire. Garde ce dossier prive.</li>
    <li><b>Pas de chiffrement.</b> Le trafic est en HTTP simple : bon pour un reseau domestique, a ne pas exposer sur Internet tel quel.</li>
    <li><b>Pare-feu Windows :</b> autorise Node.js sur le reseau prive a la premiere demande, sinon personne ne verra le port ${c.port}.</li>
    <li>La console est ${c.hasAdminPassword ? '<b>protegee par mot de passe</b> et accessible depuis le reseau.' : '<b>limitee a cette machine</b>. Definis un mot de passe pour l\'ouvrir depuis un telephone.'}</li>`;
}

/* Cache de prompt : la valeur qui s'applique, d'ou elle vient, et ce avec quoi
 * le modele en service est reellement parti - trois choses differentes qu'il
 * vaut mieux montrer que faire deviner. */
function renderCacheRam() {
  const c = state.cacheRam || { session: null, default: 4096, effective: 4096, running: null };
  const enSession = c.session != null;

  if (document.activeElement !== $('#cramValue')) $('#cramValue').value = c.effective;
  $('#cramState').textContent = enSession
    ? mb(c.effective) + ' pour cette session'
    : mb(c.effective) + ' par defaut';
  $('#cramState').className = 'hint' + (enSession ? ' warn-inline' : '');
  $('#cramReset').hidden = !enSession;

  const lignes = [
    `<li><span>valeur appliquee aux prochains chargements</span><b>${mb(c.effective)}</b>
       <span class="muted">${enSession ? 'valeur de session' : 'defaut de models.json'}</span></li>`,
    `<li><span>defaut enregistre</span><b>${mb(c.default)}</b>
       <span class="muted">${enSession ? 'mis de cote tant que la session dure' : 'en vigueur'}</span></li>`
  ];
  if (c.running != null) {
    lignes.push(`<li><span>modele en service</span><b>${mb(c.running)}</b>
      <span class="muted">${c.running === c.effective
        ? 'a jour' : 'parti avec l\'ancienne valeur, il faut le relancer'}</span></li>`);
  }
  $('#cramLines').innerHTML = lignes.join('');
}

async function poserCacheRam(scope) {
  const v = parseInt($('#cramValue').value, 10);
  if (!Number.isFinite(v) || v < 0) { $('#cramHint').textContent = 'Valeur illisible.'; return; }
  try {
    const r = await api('/cache-ram', 'PUT', { value: v, scope, clearSession: scope === 'default' });
    state.cacheRam = r.cacheRam;
    state.defaults = r.defaults;
    renderCacheRam();
    renderSettings();
    $('#cramHint').textContent = scope === 'session'
      ? 'Valeur de session posee. Elle tombera a la fermeture de la console.'
      : 'Defaut enregistre dans models.json.';
    toast(state.status.running
      ? 'Enregistre. Le modele en service garde son reglage : relance-le pour l\'appliquer.'
      : 'Enregistre. Il partira avec au prochain chargement.');
  } catch (e) { $('#cramHint').textContent = e.message; }
}

$('#cramSession').addEventListener('click', () => poserCacheRam('session'));
$('#cramDefault').addEventListener('click', () => poserCacheRam('default'));
$('#cramReset').addEventListener('click', async () => {
  try {
    const r = await api('/cache-ram', 'PUT', { value: null, scope: 'session' });
    state.cacheRam = r.cacheRam;
    renderCacheRam();
    $('#cramHint').textContent = 'Retour au defaut enregistre.';
  } catch (e) { $('#cramHint').textContent = e.message; }
});

/* Partage des agents : l'etat du moment, et le seuil au-dela duquel on refuse
 * plutot que de faire attendre en silence. */
function renderOverload() {
  const o = (state.config && state.config.overload) || { enabled: true, queuePerSlot: 1 };
  const l = state.load || { agents: 0, busy: 0, queue: 0, waitS: 0, medianMs: 0 };
  $('#ovOn').checked = o.enabled !== false;
  $('#ovLbl').textContent = o.enabled !== false ? 'actif' : 'desactive';
  if (document.activeElement !== $('#ovQueue')) $('#ovQueue').value = o.queuePerSlot ?? 1;

  const seuil = l.agents ? l.agents * (o.queuePerSlot ?? 1) + (o.queuePerSlot ?? 1) : 0;
  $('#ovLines').innerHTML = [
    `<li><span>agents du modele en service</span><b>${l.agents || '—'}</b>
       <span class="muted">${l.agents ? l.busy + ' occupe' + (l.busy > 1 ? 's' : '') : 'aucun modele charge'}</span></li>`,
    `<li><span>requetes en attente</span><b>${l.queue}</b>
       <span class="muted">${seuil ? 'refus au-dela de ' + seuil : 'seuil inconnu sans modele charge'}</span></li>`,
    `<li><span>duree mediane d'une reponse</span><b>${l.medianMs ? (l.medianMs / 1000).toFixed(1) + ' s' : '—'}</b>
       <span class="muted">${l.medianMs ? 'sert a annoncer l\'attente' : 'pas encore assez de reponses'}</span></li>`
  ].join('');
}

$('#samplingPick').addEventListener('change', async e => {
  if (e.target.name !== 'samplingMode') return;
  try {
    const r = await api('/sampling', 'PUT', { mode: e.target.value });
    state.config.sampling = r.sampling;
    $('#samplingHint').textContent = {
      fill: 'Les valeurs du modele comblent les silences du client.',
      force: 'Les valeurs du modele l\'emportent sur celles du client.',
      off: 'La passerelle ne touche plus aux requetes.'
    }[r.sampling.mode];
  } catch (err) { $('#samplingHint').textContent = err.message; }
});

$('#ovOn').addEventListener('change', async e => {
  try {
    const r = await api('/overload', 'PUT', { enabled: e.target.checked });
    state.config.overload = r.overload;
    renderOverload();
    toast(e.target.checked
      ? 'Les requetes en trop recevront un refus chiffre.'
      : 'Plus de refus : tout le monde attend dans la file de llama.cpp.');
  } catch (err) { toast(err.message, true); }
});
$('#ovSave').addEventListener('click', async () => {
  try {
    const r = await api('/overload', 'PUT', { queuePerSlot: +$('#ovQueue').value });
    state.config.overload = r.overload;
    renderOverload();
    $('#ovHint').textContent = 'Enregistre.';
  } catch (e) { $('#ovHint').textContent = e.message; }
});

/* Question du moment : ce qu'on demande, et ce qu'on a recu. */
function renderPoll() {
  const p = state.poll || { active: false, question: '', options: [], count: 0, tally: [], answers: [] };
  $('#pollOn').checked = !!p.active;
  $('#pollLbl').textContent = p.active ? 'posee' : 'inactive';
  if (document.activeElement !== $('#pollQ')) $('#pollQ').value = p.question || '';
  $$('.poll-opts .inp').forEach((el, i) => {
    if (document.activeElement !== el) el.value = (p.options || [])[i] || '';
  });
  $('#pollText').checked = p.allowText !== false;

  if (!p.count) {
    $('#pollResults').innerHTML = p.question
      ? '<p class="help">Aucune reponse pour l\'instant.</p>' : '';
    return;
  }
  const max = Math.max(1, ...p.tally.map(t => t.count));
  const barres = p.tally.map(t => `<div class="rate-bar"><span>${esc(t.label)}</span>
      <span class="meter thin"><i style="width:${t.count / max * 100}%"></i></span>
      <span>${t.count}</span></div>`).join('');
  const mots = p.answers.filter(a => a.text).slice(0, 8).map(a =>
    `<li><span class="who">${esc(a.keyName)}</span><span>${esc(a.text)}</span>
      <span class="when">${esc(ago(a.at))}</span></li>`).join('');
  $('#pollResults').innerHTML = `
    <div class="poll-res">
      <div class="hint">${p.count} reponse${p.count > 1 ? 's' : ''}</div>
      <div class="rate-bars">${barres}</div>
      ${mots ? `<ul class="rate-list">${mots}</ul>` : ''}
    </div>`;
}

async function envoyerSondage(actif) {
  const options = $$('.poll-opts .inp').map(el => el.value.trim()).filter(Boolean);
  try {
    const r = await api('/poll', 'PUT', {
      question: $('#pollQ').value.trim(),
      options,
      allowText: $('#pollText').checked,
      active: actif
    });
    state.poll = r.poll;
    renderPoll();
    $('#pollHint').textContent = r.poll.question
      ? (r.poll.active ? 'Question posee dans le portail.' : 'Question enregistree, pas encore posee.')
      : 'Question effacee.';
  } catch (e) { $('#pollHint').textContent = e.message; }
}
$('#pollSave').addEventListener('click', () => envoyerSondage($('#pollOn').checked));
$('#pollOn').addEventListener('change', e => envoyerSondage(e.target.checked));

$('#saveConfig').addEventListener('click', async () => {
  const pass = field('#formConfig', 'adminPassword');
  const body = {
    modelsJson: field('#formConfig', 'modelsJson').value,
    port: +field('#formConfig', 'port').value,
    upstreamPort: +field('#formConfig', 'upstreamPort').value,
    reserveMb: +field('#formConfig', 'reserveMb').value,
    idleUnloadMin: +field('#formConfig', 'idleUnloadMin').value
  };
  if (pass.value) body.adminPassword = pass.value;
  try {
    await api('/config', 'PUT', body);
    pass.value = '';
    $('#cfgHint').textContent = body.adminPassword
      ? 'Enregistre. Mot de passe admin actif.'
      : 'Enregistre. Un changement de port demande un redemarrage de la console.';
    await refresh();
  } catch (e) { $('#cfgHint').textContent = e.message; }
});

$('#saveDefaults').addEventListener('click', async () => {
  try {
    const r = await api('/defaults', 'PUT', {
      gpu_layers: +field('#formDefaults', 'gpu_layers').value,
      batch: +field('#formDefaults', 'batch').value,
      ubatch: +field('#formDefaults', 'ubatch').value,
      cache_ram_mb: +field('#formDefaults', 'cache_ram_mb').value,
      cache_reuse: +field('#formDefaults', 'cache_reuse').value
    });
    state.defaults = r.defaults;
    $('#defHint').textContent = 'Enregistre dans models.json.';
  } catch (e) { $('#defHint').textContent = e.message; }
});

// --------------------------------------------------------------------------
// navigation
// --------------------------------------------------------------------------
function go(page) {
  state.page = page;
  $$('.nav').forEach(b => b.setAttribute('aria-current', b.dataset.page === page ? 'page' : 'false'));
  $$('.page').forEach(s => { s.hidden = s.dataset.page !== page; });
  if (page === 'activity') loadActivity();
  if (page === 'settings') safe('reglages', renderSettings);
  if (page === 'keys') safe('cles', renderKeys);
  if (page === 'server') safe('serveur', renderServer);
  if (page === 'pricing') safe('tarifs', renderPricing);
  if (page === 'admin') { safe('admin', renderAdmin); refreshTailscale(); }
  location.hash = page;
}

/* L'etat Tailscale bouge hors de la console : on le relit a l'ouverture. */
async function refreshTailscale() {
  try {
    state.tailscale = await api('/tailscale');
    if (state.page === 'admin') renderAdmin();
  } catch {}
}
$$('.nav').forEach(b => b.addEventListener('click', () => go(b.dataset.page)));

// --------------------------------------------------------------------------
// donnees et temps reel
// --------------------------------------------------------------------------
/* Un bloc qui echoue ne doit pas emporter les autres, ni faire remonter
 * l'erreur jusqu'a l'ecran de secours qui remplace la page. */
function safe(name, fn) {
  try { fn(); }
  catch (e) { console.error('rendu ' + name + ' :', e); toast('Affichage de « ' + name + ' » en echec, voir la console du navigateur.', true); }
}

function renderAll() {
  safe('barre haute', renderTop);
  safe('adresses', renderAddresses);
  safe('modeles', renderModels);
  safe('serveur', renderServer);
  if (state.page === 'keys') safe('cles', renderKeys);
  if (state.page === 'settings') safe('reglages', renderSettings);
  if (state.page === 'admin') safe('admin', renderAdmin);
  if (state.page === 'pricing') safe('tarifs', renderPricing);
  $('#navPublic').hidden = !(state.config.remote && state.config.remote.enabled);
}

async function refresh() {
  const s = await api('/state');
  Object.assign(state, {
    models: s.models, defaults: s.defaults, status: s.status, gpu: s.gpu,
    config: s.config, keys: s.keys, lan: s.lan, stats: s.stats,
    tunnel: s.tunnel, tailscale: s.tailscale,
    cacheRam: s.cacheRam, ratings: s.ratings, poll: s.poll, load: s.load
  });
  // Le journal ne doit jamais empecher la page d'exister : une ligne mal formee
  // laissait l'interface entierement vide, sans rien dire de plus qu'un toast
  // de quatre secondes.
  safe('journal', () => {
    logView.innerHTML = '';
    (s.logs || []).forEach(appendLog);
  });
  renderAll();
}

function connectStream() {
  const es = new EventSource('/_api/stream');
  es.addEventListener('log', e => appendLog(JSON.parse(e.data)));
  es.addEventListener('status', e => {
    state.status = JSON.parse(e.data);
    renderTop(); renderModels(); renderServer();
  });
  es.addEventListener('live', e => {
    const d = JSON.parse(e.data);
    if (d.gpu) state.gpu = d.gpu;
    if (d.slots) state.status.slots = d.slots;
    if (d.metrics) state.status.metrics = d.metrics;
    if (d.uptime) state.status.uptime = d.uptime;
    if (d.idleMs !== undefined) state.status.idleMs = d.idleMs;
    if (d.inFlight !== undefined) state.status.inFlight = d.inFlight;
    renderTop();
    if (state.page === 'server') renderServer();
  });
  es.addEventListener('tunnel', e => {
    state.tunnel = JSON.parse(e.data);
    if (state.page === 'admin') renderAdmin();
  });
  es.addEventListener('remote', e => {
    Object.assign(state.config, JSON.parse(e.data));
    $('#navPublic').hidden = !state.config.remote.enabled;
    if (state.page === 'admin') renderAdmin();
  });
  es.addEventListener('usage', e => {
    const rec = JSON.parse(e.data);
    const k = state.keys.find(x => x.id === rec.keyId);
    if (k) {
      k.requests++; k.tokensIn += rec.tokensIn; k.tokensOut += rec.tokensOut;
      k.cost = (k.cost || 0) + (rec.cost || 0);
      k.lastUsed = rec.at; k.lastIp = rec.ip;
      // les compteurs d'enveloppe viennent du serveur : on les avance de la
      // meme quantite pour que soldes et jauges suivent en direct
      const s = k.status;
      if (s) {
        const bump = o => {
          o.requests++; o.tokensIn += rec.tokensIn; o.tokensOut += rec.tokensOut;
          o.tokens = o.tokensIn + o.tokensOut; o.cost += rec.cost || 0;
        };
        bump(s.today); bump(s.total);
      }
    }
    if (state.page === 'activity') loadActivity();
    if (state.page === 'admin') renderAdmin();
    if (state.page === 'pricing') renderPricing();
    if (state.page === 'keys') renderKeys();
  });
  es.onerror = () => { /* EventSource se reconnecte tout seul */ };
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/login', 'POST', { password: $('#loginPass').value });
    $('#loginBack').hidden = true;
    await start();
  } catch (err) { $('#loginErr').textContent = err.message; }
});

/* Un bandeau qui reste. Un toast de quatre secondes se rate, et on se retrouve
 * devant une page vide sans savoir pourquoi. */
function banniere(texte, ton) {
  let b = $('#bandeau');
  if (!b) {
    b = document.createElement('div');
    b.id = 'bandeau';
    b.className = 'bandeau';
    document.body.insertBefore(b, document.body.firstChild);
  }
  b.className = 'bandeau ' + (ton || '');
  b.innerHTML = esc(texte) + ' <button class="mini" onclick="location.reload()">recharger</button>';
  b.hidden = false;
}
function enleverBanniere() { const b = $('#bandeau'); if (b) b.hidden = true; }

/* Le premier appel a le droit d'echouer : CONSOLE.bat ouvrait le navigateur
 * avant que le serveur n'ecoute. On reessaie quelques secondes plutot que de
 * laisser une page vide pour toujours. */
async function premierEtat(essais) {
  for (let i = 0; i < essais; i++) {
    try {
      await refresh();
      enleverBanniere();
      return true;
    } catch (e) {
      // Un refus n'est pas une absence : mot de passe demande, droit refuse -
      // ca ne s'arrangera pas en reessayant, et faire patienter six secondes
      // devant un ecran vide serait pire que de le dire tout de suite.
      if (e.status >= 400 && e.status < 500) throw e;
      if (i === essais - 1) throw e;
      banniere('Connexion a la console... (essai ' + (i + 2) + ')', 'attente');
      await new Promise(r => setTimeout(r, 700));
    }
  }
}

async function start() {
  await premierEtat(8);                 // seul appel qui a le droit d'echouer fort
  connectStream();
  const h = location.hash.slice(1);
  go(['models', 'server', 'keys', 'activity', 'pricing', 'admin', 'settings'].includes(h) ? h : 'models');
}

(async function init() {
  try {
    await start();
    return;
  } catch (e) {
    // On ne remplace la page que si la console est vraiment injoignable :
    // une erreur d'affichage ne doit jamais effacer ce qui est a l'ecran.
    const r = await fetch('/_api/state').then(x => x.json()).catch(() => null);
    if (r && r.needsLogin) { $('#loginBack').hidden = false; $('#loginPass').focus(); return; }
    if (r && !r.error) {
      // la console repond, c'est donc l'affichage qui a lache : on le dit et on
      // le laisse a l'ecran, avec de quoi recharger
      console.error(e);
      banniere('L\'affichage a echoue : ' + e.message, 'mauvais');
      toast('Erreur d\'affichage : ' + e.message, true);
      return;
    }
    document.body.innerHTML = `<div style="padding:60px;max-width:60ch;margin:auto;font-family:system-ui;color:#e7eaf0">
      <h1 style="margin-bottom:12px">Console indisponible</h1>
      <p style="color:#949cab">${esc((r && r.error) || e.message)}</p></div>`;
  }
})();

// l'uptime avance meme sans evenement du serveur
setInterval(() => { if (state.status.running) renderTop(); }, 1000);
