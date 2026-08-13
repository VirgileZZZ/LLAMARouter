/* ==========================================================================
   Espace utilisateur. La cle API sert d'identifiant : il n'y a pas de compte,
   pas de mot de passe, et rien d'autre a voir que sa propre consommation.
   Page autonome, elle ne partage aucun etat avec la console d'administration.
   ========================================================================== */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const KEY_STORE = 'llamadash.key';
const state = { key: '', data: null, tab: 'url' };

// --------------------------------------------------------------------------
// formats
// --------------------------------------------------------------------------
const nf = new Intl.NumberFormat('fr-FR');

function tok(v) {
  v = v || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + ' M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace('.', ',') + ' k';
  return String(Math.round(v));
}
function mb(v) {
  if (!v) return '0 Mo';
  return v >= 1024 ? (v / 1024).toFixed(1).replace('.', ',') + ' Go' : Math.round(v) + ' Mo';
}
function dur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}
function hhmm(t) { return new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* Les montants sont minuscules : on garde des chiffres significatifs plutot
 * qu'un nombre fixe de decimales, sinon tout s'affiche a zero. */
function money(v) {
  const cur = ((state.data && state.data.pricing) || {}).currency === 'EUR' ? '€' : '$';
  const n = Math.abs(v || 0);
  const trim = x => (x.includes('.') ? x.replace(/0+$/, '').replace(/\.$/, '') : x);
  let s;
  if (n === 0) s = '0';
  else if (n >= 100) s = Math.round(n).toString();
  else if (n >= 1) s = n.toFixed(2);
  else if (n >= 0.01) s = trim(n.toFixed(3));
  else s = trim(n.toFixed(Math.min(10, Math.ceil(-Math.log10(n)) + 1)));
  return cur === '€' ? s.replace('.', ',') + ' €' : '$' + s;
}

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 4000);
}

/* Meme raison que dans la console : une requete sans reponse laisse un bouton
 * en suspens et personne ne sait pourquoi. On borne, et on l'explique. */
async function api(path, method, body) {
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), 30000);
  let r;
  try {
    r = await fetch('/_user' + path, {
      method: method || 'GET',
      headers: Object.assign(
        { Authorization: 'Bearer ' + state.key },
        body ? { 'Content-Type': 'application/json' } : null),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError'
      ? 'Le serveur n\'a pas repondu en 30 s. Il est peut-etre arrete.'
      : 'Serveur injoignable : ' + e.message);
    err.status = 0;
    throw err;
  } finally {
    clearTimeout(minuteur);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'erreur ' + r.status); e.status = r.status; throw e; }
  return j;
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast((label || 'Copie') + ' dans le presse-papier.'); }
  catch { toast('Copie impossible : le navigateur la bloque hors https.', true); }
}

// --------------------------------------------------------------------------
// solde et compteurs
// --------------------------------------------------------------------------
/* Une jauge : rien a afficher quand la limite est a zero, c'est illimite. */
function gauge(label, used, limit, fmt) {
  if (!limit) {
    return `<div class="gauge free">
      <div class="g-head"><span>${esc(label)}</span><b>${fmt(used)}</b></div>
      <div class="g-note">sans limite</div></div>`;
  }
  const pct = Math.min(100, used / limit * 100);
  const cls = pct >= 100 ? 'full' : pct >= 80 ? 'high' : '';
  return `<div class="gauge ${cls}">
    <div class="g-head"><span>${esc(label)}</span><b>${fmt(used)} <i>/ ${fmt(limit)}</i></b></div>
    <div class="meter"><i style="width:${pct}%"></i></div>
    <div class="g-note">${pct >= 100 ? 'atteint, ca repart a minuit' : fmt(limit - used) + ' restants'}</div></div>`;
}

function renderBalance() {
  const s = state.data.status;
  const L = s.limits, tot = s.total;

  if (L.credit > 0) {
    const left = Math.max(0, L.credit - tot.cost);
    const pct = Math.min(100, tot.cost / L.credit * 100);
    $('#balanceKind').textContent = 'enveloppe attribuee';
    $('#balanceV').textContent = money(left);
    $('#balanceSub').textContent = 'restants';
    $('#balanceBar').style.width = pct + '%';
    $('#balanceBar').className = pct >= 100 ? 'full' : pct >= 80 ? 'high' : '';
    $('#balanceUsed').textContent = money(tot.cost) + ' consommes';
    $('#balanceCap').textContent = 'sur ' + money(L.credit);
    $('#balancePanel').classList.toggle('empty-balance', left <= 0);
  } else {
    $('#balanceKind').textContent = 'sans plafond';
    $('#balanceV').textContent = money(tot.cost);
    $('#balanceSub').textContent = 'consommes depuis le debut';
    $('#balanceBar').style.width = '100%';
    $('#balanceBar').className = 'free';
    $('#balanceUsed').textContent = nf.format(tot.requests) + ' requetes · ' + tok(tot.tokens) + ' tokens';
    $('#balanceCap').textContent = 'aucune enveloppe';
    $('#balancePanel').classList.remove('empty-balance');
  }

  $('#btnTopup').disabled = true;
  $('#topupWhy').textContent = state.data.portal.topupEnabled
    ? 'Rechargement en ligne indisponible pour le moment.'
    : 'Le rechargement en ligne est coupe : c\'est l\'administrateur qui attribue les fonds, cle par cle.';

  const day = s.today;
  // ce que le cache a evite de recalculer : c'est du temps gagne, et une
  // depense qui ne compte qu'au dixieme
  const relu = day.tokensIn ? Math.round((day.tokensCached || 0) / day.tokensIn * 100) : 0;
  $('#dayHint').textContent = nf.format(day.requests) + ' requetes'
    + (relu ? ' · ' + relu + ' % du prompt relu du cache' : '');
  $('#gauges').innerHTML = [
    gauge('requetes', day.requests, L.reqPerDay, v => nf.format(Math.round(v))),
    gauge('tokens', day.tokens, L.tokensPerDay, tok),
    gauge('depense', day.cost, L.costPerDay, money),
    L.tokensTotal ? gauge('tokens au total', s.total.tokens, L.tokensTotal, tok) : ''
  ].filter(Boolean).join('');

  // un blocage l'emporte sur tout le reste : on le dit en haut, en clair
  const b = s.blocked;
  const old = $('#blockNote');
  if (old) old.remove();
  if (b) {
    const p = document.createElement('p');
    p.id = 'blockNote';
    p.className = 'warn';
    p.innerHTML = '<b>Ta cle ne repond plus aux requetes.</b> ' + esc(b.message);
    $('#balancePanel').querySelector('.pad').prepend(p);
  }
}

// --------------------------------------------------------------------------
// modele en service et demande de chargement
// --------------------------------------------------------------------------
function renderServer() {
  const sv = state.data.server, g = state.data.gpu, po = state.data.portal;
  const on = sv.running && sv.ready;

  // compte a rebours du dechargement automatique
  let idle = '';
  if (on && sv.idleUnloadMin) {
    const left = sv.idleUnloadMin * 60000 - (sv.idleMs || 0);
    idle = sv.busy || sv.inFlight
      ? ' · en travail'
      : left > 0 ? ' · liberation auto dans ' + dur(left) : ' · liberation imminente';
  }

  $('#srvHint').textContent = g.ok ? g.name + ' · ' + mb(g.usedMb) + ' / ' + mb(g.totalMb) : '';

  /* Charge : ce qui est pris, ce qui attend, et ce que ta cle peut occuper.
   * Trois chiffres, aucune interpretation. */
  const L = state.data.load || {};
  const barre = $('#loadBar');
  if (!L.agents) {
    barre.hidden = true;
  } else {
    barre.hidden = false;
    const pris = Math.min(L.busy, L.agents);
    $('#loadDots').innerHTML = Array.from({ length: L.agents }, (_, i) =>
      `<i class="agent-dot ${i < pris ? 'busy' : ''}"></i>`).join('');
    $('#loadText').textContent = pris + ' / ' + L.agents + ' agent'
      + (L.agents > 1 ? 's' : '') + ' occupe' + (pris > 1 ? 's' : '');
    $('#loadQueue').hidden = !L.queue;
    if (L.queue) {
      $('#loadQueue').textContent = L.queue + ' en attente'
        + (L.waitS ? ' · environ ' + dur(L.waitS * 1000) : '');
    }
    $('#loadMine').textContent = L.budget
      ? 'ta cle : ' + (L.mine || 0) + ' / ' + L.budget + (L.budget > 1 ? ' agents' : ' agent')
      : 'ta cle : sans limite d\'agents';
    $('#loadMine').classList.toggle('full', L.budget && (L.mine || 0) >= L.budget);
  }
  $('#srv').innerHTML = sv.running
    ? `<div class="srv-on ${on ? 'ready' : 'boot'}">
         <span class="srv-dot"></span>
         <div>
           <b>${esc(sv.modelName || sv.modelId)}</b>
           <span>${on ? 'pret · ' + dur(sv.uptime) + ' en service' : 'en cours de chargement, patiente'}
             ${sv.slots ? ' · ' + sv.busy + '/' + sv.slots + ' agents occupes' : ''}
             ${sv.noCtx ? '' : sv.ctxSlot ? ' · ' + tok(sv.ctxSlot) + ' de contexte chacun' : ''}
             ${sv.by && sv.by !== 'admin' ? ' · demande par ' + esc(sv.by) : ''}${idle}</span>
         </div>
       </div>`
    : `<div class="srv-off"><span class="srv-dot"></span><div><b>Aucun modele charge</b>
         <span>${sv.idleStopped ? 'libere tout seul, faute d\'activite' : 'la carte est libre'}${po.allowLaunch
           ? '' : ' · ta cle ne peut pas en demander un, elle se sert de celui qui tourne'}</span></div></div>`;

  // ---- liberer la carte ----
  const canStop = sv.running && po.allowStop;
  $('#srvActions').hidden = !canStop;
  if (canStop) {
    const busy = sv.busy || sv.inFlight;
    $('#btnFree').disabled = !!busy || !sv.ready;
    $('#freeWhy').textContent = busy
      ? `${sv.busy || sv.inFlight} agent(s) travaillent : on n'arrete pas un modele en pleine reponse.`
      : !sv.ready ? 'Le modele est en cours de chargement.'
      : 'Personne ne s\'en sert. L\'arreter rend la VRAM et permet d\'en charger un autre.';
  }

  // ---- demander un modele ----
  // Un modele deja charge peut ceder la place, si la cle en a le droit et que
  // personne ne travaille : on ne coupe jamais une reponse en cours.
  const libre = !sv.busy && !sv.inFlight;
  const remplacable = !sv.running || (po.allowSwap && sv.ready && libre);
  const canAsk = po.allowLaunch && remplacable;
  $('#ask').hidden = !canAsk;
  if (!canAsk) { tune.model = null; $('#tuner').hidden = true; return; }

  /* Avec le reglage libre, ce qui compte n'est pas que le preset enregistre
   * tienne, mais que le modele puisse tenir une fois regle au plus juste.
   * Et une cle administratrice n'est bornee par rien : elle a le droit de
   * deporter hors du GPU, donc tout lui est proposable. */
  const ok = m => (po.allowOffload ? true : po.allowTune ? m.fitsMin : m.fits);
  const models = state.data.models.filter(m => m.ready && !m.loaded);
  const fit = models.filter(ok);
  const nofit = models.filter(m => !ok(m));
  $('#askHelp').innerHTML = (sv.running
    ? 'Tu peux faire changer de modele : celui qui tourne sera arrete, puis le nouveau charge, '
      + 'ce qui prend une minute ou deux.'
    : 'Aucun modele n\'est charge. Tu peux en demander un : il sera lance pour tout le monde, '
      + 'ce qui prend une minute ou deux.')
    + (po.allowTune ? ' Tu pourras choisir le nombre d\'agents et le contexte.' : '');

  const row = m => `<button class="ask-row ${ok(m) ? '' : 'no'}" data-id="${esc(m.id)}" ${ok(m) ? '' : 'disabled'}>
      <span class="ask-name">${esc(m.name)}</span>
      <span class="ask-meta">${mb(m.sizeMb)}${m.vision ? ' · vision' : ''} · ${m.slots} agent${m.slots > 1 ? 's' : ''}
        · ${money(m.price.out)} / 1M sortie</span>
      <span class="ask-go">${!ok(m) ? 'ne tient pas en VRAM'
        : (po.allowOffload && !m.fitsMin) ? 'trop gros : deport hors GPU'
        : po.allowTune ? (m.fits ? 'regler et demander' : 'a regler pour tenir')
        : 'demander'}</span>
    </button>`;

  /* Cinq quantifications d'un meme reseau, ce sont cinq lignes pour un seul
   * choix : on n'en montre qu'une, depliable. */
  const liste = arr => {
    const fams = [];
    const parCle = new Map();
    for (const m of arr) {
      const cle = m.family || m.id;
      if (!parCle.has(cle)) {
        const f = { name: m.familyName || m.name, membres: [] };
        parCle.set(cle, f); fams.push(f);
      }
      parCle.get(cle).membres.push(m);
    }
    return fams.map(f => {
      if (f.membres.length < 2) return row(f.membres[0]);
      const poids = f.membres.map(m => m.sizeMb).filter(Boolean);
      const prix = f.membres.map(m => m.price.out);
      const bornes = (v, fmt) => (Math.min(...v) === Math.max(...v)
        ? fmt(v[0]) : fmt(Math.min(...v)) + ' a ' + fmt(Math.max(...v)));
      return `<details class="ask-fam">
        <summary>
          <span class="ask-name">${esc(f.name)}</span>
          <span class="ask-meta">${f.membres.length} variantes${poids.length ? ' · ' + bornes(poids, mb) : ''}
            · ${bornes(prix, money)} / 1M sortie</span>
          <span class="ask-go">voir les variantes</span>
        </summary>
        <div class="fam-body">${f.membres.map(row).join('')}</div>
      </details>`;
    }).join('');
  };

  // la liste disparait pendant le reglage : une seule chose a faire a la fois
  const tuning = !!tune.model;
  $('#askList').hidden = tuning;
  $('#askHelp').hidden = tuning;
  $('#tuner').hidden = !tuning;
  if (tuning) return syncTuner();

  $('#askList').innerHTML = liste(fit)
    + (nofit.length
      ? `<details class="ask-more"><summary>${nofit.length} modele(s) trop gros pour la memoire libre</summary>
         <p class="help">Les charger demanderait d'en deporter une partie hors du GPU. Seul l'administrateur peut le faire, depuis la console.</p>
         ${liste(nofit)}</details>`
      : '');
}

$('#btnFree').addEventListener('click', async () => {
  const b = $('#btnFree');
  b.disabled = true;
  b.textContent = 'arret...';
  try {
    await api('/stop', 'POST', {});
    toast('Carte liberee. N\'importe qui peut maintenant demander un modele.');
  } catch (e) { toast(e.message, true); }
  b.textContent = 'Liberer la carte';
  setTimeout(load, 1200);
});

// --------------------------------------------------------------------------
// reglage avant lancement
// --------------------------------------------------------------------------
const tune = { model: null, slots: 1, ctxSlot: 8192 };
const CTX_STEPS = [2048, 4096, 8192, 12288, 16384, 24576, 32768, 49152, 65536,
                   98304, 131072, 163840, 196608, 262144];
const KVF = { q4_0: 1000, q5_0: 1222, q8_0: 1889, f16: 3556 };

/* Meme calcul que la console et que le .bat. Le serveur revalide de toute
 * facon avant de lancer : ceci sert a montrer, pas a autoriser. */
function estimate(m, slots, ctxSlot) {
  const c = m.calc;
  const per = c.noCtx ? m.nativeCtx : ctxSlot;
  const ctxTotal = per * slots;
  const kv = Math.round((ctxTotal / 1024) * c.kvKbToken * (KVF[c.cache] || 1000) / 1000)
    + slots * c.swaMb;
  const compute = 400 + slots * 60;
  const total = c.weights + kv + compute;
  const usable = state.data.gpu.usableMb || 1;
  return { kv, compute, total, usable, over: total - usable, ctxTotal };
}

function ctxSteps(m) { return CTX_STEPS.filter(v => v <= m.nativeCtx); }

/* Ouvre le reglage sur un point de depart qui tient : on part de ce que
 * l'admin a enregistre, puis on retire du contexte, puis des agents, jusqu'a
 * rentrer. Mieux vaut proposer un reglage utilisable qu'un rouge d'entree. */
function openTuner(id) {
  const m = state.data.models.find(x => x.id === id);
  if (!m) return;
  const maxSlots = state.data.portal.maxSlots || 16;
  const steps = ctxSteps(m);

  let slots = Math.min(maxSlots, m.slots || 1);
  let ctx = m.ctx || steps[Math.min(2, steps.length - 1)];
  let i = steps.reduce((best, s, k) => Math.abs(s - ctx) < Math.abs(steps[best] - ctx) ? k : best, 0);
  while (estimate(m, slots, steps[i]).over > 0 && i > 0) i--;
  while (estimate(m, slots, steps[i]).over > 0 && slots > 1) slots--;

  tune.model = m;
  tune.slots = slots;
  tune.ctxSlot = steps[i];
  $('#tSlots').max = String(maxSlots);
  $('#tCtx').max = String(steps.length - 1);
  renderServer();
}

function syncTuner() {
  const m = tune.model;
  const steps = ctxSteps(m);
  const e = estimate(m, tune.slots, tune.ctxSlot);

  $('#tunerName').textContent = m.name;
  $('#tunerSub').textContent = mb(m.sizeMb) + (m.vision ? ' · vision' : '')
    + ' · ' + money(m.price.in) + ' / ' + money(m.price.out) + ' par million';

  $('#tSlots').value = String(tune.slots);
  $('#tSlotsV').textContent = tune.slots + (tune.slots > 1 ? ' agents' : ' agent');

  const locked = m.calc.noCtx;
  $('#tCtx').disabled = locked;
  $('#tCtxField').classList.toggle('off', locked);
  let best = 0;
  steps.forEach((s, i) => { if (Math.abs(s - tune.ctxSlot) < Math.abs(steps[best] - tune.ctxSlot)) best = i; });
  $('#tCtx').value = String(best);
  $('#tCtxV').textContent = locked ? 'automatique' : nf.format(tune.ctxSlot) + ' tokens';
  $('#tCtxHelp').textContent = locked
    ? 'Ce modele fixe lui-meme son contexte au chargement : il n\'y a rien a regler ici.'
    : 'Contexte total ' + nf.format(e.ctxTotal) + ' tokens, partages entre les agents. '
      + 'Plus de contexte = plus de memoire occupee.';

  const pct = Math.min(100, e.total / e.usable * 100);
  $('#tvBar').style.width = pct + '%';
  $('#tvBar').className = e.over > 0 ? 'full' : pct >= 85 ? 'high' : '';
  $('#tvTotal').textContent = mb(e.total) + ' / ' + mb(e.usable);

  /* Un depassement n'a pas le meme sens selon la cle : pour un utilisateur
   * c'est un mur, pour l'administrateur c'est un choix - ce qui deborde ira en
   * RAM, plus lentement, et c'est a lui de trancher. */
  const admin = !!state.data.portal.allowOffload;
  const warn = $('#tWarn');
  warn.hidden = e.over <= 0;
  if (e.over > 0) {
    warn.innerHTML = admin
      ? `<b>Il manque ${mb(e.over)} sur la carte.</b> Tu peux lancer quand meme : ce qui ne rentre `
        + 'pas ira en RAM, et le modele tournera nettement plus lentement.'
      : `<b>Il manque ${mb(e.over)}.</b> Reduis le nombre d'agents`
        + (locked ? '' : ' ou le contexte') + ' : sans droits d\'administrateur, rien ne peut deborder hors du GPU.';
  }
  $('#tGo').disabled = e.over > 0 && !admin;
  $('#tGo').textContent = e.over > 0 && admin ? 'Demander quand meme' : 'Demander ce modele';
}

$('#tSlots').addEventListener('input', e => { tune.slots = +e.target.value; syncTuner(); });
$('#tCtx').addEventListener('input', e => {
  tune.ctxSlot = ctxSteps(tune.model)[+e.target.value];
  syncTuner();
});
$('#tunerBack').addEventListener('click', () => { tune.model = null; renderServer(); });

$('#tGo').addEventListener('click', async () => {
  const b = $('#tGo');
  b.disabled = true;
  b.textContent = 'demande envoyee...';
  try {
    await api('/launch', 'POST', {
      id: tune.model.id, slots: tune.slots, ctxSlot: tune.ctxSlot
    });
    tune.model = null;
    toast('Chargement lance. La page se met a jour toute seule.');
    setTimeout(load, 1500);
  } catch (err) {
    toast(err.message, true);
    b.disabled = false;
  }
  b.textContent = 'Demander ce modele';
});

$('#askList').addEventListener('click', async e => {
  const b = e.target.closest('.ask-row');
  if (!b || b.disabled) return;
  if (state.data.portal.allowTune) return openTuner(b.dataset.id);

  b.disabled = true;
  const go = $('.ask-go', b);
  const label = go.textContent;
  go.textContent = 'demande envoyee...';
  try {
    await api('/launch', 'POST', { id: b.dataset.id });
    toast('Chargement lance. La page se met a jour toute seule.');
    setTimeout(load, 1500);
  } catch (err) {
    toast(err.message, true);
    go.textContent = label;
    b.disabled = false;
  }
});

// --------------------------------------------------------------------------
// exemples de connexion
// --------------------------------------------------------------------------
function renderConnect() {
  const url = location.origin + '/v1';
  const sv = state.data.server;
  const loaded = state.data.models.find(m => m.loaded) || state.data.models[0] || {};
  const model = sv.modelId || loaded.id || 'nom-du-modele';
  const key = state.key;

  const openc = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      llamacpp: {
        npm: '@ai-sdk/openai-compatible',
        name: 'llama.cpp maison',
        options: { baseURL: url, apiKey: key },
        models: {}
      }
    }
  };
  for (const m of state.data.models) {
    const e = {
      name: m.name,
      cost: { input: m.price.in, output: m.price.out },
      limit: { context: m.ctx || 32768, output: 8192 }
    };
    if (m.vision) e.modalities = { input: ['text', 'image'], output: ['text'] };
    openc.provider.llamacpp.models[m.id] = e;
  }

  const snippets = {
    url: `Adresse de base   ${url}\nCle API           ${key}\nModele            ${model}\n\n`
       + `A coller partout ou on peut choisir "OpenAI compatible" :\nLM Studio, Open WebUI, Cherry Studio, Chatbox, Cline, Continue...`,
    opencode: `// ~/.config/opencode/opencode.json  (ou opencode.json a la racine du projet)\n`
       + `//\n`
       + `// "cost" est en unites par million de tokens. Sans ce bloc, opencode\n`
       + `// affiche 0 : il calcule la depense lui-meme et ne lit pas le champ\n`
       + `// usage.cost renvoye par la passerelle.\n\n`
       + JSON.stringify(openc, null, 2),
    curl: `curl ${url}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '{\n    "model": "${model}",\n    "messages": [{"role": "user", "content": "Bonjour"}]\n  }'\n\n`
       + `# le cout de la requete revient dans la reponse, champ usage.cost`,
    py: `from openai import OpenAI\n\nclient = OpenAI(base_url="${url}", api_key="${key}")\n\n`
       + `r = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Bonjour"}],\n)\n`
       + `print(r.choices[0].message.content)\nprint("coute", r.usage.model_extra.get("cost"))`
  };
  $('#cxSnippet').textContent = snippets[state.tab];
}

$('#cxTabs').addEventListener('click', e => {
  const t = e.target.closest('.tab');
  if (!t) return;
  state.tab = t.dataset.t;
  $$('#cxTabs .tab').forEach(x => x.classList.toggle('on', x === t));
  renderConnect();
});
$('#cxCopy').addEventListener('click', () => copy($('#cxSnippet').textContent, 'Extrait'));

// --------------------------------------------------------------------------
// activite
// --------------------------------------------------------------------------
function renderActivity() {
  const rows = state.data.activity || [];
  $('#actHint').textContent = rows.length ? rows.length + ' dernieres' : '';
  $('#actTable tbody').innerHTML = rows.length
    ? rows.map(a => `<tr>
        <td class="mono">${hhmm(a.at)}</td>
        <td>${esc(a.model)}</td>
        <td class="num" title="${a.tokensCached ? tok(a.tokensCached) + ' relus du cache' : ''}">${tok(a.tokensIn)}${a.exact ? '' : '~'}${
          a.tokensCached ? ` <span class="cache-part">${Math.round(a.tokensCached / Math.max(1, a.tokensIn) * 100)}% ⤒</span>` : ''}</td>
        <td class="num">${tok(a.tokensOut)}${a.exact ? '' : '~'}</td>
        <td class="num cost">${a.cost != null ? money(a.cost) : '—'}</td>
        <td class="num">${a.ms < 1000 ? a.ms + ' ms' : (a.ms / 1000).toFixed(1) + ' s'}</td>
        <td class="num ${a.status < 400 ? 'ok' : 'ko'}">${a.status}</td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty">Aucune requete avec cette cle pour l\'instant.</td></tr>';
}

// --------------------------------------------------------------------------
// avis : cinq etoiles, une fois, et on n'en reparle plus
// --------------------------------------------------------------------------
/* Le serveur decide s'il y a lieu de demander - assez de requetes, pas
 * d'avis recent. Le navigateur ajoute son propre refus : quelqu'un qui ferme
 * la boite ne doit pas la revoir a chaque rechargement de page. */
const RATE_SNOOZE = 'llamadash.rate.snooze';
const MOTS = ['', 'ca ne va pas', 'peut mieux faire', 'correct', 'tres bien', 'parfait'];
let noteChoisie = 0;

/* La boite enchaine trois temps : la note, la question du moment s'il y en a
 * une, puis un merci. Elle ne revient qu'une fois par mois, et la fermer la
 * repousse d'une semaine. */
function renderRate() {
  const d = state.data || {};
  const veutNote = (d.rating || {}).ask;
  const veutQuestion = !!d.poll;
  const repousse = Number(localStorage.getItem(RATE_SNOOZE) || 0);
  const pop = $('#ratePop');
  if (pop.dataset.done || Date.now() < repousse || (!veutNote && !veutQuestion)) {
    if (!pop.dataset.open) pop.hidden = true;
    return;
  }
  if (pop.dataset.open) return;

  if (veutQuestion) {
    $('#pollQuestion').textContent = d.poll.question;
    $('#pollChoices').innerHTML = (d.poll.options || []).map((o, i) =>
      `<button class="poll-choice" data-i="${i}">${esc(o)}</button>`).join('');
    $('#pollAfter').hidden = !(d.poll.allowText !== false || !(d.poll.options || []).length);
  }
  // ni brutal ni timide : la boite se pose apres trois secondes
  clearTimeout(renderRate._t);
  renderRate._t = setTimeout(() => {
    if (pop.dataset.done) return;
    montrerEtape(veutNote ? 1 : 2);
    pop.dataset.open = '1';
    pop.hidden = false;
  }, 3000);
}

function montrerEtape(n) {
  $('#rateStep1').hidden = n !== 1;
  $('#rateStep2').hidden = n !== 2;
  $('#rateStep3').hidden = n !== 3;
}

function fermerPop(delai) {
  const pop = $('#ratePop');
  pop.dataset.done = '1';
  setTimeout(() => {
    pop.classList.add('out');
    setTimeout(() => { pop.hidden = true; pop.classList.remove('out'); delete pop.dataset.open; }, 220);
  }, delai || 0);
}

/* Etape suivante : la question s'il y en a une, sinon le merci. */
function apresLaNote() {
  if (state.data && state.data.poll) { montrerEtape(2); return; }
  montrerEtape(3);
  fermerPop(1400);
}

function peindreEtoiles(n) {
  $$('#rateStars button').forEach(b => b.classList.toggle('on', +b.dataset.n <= n));
  $('#rateLegend').textContent = MOTS[n] || 'clique une etoile';
}

$('#rateStars').addEventListener('mouseover', e => {
  const b = e.target.closest('button');
  if (b) peindreEtoiles(+b.dataset.n);
});
$('#rateStars').addEventListener('mouseleave', () => peindreEtoiles(noteChoisie));
$('#rateStars').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b || noteChoisie) return;
  noteChoisie = +b.dataset.n;
  peindreEtoiles(noteChoisie);
  b.classList.add('pop');
  // la note part tout de suite : c'est elle qui compte, le mot est un bonus
  await envoyerNote('');
  $('#rateAfter').hidden = false;
  $('#rateWord').focus();
});

async function envoyerNote(mot) {
  try {
    await api('/rate', 'POST', { stars: noteChoisie, comment: mot });
    if (state.data && state.data.rating) state.data.rating.ask = false;
  } catch (e) {
    if (e.status !== 429) toast(e.message, true);
  }
}

$('#rateSend').addEventListener('click', async () => {
  const mot = $('#rateWord').value.trim();
  if (mot) await envoyerNote(mot);   // meme avis, precise dans le quart d'heure
  apresLaNote();
});

// ---- la question du moment ----
let choixSondage = null;
$('#pollChoices').addEventListener('click', e => {
  const b = e.target.closest('.poll-choice');
  if (!b) return;
  choixSondage = +b.dataset.i;
  $$('.poll-choice').forEach(x => x.classList.toggle('on', x === b));
  if ($('#pollAfter').hidden) envoyerSondage();
});
$('#pollSend').addEventListener('click', () => envoyerSondage());

async function envoyerSondage() {
  const texte = $('#pollWord').value.trim();
  if (choixSondage === null && !texte) return toast('Choisis une reponse, ou ecris un mot.', true);
  try {
    await api('/poll', 'POST', { choice: choixSondage, text: texte });
    if (state.data) state.data.poll = null;
  } catch (e) { if (e.status !== 409) toast(e.message, true); }
  $('#rateThanks').textContent = 'Merci, c\'est note !';
  montrerEtape(3);
  fermerPop(1400);
}

$('#rateClose').addEventListener('click', () => {
  // repousse d'une semaine : refuser de repondre est une reponse
  localStorage.setItem(RATE_SNOOZE, String(Date.now() + 7 * 24 * 3600000));
  fermerPop(0);
});

// --------------------------------------------------------------------------
// chargement
// --------------------------------------------------------------------------
function showGate(msg) {
  $('#gate').hidden = false;
  $('#board').hidden = true;
  $('#who').hidden = true;
  $('#gateErr').textContent = msg || '';
  $('#gateKey').focus();
}

async function load() {
  try {
    state.data = await api('/me');
  } catch (e) {
    if (e.status === 401) { localStorage.removeItem(KEY_STORE); return showGate(e.message); }
    return toast(e.message, true);
  }
  // le rechargement periodique remplace les objets : on repointe le modele
  // en cours de reglage, sinon les curseurs travaillent sur des donnees mortes
  if (tune.model) tune.model = state.data.models.find(m => m.id === tune.model.id) || null;

  $('#gate').hidden = true;
  $('#board').hidden = false;
  $('#who').hidden = false;
  $('#whoName').textContent = state.data.key.name;
  $('#whoTail').textContent = '…' + state.data.key.tail;
  const role = state.data.key.role || 'user';
  const badge = $('#whoRole');
  badge.textContent = state.data.key.roleLabel || 'utilisateur';
  badge.className = 'portal-role ' + role;
  badge.title = role === 'admin'
    ? 'Cette cle peut tout demander, deport hors GPU compris.'
    : role === 'trusted'
      ? 'Cette cle peut charger, remplacer et arreter un modele, et regler agents et contexte.'
      : 'Cette cle se sert du modele charge. Charger ou arreter demande une cle de confiance.';
  renderBalance();
  renderServer();
  renderConnect();
  renderActivity();
  renderRate();
}

$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault();
  const k = $('#gateKey').value.trim();
  if (!k) return;
  state.key = k;
  try {
    state.data = await api('/me');
    localStorage.setItem(KEY_STORE, k);
    await load();
  } catch (err) { $('#gateErr').textContent = err.message; }
});

$('#signOut').addEventListener('click', () => {
  localStorage.removeItem(KEY_STORE);
  state.key = '';
  $('#gateKey').value = '';
  showGate('');
});

(function init() {
  const saved = localStorage.getItem(KEY_STORE);
  if (!saved) return showGate('');
  state.key = saved;
  load();
})();

// l'etat du serveur bouge sans nous : on relit tranquillement
setInterval(() => { if (state.key && !$('#board').hidden) load(); }, 15000);
