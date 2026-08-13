/* ==========================================================================
 * llama.cpp control panel - serveur (Node >= 18, aucune dependance)
 *
 *   - lit et ecrit le meme models.json que LLAMA.bat
 *   - lance / arrete llama-server.exe, capture les logs
 *   - expose une passerelle compatible OpenAI protegee par cles API
 *
 * llama-server est toujours lance sur 127.0.0.1 avec une cle interne
 * aleatoire : le reseau local ne peut l'atteindre qu'a travers cette
 * passerelle, donc la revocation d'une cle est immediate et sans redemarrage.
 * ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const KEYS_PATH = path.join(APP_DIR, 'keys.json');
const STATS_PATH = path.join(APP_DIR, 'stats.json');
const ACTIVITY_PATH = path.join(APP_DIR, 'activity.jsonl');
const RATINGS_PATH = path.join(APP_DIR, 'ratings.jsonl');
const POLL_PATH = path.join(APP_DIR, 'poll-answers.jsonl');

const DEFAULT_CONFIG = {
  modelsJson: path.join(__dirname, 'models.json'),
  port: 3939,
  upstreamHost: '127.0.0.1',
  upstreamPort: 8080,
  adminPassword: '',
  reserveMb: 512,
  autoStartLast: false,
  lastLaunch: null,
  // acces depuis l'exterieur du reseau local
  remote: {
    enabled: false,
    method: 'off',        // off | cloudflare | tailscale | manual
    publicUrl: ''         // rempli par le tunnel, ou saisi a la main
  },
  // tarifs : sert a facturer les cles et a afficher ce que ca aurait coute
  pricing: {
    enabled: true,
    currency: 'USD',
    defaultIn: 0.10,      // par million de tokens
    defaultOut: 0.30,
    // Un token deja en cache n'a pas ete recalcule : il ne coute pas le prix
    // d'entree. Comme chez les fournisseurs, on le compte a une fraction de
    // celui-ci - un dixieme par defaut. Un prix explicite par modele
    // (price_cache dans models.json) l'emporte sur ce rapport.
    cacheRatio: 0.10,
    // Prix du kilowattheure, pour chiffrer ce que la carte a reellement coute.
    // Par defaut la moyenne des deux tarifs francais courants : 18 centimes en
    // heures creuses, 25 en heures pleines.
    kwhPrice: 0.215,
    kwhCurrency: 'EUR',
    // renvoyer le cout dans la reponse OpenAI (usage.cost), comme OpenRouter :
    // c'est ce que lisent opencode et les clients compatibles
    reportCost: true
  },
  // Quand tous les agents travaillent, les requetes suivantes s'empilent dans
  // llama.cpp sans que personne ne le sache. Au-dela de cette file, la
  // passerelle refuse avec un chiffre et un Retry-After plutot que de faire
  // attendre en silence. queuePerSlot = requetes en attente tolerees par agent.
  overload: {
    enabled: true,
    queuePerSlot: 1
  },
  /* Reglages d'echantillonnage du modele, appliques aux requetes :
   *   fill  - on ne remplit que ce que le client n'a pas precise
   *   force - le reglage du modele l'emporte, meme sur ce que le client envoie
   *   off   - on ne touche a rien */
  sampling: { mode: 'fill' },
  // decharge le modele apres N minutes sans la moindre requete. 0 = jamais.
  idleUnloadMin: 3,
  // Le nom de modele envoye par le client fait foi : s'il figure au catalogue,
  // c'est celui-la qui sert, quitte a le charger. Sans quoi le client affiche
  // le tarif d'un modele et en consomme un autre.
  autoLoad: {
    enabled: true,     // charger le modele demande quand rien ne tourne
    swap: true,        // remplacer un modele qui ne sert plus personne
    swapIdleS: 60,     // ... a condition qu'il n'ait rien servi depuis ce delai
    waitS: 180         // au-dela, la requete repart en erreur plutot qu'attendre
  },
  /* Une question posee aux porteurs de cles depuis le portail. L'admin l'ecrit,
   * propose jusqu'a quatre reponses - ou aucune, et c'est alors du texte
   * libre. Changer la question fait un nouveau sondage : ceux qui ont repondu
   * a l'ancienne sont a nouveau interroges. */
  poll: {
    id: 0,           // horodatage de creation, 0 = aucun sondage
    active: false,
    question: '',
    options: [],
    allowText: true  // laisser ajouter un mot en plus du choix
  },
  // espace utilisateur : une page ou le porteur d'une cle voit son solde.
  // Ce qu'une personne a le droit de faire ne se regle plus ici mais sur sa
  // cle : voir les roles plus bas (utilisateur / de confiance / administrateur).
  portal: {
    enabled: true,
    topupEnabled: false,  // ajout de fonds par l'utilisateur : volontairement coupe
    launchCooldownS: 60
  }
};

// --------------------------------------------------------------------------
// petites aides fichiers
// --------------------------------------------------------------------------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/* Ecriture par fichier temporaire puis renommage : jamais de fichier a moitie
 * ecrit, meme si la machine s'arrete au mauvais moment.
 *
 * Sous Windows, le renommage se fait parfois refuser une fraction de seconde -
 * un antivirus ou l'indexeur vient d'ouvrir le .tmp qu'on vient de creer. Trois
 * essais espaces suffisent ; sans eux, l'utilisateur perd sa saisie pour une
 * raison qui n'a rien a voir avec lui. */
function writeJson(file, data) {
  const tmp = file + '.tmp';
  const texte = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, texte, 'utf8');
  let derniere = null;
  for (let essai = 0; essai < 3; essai++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      derniere = e;
      // pause courte et bloquante : on est dans un chemin d'ecriture rare
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
    }
  }
  // le renommage n'a jamais voulu : on ecrit en place plutot que de renoncer
  try {
    fs.writeFileSync(file, texte, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  } catch {
    throw derniere;
  }
}

let config = Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_PATH, {}));
config.remote = Object.assign({}, DEFAULT_CONFIG.remote, config.remote);
config.pricing = Object.assign({}, DEFAULT_CONFIG.pricing, config.pricing);
config.portal = Object.assign({}, DEFAULT_CONFIG.portal, config.portal);
config.autoLoad = Object.assign({}, DEFAULT_CONFIG.autoLoad, config.autoLoad);
config.overload = Object.assign({}, DEFAULT_CONFIG.overload, config.overload);
config.poll = Object.assign({}, DEFAULT_CONFIG.poll, config.poll);
config.sampling = Object.assign({}, DEFAULT_CONFIG.sampling, config.sampling);
// les droits du portail sont passes sur les cles : on nettoie les anciens champs
for (const mort of ['allowLaunch', 'allowTune', 'allowStop']) delete config.portal[mort];
function saveConfig() { writeJson(CONFIG_PATH, config); }
if (!fs.existsSync(CONFIG_PATH)) saveConfig();

let keyStore = readJson(KEYS_PATH, { keys: [] });
function saveKeys() { writeJson(KEYS_PATH, keyStore); }
if (!fs.existsSync(KEYS_PATH)) saveKeys();

let stats = readJson(STATS_PATH, { days: {} });
let statsDirty = false;
setInterval(() => {
  if (statsDirty) { writeJson(STATS_PATH, stats); statsDirty = false; }
}, 10000).unref();

const INTERNAL_KEY = crypto.randomBytes(24).toString('hex');

// --------------------------------------------------------------------------
// models.json partage avec LLAMA.bat
// --------------------------------------------------------------------------
/* Relu seulement quand le fichier change : le calcul du cout tape ici a
 * chaque requete de la passerelle. */
let modelsCache = { at: 0, mtime: 0, doc: null };

function loadModels() {
  let mtime = 0;
  try { mtime = fs.statSync(config.modelsJson).mtimeMs; } catch {}
  if (modelsCache.doc && modelsCache.mtime === mtime && modelsCache.path === config.modelsJson) {
    return modelsCache.doc;
  }
  const raw = readJson(config.modelsJson, null)
    || { defaults: { port: 8080, gpu_layers: 99, reserve_mb: 512, batch: 2048, ubatch: 512, api_key: '' }, models: [] };
  raw.defaults = raw.defaults || {};
  raw.models = Array.isArray(raw.models) ? raw.models : [];
  modelsCache = { mtime, doc: raw, path: config.modelsJson };
  return raw;
}

function saveModels(doc) {
  // La copie de sauvegarde est un confort, pas une condition : si elle echoue -
  // fichier tenu par un editeur, antivirus en train de lire - on enregistre
  // quand meme plutot que de perdre le travail de l'utilisateur.
  try {
    if (fs.existsSync(config.modelsJson)) {
      fs.copyFileSync(config.modelsJson, config.modelsJson + '.bak');
    }
  } catch (e) {
    pushLog('err', 'Copie de sauvegarde de models.json impossible (' + e.code + ') : '
      + 'on enregistre quand meme.');
  }
  writeJson(config.modelsJson, doc);
  modelsCache = { mtime: 0, doc: null, path: '' };
  // un chemin vient peut-etre de changer : ce qu'on savait des fichiers ne
  // vaut plus, on repart d'une page blanche
  statCache.clear();
}

/* --------------------------------------------------------------------------
 * Etat des fichiers, garde en memoire
 *
 * Decrire le catalogue demande, pour chaque modele, la taille et la presence du
 * .gguf, du projecteur, du draft et du lora : plus de cent cinquante acces
 * disque a chaque lecture d'etat. Sur un disque de modeles qui s'endort, le
 * premier reveille le moteur pendant plusieurs secondes - et la console qui se
 * voulait instantanee fait patienter.
 *
 * Un .gguf ne change ni de taille ni de place en cours de route : on garde donc
 * le resultat quelques secondes. Ecrire le catalogue vide le cache, pour que ce
 * qu'on vient de changer se voie tout de suite.
 * ----------------------------------------------------------------------- */
const STAT_TTL = 15000;
const statCache = new Map();

function fileInfo(p) {
  if (!p) return { exists: false, mb: 0 };
  const now = Date.now();
  const garde = statCache.get(p);
  if (garde && now - garde.at < STAT_TTL) return garde.v;
  let v = { exists: false, mb: 0 };
  try {
    const s = fs.statSync(p);
    v = { exists: s.isFile(), mb: Math.round(s.size / (1024 * 1024)) };
  } catch {}
  statCache.set(p, { at: now, v });
  return v;
}

function fileSizeMb(p) { return fileInfo(p).mb; }
function fileExists(p) { return fileInfo(p).exists; }

/* ---------------------------------------------------------------------------
 * Tarifs. Chaque modele porte price_in / price_out dans models.json, en unites
 * monetaires par million de tokens. Quand rien n'est renseigne, on propose un
 * tarif deduit du nombre de parametres lu dans le nom du fichier - c'est un
 * point de depart a corriger a la main, pas une verite.
 * ------------------------------------------------------------------------- */
const PRICE_BY_SIZE = [
  [4, 0.02, 0.05], [9, 0.05, 0.10], [15, 0.10, 0.20],
  [24, 0.15, 0.35], [40, 0.25, 0.60], [Infinity, 0.50, 1.20]
];

function paramsB(m) {
  const s = (m.name || '') + ' ' + (m.model || '');
  const hit = s.match(/(\d+(?:[.,]\d+)?)\s*[bB](?![a-zA-Z])/);
  return hit ? parseFloat(hit[1].replace(',', '.')) : null;
}

function suggestedPrice(m) {
  const b = paramsB(m);
  if (b == null) return { in: config.pricing.defaultIn, out: config.pricing.defaultOut };
  const row = PRICE_BY_SIZE.find(r => b <= r[0]);
  return { in: row[1], out: row[2] };
}

const rempli = v => v !== undefined && v !== '' && v !== null;

/* Prix des tokens relus depuis le cache. llama.cpp les compte separement
 * (usage.prompt_tokens_details.cached_tokens) : ils n'ont pas ete recalcules,
 * les facturer au prix d'entree reviendrait a faire payer deux fois le meme
 * travail. Un prix explicite par modele l'emporte ; sinon c'est une fraction
 * de l'entree. */
function cachePrice(model, prixIn) {
  if (model && rempli(model.price_cache) && Number.isFinite(Number(model.price_cache))) {
    return Math.max(0, Number(model.price_cache));
  }
  const r = Number(config.pricing.cacheRatio);
  return prixIn * (Number.isFinite(r) && r >= 0 ? Math.min(1, r) : 0.1);
}

function priceOf(model) {
  // modele inconnu : on facture au tarif par defaut plutot que gratuitement
  let p;
  if (!model) {
    p = { in: config.pricing.defaultIn, out: config.pricing.defaultOut, suggested: true };
  } else if (rempli(model.price_in) || rempli(model.price_out)) {
    p = { in: Number(model.price_in) || 0, out: Number(model.price_out) || 0, suggested: false };
  } else {
    p = Object.assign(suggestedPrice(model), { suggested: true });
  }
  p.cache = cachePrice(model, p.in);
  p.cacheSuggested = !(model && rempli(model.price_cache));
  return p;
}

function costOf(modelId, tokensIn, tokensOut, tokensCached) {
  if (!config.pricing.enabled) return 0;
  const doc = loadModels();
  const m = doc.models.find(x => x.id === modelId)
    || doc.models.find(x => x.name === modelId)
    || doc.models.find(x => x.id === runtime.modelId);
  const p = priceOf(m);
  // les tokens caches font partie de l'entree : on ne les compte pas deux fois
  const cache = Math.min(Math.max(0, Number(tokensCached) || 0), tokensIn);
  const frais = tokensIn - cache;
  return (frais / 1e6) * p.in + (cache / 1e6) * p.cache + (tokensOut / 1e6) * p.out;
}

/* --------------------------------------------------------------------------
 * Familles
 *
 * Cinq Gemma 4 12B qui ne different que par la quantification ou le fine-tune,
 * ce sont cinq lignes pour un seul choix. On les regroupe : la cle de famille
 * est deduite de l'identifiant, qui porte deja cette forme
 * (gemma4-12b-google, gemma4-12b-lora...). Un champ family dans models.json
 * l'emporte si l'admin veut regrouper autrement.
 * ----------------------------------------------------------------------- */
const SIZE_SEG = /^\d+(?:[.,]\d+)?[bm]$/;      // 12b, 27b, 1.5b
const ACTIVE_SEG = /^a\d+(?:[.,]\d+)?[bm]$/;   // la partie active d'un MoE : 35b-a3b

function familyKey(m) {
  if (m.family) return String(m.family).toLowerCase().trim();
  return idFamilyKey(m);
}

/* La famille telle que l'identifiant la donne, sans tenir compte d'un
 * rattachement manuel : sert a savoir qui est d'origine dans une famille. */
function idFamilyKey(m) {
  const segs = String(m.id || '').toLowerCase().split('-');
  for (let i = 0; i < segs.length; i++) {
    if (!SIZE_SEG.test(segs[i])) continue;
    const n = ACTIVE_SEG.test(segs[i + 1] || '') ? i + 2 : i + 1;
    return segs.slice(0, n).join('-');
  }
  return String(m.id || '').toLowerCase();
}

/* Le nom de la famille est celui de ses membres, ampute de ce qui les
 * distingue : « Gemma 4 12B QAT - Unsloth UD-Q4_K_XL » donne « Gemma 4 12B
 * QAT », et on garde le plus court des membres, qui est aussi le plus general.
 *
 * Quand un modele est rattache a la main a une famille qui n'est pas la sienne
 * - les Bonsai sont des Qwen3.6 27B, leur identifiant ne le dit pas - ce sont
 * les membres d'origine qui nomment la famille, pas les rattaches : sans quoi
 * « Bonsai 27B », plus court, volerait le nom du reseau dont il derive. */
function familyLabel(cle, members) {
  const impose = members.map(m => m.family_name).find(Boolean);
  if (impose) return String(impose);
  const base = n => String(n)
    .split(/\s+[-–—]\s+|\s+\+\s+/)[0]
    .replace(/\s+(UD-)?I?Q\d\S*$/i, '')   // ... - Q4_K_M, IQ3_XXS, UD-Q4_K_XL
    .replace(/\s+(UD|AD|XL|GGUF)$/i, '')  // marqueurs de variante restes seuls
    .trim();
  const natifs = members.filter(m => idFamilyKey(m) === cle);
  const noms = (natifs.length ? natifs : members).map(m => base(m.name || m.id)).filter(Boolean);
  if (!noms.length) return members[0] ? members[0].id : '';
  return noms.reduce((a, b) => (b.length < a.length ? b : a));
}

let famCache = { doc: null, map: null };
function families() {
  const doc = loadModels();
  if (famCache.doc === doc) return famCache.map;
  const groups = new Map();
  for (const m of doc.models) {
    const k = familyKey(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const map = new Map();
  for (const [k, membres] of groups) {
    map.set(k, { key: k, label: familyLabel(k, membres), count: membres.length });
  }
  famCache = { doc, map };
  return map;
}

function familyOf(m) {
  const k = familyKey(m);
  return families().get(k) || { key: k, label: m.name || m.id, count: 1 };
}

/* Toute reponse qui renvoie des modeles doit passer par ici : si le prix
 * manque, l'interface reaffiche 0 et le prochain enregistrement ecrase les
 * tarifs de models.json. */
function modelPayload(m) {
  const f = familyOf(m);
  return Object.assign(describeModel(m), {
    price: priceOf(m),
    family: f.key, familyName: f.label, familySize: f.count
  });
}

/* Etat enrichi d'un modele : tailles reelles, presence des fichiers. */
function describeModel(m) {
  const binExe = m.bin ? path.join(m.bin, 'llama-server.exe') : '';
  return Object.assign({}, m, {
    modelMb: fileSizeMb(m.model),
    mmprojMb: fileSizeMb(m.mmproj),
    draftMb: fileSizeMb(m.draft),
    loraMb: fileSizeMb(m.lora),
    hasModel: fileExists(m.model),
    hasMmproj: fileExists(m.mmproj),
    hasDraft: fileExists(m.draft),
    // tete MTP incluse dans le .gguf : pas de fichier a cote, mais du draft
    // quand meme - llama.cpp monte le contexte sur le modele lui-meme
    hasMtp: !!m.mtp_builtin || fileExists(m.draft),
    hasLora: fileExists(m.lora),
    hasBin: fileExists(binExe)
  });
}

// --------------------------------------------------------------------------
// GPU
// --------------------------------------------------------------------------
let gpuState = { name: 'lecture...', totalMb: 0, usedMb: 0, utilPct: 0, tempC: 0, powerW: 0, ok: false, at: 0 };

function pollGpu() {
  execFile('nvidia-smi',
    ['--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw',
     '--format=csv,noheader,nounits'],
    { timeout: 4000 },
    (err, stdout) => {
      if (err || !stdout) {
        gpuState = Object.assign({}, gpuState, { name: 'GPU non detecte', ok: false, at: Date.now() });
        return;
      }
      const p = stdout.trim().split('\n')[0].split(',').map(s => s.trim());
      // Energie consommee depuis la mesure precedente. La puissance lue est
      // celle de la carte a l'instant t ; multipliee par le temps ecoule, elle
      // donne des watt-heures, qu'on accumule par journee. C'est la seule
      // facon honnete de chiffrer ce que tout ceci coute vraiment.
      const wattsAvant = gpuState.ok ? gpuState.powerW : 0;
      const dt = gpuState.at ? Date.now() - gpuState.at : 0;
      const watts = Math.round(parseFloat(p[5]) || 0);
      if (wattsAvant > 0 && dt > 0 && dt < 60000) {
        // moyenne des deux mesures : plus juste qu'un simple echantillon
        ajouterEnergie(((wattsAvant + watts) / 2) * (dt / 3600000));
      }
      gpuState = {
        name: p[0] || 'GPU',
        totalMb: parseInt(p[1], 10) || 0,
        usedMb: parseInt(p[2], 10) || 0,
        utilPct: parseInt(p[3], 10) || 0,
        tempC: parseInt(p[4], 10) || 0,
        powerW: Math.round(parseFloat(p[5]) || 0),
        ok: true,
        at: Date.now()
      };
    });
}
pollGpu();
setInterval(pollGpu, 3000).unref();

// --------------------------------------------------------------------------
// Serveur llama.cpp : cycle de vie
// --------------------------------------------------------------------------
const LOG_MAX = 1200;
const runtime = {
  proc: null,
  pid: null,
  modelId: null,
  modelName: null,
  args: [],
  cmdline: '',
  launch: null,        // parametres retenus
  startedAt: 0,
  ready: false,
  exitCode: null,
  exitAt: 0,
  logs: [],
  slots: null,
  metrics: null,
  lastActivity: 0,     // derniere requete passee par la passerelle
  idleStopped: false   // le dernier arret vient du dechargement automatique
};

/* Requetes en cours. Les emplacements de llama.cpp sont sondes toutes les deux
 * secondes : trop lent pour savoir si quelqu'un attend une reponse a l'instant.
 * Ce compteur, lui, est exact. */
let inFlight = 0;

/* --------------------------------------------------------------------------
 * Cache de prompt : la valeur du moment
 *
 * Deux niveaux. Le defaut vit dans models.json et survit a tout. La valeur de
 * session vit ici, en memoire : elle s'applique a tous les chargements jusqu'a
 * la fermeture de la console, et disparait avec elle. De quoi essayer un
 * reglage sans l'inscrire nulle part.
 *
 * Un modele deja charge garde le reglage avec lequel il est parti : le drapeau
 * se transmet au lancement, pas en cours de route.
 * ----------------------------------------------------------------------- */
let sessionCacheRam = null;   // null = on suit le defaut

/* --------------------------------------------------------------------------
 * Charge et partage
 *
 * llama.cpp sert autant de requetes en parallele qu'il a d'agents ; au-dela,
 * elles s'empilent dans sa file sans que personne ne le sache. La passerelle,
 * elle, compte exactement ce qui est en vol : de quoi refuser proprement plutot
 * que faire attendre en silence, et empecher qu'une seule cle prenne tout.
 * ----------------------------------------------------------------------- */
const inFlightByKey = new Map();

function keyLoad(id) { return inFlightByKey.get(id) || 0; }
function keyLoadAdd(id, n) {
  const v = keyLoad(id) + n;
  if (v > 0) inFlightByKey.set(id, v); else inFlightByKey.delete(id);
}

/* Combien d'agents une cle peut occuper en meme temps. L'administrateur n'est
 * pas bride ; une cle de confiance en prend deux quand la carte en offre plus
 * de deux, sinon un ; un simple utilisateur en prend un. Le but n'est pas
 * d'economiser, c'est d'empecher qu'une seule session avale tous les agents et
 * laisse les autres devant une porte fermee. */
function slotBudget(key) {
  const role = roleOf(key);
  if (role === 'admin') return Infinity;
  const agents = (runtime.slots || []).length
    || (runtime.launch && runtime.launch.slots) || 1;
  if (role === 'trusted') return agents > 2 ? 2 : 1;
  return 1;
}

/* Duree des dernieres reponses, pour estimer une attente honnete plutot que
 * d'annoncer un chiffre invente. */
const recentMs = [];
function noteDuree(ms, tokensOut) {
  // une reponse d'une ligne ne dit rien du temps d'attente d'une vraie requete
  if (!(ms > 0) || !(tokensOut > 20)) return;
  recentMs.push(ms);
  if (recentMs.length > 40) recentMs.shift();
}
function dureeMediane() {
  if (!recentMs.length) return 0;
  const t = recentMs.slice().sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
}

/* Etat de la charge, tel qu'on l'affiche et tel qu'on le decide. */
function loadState() {
  const agents = (runtime.slots || []).length
    || (runtime.launch && runtime.launch.slots) || 0;
  const busy = (runtime.slots || []).filter(s => s.busy).length;
  // le sondage des slots a deux secondes de retard : le compte en vol, lui,
  // est exact. On garde le plus pessimiste des deux.
  const occupes = Math.min(agents || inFlight, Math.max(busy, Math.min(inFlight, agents || inFlight)));
  const file = Math.max(0, inFlight - (agents || inFlight));
  const mediane = dureeMediane();
  return {
    agents,
    busy: occupes,
    inFlight,
    queue: file,
    free: Math.max(0, agents - occupes),
    // attente estimee : les requetes devant nous, reparties sur les agents
    waitS: agents && mediane ? Math.round(mediane / 1000 * Math.ceil((file + 1) / agents)) : 0,
    medianMs: mediane
  };
}

function effectiveCacheRam(model, defaults) {
  if (sessionCacheRam != null) return sessionCacheRam;
  const d = defaults || (loadModels().defaults || {});
  const perModele = model && model.cache_ram_mb;
  if (perModele !== undefined && perModele !== '' && perModele !== null
      && Number.isFinite(Number(perModele))) {
    return Number(perModele);
  }
  return Number.isFinite(Number(d.cache_ram_mb)) ? Number(d.cache_ram_mb) : 4096;
}

function cacheRamPayload() {
  const d = loadModels().defaults || {};
  return {
    session: sessionCacheRam,
    default: Number.isFinite(Number(d.cache_ram_mb)) ? Number(d.cache_ram_mb) : 4096,
    effective: effectiveCacheRam(null, d),
    // ce avec quoi le modele en service a reellement demarre
    running: runtime.proc && runtime.launch ? runtime.launch.cacheRam : null
  };
}

function pushLog(stream, text) {
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = { t: Date.now(), s: stream, m: line };
    runtime.logs.push(entry);
    if (runtime.logs.length > LOG_MAX) runtime.logs.shift();
    broadcast('log', entry);
  }
}

/* La formulation des logs change d'un build a l'autre : on considere le
 * serveur pret quand /health repond, pas quand une ligne le dit. */
function watchReady() {
  const startedFor = runtime.startedAt;
  const tick = async () => {
    if (runtime.startedAt !== startedFor || !runtime.proc || runtime.ready) return;
    const r = await upstreamGet('/health');
    if (r && r.status === 200) {
      runtime.ready = true;
      pushLog('sys', 'Modele pret, la passerelle accepte les requetes.');
      broadcast('status', statusPayload());
      return;
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1500);
}

/* Deux raisons de ne pas transmettre -c :
 *   dspark - avec ce type de draft, -c fait doubler le contexte alloue et le
 *            chargement echoue
 *   auto   - contexte a -1, l'utilisateur laisse la main a llama.cpp pour ne
 *            regler que le nombre d'agents
 * Renvoie la raison, ou une chaine vide si -c doit bien etre transmis. */
function ctxOmitReason(model, L) {
  if (L.mtp && model.draft && (model.spec_type || '') === 'draft-dspark') return 'dspark';
  if (L.ctxSlot === -1) return 'auto';
  return '';
}

/* Estimation de la VRAM, meme calcul que LLAMA.bat et que le tiroir.
 * Quand -c n'est pas transmis, la taille du cache KV n'est pas connue : on la
 * majore avec la fenetre native, ce qui donne une borne haute honnete plutot
 * qu'un zero rassurant. */
const KVF = { q4_0: 1000, q5_0: 1222, q8_0: 1889, f16: 3556 };

function estimateVram(model, L) {
  const d = describeModel(model);
  const noCtx = !!ctxOmitReason(model, L);
  const perSlot = noCtx ? (Number(model.native_ctx) || 32768) : L.ctxSlot;
  const ctxTotal = perSlot * L.slots;
  const kvf = KVF[L.cache] || 1000;
  const kv = Math.round((ctxTotal / 1024) * (Number(model.kv_kb_token) || 20) * kvf / 1000)
    + L.slots * (Number(model.swa_mb) || 0);
  const weights = (d.modelMb || 0)
    + (L.vision === 1 ? (d.mmprojMb || 0) : 0)
    + (L.mtp ? (d.draftMb || 0) : 0)
    + (d.hasLora ? (d.loraMb || 0) : 0);
  const compute = 400 + L.slots * 60;
  const busy = runtime.proc ? 0 : (gpuState.usedMb || 0);
  const usable = Math.max(256, (gpuState.totalMb || 0) - busy - (config.reserveMb ?? 512));
  const total = kv + weights + compute;
  return { kv, weights, compute, total, usable, ctxTotal, kvGuessed: noCtx, over: total - usable };
}

/* --------------------------------------------------------------------------
 * Echantillonnage
 *
 * Chaque modele a ses valeurs, et elles ne se ressemblent pas : Qwen3.6 veut
 * 0.6 pour le code, Gemma 4 se degrade en dessous de 1.0, LFM 2.5 demande 0.2.
 * Les valeurs vivent dans models.json, sous "sampling".
 *
 * Elles sont appliquees deux fois. En drapeaux au lancement, pour les clients
 * qui ne demandent rien. Et dans le corps de la requete, parce qu'un client qui
 * envoie sa propre temperature ecrase le drapeau du serveur - c'est un
 * comportement connu de llama.cpp, et opencode envoie la sienne.
 * ----------------------------------------------------------------------- */
const SAMPLING_KEYS = ['temp', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'repeat_penalty'];

function samplingOf(model) {
  const s = (model && model.sampling) || {};
  const out = {};
  for (const k of SAMPLING_KEYS) {
    const v = Number(s[k]);
    if (s[k] !== undefined && s[k] !== '' && s[k] !== null && Number.isFinite(v)) out[k] = v;
  }
  if (typeof s.samplers === 'string' && s.samplers.trim()) out.samplers = s.samplers.trim();
  return out;
}

/* --------------------------------------------------------------------------
 * Reflexion
 *
 * Trois leviers, et ils ne servent pas aux memes modeles :
 *   mode    - --reasoning on/off/auto. Sans effet sur les modeles dont le
 *             gabarit ouvre la reflexion sans condition (Muse Glimmer).
 *   budget  - --reasoning-budget : plafond de tokens de reflexion. 0 la coupe
 *             net, -1 la laisse libre. Marche meme quand le mode ne fait rien.
 *   gabarit - --chat-template-kwargs : les variables que le gabarit du modele
 *             comprend. C'est la que vivent enable_thinking (Qwen3.6) et
 *             reasoning_strength (Muse Glimmer : low/medium/high/xhigh).
 *
 * Les deux premiers sont des drapeaux de lancement. Le troisieme part aussi
 * dans chaque requete, parce qu'un client qui n'en sait rien n'en enverra
 * jamais - et c'est le seul qui change vraiment quelque chose sur certains
 * modeles.
 * ----------------------------------------------------------------------- */
function thinkingOf(model) {
  const t = (model && model.thinking) || {};
  const out = {};
  if (['on', 'off', 'auto'].includes(t.mode)) out.mode = t.mode;
  if (t.budget !== undefined && t.budget !== '' && t.budget !== null
      && Number.isFinite(Number(t.budget))) {
    out.budget = Math.round(Number(t.budget));
  }
  if (['none', 'deepseek', 'deepseek-legacy', 'auto'].includes(t.format)) out.format = t.format;
  if (typeof t.preserve === 'boolean') out.preserve = t.preserve;
  if (t.kwargs && typeof t.kwargs === 'object' && Object.keys(t.kwargs).length) {
    out.kwargs = t.kwargs;
  }
  return out;
}

/* Les noms cote API OpenAI ne sont pas ceux des drapeaux. */
const SAMPLING_BODY = {
  temp: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  presence_penalty: 'presence_penalty',
  repeat_penalty: 'repeat_penalty'
};

/* Complete - ou impose - les reglages du modele dans le corps d'une requete.
 * Renvoie vrai si quelque chose a change. */
function appliquerEchantillonnage(body, modelId, asked) {
  const mode = (config.sampling && config.sampling.mode) || 'fill';
  if (mode === 'off' || !body || typeof body !== 'object') return false;
  const modele = loadModels().models.find(m => m.id === modelId);
  const s = samplingOf(modele);
  let change = false;
  for (const [cle, champ] of Object.entries(SAMPLING_BODY)) {
    if (s[cle] === undefined) continue;
    const absent = body[champ] === undefined || body[champ] === null;
    if (mode === 'force' || absent) {
      if (body[champ] !== s[cle]) { body[champ] = s[cle]; change = true; }
    }
  }

  /* Les variables de gabarit voyagent aussi : c'est par elles que passent
   * enable_thinking et reasoning_strength, et aucun client ne les envoie de
   * lui-meme. On complete cle par cle, sans ecraser ce que le client a dit -
   * sauf en mode « imposer ». */
  const t = thinkingOf(modele);
  /* Le niveau reclame par la requete l'emporte sur le defaut du modele : c'est
   * lui qui permet de choisir « muse-glimmer-30b:low » depuis n'importe quel
   * client, sans rien relancer. */
  const niveau = niveauDemande(asked, body, modele);
  const voulu = Object.assign({}, t.kwargs || null, niveau ? niveau.kwargs : null);

  if (Object.keys(voulu).length) {
    const actuel = (body.chat_template_kwargs && typeof body.chat_template_kwargs === 'object')
      ? body.chat_template_kwargs : {};
    const fusion = Object.assign({}, actuel);
    for (const [k, v] of Object.entries(voulu)) {
      // un niveau demande explicitement passe devant ce que le client avait mis
      const impose = mode === 'force' || (niveau && niveau.kwargs[k] !== undefined);
      if (impose || fusion[k] === undefined) fusion[k] = v;
    }
    if (JSON.stringify(fusion) !== JSON.stringify(actuel)) {
      body.chat_template_kwargs = fusion;
      change = true;
    }
  }
  return change;
}

/* Construit la ligne de commande, meme logique que LLAMA.bat. */
function buildArgs(model, L, defaults) {
  const nativeCtx = Number(model.native_ctx) || 32768;
  const reason = ctxOmitReason(model, L);
  const noCtx = !!reason;
  const ctxTotal = noCtx ? 0 : L.ctxSlot * L.slots;
  const rope = noCtx ? 1 : Math.max(1, Math.ceil(L.ctxSlot / nativeCtx));
  const a = [
    '-m', model.model,
    ...(noCtx ? [] : ['-c', String(ctxTotal)]),
    '-np', String(L.slots),
    '-ngl', String(L.gpuLayers),
    '-b', String(L.batch),
    '-ub', String(L.ubatch),
    '--no-mmap',
    '--flash-attn', 'on',
    '--cache-type-k', L.cache,
    '--cache-type-v', L.cache
  ];
  // --mmproj-auto est actif par defaut dans llama.cpp : omettre --mmproj ne
  // suffit pas, le serveur ramasse tout seul un projecteur trouve a cote du
  // modele. Pour couper la vision il faut le dire explicitement.
  if (L.vision === 0) a.push('--no-mmproj');
  else if (L.vision === 1 && model.mmproj) a.push('--mmproj', model.mmproj);
  else if (L.vision === 2 && model.mmproj) a.push('--mmproj', model.mmproj, '--no-mmproj-offload');
  /* Decodage speculatif. Deux cas : un fichier draft a cote du modele, ou une
   * tete MTP deja incluse dans le .gguf - les builds « MTP » de Qwen3.6, par
   * exemple. Dans ce second cas llama.cpp monte le contexte de draft sur le
   * modele lui-meme, il ne faut surtout pas lui passer --model-draft. */
  if (L.mtp && (model.draft || model.mtp_builtin)) {
    if (model.draft) a.push('--model-draft', model.draft);
    a.push('--spec-type', model.spec_type || 'draft-mtp',
           '--spec-draft-n-max', String(L.draftN));
    if (model.spec_extra) a.push(...String(model.spec_extra).split(/\s+/).filter(Boolean));
  }
  if (model.lora) a.push('--lora', model.lora);
  if (rope > 1) a.push('--rope-scaling', 'yarn', '--rope-scale', String(rope));

  /* Cache de prompt. Il vit en RAM systeme : quand un agent change de
   * conversation, son etat KV est recopie la plutot que jete, et revient sans
   * etre recalcule. Ca ne rend pas la generation plus rapide, ca supprime des
   * attentes avant le premier token. 0 coupe le cache ; -1 le laisse grossir
   * sans limite, ce que la console n'offre pas - une machine qui s'etouffe ne
   * previent pas. */
  // Echantillonnage du modele : ce que le moteur applique quand le client ne
  // demande rien de particulier.
  const ech = samplingOf(model);
  const drapeau = { temp: '--temp', top_p: '--top-p', top_k: '--top-k', min_p: '--min-p',
    presence_penalty: '--presence-penalty', repeat_penalty: '--repeat-penalty' };
  for (const [cle, f] of Object.entries(drapeau)) {
    if (ech[cle] !== undefined) a.push(f, String(ech[cle]));
  }
  if (ech.samplers) a.push('--samplers', ech.samplers);

  // Reflexion : mode, budget, format de restitution, variables du gabarit.
  const th = thinkingOf(model);
  if (th.mode) a.push('--reasoning', th.mode);
  if (th.budget !== undefined) a.push('--reasoning-budget', String(th.budget));
  if (th.format && th.format !== 'auto') a.push('--reasoning-format', th.format);
  if (th.preserve === true) a.push('--reasoning-preserve');
  else if (th.preserve === false) a.push('--no-reasoning-preserve');
  if (th.kwargs) a.push('--chat-template-kwargs', JSON.stringify(th.kwargs));

  const cram = Number.isFinite(L.cacheRam) ? Math.max(0, Math.round(L.cacheRam)) : 4096;
  a.push('--cache-ram', String(cram));
  // Reutilisation par morceaux apres une divergence au milieu du prompt : sans
  // cache de prompt elle n'a rien a reutiliser, llama.cpp l'ignorerait.
  const reuse = Number.isFinite(L.cacheReuse) ? Math.max(0, Math.round(L.cacheReuse)) : 0;
  if (cram > 0 && reuse > 0) a.push('--cache-reuse', String(reuse));
  a.push('--jinja', '--slots', '--props', '--metrics',
         '--threads-http', '8',
         '--alias', model.id,
         '--host', config.upstreamHost,
         '--port', String(config.upstreamPort),
         '--api-key', INTERNAL_KEY);
  const extra = [model.extra_args, L.extraArgs].filter(Boolean).join(' ').trim();
  if (extra) a.push(...extra.split(/\s+/).filter(Boolean));
  return { args: a, ctxTotal, rope, noCtx, reason };
}

/* Les reglages enregistres d'un modele, dans la meme forme que le corps envoye
 * par le tiroir. Sert au portail : l'utilisateur ne choisit que le modele, tout
 * le reste vient de ce que l'admin a enregistre. */
function savedBody(model, defaults) {
  const d = defaults || {};
  const val = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v);
  return {
    id: model.id,
    slots: Number(val(model.slots, 1)),
    ctxSlot: model.ctx_auto ? -1 : Number(val(model.ctx, 32768)),
    cache: model.cache || 'q4_0',
    vision: Number(val(model.vision_mode, model.mmproj ? 1 : 0)),
    // le draft peut etre un fichier a cote, ou une tete MTP incluse dans le .gguf
    mtp: !!(model.draft || model.mtp_builtin) && !!val(model.draft_on, true),
    draftN: Number(val(model.spec_n, 2)),
    gpuLayers: Number(val(model.gpu_layers, d.gpu_layers ?? 99)),
    batch: Number(val(model.batch, d.batch ?? 2048)),
    ubatch: Number(val(model.ubatch, d.ubatch ?? 512)),
    // cache de prompt : en RAM systeme, pas en VRAM. La valeur de session, si
    // elle existe, l'emporte sur le modele comme sur le defaut.
    cacheRam: effectiveCacheRam(model, d),
    cacheReuse: Number(val(model.cache_reuse, d.cache_reuse ?? 0)),
    extraArgs: String(val(model.ui_extra_args, ''))
  };
}

function launch(body) {
  if (runtime.proc) throw new Error('Un serveur tourne deja. Arrete-le avant d\'en lancer un autre.');
  const doc = loadModels();
  const model = doc.models.find(m => m.id === body.id);
  if (!model) throw new Error('Modele inconnu : ' + body.id);
  const d = doc.defaults || {};

  const L = {
    slots: clampInt(body.slots, 1, 64, model.slots || 1),
    // -1 est un choix explicite : contexte laisse a llama.cpp
    ctxSlot: Number(body.ctxSlot) === -1 ? -1 : clampInt(body.ctxSlot, 512, 4194304, model.ctx || 32768),
    cache: ['q4_0', 'q5_0', 'q8_0', 'f16'].includes(body.cache) ? body.cache : (model.cache || 'q4_0'),
    vision: clampInt(body.vision, 0, 2, model.mmproj ? 1 : 0),
    mtp: !!body.mtp && !!(model.draft || model.mtp_builtin),
    draftN: clampInt(body.draftN, 1, 8, model.spec_n || 2),
    gpuLayers: clampInt(body.gpuLayers, 0, 999, d.gpu_layers ?? 99),
    batch: clampInt(body.batch, 32, 65536, d.batch ?? 2048),
    ubatch: clampInt(body.ubatch, 32, 65536, d.ubatch ?? 512),
    // cache de prompt : en RAM systeme. Plafonne a 32 Go, un chiffre saisi de
    // travers ne doit pas mettre la machine a genoux.
    cacheRam: clampInt(body.cacheRam, 0, 32768, effectiveCacheRam(model, d)),
    cacheReuse: clampInt(body.cacheReuse, 0, 8192,
      Number(model.cache_reuse ?? d.cache_reuse ?? 0)),
    extraArgs: typeof body.extraArgs === 'string' ? body.extraArgs.trim() : ''
  };

  const exe = path.join(model.bin, 'llama-server.exe');
  if (!fs.existsSync(exe)) throw new Error('llama-server.exe introuvable : ' + exe);
  if (!fs.existsSync(model.model)) throw new Error('Fichier .gguf introuvable : ' + model.model);

  const { args, ctxTotal, rope, noCtx, reason } = buildArgs(model, L, d);

  runtime.logs = [];
  runtime.ready = false;
  runtime.exitCode = null;
  runtime.slots = null;
  runtime.metrics = null;
  runtime.modelId = model.id;
  runtime.modelName = model.name || model.id;
  runtime.launch = Object.assign({}, L, { ctxTotal, rope, noCtx, ctxReason: reason });
  runtime.args = args;
  runtime.cmdline = 'llama-server.exe ' + args
    .map(x => (/\s/.test(x) ? '"' + x + '"' : x))
    .join(' ')
    .replace(INTERNAL_KEY, '<cle-interne>');
  runtime.startedAt = Date.now();
  runtime.lastActivity = 0;
  runtime.idleStopped = false;

  runtime.launchedBy = body.by || 'admin';

  // le moteur precedent a peut-etre laisse des connexions ouvertes sur ce port
  dropUpstreamSockets();
  const proc = spawn(exe, args, { cwd: model.bin, windowsHide: true });
  runtime.proc = proc;
  runtime.pid = proc.pid;

  if (body.by === 'API') pushLog('sys', 'Chargement declenche par un client qui a demande ce modele par son nom.');
  else if (body.by) pushLog('sys', 'Chargement demande depuis le portail par « ' + body.by + ' ».');
  pushLog('sys', '> ' + runtime.cmdline);
  if (reason === 'dspark') {
    pushLog('sys', 'draft dspark actif : -c volontairement omis, llama.cpp choisit le contexte '
      + '(avec -c, le contexte est alloue en double et le chargement echoue).');
  } else if (reason === 'auto') {
    pushLog('sys', 'contexte regle sur automatique (-1) : -c n\'est pas transmis, '
      + 'llama.cpp prend le contexte natif du modele.');
  }
  proc.stdout.on('data', b => pushLog('out', b.toString('utf8')));
  proc.stderr.on('data', b => pushLog('err', b.toString('utf8')));
  proc.on('error', e => pushLog('sys', 'ERREUR de lancement : ' + e.message));
  proc.on('exit', (code, signal) => {
    // Un processus abandonne - celui qui n'a pas tenu au demarrage, avant une
    // seconde tentative - peut rendre l'ame apres que son remplacant a pris la
    // place. Sa sortie ne doit rien effacer : seul le processus en cours parle
    // au nom du moteur.
    if (runtime.proc !== proc) {
      pushLog('sys', `Un moteur abandonne s'est termine (code ${code === null ? signal : code}).`);
      return;
    }
    pushLog('sys', `Serveur arrete (code ${code === null ? signal : code}).`);
    runtime.proc = null;
    runtime.pid = null;
    runtime.ready = false;
    runtime.exitCode = code;
    runtime.exitAt = Date.now();
    broadcast('status', statusPayload());
  });

  watchReady();
  config.lastLaunch = Object.assign({ id: model.id }, L);
  saveConfig();
  broadcast('status', statusPayload());
  return statusPayload();
}

/* Depuis combien de temps plus personne ne se sert du modele. Le chargement
 * compte comme une activite : on ne decharge pas un modele qui vient d'arriver
 * et que personne n'a encore eu le temps d'appeler. */
function idleFor() {
  if (!runtime.proc) return 0;
  if (inFlight > 0) return 0;
  if ((runtime.slots || []).some(s => s.busy)) return 0;
  return Date.now() - Math.max(runtime.startedAt, runtime.lastActivity || 0);
}

/* Un modele oublie garde 10 Go de VRAM pour rien. Au-dela du delai regle dans
 * Reglages, on le decharge : la carte est rendue, et n'importe qui peut en
 * demander un autre depuis le portail. */
setInterval(() => {
  const mins = Number(config.idleUnloadMin) || 0;
  if (!mins || !runtime.proc || !runtime.ready) return;
  if (idleFor() < mins * 60000) return;
  runtime.idleStopped = true;
  pushLog('sys', `Aucune requete depuis ${mins} min : dechargement automatique, la VRAM est rendue. `
    + '(Reglages > Dechargement automatique pour changer ce delai.)');
  stopServer();
}, 15000).unref();

function stopServer() {
  return new Promise(resolve => {
    if (!runtime.proc) return resolve(false);
    const pid = runtime.pid;
    // On vise ce processus-ci, pas « celui qui sera la dans trois secondes » :
    // entre-temps un autre modele a pu prendre sa place, et le coup de grace
    // tombait alors sur le nouveau venu.
    const victime = runtime.proc;
    pushLog('sys', 'Arret demande...');
    dropUpstreamSockets();   // aucune connexion ne doit survivre au processus
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve(true));
    setTimeout(() => {
      try { if (!victime.killed && victime.exitCode === null) victime.kill('SIGKILL'); } catch {}
    }, 3000);
  });
}

/* Le .bat peut deja occuper le port : autant le dire avant de lancer un
 * serveur qui echouera a se lier. */
function portBusy(port) {
  return new Promise(resolve => {
    const s = new (require('net').Socket)();
    s.setTimeout(700);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
    s.connect(port, '127.0.0.1');
  });
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function statusPayload() {
  return {
    running: !!runtime.proc,
    ready: runtime.ready,
    pid: runtime.pid,
    modelId: runtime.modelId,
    modelName: runtime.modelName,
    launchedBy: runtime.launchedBy || '',
    launch: runtime.launch,
    cmdline: runtime.cmdline,
    startedAt: runtime.startedAt,
    uptime: runtime.proc ? Date.now() - runtime.startedAt : 0,
    exitCode: runtime.exitCode,
    idleMs: runtime.proc ? idleFor() : 0,
    idleUnloadMin: config.idleUnloadMin || 0,
    idleStopped: runtime.idleStopped,
    inFlight,
    slots: runtime.slots,
    metrics: runtime.metrics,
    upstream: `http://${config.upstreamHost}:${config.upstreamPort}`
  };
}

/* --------------------------------------------------------------------------
 * Connexions vers le moteur
 *
 * Node garde les connexions ouvertes entre deux requetes (keepAlive), ce qui
 * evite une poignee de main par appel. Seulement, le moteur est tue et relance
 * sur le meme port a chaque changement de modele : une connexion survivante
 * pointe alors vers un processus mort, et la premiere requete d'apres repart
 * en 502 sans avoir rien fait de mal. On vide donc le reservoir a chaque arret
 * et a chaque lancement, plutot que de le decouvrir en plein travail.
 * ----------------------------------------------------------------------- */
const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 128 });
function dropUpstreamSockets() {
  try { upstreamAgent.destroy(); } catch {}
}

// --------------------------------------------------------------------------
// Sondage /slots et /metrics de llama-server
// --------------------------------------------------------------------------
function upstreamGet(pathname) {
  return new Promise(resolve => {
    const req = http.request({
      host: config.upstreamHost, port: config.upstreamPort, path: pathname, method: 'GET',
      headers: { Authorization: 'Bearer ' + INTERNAL_KEY }, timeout: 2500,
      agent: upstreamAgent
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function parseMetrics(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const name = line.slice(0, sp).replace(/\{.*\}$/, '').replace('llamacpp:', '');
    const val = parseFloat(line.slice(sp + 1));
    if (!Number.isNaN(val)) out[name] = val;
  }
  return out;
}

setInterval(async () => {
  if (!runtime.proc || !runtime.ready) return;
  const [slots, metrics] = await Promise.all([upstreamGet('/slots'), upstreamGet('/metrics')]);
  if (slots && slots.status === 200) {
    try {
      const arr = JSON.parse(slots.body);
      // Un client peut partir en pleine reponse - opencode qu'on interrompt,
      // un onglet ferme : la passerelle rend la main tout de suite alors que le
      // moteur, lui, produit encore. On repousse donc le compteur quand un slot
      // passe d'occupe a libre. L'inactivite se compte depuis le dernier token,
      // jamais depuis le dernier client.
      const occupeAvant = (runtime.slots || []).some(s => s.busy);
      runtime.slots = arr.map(s => ({
        id: s.id,
        busy: s.is_processing !== undefined ? s.is_processing : (s.state !== 0),
        nCtx: s.n_ctx,
        nPast: s.n_past || s.prompt_n || 0
      }));
      if (occupeAvant && !runtime.slots.some(s => s.busy)) runtime.lastActivity = Date.now();
    } catch {}
  }
  if (metrics && metrics.status === 200) runtime.metrics = parseMetrics(metrics.body);
  broadcast('live', {
    slots: runtime.slots, metrics: runtime.metrics, gpu: gpuState,
    uptime: Date.now() - runtime.startedAt,
    idleMs: idleFor(), inFlight
  });
}, 2000).unref();

setInterval(() => { if (!runtime.proc) broadcast('live', { gpu: gpuState }); }, 3000).unref();

// --------------------------------------------------------------------------
// Cles API
// --------------------------------------------------------------------------
/* Limites d'une cle. Zero partout = illimite, c'est le comportement d'origine.
 *   par jour   : remis a zero a minuit, c'est un debit maximal
 *   au total   : une enveloppe, une fois epuisee la cle ne sert plus
 * Le solde (credit) est en unites monetaires, au tarif du modele servi. */
function emptyLimits() {
  return {
    reqPerDay: 0,
    tokensPerDay: 0,
    costPerDay: 0,
    tokensTotal: 0,
    credit: 0            // enveloppe en argent, 0 = illimite
  };
}

function readLimits(src, base) {
  const L = Object.assign(emptyLimits(), base || {});
  if (!src || typeof src !== 'object') return L;
  const num = (v, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
  };
  if (src.reqPerDay !== undefined) L.reqPerDay = Math.round(num(src.reqPerDay, 1e9));
  if (src.tokensPerDay !== undefined) L.tokensPerDay = Math.round(num(src.tokensPerDay, 1e12));
  if (src.costPerDay !== undefined) L.costPerDay = num(src.costPerDay, 1e9);
  if (src.tokensTotal !== undefined) L.tokensTotal = Math.round(num(src.tokensTotal, 1e12));
  if (src.credit !== undefined) L.credit = num(src.credit, 1e9);
  return L;
}

/* --------------------------------------------------------------------------
 * Roles
 *
 * Ce qu'une personne a le droit de faire tient a sa cle, pas a un interrupteur
 * global : deux personnes peuvent partager le serveur sans partager les memes
 * pouvoirs.
 *
 *   user    - se sert du modele charge, rien de plus
 *   trusted - peut demander un chargement, un remplacement, un arret, et
 *             regler agents / contexte ; jamais de deport hors GPU
 *   admin   - tout, y compris charger un modele qui ne tient pas en VRAM
 * ----------------------------------------------------------------------- */
const ROLES = ['user', 'trusted', 'admin'];
const ROLE_LABEL = { user: 'utilisateur', trusted: 'de confiance', admin: 'administrateur' };

function roleOf(k) {
  return k && ROLES.includes(k.role) ? k.role : 'user';
}

function permOf(k) {
  const role = roleOf(k);
  const eleve = role === 'trusted' || role === 'admin';
  return {
    role,
    label: ROLE_LABEL[role],
    launch: eleve,    // demander un chargement quand rien ne tourne
    swap: eleve,      // faire changer de modele
    tune: eleve,      // choisir agents et contexte
    stop: eleve,      // rendre la carte
    offload: role === 'admin'  // deporter hors du GPU ce qui ne tient pas
  };
}

/* Les cles creees avant les enveloppes n'ont qu'un quota de requetes : on le
 * transporte tel quel dans la nouvelle structure, rien n'est perdu. */
(function migrateKeys() {
  let changed = false;
  for (const k of keyStore.keys) {
    if (!k.limits) {
      k.limits = Object.assign(emptyLimits(), { reqPerDay: k.limitPerDay || 0 });
      changed = true;
    }
    if (k.cost === undefined) { k.cost = 0; changed = true; }
    // Avant les roles, toutes les cles pouvaient charger et arreter des que
    // l'admin avait ouvert le portail : on ne retire rien au passage, les cles
    // existantes deviennent « de confiance ». A l'admin de retrograder ce qui
    // doit l'etre - une cle neuve, elle, nait simple utilisatrice.
    if (!ROLES.includes(k.role)) { k.role = 'trusted'; changed = true; }
  }
  if (changed) saveKeys();
})();

function newKey(name) {
  const k = {
    id: crypto.randomUUID(),
    name: (name || 'Sans nom').slice(0, 60),
    key: 'sk-llama-' + crypto.randomBytes(20).toString('base64url'),
    createdAt: Date.now(),
    disabled: false,
    role: 'user',            // le moins de pouvoirs par defaut, ca se remonte

    limitPerDay: 0,          // conserve pour LLAMA.bat et les anciens outils
    limits: emptyLimits(),
    remoteAllowed: true,     // utilisable hors du reseau local
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,                 // ce que ces requetes ont coute a la cle
    lastUsed: 0,
    lastIp: ''
  };
  keyStore.keys.push(k);
  saveKeys();
  return k;
}

function findKey(raw) {
  if (!raw) return null;
  const val = raw.replace(/^Bearer\s+/i, '').trim();
  if (!val) return null;
  const buf = Buffer.from(val);
  for (const k of keyStore.keys) {
    const kb = Buffer.from(k.key);
    if (kb.length === buf.length && crypto.timingSafeEqual(kb, buf)) return k;
  }
  return null;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

/* Consommation du jour pour une cle : requetes, tokens et argent. */
function usedToday(keyId) {
  const d = stats.days[todayStr()];
  const u = (d && d.byKey && d.byKey[keyId]) || {};
  return {
    requests: u.requests || 0,
    tokensIn: u.tokensIn || 0,
    tokensOut: u.tokensOut || 0,
    tokensCached: u.tokensCached || 0,
    tokens: (u.tokensIn || 0) + (u.tokensOut || 0),
    cost: u.cost || 0
  };
}

function totalUsed(k) {
  return {
    requests: k.requests || 0,
    tokensIn: k.tokensIn || 0,
    tokensOut: k.tokensOut || 0,
    tokensCached: k.tokensCached || 0,
    tokens: (k.tokensIn || 0) + (k.tokensOut || 0),
    cost: k.cost || 0
  };
}

/* Renvoie la raison du refus, ou null si la cle peut servir.
 * Le controle est fait avant la requete : une requete deja partie peut donc
 * depasser legerement l'enveloppe, comme chez tous les fournisseurs. */
function quotaBlock(key) {
  const L = key.limits || emptyLimits();
  const day = usedToday(key.id);
  const tot = totalUsed(key);
  if (L.reqPerDay > 0 && day.requests >= L.reqPerDay) {
    return { status: 429, type: 'rate_limit_error',
      message: `Quota journalier atteint : ${L.reqPerDay} requetes par jour. Il repart a minuit.` };
  }
  if (L.tokensPerDay > 0 && day.tokens >= L.tokensPerDay) {
    return { status: 429, type: 'rate_limit_error',
      message: `Quota journalier atteint : ${L.tokensPerDay} tokens par jour. Il repart a minuit.` };
  }
  if (L.costPerDay > 0 && day.cost >= L.costPerDay) {
    return { status: 429, type: 'rate_limit_error',
      message: `Plafond journalier atteint : ${L.costPerDay} ${config.pricing.currency} par jour. Il repart a minuit.` };
  }
  if (L.tokensTotal > 0 && tot.tokens >= L.tokensTotal) {
    return { status: 402, type: 'insufficient_quota',
      message: `Cette cle a consomme ses ${L.tokensTotal} tokens. Demande a l'administrateur de la recharger.` };
  }
  if (L.credit > 0 && tot.cost >= L.credit) {
    return { status: 402, type: 'insufficient_quota',
      message: `Solde epuise : l'enveloppe de ${L.credit} ${config.pricing.currency} est consommee. Demande a l'administrateur de la recharger.` };
  }
  return null;
}

/* Vue lisible de l'etat d'une cle, pour le portail et le panneau admin. */
function keyStatus(k) {
  const L = k.limits || emptyLimits();
  const day = usedToday(k.id);
  const tot = totalUsed(k);
  const left = (limit, used) => (limit > 0 ? Math.max(0, limit - used) : null);
  return {
    limits: L,
    today: day,
    total: tot,
    remaining: {
      credit: left(L.credit, tot.cost),
      tokensTotal: left(L.tokensTotal, tot.tokens),
      reqToday: left(L.reqPerDay, day.requests),
      tokensToday: left(L.tokensPerDay, day.tokens),
      costToday: left(L.costPerDay, day.cost)
    },
    blocked: k.disabled ? { message: 'Cle suspendue par l\'administrateur.' } : quotaBlock(k)
  };
}

/* Les cles telles que le panneau admin les affiche : l'etat du jour et le
 * reste de l'enveloppe sont calcules ici, l'interface ne recompte rien. */
function keysPayload() {
  return keyStore.keys.map(k => Object.assign({}, k, {
    role: roleOf(k), perm: permOf(k), status: keyStatus(k)
  }));
}

/* Watt-heures du jour. Ils vivent dans le meme journal que les requetes : une
 * journee, une ligne. On separe ce que la carte a bu pendant qu'un modele etait
 * charge de ce qu'elle boit au repos - c'est la premiere qui est imputable a la
 * console. */
function ajouterEnergie(wh) {
  if (!(wh > 0)) return;
  const jour = todayStr();
  const d = stats.days[jour] || (stats.days[jour] = { requests: 0, tokensIn: 0, tokensOut: 0, cost: 0, byKey: {}, byModel: {} });
  d.wh = (d.wh || 0) + wh;
  if (runtime.proc) d.whCharge = (d.whCharge || 0) + wh;
  statsDirty = true;
}

function recordUsage(rec) {
  rec.tokensCached = Math.min(Math.max(0, rec.tokensCached || 0), rec.tokensIn);
  // fige le cout au tarif du moment : changer un prix ne reecrit pas l'historique
  rec.cost = costOf(rec.model, rec.tokensIn, rec.tokensOut, rec.tokensCached);

  const day = todayStr();
  const d = stats.days[day] || (stats.days[day] = { requests: 0, tokensIn: 0, tokensOut: 0, cost: 0, byKey: {}, byModel: {} });
  d.requests++;
  d.tokensIn += rec.tokensIn;
  d.tokensOut += rec.tokensOut;
  d.tokensCached = (d.tokensCached || 0) + rec.tokensCached;
  d.cost = (d.cost || 0) + rec.cost;
  const bk = d.byKey[rec.keyId] || (d.byKey[rec.keyId] = { requests: 0, tokensIn: 0, tokensOut: 0, cost: 0 });
  bk.requests++; bk.tokensIn += rec.tokensIn; bk.tokensOut += rec.tokensOut; bk.cost = (bk.cost || 0) + rec.cost;
  bk.tokensCached = (bk.tokensCached || 0) + rec.tokensCached;
  const bm = d.byModel[rec.model] || (d.byModel[rec.model] = { requests: 0, tokensOut: 0, cost: 0 });
  bm.requests++; bm.tokensOut += rec.tokensOut; bm.cost = (bm.cost || 0) + rec.cost;
  bm.tokensCached = (bm.tokensCached || 0) + rec.tokensCached;

  // on ne conserve que 30 jours
  const keep = Object.keys(stats.days).sort().slice(-30);
  for (const k of Object.keys(stats.days)) if (!keep.includes(k)) delete stats.days[k];
  statsDirty = true;

  const key = keyStore.keys.find(k => k.id === rec.keyId);
  if (key) {
    key.requests++; key.tokensIn += rec.tokensIn; key.tokensOut += rec.tokensOut;
    key.tokensCached = (key.tokensCached || 0) + rec.tokensCached;
    key.cost = (key.cost || 0) + rec.cost;
    key.lastUsed = rec.at; key.lastIp = rec.ip;
    saveKeys();
  }
  // journal borne : au-dela de 5 Mo on bascule sur un fichier .1 et on repart
  try {
    if (fs.existsSync(ACTIVITY_PATH) && fs.statSync(ACTIVITY_PATH).size > 5 * 1024 * 1024) {
      fs.renameSync(ACTIVITY_PATH, ACTIVITY_PATH + '.1');
    }
    fs.appendFileSync(ACTIVITY_PATH, JSON.stringify(rec) + '\n');
  } catch {}
  broadcast('usage', rec);
}

/* --------------------------------------------------------------------------
 * Avis des utilisateurs
 *
 * Cinq etoiles, rien d'autre. On ne demande pas a quelqu'un qui vient
 * d'arriver, et on ne redemande pas avant un mois : une question posee trop
 * souvent ne recolte plus des avis, seulement des clics pour s'en debarrasser.
 * ----------------------------------------------------------------------- */
const RATING_AGAIN_MS = 30 * 24 * 3600000;   // un mois entre deux demandes

function readRatings() {
  try {
    return fs.readFileSync(RATINGS_PATH, 'utf8').split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function ratingsSummary() {
  const all = readRatings();
  if (!all.length) return { count: 0, average: null, last: [], byStar: [0, 0, 0, 0, 0] };
  const byStar = [0, 0, 0, 0, 0];
  let somme = 0;
  for (const r of all) {
    somme += r.stars;
    if (r.stars >= 1 && r.stars <= 5) byStar[r.stars - 1]++;
  }
  return {
    count: all.length,
    average: Math.round(somme / all.length * 100) / 100,
    byStar,
    last: all.slice(-12).reverse()
  };
}

/* Ce qu'on peut demander a ce porteur de cle, maintenant. La question arrive
 * des la premiere visite du portail : quelqu'un qui vient de recevoir sa cle a
 * un avis sur l'accueil qu'on lui fait, et on ne le retiendra pas plus tard. */
function ratingAsk(key) {
  const mien = readRatings().filter(r => r.keyId === key.id);
  const dernier = mien.length ? mien[mien.length - 1].at : 0;
  return {
    ask: Date.now() - dernier > RATING_AGAIN_MS,
    first: !mien.length,
    lastAt: dernier || null,
    mine: mien.length ? mien[mien.length - 1].stars : null
  };
}

/* La note part au clic sur l'etoile - c'est le signal qui compte - et le mot
 * facultatif arrive apres. On ne cree donc pas un second avis : pendant un
 * quart d'heure, le dernier avis reste modifiable. */
const RATING_EDIT_MS = 15 * 60000;

function saveRating(key, stars, comment) {
  const mot = String(comment || '').slice(0, 400);
  const tous = readRatings();
  const i = tous.map(r => r.keyId).lastIndexOf(key.id);
  const rec = tous[i];

  if (rec && Date.now() - rec.at < RATING_EDIT_MS) {
    rec.stars = stars;
    if (mot) rec.comment = mot;
    rec.at = Date.now();
    try { fs.writeFileSync(RATINGS_PATH, tous.map(r => JSON.stringify(r)).join('\n') + '\n'); } catch {}
    broadcast('rating', rec);
    return rec;
  }

  const neuf = {
    at: Date.now(), keyId: key.id, keyName: key.name,
    stars, comment: mot,
    model: runtime.modelId || '', requests: key.requests || 0
  };
  try { fs.appendFileSync(RATINGS_PATH, JSON.stringify(neuf) + '\n'); } catch {}
  broadcast('rating', neuf);
  return neuf;
}

/* --------------------------------------------------------------------------
 * Sondage : une question, quatre reponses au plus
 * ----------------------------------------------------------------------- */
function readPollAnswers() {
  try {
    return fs.readFileSync(POLL_PATH, 'utf8').split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function pollSummary() {
  const p = config.poll;
  const rep = readPollAnswers().filter(r => r.pollId === p.id);
  const tally = (p.options || []).map((label, i) => ({
    label, count: rep.filter(r => r.choice === i).length
  }));
  return {
    id: p.id, active: !!p.active, question: p.question,
    options: p.options || [], allowText: p.allowText !== false,
    count: rep.length,
    tally,
    answers: rep.slice(-20).reverse()
  };
}

/* Ce que le portail doit montrer a ce porteur de cle : la question, seulement
 * s'il n'y a pas deja repondu. */
function pollFor(key) {
  const p = config.poll;
  if (!p.active || !p.id || !p.question) return null;
  const dejaRepondu = readPollAnswers().some(r => r.pollId === p.id && r.keyId === key.id);
  if (dejaRepondu) return null;
  return { id: p.id, question: p.question, options: p.options || [], allowText: p.allowText !== false };
}

function savePollAnswer(key, choice, text) {
  const rec = {
    at: Date.now(), pollId: config.poll.id, keyId: key.id, keyName: key.name,
    choice: Number.isInteger(choice) ? choice : null,
    text: String(text || '').slice(0, 400)
  };
  try { fs.appendFileSync(POLL_PATH, JSON.stringify(rec) + '\n'); } catch {}
  broadcast('poll', rec);
  return rec;
}

function readActivity(limit) {
  try {
    const txt = fs.readFileSync(ACTIVITY_PATH, 'utf8').trim();
    if (!txt) return [];
    const lines = txt.split('\n');
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).reverse();
  } catch { return []; }
}

// --------------------------------------------------------------------------
// Acces depuis l'exterieur
//
// Deux chemins, au choix dans le panneau admin :
//   cloudflare - un tunnel sortant donne une adresse https publique, les amis
//                n'installent rien mais l'adresse est ouverte a tous, seule la
//                cle API protege l'acces
//   tailscale  - reseau prive chiffre, chaque ami installe Tailscale et rejoint
//                le reseau ; rien n'est publie sur Internet
// --------------------------------------------------------------------------
const CF_EXE = path.join(APP_DIR, 'cloudflared.exe');
const CF_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const TS_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';

const tunnel = { proc: null, pid: null, url: '', state: 'off', logs: [], error: '' };

function tunnelLog(line) {
  tunnel.logs.push({ t: Date.now(), m: line });
  if (tunnel.logs.length > 200) tunnel.logs.shift();
  broadcast('tunnel', tunnelPayload());
}

function tunnelPayload() {
  return {
    state: tunnel.state, url: tunnel.url, pid: tunnel.pid, error: tunnel.error,
    installed: fs.existsSync(CF_EXE),
    logs: tunnel.logs.slice(-40)
  };
}

function startTunnel() {
  if (tunnel.proc) throw new Error('Le tunnel tourne deja.');
  if (!fs.existsSync(CF_EXE)) throw new Error('cloudflared.exe absent. Installe-le depuis le panneau admin.');
  tunnel.logs = [];
  tunnel.url = '';
  tunnel.error = '';
  tunnel.state = 'starting';

  const proc = spawn(CF_EXE, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + config.port],
    { cwd: APP_DIR, windowsHide: true });
  tunnel.proc = proc;
  tunnel.pid = proc.pid;

  const onData = b => {
    const text = b.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      tunnelLog(line);
      const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !tunnel.url) {
        tunnel.url = m[0];
        tunnel.state = 'up';
        config.remote.publicUrl = m[0];
        config.remote.method = 'cloudflare';
        saveConfig();
        tunnelLog('Adresse publique : ' + m[0]);
      }
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);        // cloudflared ecrit tout sur stderr
  proc.on('error', e => { tunnel.state = 'error'; tunnel.error = e.message; tunnelLog('ERREUR : ' + e.message); });
  proc.on('exit', code => {
    tunnel.proc = null; tunnel.pid = null; tunnel.state = 'off';
    if (tunnel.url) { config.remote.publicUrl = ''; saveConfig(); }
    tunnel.url = '';
    tunnelLog('Tunnel ferme (code ' + code + ').');
  });

  return tunnelPayload();
}

function stopTunnel() {
  return new Promise(resolve => {
    if (!tunnel.proc) return resolve(false);
    execFile('taskkill', ['/PID', String(tunnel.pid), '/T', '/F'], () => resolve(true));
  });
}

/* Telechargement de cloudflared, declenche par un clic dans le panneau. */
function installCloudflared() {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const tmp = CF_EXE + '.part';
    const file = fs.createWriteStream(tmp);
    let hops = 0;

    const get = u => https.get(u, { headers: { 'User-Agent': 'console-llamacpp' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        if (++hops > 5) return reject(new Error('Trop de redirections.'));
        r.resume();
        return get(r.headers.location);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('Telechargement refuse (' + r.statusCode + ').')); }
      const total = parseInt(r.headers['content-length'], 10) || 0;
      let done = 0, lastPct = -1;
      r.on('data', c => {
        done += c.length;
        const pct = total ? Math.floor(done / total * 100) : 0;
        if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; tunnelLog('Telechargement ' + pct + ' %'); }
      });
      r.pipe(file);
      file.on('finish', () => file.close(() => {
        try {
          fs.renameSync(tmp, CF_EXE);
          tunnelLog('cloudflared installe.');
          resolve(tunnelPayload());
        } catch (e) { reject(e); }
      }));
    }).on('error', e => { try { fs.unlinkSync(tmp); } catch {} reject(e); });

    tunnelLog('Telechargement de cloudflared...');
    get(CF_URL);
  });
}

/* Etat de Tailscale : connecte ? quelle adresse 100.x partager ? */
/* Interroger tailscale lance un programme externe : jusqu'a cinq secondes
 * d'attente si la machine traine. L'etat general de la console ne doit pas en
 * dependre - il est lu en boucle par la page. On garde donc la derniere reponse
 * et on la rafraichit en arriere-plan ; la page Admin, elle, demande la valeur
 * fraiche quand on l'ouvre. */
let tsCache = { at: 0, v: { installed: false }, enCours: false };

function tailscaleCached() {
  if (!tsCache.enCours && Date.now() - tsCache.at > 15000) {
    tsCache.enCours = true;
    tailscaleState().then(v => { tsCache = { at: Date.now(), v, enCours: false }; },
      () => { tsCache.enCours = false; });
  }
  return tsCache.v;
}

function tailscaleState() {
  return new Promise(resolve => {
    if (!fs.existsSync(TS_EXE)) return resolve({ installed: false });
    execFile(TS_EXE, ['status', '--json'], { timeout: 5000, maxBuffer: 4e6 }, (err, stdout) => {
      if (err || !stdout) return resolve({ installed: true, running: false });
      try {
        const j = JSON.parse(stdout);
        const self = j.Self || {};
        const peers = Object.values(j.Peer || {}).map(p => ({
          name: p.HostName, online: !!p.Online, os: p.OS
        }));
        resolve({
          installed: true,
          running: j.BackendState === 'Running',
          state: j.BackendState,
          ip: (self.TailscaleIPs || []).find(a => a.includes('.')) || '',
          name: self.HostName || '',
          tailnet: j.CurrentTailnet ? j.CurrentTailnet.Name : '',
          peers
        });
      } catch { resolve({ installed: true, running: false }); }
    });
  });
}

// --------------------------------------------------------------------------
// SSE : un seul flux pour logs, statut, live, usage
// --------------------------------------------------------------------------
const clients = new Set();
function broadcast(event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(chunk); } catch {} }
}
setInterval(() => broadcast('ping', Date.now()), 25000).unref();

// --------------------------------------------------------------------------
// Authentification de l'admin
// --------------------------------------------------------------------------
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const sessions = new Map();     // jeton -> date d'expiration
const loginTries = new Map();   // ip -> horodatages des echecs, fenetre de 15 min

function sessionValid(tok) {
  if (!tok) return false;
  const exp = sessions.get(tok);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(tok); return false; }
  return true;
}

// menage periodique : jetons expires et compteurs de tentatives
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  for (const [ip, list] of loginTries) {
    const rest = list.filter(t => now - t < 15 * 60000);
    if (rest.length) loginTries.set(ip, rest); else loginTries.delete(ip);
  }
}, 10 * 60000).unref();

/* Attention : un tunnel Cloudflare tourne en local, ses requetes arrivent donc
 * de 127.0.0.1. Sans le test sur CF-Connecting-IP, toute personne connaissant
 * l'adresse publique passerait pour l'utilisateur assis devant la machine. */
/* Un tunnel (Cloudflare, ngrok, un reverse proxy...) tourne en local : ses
 * requetes arrivent de 127.0.0.1. Sans ce test, quiconque connait l'adresse
 * publique passerait pour l'utilisateur assis devant la machine. La presence
 * d'un en-tete de relais suffit a disqualifier la boucle locale. */
const RELAY_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host'];

function viaRelay(req) {
  return RELAY_HEADERS.some(h => req.headers[h]);
}

function isLoopback(req) {
  const a = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (viaRelay(req)) return false;
  return a === '127.0.0.1' || a === '::1';
}

/* Protection CSRF. La console est ouverte sans mot de passe depuis la machine
 * locale : sans ce controle, n'importe quel site visite par l'utilisateur
 * pourrait poster vers http://127.0.0.1:3939/_api/... et piloter le serveur.
 * Une requete sans Origin ni Referer vient d'un outil (curl, script), pas
 * d'une page : on la laisse passer. */
function sameOrigin(req) {
  const host = req.headers.host;
  const src = req.headers.origin || req.headers.referer;
  if (!src) return true;
  if (src === 'null') return false;
  try { return new URL(src).host === host; } catch { return false; }
}

function cookieOf(req, name) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

/* La console est libre depuis la machine locale. Depuis le reseau, elle exige
 * le mot de passe admin ; sans mot de passe defini, elle reste fermee. */
function adminAllowed(req) {
  if (isLoopback(req)) return true;
  if (!config.adminPassword) return false;
  const s = cookieOf(req, 'llamadash');
  return sessionValid(s);
}

// --------------------------------------------------------------------------
// Passerelle compatible OpenAI
// --------------------------------------------------------------------------
const PROXY_PREFIXES = [
  '/v1/', '/chat/completions', '/completion', '/completions', '/infill',
  '/embedding', '/embeddings', '/rerank', '/reranking', '/tokenize',
  '/detokenize', '/apply-template', '/props', '/models', '/api/'
];

function isProxyPath(p) {
  return PROXY_PREFIXES.some(pre => p === pre.replace(/\/$/, '') || p.startsWith(pre));
}

/* 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 et la plage Tailscale
 * 100.64/10 : tout ce qui n'est pas la-dedans vient de l'exterieur. */
function isPrivateIp(ip) {
  if (!ip) return false;
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return false;
  if (p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;   // Tailscale
  return false;
}

/* Origine reelle d'une requete. Un tunnel (Cloudflare, ngrok, un reverse
 * proxy...) tourne sur la machine : ses requetes arrivent de 127.0.0.1 et
 * passeraient donc pour locales. La presence d'un en-tete de relais suffit a
 * les compter comme venant de l'exterieur - le meme raisonnement que pour la
 * console, sinon l'interrupteur d'acces distant se contournerait par un
 * simple en-tete. */
function originOf(req) {
  const sock = (req.socket.remoteAddress || '').replace('::ffff:', '');
  const local = sock === '127.0.0.1' || sock === '::1';
  const viaTunnel = local && RELAY_HEADERS.some(h => req.headers[h]);
  const declared = req.headers['cf-connecting-ip']
    || req.headers['x-real-ip']
    || req.headers['x-forwarded-for'] || '';
  const ip = viaTunnel && declared ? String(declared).split(',')[0].trim() : sock;
  return { ip, sock, viaTunnel, remote: viaTunnel || !isPrivateIp(sock) };
}

function jsonError(res, status, message, type) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: { message, type: type || 'invalid_request_error', code: status } }));
}

function estimateTokens(str) { return Math.max(1, Math.round(str.length / 4)); }

function sendOai(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(s);
}

/* Catalogue au format OpenRouter : les tarifs y sont par token, en chaine.
 * C'est ce que lisent les clients qui savent afficher un cout, et ca permet a
 * l'utilisateur de voir ce qui existe meme quand rien n'est charge. */
function sendModelList(res) {
  const doc = loadModels();
  const rows = doc.models.filter(m => m.model).map(m => {
    const p = priceOf(m);
    const loaded = runtime.modelId === m.id && runtime.ready;
    const ctx = Number(m.native_ctx) || 32768;
    return {
      id: m.id,
      object: 'model',
      name: m.name || m.id,
      created: Math.floor((m.added_at || Date.now()) / 1000),
      owned_by: 'llama.cpp',
      description: (m.name || m.id) + (loaded ? ' (charge)' : ' (a charger)'),
      context_length: ctx,
      architecture: {
        modality: m.mmproj ? 'text+image->text' : 'text->text',
        input_modalities: m.mmproj ? ['text', 'image'] : ['text'],
        output_modalities: ['text'],
        tokenizer: 'Other', instruct_type: null
      },
      pricing: {
        prompt: String(p.in / 1e6), completion: String(p.out / 1e6),
        // meme convention qu'OpenRouter : la relecture de cache a son tarif
        input_cache_read: String(p.cache / 1e6), input_cache_write: '0',
        request: '0', image: '0', web_search: '0', internal_reasoning: '0'
      },
      top_provider: { context_length: ctx, max_completion_tokens: null, is_moderated: false },
      per_request_limits: null,
      supported_parameters: ['temperature', 'top_p', 'top_k', 'max_tokens', 'stop', 'seed', 'tools'],
      loaded
    };
  });
  /* Les niveaux de reflexion ne sont pas des modeles : les lister comme tels
   * doublerait le catalogue pour rien. Ils sont annonces a cote, et la
   * passerelle comprend « muse-glimmer-30b:low » pour les clients qui n'ont
   * que le nom du modele comme levier. */
  for (const ligne of rows) {
    const niveaux = niveauxDe(doc.models.find(x => x.id === ligne.id));
    if (niveaux.length) {
      ligne.thinking_levels = niveaux.map(n => ({ id: ligne.id + ':' + n.name, name: n.label }));
    }
  }

  // le modele en service en tete : les clients prennent souvent le premier
  rows.sort((a, b) => (b.loaded ? 1 : 0) - (a.loaded ? 1 : 0));
  sendOai(res, 200, { object: 'list', data: rows });
}

/* /v1/key et /v1/credits, comme chez OpenRouter : un client peut afficher le
 * solde restant sans passer par le portail. */
function sendKeyInfo(res, key, pathname) {
  const s = keyStatus(key);
  if (/credits$/.test(pathname)) {
    return sendOai(res, 200, { data: {
      total_credits: s.limits.credit || 0,
      total_usage: s.total.cost
    } });
  }
  sendOai(res, 200, { data: {
    label: key.name,
    usage: s.total.cost,
    limit: s.limits.credit || null,
    limit_remaining: s.remaining.credit,
    is_free_tier: !s.limits.credit,
    is_provisioning_key: false,
    rate_limit: s.limits.reqPerDay
      ? { requests: s.limits.reqPerDay, interval: '1d' }
      : null,
    currency: config.pricing.currency,
    tokens_used: s.total.tokens,
    tokens_limit: s.limits.tokensTotal || null
  } });
}

/* Le cout est ajoute a l'objet usage de la reponse, sous le nom qu'utilise
 * OpenRouter. Les clients qui savent l'afficher (opencode entre autres) le
 * trouvent la ; les autres l'ignorent sans broncher. */
function cachedOf(u) {
  const d = (u && u.prompt_tokens_details) || {};
  const n = Number(d.cached_tokens);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function addCost(u, price) {
  if (!u || typeof u !== 'object') return u;
  const tIn = Number(u.prompt_tokens) || 0;
  const tOut = Number(u.completion_tokens) || 0;
  // llama.cpp dit combien de tokens d'entree venaient du cache : ceux-la n'ont
  // rien coute a recalculer, on les facture au tarif de relecture
  const cache = Math.min(cachedOf(u), tIn);
  const frais = tIn - cache;
  // un tarif venu d'ailleurs peut ne pas porter de prix de relecture : mieux
  // vaut retomber sur la fraction habituelle qu'annoncer un cout NaN
  const pCache = Number.isFinite(price.cache) ? price.cache : price.in * 0.1;
  const cFrais = (frais / 1e6) * price.in;
  const cCache = (cache / 1e6) * pCache;
  const cOut = (tOut / 1e6) * price.out;
  const r = x => Math.round(x * 1e10) / 1e10;
  if (u.total_tokens === undefined) u.total_tokens = tIn + tOut;
  u.cost = r(cFrais + cCache + cOut);
  u.cost_details = {
    upstream_inference_cost: null,
    upstream_inference_prompt_cost: r(cFrais + cCache),
    upstream_inference_completions_cost: r(cOut),
    // le detail, pour qui veut voir ce que le cache a economise
    cache_read_tokens: cache,
    cache_read_cost: r(cCache),
    cache_saved: r((cache / 1e6) * (price.in - price.cache))
  };
  u.is_byok = false;
  return u;
}

/* Reecrit un evenement SSE complet dont une ligne data: porte un usage. */
function injectCostSse(chunk, price) {
  return chunk.split('\n').map(line => {
    if (!line.startsWith('data:')) return line;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return line;
    try {
      const j = JSON.parse(raw);
      if (!j.usage) return line;
      addCost(j.usage, price);
      return 'data: ' + JSON.stringify(j);
    } catch { return line; }
  }).join('\n');
}

function isCompletionPath(p) {
  return /\/(chat\/completions|completions|completion|infill|responses)$/.test(p);
}

/* --------------------------------------------------------------------------
 * Honorer le modele demande
 *
 * Un client compatible OpenAI envoie un nom de modele. Jusqu'ici on servait
 * de toute facon celui qui etait charge : pratique, mais le client affichait
 * alors le tarif du modele qu'il croyait utiliser. Desormais, si le nom
 * figure au catalogue, c'est ce modele-la qui sert - charge au besoin. Un nom
 * inconnu (local-model, gpt-4...) retombe sur le modele en service, comme
 * avant.
 * ----------------------------------------------------------------------- */
/* Attend que le moteur reponde. Apres un lancement, un moteur qui disparait ne
 * reviendra pas : inutile d'attendre les trois minutes completes, on rend la
 * main tout de suite. */
function waitReady(ms, apresLancement) {
  const t0 = Date.now();
  const until = t0 + ms;
  return new Promise(resolve => {
    const tick = () => {
      if (runtime.proc && runtime.ready) return resolve(true);
      if (apresLancement && !runtime.proc && Date.now() - t0 > 1500) return resolve(false);
      if (Date.now() > until) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

/* Le nom demande peut porter un niveau de reflexion : « muse-glimmer-30b:low ».
 * C'est le seul moyen de choisir ce niveau depuis un client qui ne connait que
 * la liste des modeles - opencode, une interface web, n'importe quoi. */
function separerNiveau(asked) {
  const brut = String(asked || '').split('/').pop().trim();
  const i = brut.lastIndexOf(':');
  if (i <= 0) return { nom: brut, niveau: '' };
  return { nom: brut.slice(0, i), niveau: brut.slice(i + 1).toLowerCase() };
}

function resolveAsked(asked) {
  if (!asked) return null;
  // certains clients prefixent par le fournisseur : llamacpp/qwen36-27b
  const { nom, niveau } = separerNiveau(asked);
  const want = nom.toLowerCase();
  if (!want) return null;
  const doc = loadModels();
  const m = doc.models.find(x => String(x.id).toLowerCase() === want)
    || doc.models.find(x => String(x.name || '').toLowerCase() === want)
    || null;
  // un suffixe qui ne correspond a aucun niveau connu n'est pas un niveau :
  // c'est peut-etre un nom de modele qui contient deux-points
  if (m && niveau && niveauxDe(m).some(n => n.name === niveau)) return m;
  if (m && !niveau) return m;
  if (m && niveau) return m;   // niveau inconnu : on sert le modele quand meme
  return doc.models.find(x => String(x.id).toLowerCase() === String(asked).split('/').pop().trim().toLowerCase())
    || null;
}

/* Les niveaux de reflexion offerts par un modele, tels que le catalogue les
 * declare. Chacun porte les variables de gabarit qui vont avec. */
function niveauxDe(model) {
  const l = model && model.thinking && model.thinking.levels;
  if (!Array.isArray(l)) return [];
  return l.filter(n => n && n.name && n.kwargs && typeof n.kwargs === 'object')
    .map(n => ({ name: String(n.name).toLowerCase(), label: n.label || n.name, kwargs: n.kwargs }));
}

/* Le niveau reclame par la requete : par le nom du modele (« ...:low »), ou
 * par le champ reasoning_effort que certains clients envoient. */
function niveauDemande(asked, body, model) {
  const niveaux = niveauxDe(model);
  if (!niveaux.length) return null;
  const { niveau } = separerNiveau(asked);
  if (niveau) {
    const n = niveaux.find(x => x.name === niveau);
    if (n) return n;
  }
  const effort = body && typeof body.reasoning_effort === 'string'
    ? body.reasoning_effort.toLowerCase() : '';
  if (effort) {
    const direct = niveaux.find(x => x.name === effort);
    if (direct) return direct;
    // les valeurs d'OpenAI ne sont pas celles des modeles : on les rabat sur
    // les extremes plutot que de les ignorer
    if (['none', 'minimal'].includes(effort)) return niveaux[0];
    if (['max', 'maximum'].includes(effort)) return niveaux[niveaux.length - 1];
  }
  return null;
}

const noModel = m => ({ status: 503, type: 'service_unavailable', message: m });
const busyModel = m => ({ status: 409, type: 'invalid_request_error', message: m });
const tooBig = m => ({ status: 400, type: 'invalid_request_error', message: m });

/* Ce que donnerait le chargement de ce modele pour ce porteur de cle : les
 * reglages enregistres, ramenes au tout-GPU quand la cle n'a pas le droit de
 * deporter. Meme regle que le portail : un choix fait depuis opencode ne doit
 * pas pouvoir ce qu'un clic sur la meme page refuserait. */
function launchPlan(model, perm) {
  const L = savedBody(model, loadModels().defaults);
  if (!perm.offload) {
    L.gpuLayers = 999;
    if (L.vision === 2) L.vision = 1;
  }
  return L;
}

function vramRefusal(model, L, perm) {
  if (perm.offload) return null;   // l'admin assume le deport hors GPU
  // sans lecture de la carte, on ne sait rien : on ne bloque pas au hasard
  if (!gpuState.ok || !gpuState.totalMb) return null;
  const e = estimateVram(model, L);
  if (e.total <= e.usable) return null;
  const nom = model.name || model.id;
  const min = estimateVram(model, Object.assign({}, L, { slots: 1, ctxSlot: 2048 }));
  return tooBig(`« ${nom} » ne tient pas dans la memoire libre du GPU : `
    + `${Math.round(e.total)} Mo estimes avec son reglage enregistre `
    + `(${L.slots} agents × ${L.ctxSlot === -1 ? 'contexte automatique' : L.ctxSlot} tokens) `
    + `pour ${Math.round(e.usable)} Mo disponibles. `
    + (min.total <= min.usable
      ? 'Ouvre /portal avec ta cle pour le charger avec moins d\'agents ou moins de contexte.'
      : 'Meme au minimum il ne rentre pas : seul l\'administrateur peut le charger, '
        + 'en deportant une partie hors du GPU.'));
}

async function ensureModelInner(asked, key) {
  const A = config.autoLoad;
  const P = permOf(key);
  const waitMs = Math.max(5, Number(A.waitS) || 180) * 1000;
  const wanted = resolveAsked(asked);

  // 1. le modele voulu est deja en place, ou le client n'a rien demande de precis
  if (runtime.proc && (!wanted || wanted.id === runtime.modelId)) {
    if (runtime.ready) return null;
    return (await waitReady(waitMs))
      ? null
      : noModel('Le modele est encore en cours de chargement. Reessaie dans une minute.');
  }

  // 2. rien de charge, et aucun nom exploitable
  if (!wanted) {
    return noModel('Aucun modele charge. Demande-en un par son nom - la liste est '
      + 'sur GET /v1/models - ou ouvre /portal avec ta cle.');
  }

  // 3. il faudrait charger, ou remplacer
  if (!A.enabled) {
    return runtime.proc
      ? busyModel(`« ${runtime.modelName} » est en service. Demande ce modele-la `
        + `(${runtime.modelId}) : le chargement a la demande est desactive.`)
      : noModel('Aucun modele charge, et le chargement a la demande est desactive.');
  }

  // 3 bis. cette cle a-t-elle le droit de faire bouger le serveur ?
  if (!P.launch) {
    return runtime.proc
      ? busyModel(`« ${runtime.modelName} » est en service et cette cle ne peut pas faire `
        + `changer de modele. Demande ${runtime.modelId}, ou fais passer ta cle en `
        + '« de confiance ».')
      : noModel('Aucun modele charge, et cette cle ne peut pas en faire charger un. '
        + 'Demande a l\'administrateur d\'en charger un, ou de remonter les droits de ta cle.');
  }

  // 3 ter. et est-ce que ca tient ? Le controle est fait avant d'arreter quoi
  // que ce soit : on ne libere pas la carte pour finalement refuser.
  const plan = launchPlan(wanted, P);
  const refus = vramRefusal(wanted, plan, P);
  if (refus) return refus;

  if (runtime.proc) {
    if (!A.swap) {
      return busyModel(`« ${runtime.modelName} » est en service et le remplacement automatique `
        + `est desactive. Demande ${runtime.modelId}, ou fais changer de modele.`);
    }
    if ((runtime.slots || []).some(s => s.busy) || inFlight > 0) {
      return busyModel(`« ${runtime.modelName} » travaille en ce moment : on ne le remplace pas `
        + 'en pleine reponse. Reessaie dans un instant.');
    }
    const idle = idleFor();
    const grace = Math.max(0, Number(A.swapIdleS) || 0) * 1000;
    if (idle < grace) {
      return busyModel(`« ${runtime.modelName} » a servi il y a ${Math.round(idle / 1000)} s. `
        + `Il faut ${Math.round(grace / 1000)} s de calme avant de le remplacer, pour ne pas `
        + 'faire des allers-retours entre deux modeles.');
    }
    pushLog('sys', `Modele demande par un client : ${runtime.modelId} laisse la place a ${wanted.id}.`);
    await stopServer();
    for (let i = 0; i < 30 && runtime.proc; i++) await new Promise(r => setTimeout(r, 200));
    await new Promise(r => setTimeout(r, 800));
  }

  /* Deux tentatives, et une seule raison a cela : un moteur qu'on vient de tuer
   * ne rend pas son port dans la milliseconde. La sonde le voit libre, le
   * suivant se fait refuser l'adresse et meurt aussitot. C'est exactement ce
   * qui arrive quand on arrete un modele depuis la console puis qu'on relance
   * une requete dans la foulee : une seconde chance vaut mieux qu'une erreur. */
  const nom = wanted.name || wanted.id;
  for (let essai = 0; essai < 2; essai++) {
    if (await portBusy(config.upstreamPort)) {
      if (essai) {
        return noModel(`Le port ${config.upstreamPort} est occupe par un autre llama-server. `
          + 'Previens l\'administrateur.');
      }
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    try {
      launch(Object.assign({}, plan, { by: (key && key.name) || 'API' }));
    } catch (e) {
      return noModel('Chargement impossible : ' + e.message);
    }
    if (await waitReady(waitMs, true)) return null;
    // trop lent, ou mort au demarrage : ce n'est pas la meme histoire a raconter
    if (runtime.proc) {
      return { status: 504, type: 'service_unavailable',
        message: `« ${nom} » met trop de temps a charger. Il continue `
          + 'peut-etre : reessaie dans une minute.' };
    }
    if (essai === 0) {
      pushLog('sys', `${wanted.id} n'a pas tenu au demarrage`
        + (runtime.exitCode != null ? ` (code ${runtime.exitCode})` : '')
        + ' : nouvelle tentative dans une seconde et demie.');
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    return { status: 503, type: 'service_unavailable',
      message: `« ${nom} » s'est arrete des le demarrage`
        + (runtime.exitCode != null ? ` (code ${runtime.exitCode})` : '')
        + '. Les journaux de la console disent pourquoi.' };
  }
  return noModel(`« ${nom} » n'a pas pu demarrer : le port ${config.upstreamPort} reste occupe.`);
}

/* Les demandes sont servies l'une apres l'autre : deux clients qui reclament
 * le meme modele absent ne doivent pas lancer deux serveurs, le second doit
 * simplement attendre le premier. */
let loadChain = Promise.resolve();
function ensureModel(asked, key) {
  const run = () => ensureModelInner(asked, key);
  const next = loadChain.then(run, run);
  loadChain = next.then(() => {}, () => {});
  return next;
}

function handleProxy(req, res, url) {
  const started = Date.now();
  const origin = originOf(req);
  const ip = origin.ip;

  const rawKey = req.headers.authorization
    || req.headers['x-api-key']
    || (url.searchParams.get('api_key') ? 'Bearer ' + url.searchParams.get('api_key') : '');
  const key = findKey(rawKey);

  if (!key) return jsonError(res, 401, 'Cle API absente ou invalide.', 'authentication_error');
  if (key.disabled) return jsonError(res, 403, 'Cette cle est desactivee.', 'permission_error');
  if (origin.remote) {
    if (!config.remote.enabled) {
      return jsonError(res, 403, 'Acces hors du reseau local desactive.', 'permission_error');
    }
    if (key.remoteAllowed === false) {
      return jsonError(res, 403, 'Cette cle ne fonctionne que sur le reseau local.', 'permission_error');
    }
  }
  // Routes de service, avant le controle d'enveloppe : c'est justement quand
  // le solde est epuise qu'un client a besoin de lire son solde.
  if (req.method === 'GET' && /\/models$/.test(url.pathname)) return sendModelList(res);
  if (req.method === 'GET' && /\/(key|credits)$/.test(url.pathname)) return sendKeyInfo(res, key, url.pathname);

  const blocked = quotaBlock(key);
  if (blocked) return jsonError(res, blocked.status, blocked.message, blocked.type);

  /* Partage et surcharge. On ne fait patienter personne en silence : soit il
   * reste de la place, soit on le dit avec un chiffre et un Retry-After que les
   * clients savent lire. Le controle ne vaut que pour les requetes qui occupent
   * un agent - lire son solde n'en occupe aucun. */
  if (isCompletionPath(url.pathname)) {
    const charge = loadState();
    const budget = slotBudget(key);
    const pris = keyLoad(key.id);

    if (pris >= budget) {
      const attente = Math.max(3, Math.round((charge.medianMs || 15000) / 1000));
      res.setHeader('Retry-After', String(attente));
      return jsonError(res, 429,
        `Cette cle utilise deja ${pris} agent${pris > 1 ? 's' : ''} sur ${budget} `
        + `autorise${budget > 1 ? 's' : ''}. Attends qu'une reponse se termine `
        + `(environ ${attente} s) ou demande a l'administrateur d'elargir ta cle.`,
        'rate_limit_error');
    }

    const parAgent = Math.max(0, Number(config.overload.queuePerSlot) || 0);
    const filePleine = config.overload.enabled !== false
      && charge.agents > 0
      && charge.queue >= charge.agents * parAgent + parAgent;
    if (filePleine) {
      const attente = Math.max(3, charge.waitS || 20);
      res.setHeader('Retry-After', String(attente));
      return jsonError(res, 429,
        `Serveur au complet : ${charge.busy} agent${charge.busy > 1 ? 's' : ''} occupe`
        + `${charge.busy > 1 ? 's' : ''} et ${charge.queue} requete`
        + `${charge.queue > 1 ? 's' : ''} en attente. Environ ${attente} s. Reessaie.`,
        'rate_limit_error');
    }
  }

  // le corps est mis en memoire pour compter les tokens : on le borne, sinon
  // un client authentifie peut faire gonfler le processus a volonte
  const MAX_BODY = 64 * 1024 * 1024;
  const chunks = [];
  let received = 0, tooBig = false;
  req.on('data', c => {
    received += c.length;
    if (received > MAX_BODY) {
      if (!tooBig) {
        tooBig = true;
        jsonError(res, 413, 'Requete trop volumineuse (limite 64 Mo).', 'invalid_request_error');
        req.destroy();
      }
      return;
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (tooBig) return;
    let bodyBuf = Buffer.concat(chunks);
    let promptTokens = 0, stream = false, asked = '', parsed = null;
    if (bodyBuf.length) {
      try {
        parsed = JSON.parse(bodyBuf.toString('utf8'));
        stream = !!parsed.stream;
        if (parsed.model) asked = String(parsed.model);
        if (Array.isArray(parsed.messages)) {
          promptTokens = estimateTokens(parsed.messages.map(m =>
            typeof m.content === 'string' ? m.content
              : Array.isArray(m.content) ? m.content.map(p => p.text || '').join(' ') : '').join(' '));
        } else if (typeof parsed.prompt === 'string') {
          promptTokens = estimateTokens(parsed.prompt);
        }
      } catch {}
    }

    // Le bon modele, ou une erreur qui dit lequel tourne : jamais une reponse
    // silencieuse d'un autre modele au tarif de celui demande.
    const gate = await ensureModel(asked, key);
    if (gate) return jsonError(res, gate.status, gate.message, gate.type);
    // Le client a pu partir pendant l'attente du chargement. On ne regarde que
    // la reponse : req.destroyed passe a vrai des que le corps est lu, Node
    // detruit le flux de requete tout seul - le tester ici couperait
    // absolument toutes les requetes.
    if (res.writableEnded || res.destroyed) return;

    // le modele est en place : on facture celui-la, et lui seul
    const modelName = runtime.modelId || '?';
    const price = priceOf(loadModels().models.find(m => m.id === runtime.modelId));
    const billing = config.pricing.enabled && config.pricing.reportCost !== false;

    // Sans include_usage, llama.cpp ne renvoie aucun decompte en flux : il
    // n'y aurait donc aucun cout a afficher cote client. On le demande, le
    // dernier evenement porte alors usage, et on y glisse le prix.
    let corpsChange = false;
    if (billing && stream && parsed && isCompletionPath(url.pathname)) {
      parsed.stream_options = Object.assign({ include_usage: true }, parsed.stream_options);
      corpsChange = true;
    }

    /* Reglages d'echantillonnage. Les drapeaux passes au moteur ne suffisent
     * pas : un client qui envoie sa propre temperature ecrase celle du serveur,
     * et opencode le fait. C'est donc ici, sur le corps de la requete, que le
     * reglage du modele peut vraiment s'appliquer. */
    if (parsed && isCompletionPath(url.pathname)) {
      if (appliquerEchantillonnage(parsed, runtime.modelId, asked)) corpsChange = true;
    }
    if (corpsChange) bodyBuf = Buffer.from(JSON.stringify(parsed), 'utf8');

    const headers = Object.assign({}, req.headers);
    delete headers['content-length'];
    delete headers.host;
    headers.authorization = 'Bearer ' + INTERNAL_KEY;
    delete headers['x-api-key'];
    if (bodyBuf.length) headers['content-length'] = String(bodyBuf.length);

    // A partir d'ici quelqu'un attend une reponse : le dechargement
    // automatique doit voir le modele occupe, meme entre deux sondages.
    inFlight++;
    keyLoadAdd(key.id, 1);
    runtime.lastActivity = Date.now();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
      keyLoadAdd(key.id, -1);
      runtime.lastActivity = Date.now();
    };
    res.on('close', release);          // fin normale, ou client parti en route

    const up = http.request({
      host: config.upstreamHost,
      port: config.upstreamPort,
      path: url.pathname + url.search,
      method: req.method,
      headers,
      agent: upstreamAgent
    }, ur => {
      const ctype = String(ur.headers['content-type'] || '');
      const capture = ur.statusCode < 400;
      // on ne reecrit que ce qu'on comprend : une completion reussie, en JSON
      // ou en flux SSE. Tout le reste traverse octet pour octet.
      const rewrite = billing && capture && isCompletionPath(url.pathname)
        && (stream ? ctype.includes('event-stream') : ctype.includes('json'));

      // Etat de la maison, sur chaque reponse : un client qui boucle peut se
      // reguler tout seul au lieu de decouvrir la saturation en attendant.
      const charge = loadState();
      const outHeaders = Object.assign({}, ur.headers, {
        'access-control-allow-origin': '*',
        'x-agents-total': String(charge.agents),
        'x-agents-busy': String(charge.busy),
        'x-queue-depth': String(charge.queue),
        // un en-tete HTTP ne transporte pas d'Unicode : « unlimited », pas un
        // joli symbole infini qui fait tomber tout le serveur
        'x-key-slots': keyLoad(key.id) + '/'
          + (slotBudget(key) === Infinity ? 'unlimited' : slotBudget(key))
      });
      // la longueur change avec le cout ajoute : on passe en transfert par blocs
      if (rewrite && !stream) delete outHeaders['content-length'];
      res.writeHead(ur.statusCode, outHeaders);

      let collected = '';
      let pending = '';          // reste d'evenement SSE incomplet
      const held = [];           // reponse JSON mise de cote le temps de l'annoter
      let heldSize = 0, giveUp = false;

      ur.on('data', c => {
        if (capture && collected.length < 2_000_000) collected += c.toString('utf8');
        if (!rewrite || giveUp) return res.write(c);
        if (stream) {
          pending += c.toString('utf8');
          let i;
          while ((i = pending.indexOf('\n\n')) >= 0) {
            const evt = pending.slice(0, i + 2);
            pending = pending.slice(i + 2);
            res.write(evt.includes('"usage"') ? injectCostSse(evt, price) : evt);
          }
          return;
        }
        heldSize += c.length;
        if (heldSize > 8 * 1024 * 1024) {   // reponse inattendue : on renonce a annoter
          giveUp = true;
          for (const h of held) res.write(h);
          held.length = 0;
          return res.write(c);
        }
        held.push(c);
      });
      ur.on('end', () => {
        if (rewrite && !giveUp) {
          if (stream) {
            if (pending) res.write(pending.includes('"usage"') ? injectCostSse(pending, price) : pending);
          } else {
            const raw = Buffer.concat(held).toString('utf8');
            let out = raw;
            try {
              const j = JSON.parse(raw);
              if (j.usage) { addCost(j.usage, price); out = JSON.stringify(j); }
            } catch {}
            res.write(out);
          }
        }
        res.end();
        let tIn = promptTokens, tOut = 0, tCache = 0, exact = false;
        if (capture) {
          if (stream) {
            let last = null;
            let text = '';
            for (const line of collected.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const j = JSON.parse(payload);
                if (j.usage) last = j.usage;
                // le moteur donne aussi le compte en clair dans ses timings :
                // cache_n, c'est la part du prompt qui n'a pas ete recalculee
                if (j.timings && j.timings.predicted_n) last = {
                  prompt_tokens: j.timings.prompt_n, completion_tokens: j.timings.predicted_n,
                  prompt_tokens_details: { cached_tokens: j.timings.cache_n || 0 }
                };
                const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0]);
                if (d) {
                  if (typeof d.content === 'string') text += d.content;
                  if (typeof d.reasoning_content === 'string') text += d.reasoning_content;
                }
              } catch {}
            }
            if (last) {
              tIn = last.prompt_tokens ?? tIn;
              tOut = last.completion_tokens ?? 0;
              tCache = cachedOf(last);
              exact = true;
            } else {
              tOut = estimateTokens(text);
            }
          } else {
            try {
              const j = JSON.parse(collected);
              if (j.usage) {
                tIn = j.usage.prompt_tokens ?? tIn;
                tOut = j.usage.completion_tokens ?? 0;
                tCache = cachedOf(j.usage);
                exact = true;
              } else if (j.content) {
                tOut = estimateTokens(j.content);
              }
              if (!tCache && j.timings && j.timings.cache_n) tCache = j.timings.cache_n;
            } catch {}
          }
        }
        recordUsage({
          at: started,
          ms: Date.now() - started,
          keyId: key.id,
          keyName: key.name,
          ip,
          remote: origin.remote,
          path: url.pathname,
          model: modelName,
          asked: asked && asked !== modelName ? asked : '',
          status: ur.statusCode,
          stream,
          tokensIn: tIn,
          tokensOut: tOut,
          tokensCached: tCache,
          exact
        });
        // sert a estimer l'attente annoncee quand tout est occupe
        noteDuree(Date.now() - started, tOut);
      });
    });

    up.on('error', e => {
      release();
      if (!res.headersSent) jsonError(res, 502, 'Le serveur llama.cpp ne repond pas : ' + e.message, 'api_error');
      else res.end();
    });
    if (bodyBuf.length) up.write(bodyBuf);
    up.end();
  });
}

// --------------------------------------------------------------------------
// API de la console
// --------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const c = [];
    let size = 0;
    req.on('data', b => { size += b.length; if (size > 2_000_000) req.destroy(); c.push(b); });
    req.on('end', () => {
      const s = Buffer.concat(c).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const s = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

/* Adresses IPv4 de la machine, la plus utile en premier : un vrai reseau
 * domestique (192.168, 10.x, 172.16-31) avant les liens automatiques. */
function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ iface: name, address: i.address });
    }
  }
  const rank = a => {
    if (/^169\.254\./.test(a)) return 3;                       // lien local, souvent inutilisable
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) return 0;
    return 1;
  };
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

async function handleApi(req, res, url) {
  const p = url.pathname.replace('/_api', '');

  // toute requete qui modifie quelque chose doit venir de la console elle-meme
  if (req.method !== 'GET' && !sameOrigin(req)) {
    return sendJson(res, 403, {
      error: 'Requete rejetee : elle ne vient pas de la console (protection CSRF).'
    });
  }

  if (p === '/login' && req.method === 'POST') {
    const who = originOf(req).ip || 'inconnu';
    const now = Date.now();
    const tries = (loginTries.get(who) || []).filter(t => now - t < 15 * 60000);
    if (tries.length >= 10) {
      loginTries.set(who, tries);
      return sendJson(res, 429, { error: 'Trop de tentatives. Reessaie dans un quart d\'heure.' });
    }
    const b = await readBody(req);
    const ok = config.adminPassword
      && Buffer.byteLength(b.password || '') === Buffer.byteLength(config.adminPassword)
      && crypto.timingSafeEqual(Buffer.from(String(b.password)), Buffer.from(config.adminPassword));
    if (!ok) {
      tries.push(now);
      loginTries.set(who, tries);
      console.log(`[${new Date().toLocaleTimeString('fr-FR')}] mot de passe admin refuse depuis ${who}`);
    }
    if (ok) {
      const tok = crypto.randomBytes(24).toString('hex');
      sessions.set(tok, Date.now() + SESSION_TTL);
      res.setHeader('Set-Cookie', `llamadash=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 401, { error: 'Mot de passe incorrect.' });
  }

  if (!adminAllowed(req)) {
    return sendJson(res, 401, {
      error: config.adminPassword
        ? 'Connexion requise depuis le reseau.'
        : 'La console est limitee a la machine locale. Definis un mot de passe admin pour y acceder depuis le reseau.',
      needsLogin: !!config.adminPassword
    });
  }

  // ---- etat global ----
  if (p === '/state' && req.method === 'GET') {
    const doc = loadModels();
    return sendJson(res, 200, {
      models: doc.models.map(modelPayload),
      defaults: doc.defaults,
      status: statusPayload(),
      gpu: gpuState,
      config: {
        port: config.port,
        upstreamHost: config.upstreamHost,
        upstreamPort: config.upstreamPort,
        modelsJson: config.modelsJson,
        reserveMb: config.reserveMb,
        idleUnloadMin: config.idleUnloadMin,
        hasAdminPassword: !!config.adminPassword,
        lastLaunch: config.lastLaunch,
        remote: config.remote,
        pricing: config.pricing,
        portal: config.portal,
        autoLoad: config.autoLoad,
        overload: config.overload,
        sampling: config.sampling
      },
      cacheRam: cacheRamPayload(),
      ratings: ratingsSummary(),
      poll: pollSummary(),
      load: loadState(),
      keys: keysPayload(),
      lan: lanAddresses(),
      stats: stats.days,
      tunnel: tunnelPayload(),
      // valeur gardee : l'etat ne doit pas attendre un programme externe
      tailscale: tailscaleCached(),
      logs: runtime.logs.slice(-300)
    });
  }

  // ---- lancement / arret ----
  if (p === '/launch' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      // remplacer le modele en service : on arrete d'abord, la VRAM doit etre rendue
      if (runtime.proc && b.replace) {
        await stopServer();
        for (let i = 0; i < 30 && runtime.proc; i++) await new Promise(r => setTimeout(r, 200));
        await new Promise(r => setTimeout(r, 800));
      }
      if (await portBusy(config.upstreamPort)) {
        return sendJson(res, 400, {
          error: `Le port ${config.upstreamPort} est deja occupe, sans doute par un llama-server lance a la main ou par LLAMA.bat. Ferme-le, ou change le port interne dans Reglages.`
        });
      }
      return sendJson(res, 200, launch(b));
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (p === '/stop' && req.method === 'POST') {
    await stopServer();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/restart' && req.method === 'POST') {
    const last = config.lastLaunch;
    await stopServer();
    await new Promise(r => setTimeout(r, 1200));
    if (!last) return sendJson(res, 400, { error: 'Aucun lancement precedent a rejouer.' });
    try { return sendJson(res, 200, launch(last)); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  // ---- modeles ----
  if (p === '/models' && req.method === 'PUT') {
    const b = await readBody(req);
    const doc = loadModels();
    const i = doc.models.findIndex(m => m.id === b.id);
    if (i < 0) doc.models.push(b.model); else doc.models[i] = Object.assign({}, doc.models[i], b.model);
    saveModels(doc);
    return sendJson(res, 200, { ok: true, models: doc.models.map(modelPayload) });
  }
  if (p === '/models' && req.method === 'DELETE') {
    const b = await readBody(req);
    const doc = loadModels();
    doc.models = doc.models.filter(m => m.id !== b.id);
    saveModels(doc);
    return sendJson(res, 200, { ok: true, models: doc.models.map(modelPayload) });
  }
  if (p === '/defaults' && req.method === 'PUT') {
    const b = await readBody(req);
    const doc = loadModels();
    doc.defaults = Object.assign({}, doc.defaults, b);
    saveModels(doc);
    return sendJson(res, 200, { ok: true, defaults: doc.defaults });
  }

  // ---- cles ----
  if (p === '/keys' && req.method === 'POST') {
    const b = await readBody(req);
    const k = newKey(b.name);
    k.limits = readLimits(b.limits, k.limits);
    if (b.limitPerDay) k.limits.reqPerDay = clampInt(b.limitPerDay, 0, 1e9, 0);
    k.limitPerDay = k.limits.reqPerDay;
    if (ROLES.includes(b.role)) k.role = b.role;
    if (typeof b.remoteAllowed === 'boolean') k.remoteAllowed = b.remoteAllowed;
    saveKeys();
    return sendJson(res, 200, { key: k, keys: keysPayload() });
  }
  if (p === '/keys' && req.method === 'PATCH') {
    const b = await readBody(req);
    const k = keyStore.keys.find(x => x.id === b.id);
    if (!k) return sendJson(res, 404, { error: 'Cle introuvable.' });
    if (typeof b.disabled === 'boolean') k.disabled = b.disabled;
    if (typeof b.name === 'string') k.name = b.name.slice(0, 60);
    if (ROLES.includes(b.role)) k.role = b.role;
    if (typeof b.remoteAllowed === 'boolean') k.remoteAllowed = b.remoteAllowed;
    if (b.limits) k.limits = readLimits(b.limits, k.limits);
    if (b.limitPerDay !== undefined) k.limits.reqPerDay = clampInt(b.limitPerDay, 0, 1e9, 0);
    // le champ historique suit, pour rester lisible par les anciens outils
    k.limitPerDay = k.limits.reqPerDay;
    if (b.resetUsage) { k.requests = 0; k.tokensIn = 0; k.tokensOut = 0; k.tokensCached = 0; k.cost = 0; }
    saveKeys();
    return sendJson(res, 200, { keys: keysPayload() });
  }
  if (p === '/keys' && req.method === 'DELETE') {
    const b = await readBody(req);
    keyStore.keys = keyStore.keys.filter(x => x.id !== b.id);
    saveKeys();
    return sendJson(res, 200, { keys: keysPayload() });
  }

  // ---- activite ----
  if (p === '/activity' && req.method === 'GET') {
    return sendJson(res, 200, { items: readActivity(300), stats: stats.days });
  }

  // ---- acces distant ----
  if (p === '/remote' && req.method === 'PUT') {
    const b = await readBody(req);
    if (typeof b.enabled === 'boolean') {
      // ouvrir la console au monde sans mot de passe admin serait un piege
      if (b.enabled && !config.adminPassword) {
        return sendJson(res, 400, { error: 'Definis d\'abord un mot de passe admin dans Reglages : sans lui, la console serait pilotable par n\'importe qui.' });
      }
      config.remote.enabled = b.enabled;
    }
    if (typeof b.method === 'string' && ['off', 'cloudflare', 'tailscale', 'manual'].includes(b.method)) {
      config.remote.method = b.method;
    }
    if (typeof b.publicUrl === 'string') config.remote.publicUrl = b.publicUrl.trim().replace(/\/+$/, '');
    saveConfig();
    broadcast('remote', { remote: config.remote });
    return sendJson(res, 200, { remote: config.remote });
  }
  if (p === '/tunnel/start' && req.method === 'POST') {
    try { return sendJson(res, 200, startTunnel()); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (p === '/tunnel/stop' && req.method === 'POST') {
    await stopTunnel();
    return sendJson(res, 200, tunnelPayload());
  }
  if (p === '/tunnel/install' && req.method === 'POST') {
    try { return sendJson(res, 200, await installCloudflared()); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (p === '/tailscale' && req.method === 'GET') {
    return sendJson(res, 200, await tailscaleState());
  }

  // ---- tarifs ----
  if (p === '/pricing' && req.method === 'PUT') {
    const b = await readBody(req);
    if (typeof b.enabled === 'boolean') config.pricing.enabled = b.enabled;
    if (typeof b.reportCost === 'boolean') config.pricing.reportCost = b.reportCost;
    if (typeof b.currency === 'string') config.pricing.currency = b.currency.slice(0, 4);
    if (b.defaultIn !== undefined) config.pricing.defaultIn = Math.max(0, Number(b.defaultIn) || 0);
    if (b.defaultOut !== undefined) config.pricing.defaultOut = Math.max(0, Number(b.defaultOut) || 0);
    if (b.kwhPrice !== undefined) {
      const k = Number(b.kwhPrice);
      config.pricing.kwhPrice = Number.isFinite(k) && k >= 0 ? Math.min(10, k) : 0.215;
    }
    if (b.cacheRatio !== undefined) {
      const r = Number(b.cacheRatio);
      config.pricing.cacheRatio = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.1;
    }
    saveConfig();

    // prix par modele, ecrits dans models.json (le .bat ignore ces cles)
    if (Array.isArray(b.models) && b.models.length) {
      const doc = loadModels();
      let touched = 0;
      for (const row of b.models) {
        const m = doc.models.find(x => x.id === row.id);
        if (!m) continue;
        // une valeur absente ou illisible laisse le tarif en place : mieux vaut
        // ne rien changer que de remettre un prix a zero par accident
        const pin = Number(row.price_in), pout = Number(row.price_out);
        if (Number.isFinite(pin) && row.price_in !== '' && row.price_in !== null) {
          m.price_in = Math.max(0, pin); touched++;
        }
        if (Number.isFinite(pout) && row.price_out !== '' && row.price_out !== null) {
          m.price_out = Math.max(0, pout); touched++;
        }
        // le prix de relecture : vide, il retombe sur la fraction generale
        if (row.price_cache === '' || row.price_cache === null) {
          if (m.price_cache !== undefined) { delete m.price_cache; touched++; }
        } else if (row.price_cache !== undefined && Number.isFinite(Number(row.price_cache))) {
          m.price_cache = Math.max(0, Number(row.price_cache)); touched++;
        }
      }
      if (touched) saveModels(doc);
    }
    return sendJson(res, 200, { pricing: config.pricing, models: loadModels().models.map(modelPayload) });
  }

  // ---- cache de prompt : defaut durable ou valeur de session ----
  if (p === '/cache-ram' && req.method === 'PUT') {
    const b = await readBody(req);
    const n = clampInt(b.value, 0, 32768, 4096);
    if (b.scope === 'session') {
      // null remet la session sur le defaut
      sessionCacheRam = (b.value === null || b.value === '') ? null : n;
    } else {
      const doc = loadModels();
      doc.defaults = Object.assign({}, doc.defaults, { cache_ram_mb: n });
      saveModels(doc);
      // le defaut change : une valeur de session posee avant n'a plus de raison
      // de survivre en silence
      if (b.clearSession) sessionCacheRam = null;
    }
    return sendJson(res, 200, { cacheRam: cacheRamPayload(), defaults: loadModels().defaults });
  }

  // ---- avis des utilisateurs ----
  if (p === '/ratings' && req.method === 'GET') {
    return sendJson(res, 200, ratingsSummary());
  }

  // ---- sondage : poser une question ----
  if (p === '/poll' && req.method === 'PUT') {
    const b = await readBody(req);
    const question = String(b.question || '').trim().slice(0, 200);
    const options = Array.isArray(b.options)
      ? b.options.map(o => String(o || '').trim().slice(0, 60)).filter(Boolean).slice(0, 4)
      : [];
    // Question ou choix modifies : c'est un autre sondage. On change d'identite
    // pour que les reponses a l'ancienne question ne se melangent pas aux
    // nouvelles, et que chacun soit re-interroge.
    const change = question !== config.poll.question
      || options.join(' ') !== (config.poll.options || []).join(' ');
    if (change) config.poll.id = question ? Date.now() : 0;
    config.poll.question = question;
    config.poll.options = options;
    if (typeof b.active === 'boolean') config.poll.active = b.active && !!question;
    if (typeof b.allowText === 'boolean') config.poll.allowText = b.allowText;
    if (!question) config.poll.active = false;
    saveConfig();
    return sendJson(res, 200, { poll: pollSummary() });
  }
  if (p === '/poll' && req.method === 'GET') {
    return sendJson(res, 200, pollSummary());
  }

  // ---- echantillonnage ----
  if (p === '/sampling' && req.method === 'PUT') {
    const b = await readBody(req);
    if (['fill', 'force', 'off'].includes(b.mode)) config.sampling.mode = b.mode;
    saveConfig();
    return sendJson(res, 200, { sampling: config.sampling });
  }

  // ---- surcharge ----
  if (p === '/overload' && req.method === 'PUT') {
    const b = await readBody(req);
    if (typeof b.enabled === 'boolean') config.overload.enabled = b.enabled;
    if (b.queuePerSlot !== undefined) config.overload.queuePerSlot = clampInt(b.queuePerSlot, 0, 20, 1);
    saveConfig();
    return sendJson(res, 200, { overload: config.overload });
  }

  // ---- chargement a la demande ----
  if (p === '/autoload' && req.method === 'PUT') {
    const b = await readBody(req);
    if (typeof b.enabled === 'boolean') config.autoLoad.enabled = b.enabled;
    if (typeof b.swap === 'boolean') config.autoLoad.swap = b.swap;
    if (b.swapIdleS !== undefined) config.autoLoad.swapIdleS = clampInt(b.swapIdleS, 0, 3600, 60);
    if (b.waitS !== undefined) config.autoLoad.waitS = clampInt(b.waitS, 10, 900, 180);
    saveConfig();
    return sendJson(res, 200, { autoLoad: config.autoLoad });
  }

  // ---- portail utilisateur ----
  if (p === '/portal' && req.method === 'PUT') {
    const b = await readBody(req);
    if (typeof b.enabled === 'boolean') config.portal.enabled = b.enabled;
    if (typeof b.topupEnabled === 'boolean') config.portal.topupEnabled = b.topupEnabled;
    if (b.launchCooldownS !== undefined) config.portal.launchCooldownS = clampInt(b.launchCooldownS, 0, 3600, 60);
    saveConfig();
    return sendJson(res, 200, { portal: config.portal });
  }

  // ---- reglages ----
  if (p === '/config' && req.method === 'PUT') {
    const b = await readBody(req);
    // Un chemin inexistant donnerait un catalogue vide, puis la premiere
    // sauvegarde creerait un fichier a cote : on refuse plutot que de laisser
    // la console travailler en silence sur une copie.
    if (typeof b.modelsJson === 'string' && b.modelsJson.trim()) {
      const wanted = b.modelsJson.trim();
      if (wanted !== config.modelsJson) {
        if (!fs.existsSync(wanted)) {
          return sendJson(res, 400, {
            error: 'Aucun fichier a ce chemin : ' + wanted
              + '. Verifie le chemin, la console continue d\'utiliser ' + config.modelsJson + '.'
          });
        }
        const test = readJson(wanted, null);
        if (!test || !Array.isArray(test.models)) {
          return sendJson(res, 400, {
            error: 'Ce fichier n\'est pas un models.json valide (pas de liste "models"). Chemin inchange.'
          });
        }
        config.modelsJson = wanted;
        modelsCache = { mtime: 0, doc: null, path: '' };
      }
    }
    if (b.upstreamPort) config.upstreamPort = clampInt(b.upstreamPort, 1, 65535, config.upstreamPort);
    if (b.port) config.port = clampInt(b.port, 1, 65535, config.port);
    if (b.reserveMb !== undefined) config.reserveMb = clampInt(b.reserveMb, 0, 32768, config.reserveMb);
    if (b.idleUnloadMin !== undefined) config.idleUnloadMin = clampInt(b.idleUnloadMin, 0, 1440, config.idleUnloadMin);
    if (typeof b.adminPassword === 'string') {
      config.adminPassword = b.adminPassword;
      sessions.clear();
    }
    saveConfig();
    return sendJson(res, 200, { ok: true });
  }

  // ---- flux temps reel ----
  if (p === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  return sendJson(res, 404, { error: 'Route inconnue : ' + p });
}

// --------------------------------------------------------------------------
// Portail utilisateur
//
// Pas d'administration ici : la cle API sert d'identifiant, on ne montre que
// ce qui appartient a son porteur. Deux choses seulement sont possibles - voir
// sa consommation, et demander un modele quand la carte est libre.
// --------------------------------------------------------------------------
const userTries = new Map();      // ip -> horodatages des cles refusees
let lastUserLaunch = 0;

function userThrottled(ip) {
  const now = Date.now();
  const list = (userTries.get(ip) || []).filter(t => now - t < 15 * 60000);
  userTries.set(ip, list);
  return list.length >= 20;
}
function userFailed(ip) {
  const list = userTries.get(ip) || [];
  list.push(Date.now());
  userTries.set(ip, list);
}

/* Ce que le portail a le droit de savoir d'un modele : de quoi choisir, rien
 * de plus. Pas de chemin de fichier, pas d'arguments. */
function publicModel(m) {
  const d = describeModel(m);
  // le plan tel qu'il sera reellement applique depuis le portail : tout sur le
  // GPU, projecteur de vision compris, sinon l'estimation ment
  const L = launchPlan(m, { offload: false });
  const e = estimateVram(m, L);
  // Le reglage enregistre peut deborder alors que le modele, lui, tiendrait
  // tres bien avec moins d'agents ou moins de contexte. On calcule donc aussi
  // le plancher - un agent, le plus petit contexte - pour savoir si l'utilisateur
  // a la moindre chance d'y arriver en reglant.
  const eMin = estimateVram(m, Object.assign({}, L, { slots: 1, ctxSlot: 2048 }));
  const f = familyOf(m);
  return {
    id: m.id,
    name: m.name || m.id,
    family: f.key, familyName: f.label, familySize: f.count,
    sizeMb: d.modelMb,
    ctx: m.ctx_auto ? null : L.ctxSlot,
    slots: L.slots,
    nativeCtx: Number(m.native_ctx) || 32768,
    vision: !!d.hasMmproj && L.vision !== 0,
    price: priceOf(m),
    ready: d.hasModel && d.hasBin,
    loaded: runtime.modelId === m.id && !!runtime.proc,
    vram: { total: e.total, usable: e.usable, guessed: e.kvGuessed, min: eMin.total },
    fits: e.total <= e.usable,          // avec le reglage enregistre
    fitsMin: eMin.total <= eMin.usable, // en reglant au plus juste
    // de quoi refaire l'estimation dans le navigateur quand l'utilisateur
    // deplace les curseurs ; le serveur revalide de toute facon au lancement
    calc: {
      weights: e.weights,
      kvKbToken: Number(m.kv_kb_token) || 20,
      swaMb: Number(m.swa_mb) || 0,
      cache: L.cache,
      noCtx: !!ctxOmitReason(m, L)
    }
  };
}

/* Bornes de reglage offertes au portail : jamais plus que ce que la carte peut
 * tenir, et jamais moins qu'un agent. */
const USER_MAX_SLOTS = 16;

async function handleUser(req, res, url) {
  const p = url.pathname.replace('/_user', '') || '/';
  const origin = originOf(req);

  if (!config.portal.enabled) return sendJson(res, 404, { error: 'Le portail est desactive.' });
  if (req.method !== 'GET' && !sameOrigin(req)) {
    return sendJson(res, 403, { error: 'Requete rejetee : elle ne vient pas du portail.' });
  }
  if (origin.remote && !config.remote.enabled) {
    return sendJson(res, 403, { error: 'Acces hors du reseau local desactive.' });
  }
  if (userThrottled(origin.ip)) {
    return sendJson(res, 429, { error: 'Trop de cles refusees depuis cette adresse. Reessaie dans un quart d\'heure.' });
  }

  const key = findKey(req.headers.authorization || req.headers['x-api-key'] || '');
  if (!key) {
    userFailed(origin.ip);
    return sendJson(res, 401, { error: 'Cle inconnue. Verifie que tu l\'as collee en entier.' });
  }
  if (origin.remote && key.remoteAllowed === false) {
    return sendJson(res, 403, { error: 'Cette cle ne fonctionne que sur le reseau local.' });
  }

  const P = permOf(key);

  // ---- tableau de bord ----
  if (p === '/me' && req.method === 'GET') {
    const s = keyStatus(key);
    const mine = readActivity(4000).filter(a => a.keyId === key.id).slice(0, 60);
    return sendJson(res, 200, {
      key: {
        name: key.name, createdAt: key.createdAt, disabled: key.disabled,
        remoteAllowed: key.remoteAllowed !== false, tail: key.key.slice(-6),
        role: P.role, roleLabel: P.label
      },
      status: s,
      pricing: { enabled: config.pricing.enabled, currency: config.pricing.currency },
      // Les droits viennent de la cle, plus d'un interrupteur global : deux
      // personnes sur le meme serveur n'ont pas forcement les memes.
      portal: {
        topupEnabled: !!config.portal.topupEnabled,
        role: P.role,
        roleLabel: P.label,
        allowLaunch: P.launch,
        allowSwap: P.swap,
        allowTune: P.tune,
        allowStop: P.stop,
        allowOffload: P.offload,
        maxSlots: USER_MAX_SLOTS
      },
      server: {
        running: !!runtime.proc, ready: runtime.ready,
        modelId: runtime.modelId, modelName: runtime.modelName,
        by: runtime.launchedBy || '',
        uptime: runtime.proc ? Date.now() - runtime.startedAt : 0,
        slots: (runtime.slots || []).length,
        busy: (runtime.slots || []).filter(x => x.busy).length,
        inFlight,
        idleMs: idleFor(),
        idleUnloadMin: config.idleUnloadMin || 0,
        ctxSlot: runtime.launch ? runtime.launch.ctxSlot : 0,
        noCtx: !!(runtime.launch && runtime.launch.noCtx),
        idleStopped: runtime.idleStopped
      },
      gpu: {
        name: gpuState.name, totalMb: gpuState.totalMb, usedMb: gpuState.usedMb, ok: gpuState.ok,
        usableMb: Math.max(256, (gpuState.totalMb || 0)
          - (runtime.proc ? 0 : (gpuState.usedMb || 0)) - (config.reserveMb ?? 512))
      },
      models: loadModels().models.filter(m => m.model).map(publicModel),
      activity: mine,
      rating: ratingAsk(key),
      poll: pollFor(key),
      // charge du moment, et ce que cette cle a le droit d'occuper
      load: Object.assign(loadState(), {
        mine: keyLoad(key.id),
        budget: P.role === 'admin' ? null : slotBudget(key)
      })
    });
  }

  // ---- demander un modele ----
  if (p === '/launch' && req.method === 'POST') {
    const b = await readBody(req);
    if (!P.launch) {
      return sendJson(res, 403, { error: 'Cette cle sert le modele deja charge, elle ne peut pas '
        + 'en demander un autre. Demande a l\'administrateur de la passer en « de confiance ».' });
    }
    const doc = loadModels();
    const model = doc.models.find(m => m.id === b.id);
    if (!model) return sendJson(res, 404, { error: 'Modele inconnu.' });

    // un modele deja charge : le remplacer est un droit a part, et jamais en
    // pleine reponse
    if (runtime.proc) {
      if (runtime.modelId === model.id) {
        return sendJson(res, 409, { error: '« ' + (runtime.modelName || runtime.modelId)
          + ' » est deja charge.' });
      }
      if (!P.swap) {
        return sendJson(res, 409, {
          error: 'Un modele est deja charge (' + (runtime.modelName || runtime.modelId)
            + '). Seul l\'administrateur peut le remplacer.'
        });
      }
      const occupes = (runtime.slots || []).filter(s => s.busy).length;
      if (occupes || inFlight) {
        return sendJson(res, 409, { error: (occupes || inFlight)
          + ' agent(s) travaillent en ce moment : on ne remplace pas un modele en pleine reponse.' });
      }
    }

    const since = (Date.now() - lastUserLaunch) / 1000;
    // zero est une valeur choisie - « aucun delai » - pas une valeur absente :
    // un || la transformait en soixante secondes, et le reglage restait lettre morte
    const cool = Number.isFinite(config.portal.launchCooldownS)
      ? config.portal.launchCooldownS : 60;
    if (since < cool) {
      return sendJson(res, 429, { error: 'Un chargement vient d\'etre demande. Attends '
        + Math.ceil(cool - since) + ' s.' });
    }

    // Pas de deport hors GPU sans les droits d'administrateur : ni couches sur
    // le processeur, ni projecteur de vision en RAM.
    const L = launchPlan(model, P);
    L.by = key.name;

    // reglage libre des agents et du contexte, selon le role
    if (P.tune) {
      if (b.slots !== undefined) L.slots = clampInt(b.slots, 1, USER_MAX_SLOTS, L.slots);
      if (b.ctxSlot !== undefined) {
        L.ctxSlot = Number(b.ctxSlot) === -1
          ? -1
          : clampInt(b.ctxSlot, 512, Number(model.native_ctx) || 262144, L.ctxSlot);
      }
    }

    const e = estimateVram(model, L);
    if (!P.offload && gpuState.ok && gpuState.totalMb && e.total > e.usable) {
      const rattrapable = P.tune
        && estimateVram(model, Object.assign({}, L, { slots: 1, ctxSlot: 2048 })).total <= e.usable;
      return sendJson(res, 400, {
        error: 'Ce reglage ne tient pas dans la memoire libre du GPU ('
          + Math.round(e.total) + ' Mo estimes pour ' + Math.round(e.usable) + ' Mo disponibles). '
          + (rattrapable
            ? 'Reduis le nombre d\'agents ou le contexte : le modele lui-meme tient.'
            : 'Meme au minimum il ne rentre pas ; seul l\'administrateur peut le charger, en deportant une partie hors du GPU.')
      });
    }

    if (runtime.proc) {
      pushLog('sys', `Remplacement demande depuis le portail par « ${key.name} » : `
        + `${runtime.modelId} laisse la place a ${model.id}.`);
      await stopServer();
      for (let i = 0; i < 30 && runtime.proc; i++) await new Promise(r => setTimeout(r, 200));
      await new Promise(r => setTimeout(r, 800));
    }
    if (await portBusy(config.upstreamPort)) {
      return sendJson(res, 400, { error: 'Le port du moteur est occupe. Previens l\'administrateur.' });
    }
    try {
      lastUserLaunch = Date.now();
      launch(L);
      console.log(`[${new Date().toLocaleTimeString('fr-FR')}] chargement de ${model.id} `
        + `(${L.slots} agents, contexte ${L.ctxSlot}) demande par la cle « ${key.name} »`);
      return sendJson(res, 200, { ok: true, modelId: model.id });
    } catch (err) {
      lastUserLaunch = 0;
      return sendJson(res, 400, { error: err.message });
    }
  }

  // ---- donner son avis ----
  if (p === '/rate' && req.method === 'POST') {
    const b = await readBody(req);
    // pas de rabotage ici : une note de 9 n'est pas un 5 timide, c'est un
    // client qui envoie n'importe quoi. On refuse plutot que d'inventer.
    const stars = Number(b.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return sendJson(res, 400, { error: 'Choisis une note entre 1 et 5.' });
    }
    const etat = ratingAsk(key);
    // on accepte meme si on n'aurait pas demande - quelqu'un qui veut parler ne
    // doit pas etre renvoye - mais pas deux avis dans la meme journee. Le
    // quart d'heure qui suit reste ouvert : c'est la meme reponse qu'on precise.
    const ecart = etat.lastAt ? Date.now() - etat.lastAt : Infinity;
    if (ecart > RATING_EDIT_MS && ecart < 24 * 3600000) {
      return sendJson(res, 429, { error: 'Ton avis d\'aujourd\'hui est deja enregistre. Merci !' });
    }
    saveRating(key, stars, b.comment);
    console.log(`[${new Date().toLocaleTimeString('fr-FR')}] avis de « ${key.name} » : ${stars}/5`
      + (b.comment ? ' - ' + String(b.comment).slice(0, 120) : ''));
    return sendJson(res, 200, { ok: true });
  }

  // ---- repondre a la question du moment ----
  if (p === '/poll' && req.method === 'POST') {
    const b = await readBody(req);
    const q = pollFor(key);
    if (!q) return sendJson(res, 409, { error: 'Aucune question en attente pour toi.' });
    const choice = Number.isInteger(b.choice) && b.choice >= 0 && b.choice < q.options.length
      ? b.choice : null;
    const texte = String(b.text || '').trim();
    if (choice === null && !texte) {
      return sendJson(res, 400, { error: 'Choisis une reponse, ou ecris un mot.' });
    }
    savePollAnswer(key, choice, texte);
    console.log(`[${new Date().toLocaleTimeString('fr-FR')}] reponse de « ${key.name} » : `
      + (choice !== null ? q.options[choice] : '') + (texte ? ' - ' + texte.slice(0, 120) : ''));
    return sendJson(res, 200, { ok: true });
  }

  // ---- rendre la carte ----
  if (p === '/stop' && req.method === 'POST') {
    if (!P.stop) {
      return sendJson(res, 403, { error: 'Cette cle ne peut pas arreter le modele. '
        + 'Demande a l\'administrateur de la passer en « de confiance ».' });
    }
    if (!runtime.proc) return sendJson(res, 409, { error: 'Aucun modele n\'est charge.' });
    // Personne ne doit perdre une reponse en cours de route : un agent occupe
    // ou une requete en vol suffit a refuser.
    const busy = (runtime.slots || []).filter(s => s.busy).length;
    if (busy || inFlight) {
      return sendJson(res, 409, {
        error: busy
          ? `${busy} agent(s) travaillent en ce moment. Reessaie quand ils auront fini.`
          : 'Une requete est en cours. Reessaie dans un instant.'
      });
    }
    pushLog('sys', `Arret demande depuis le portail par « ${key.name} » : aucun agent occupe.`);
    console.log(`[${new Date().toLocaleTimeString('fr-FR')}] arret demande par la cle « ${key.name} »`);
    await stopServer();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Route inconnue.' });
}

// --------------------------------------------------------------------------
// Fichiers statiques
// --------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel === '/portal' || rel === '/portal/') rel = '/portal.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return jsonError(res, 403, 'Acces refuse.');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// --------------------------------------------------------------------------
// Routage
// --------------------------------------------------------------------------
function router(req, res) {
  const url = new URL(req.url, 'http://localhost');

  // CORS ouvert seulement sur la passerelle, pour que des applications web
  // puissent appeler l'API avec une cle. L'administration, elle, reste
  // strictement de meme origine : pas de preflight accorde dessus.
  if (req.method === 'OPTIONS') {
    if (isProxyPath(url.pathname)) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '600'
      });
    } else {
      res.writeHead(204);
    }
    return res.end();
  }

  if (url.pathname.startsWith('/_api')) {
    return handleApi(req, res, url).catch(e => {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
  }
  if (url.pathname.startsWith('/_user')) {
    return handleUser(req, res, url).catch(e => {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
  }
  if (isProxyPath(url.pathname)) return handleProxy(req, res, url);
  return serveStatic(req, res, url);
}

const server = http.createServer(router);
server.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });

/* Windows resout « localhost » en ::1 avant 127.0.0.1. Le serveur, lui,
 * n'ecoutait qu'en IPv4 : le navigateur frappait a une porte fermee, et selon
 * son humeur il retombait sur l'IPv4 ou affichait une erreur.
 *
 * On ajoute donc une ecoute sur la boucle locale IPv6, et elle seule : ecouter
 * sur :: ouvrirait aussi l'adresse IPv6 publique de la machine, ce qui n'est
 * pas la meme chose que d'ecouter sur le reseau local en IPv4. */
const serverV6 = http.createServer(router);
serverV6.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });
serverV6.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log('  Note : le port ' + config.port + ' est deja pris en IPv6, localhost passera par l\'IPv4.');
  } else if (e.code !== 'EAFNOSUPPORT' && e.code !== 'EADDRNOTAVAIL') {
    console.log('  Note : ecoute IPv6 impossible (' + e.code + '), localhost passera par l\'IPv4.');
  }
});

server.listen(config.port, '0.0.0.0', () => {
  const lan = lanAddresses();
  const line = '='.repeat(64);
  console.log('\n' + line);
  console.log('  Console llama.cpp demarree');
  console.log(line);
  console.log('  Console        http://localhost:' + config.port);
  for (const a of lan) console.log('  Reseau local   http://' + a.address + ':' + config.port + '   (' + a.iface + ')');
  console.log('  API OpenAI     http://<ip-ci-dessus>:' + config.port + '/v1');
  console.log('  models.json    ' + config.modelsJson);
  console.log(line);
  if (!config.adminPassword) {
    console.log('  Note : la console n\'est ouverte que sur cette machine.');
    console.log('         Definis un mot de passe dans Reglages pour y acceder depuis le reseau.');
  }
  console.log('  Ctrl+C pour quitter. Le modele charge sera arrete proprement.\n');
  // on va chercher l'etat tailscale tout de suite, en arriere-plan : la
  // premiere page ouverte le trouvera deja pret au lieu de l'attendre
  tailscaleCached();
  // et on ouvre la boucle locale IPv6, pour que « localhost » reponde
  try { serverV6.listen(config.port, '::1'); } catch {}
});

// arret propre
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\nArret...');
  if (statsDirty) { try { writeJson(STATS_PATH, stats); } catch {} }
  Promise.all([stopServer(), stopTunnel()]).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
