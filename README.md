# Console llama.cpp

Un tableau de bord web pour piloter ton serveur llama.cpp : changer de modele,
regler le nombre d'agents et le contexte, et ouvrir l'acces au reseau local
avec des cles API — sans llama-swap, sans dependance npm.

Double-clic sur **`CONSOLE.bat`**, le navigateur s'ouvre sur
<http://localhost:3939>.

---

## Ce que ca fait

| Page | Contenu |
|---|---|
| **Modeles** | Les 17 modeles de `models.json`. Un clic sur *Configurer* ouvre le panneau de reglage, un clic sur *Lancer* demarre le serveur. Changer de modele arrete le precedent tout seul. |
| **Serveur** | Etat du processus, agents occupes en direct, vitesse de generation, remplissage du cache KV, et le journal de llama-server en streaming. |
| **Cles API** | Une cle par personne, avec son enveloppe. Suspendre ou supprimer coupe l'acces **immediatement**, sans redemarrer le modele. Extraits prets a copier pour opencode, curl, Python, JavaScript. |
| **Activite** | Requetes recentes avec cle, appareil, tokens, cout et duree, filtrables (30 dernieres, derniere heure, aujourd'hui, tout). Histogramme des 14 derniers jours. |
| **Tarifs** | Monnaie, valeurs par defaut, prix de chaque modele, et ce que tout ceci a coute. |
| **Admin** | Acces hors du reseau local, tarifs par modele, et la vue complete des cles avec leurs soldes. |
| **/portal** | L'espace utilisateur : le porteur d'une cle y voit son solde, sa consommation du jour, ses requetes, et peut demander un modele quand rien ne tourne. |
| **Reglages** | Chemins, ports, mot de passe admin, dechargement automatique, chargement a la demande, espace utilisateur, defauts de lancement. |

Le panneau de lancement reprend les calculs du `.bat` : presets
SOLO / DUO / SQUAD / SWARM / HIVE derives du contexte natif, rope yarn ajoute
seulement au-dela de la fenetre native, et l'estimation VRAM (poids + KV +
calcul) comparee a la VRAM reellement libre, avec l'alerte de depassement et
les leviers chiffres.

---

## Le catalogue models.json

Par defaut la console lit et ecrit le `models.json` pose a cote de
`server.js` ; le chemin se change dans **Reglages**, ce qui permet de partager
le meme catalogue avec un lanceur `.bat` maison. Le bouton *enregistrer ces
reglages comme defaut de ce modele* met a jour `slots`, `ctx` et `cache` dans
le JSON. Une copie `models.json.bak` est faite avant chaque ecriture.

---

## Partager le modele sur le reseau

1. Page **Cles API**, bouton *Creer une cle*, un nom par personne.
2. La cle est copiee automatiquement. Donne-lui aussi l'adresse affichee en bas
   de la barre laterale, du type `http://192.168.1.42:3939/v1`. Dans l'encart
   *Comment s'y connecter*, la cle est masquee a l'ecran - le bouton *copier*
   prend la vraie, *montrer la cle* la devoile si tu en as besoin.
3. Cette adresse marche partout ou on peut choisir « OpenAI compatible » :
   LM Studio, Open WebUI, Cherry Studio, Chatbox, Cline, Continue, le SDK
   `openai` en Python ou en JS.

```bash
curl http://192.168.1.42:3939/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-llama-..." \
  -d '{"model": "demo-petit-8b", "messages": [{"role": "user", "content": "Bonjour"}]}'
```

Au premier lancement, Windows demandera d'autoriser Node.js sur le reseau
prive : il faut accepter, sinon personne ne verra le port 3939.

### Comment l'acces est protege

`llama-server` n'est **jamais** expose au reseau. La console le lance sur
`127.0.0.1` avec une cle interne tiree au hasard a chaque demarrage, et le
reseau ne parle qu'a la passerelle. C'est ce qui permet de revoquer une cle
sans redemarrer le modele, et d'avoir un quota par personne — ce que
`--api-key` seul ne sait pas faire.

Une requete sans cle valide recoit un 401 au format OpenAI. Une cle suspendue,
un 403. Un quota journalier atteint, un 429. Une enveloppe vide, un 402.

---

## Ce que coute une cle

Chaque cle porte une **enveloppe** et des **plafonds journaliers**. Zero
partout veut dire : pas de limite. Bouton *limites* sur une cle, ou a la
creation.

| Limite | Effet quand elle est atteinte |
|---|---|
| Credit (en monnaie) | `402` — l'enveloppe est vide, il faut la recharger |
| Tokens au total | `402` — meme chose, comptee en tokens |
| Requetes par jour | `429` — repart a minuit |
| Tokens par jour | `429` — repart a minuit |
| Depense par jour | `429` — repart a minuit |

Le controle a lieu **avant** chaque requete : celle qui est deja partie va au
bout, le depassement est donc au pire d'une reponse. Le montant debite est
celui du modele reellement charge, au tarif de `models.json`.

Une enveloppe se recharge en augmentant le credit, ou en cochant *remettre la
consommation a zero* dans la fenetre des limites.

## Le cout affiche chez le client

Panneau **Admin > Tarifs**, case *renvoyer le cout dans la reponse de l'API*.
La console ajoute alors `usage.cost` a chaque reponse, au format d'OpenRouter :

```json
"usage": { "prompt_tokens": 1200, "completion_tokens": 350,
           "cost": 0.00039, "cost_details": { ... } }
```

En flux, llama.cpp ne renvoie aucun decompte sauf si on le demande : la console
ajoute donc `stream_options.include_usage` a la requete montante, et un dernier
evenement porte le decompte et le cout. Si un client s'en trouve gene, decoche
la case.

Trois autres routes suivent la meme convention :

| Route | Contenu |
|---|---|
| `GET /v1/models` | tout le catalogue avec `pricing.prompt`, `pricing.completion` et `pricing.input_cache_read` par token, le modele charge en tete |
| `GET /v1/key` | le solde de la cle : `usage`, `limit`, `limit_remaining` |
| `GET /v1/credits` | credit total et consommation |

## Les tokens relus du cache

Dans une conversation, chaque tour renvoie tout ce qui precede : llama.cpp
reconnait le prefixe commun et ne recalcule que la suite. Il dit combien de
tokens il a ainsi economises, sous `usage.prompt_tokens_details.cached_tokens`.

Ces tokens-la n'ont rien coute a produire : les facturer au prix d'entree
reviendrait a faire payer deux fois le meme travail. La console les compte donc
au **tarif de relecture**, par defaut **un dixieme de l'entree** — c'est le
champ *entree relue* de la page Tarifs, reglable globalement ou modele par
modele (`price_cache` dans `models.json`).

Le detail part avec la reponse :

```json
"usage": {
  "prompt_tokens": 1000, "completion_tokens": 100,
  "prompt_tokens_details": { "cached_tokens": 800 },
  "cost": 0.000102,
  "cost_details": { "cache_read_tokens": 800, "cache_read_cost": 0.000012,
                    "cache_saved": 0.000108 }
}
```

La part relue s'affiche dans **Activite** (une carte pour la journee, un badge
par requete) et dans le portail. Pour opencode, l'extrait genere porte
`cost.cache_read` : sans lui, il compte tout au prix d'entree et surestime
largement.

### Garder les etats entre deux conversations

La reconnaissance du prefixe est gratuite et toujours active, mais elle ne vaut
que pour la conversation qui occupe le slot. Deux reglages vont plus loin, dans
le tiroir de lancement et dans **Reglages > Defauts de lancement** :

| Reglage | Drapeau | Ce qu'il fait |
|---|---|---|
| **Cache de prompt** | `--cache-ram N` | Quand un agent change de conversation, son etat KV est recopie en **RAM systeme** au lieu d'etre jete. Il revient sans etre recalcule. `0` coupe le cache. Defaut **4096 Mo**. |
| **Reutilisation par morceaux** | `--cache-reuse N` | Rattrape une divergence **au milieu** du prompt en decalant le cache, au lieu de tout recalculer apres le point de rupture. `0` = inactive. |

Aucun des deux n'accelere la generation d'un seul token : ils suppriment des
attentes **avant** le premier. Et le cache n'est pas gratuit en memoire — un
etat pese le contexte d'un agent, soit `kv_kb_token x tokens` : de quelques
dizaines de Mo a plus de 3 Go selon le modele et le reglage. Le tiroir affiche
le calcul pour le modele ouvert, avec le nombre d'etats que la reserve peut
tenir.

Le decalage de cache n'est pas valable pour toutes les architectures : mets
`--cache-reuse` a `0` si un modele repond de travers apres l'avoir active,
et essaie modele par modele plutot que d'activer partout.

**Reglages > Cache de prompt** regle la taille a deux niveaux :

- **pour cette session** — s'applique a tous les chargements jusqu'a la
  fermeture de la console, et disparait avec elle. Rien n'est ecrit sur le
  disque, de quoi essayer une valeur sans s'engager ;
- **comme defaut** — ecrit dans `models.json`, sous `defaults.cache_ram_mb`.

Une valeur de session l'emporte sur le defaut comme sur le reglage d'un modele.
Le drapeau part **au lancement** : un modele deja charge garde sa valeur, le
panneau le dit et te rappelle qu'il faut le relancer.

## Echantillonnage : la temperature de chaque modele

Chaque modele a ses valeurs, et elles ne se ressemblent pas. Elles vivent dans
`models.json` sous `sampling`, se reglent dans le tiroir de lancement, et sont
orientees **code** dans le catalogue livre :

| modele | temp | top_p | top_k | autre |
|---|---|---|---|---|
| Qwen3.6 27B et 35B-A3B, Bonsai | 0.6 | 0.95 | 20 | min_p 0, presence 0, repeat 1.0 |
| Gemma 4 12B et 31B | 1.0 | 0.95 | 64 | `--samplers temperature;top_p;top_k` |
| Ling 3.0 Flash | 0.6 | 0.95 | 20 | |
| Ling 3.0 tiny | 1.0 | 0.95 | 20 | |
| LFM 2.5 | 0.2 | — | 80 | repeat_penalty 1.05 |
| Muse Glimmer 30B | 1.0 | 0.95 | 64 | |
| Devstral Small 2 24B | 0.15 | 0.95 | — | |
| KAT-Coder V2.5 | 1.0 | 0.95 | — | valeurs de leur run SWE-bench |
| Ovis OCR 2 | 0 | — | 1 | decodage deterministe |

**Gemma 4 casse la regle du « froid pour le code »** : descendre a 0.6 ou 0.3 le
degrade, contrairement a ce qu'on ferait spontanement. Les modeles sans reglage
publie (BigBang, Maple) recoivent un profil prudent, signale dans leur note.

Ces valeurs sont appliquees **deux fois** :

1. en drapeaux au lancement (`--temp`, `--top-p`, `--top-k`, `--min-p`,
   `--presence-penalty`, `--repeat-penalty`, `--samplers`) ;
2. dans le corps de chaque requete — parce qu'un client qui envoie sa propre
   temperature **ecrase le drapeau du serveur**, et opencode envoie la sienne.

Le mode se choisit dans **Reglages > Echantillonnage** : *completer* (on ne pose
que ce que le client n'a pas precise), *imposer* (le modele l'emporte), ou *ne
rien faire*.

## La reflexion, modele par modele

Trois leviers dans le tiroir de lancement, et ils ne servent pas aux memes
modeles :

| reglage | drapeau | ce qu'il fait |
|---|---|---|
| **Mode** | `--reasoning on/off/auto` | sans effet sur les modeles dont le gabarit ouvre la reflexion sans condition |
| **Budget** | `--reasoning-budget N` | plafond de tokens de reflexion. `0` la coupe net, `-1` la laisse libre. **Marche partout**, meme quand le mode ne fait rien |
| **Variables du gabarit** | `--chat-template-kwargs` | la ou vivent `enable_thinking` (Qwen3.6) et `reasoning_strength` (Muse Glimmer) |
| **Restitution** | `--reasoning-format` | `deepseek` met la reflexion dans `message.reasoning_content` — c'est ce que lisent les clients qui savent l'afficher |

**Muse Glimmer ouvre sa reflexion sans condition** : `--reasoning off` n'a aucun
effet sur lui, et `reasoning_effort: none` non plus. Ce qui se regle, c'est la
force — `reasoning_strength` a `low`, `medium`, `high` ou `xhigh`, `high` par
defaut. Le catalogue livre le pose explicitement, pour qu'il soit visible et
modifiable ; ses anciens `--reasoning auto --reasoning-preserve`, eux, ne
servaient a rien.

Les variables du gabarit partent **aussi dans chaque requete**, fusionnees cle
par cle : aucun client ne les envoie de lui-meme, et c'est pourtant le seul
levier qui change quelque chose sur certains modeles. Ce que le client precise
l'emporte, sauf en mode *imposer*.

### Choisir le niveau depuis n'importe quel client

Un modele peut declarer des **niveaux**, et chacun devient un modele a part
entiere dans la liste :

```
muse-glimmer-30b            reflexion forte (le defaut du modele)
muse-glimmer-30b:low        reflexion legere
muse-glimmer-30b:medium     moyenne
muse-glimmer-30b:high       forte
muse-glimmer-30b:xhigh      maximale
demo-27b:off              reflexion coupee
demo-27b:on               reflexion activee
```

Il suffit de choisir l'entree voulue dans opencode, dans une interface web, ou
partout ou l'on selectionne un modele : **rien a relancer, rien a configurer**.
La passerelle traduit le suffixe en variables de gabarit avant de transmettre.

Les clients qui envoient `reasoning_effort` sont servis aussi : la valeur est
traduite vers le niveau correspondant, et les valeurs d'OpenAI qui n'existent
pas chez le modele (`none`, `max`) tombent sur le plus bas ou le plus haut.

Le tiroir affiche les niveaux en **boutons** — plus besoin de se souvenir qu'on
ecrit `xhigh` et pas *very high* — et le bouton choisit le defaut du modele.

## Decodage speculatif : fichier draft ou tete incluse

Deux formes, et la console gere les deux :

- un **fichier draft a cote** du modele (`draft` + `spec_type`) — MTP ou dspark ;
- une **tete MTP dans le .gguf lui-meme** (`mtp_builtin: true`, `draft` vide) —
  les builds « MTP-GGUF » de Qwen3.6, plus lourds que leurs equivalents parce
  que la tete est dedans. llama.cpp monte alors le contexte de draft sur le
  modele : il ne faut surtout pas lui passer `--model-draft`.

## Ce que ca coute vraiment en electricite

`nvidia-smi` donne la puissance instantanee de la carte. La console la releve
toutes les trois secondes et l'integre : puissance moyenne entre deux mesures,
multipliee par le temps ecoule, cumulee par journee dans `stats.json` sous
`wh` — et `whCharge` pour la part consommee pendant qu'un modele etait charge.

Rien n'est estime : ce sont des watt-heures mesures.

**Tarifs > Prix du kWh** contient par defaut **0,215 €**, la moyenne des deux
tarifs francais courants (18 centimes en heures creuses, 25 en heures pleines).
La page affiche alors l'electricite du jour, celle des trente jours, et le
**bilan** : ce que le meme travail aurait coute chez un fournisseur cloud, moins
le courant. Quand le bilan est negatif, c'est dit — *surcout*, pas *economie*.

Une precision honnete : la mesure ne couvre que la carte graphique. Le reste de
la machine, l'alimentation et son rendement ne sont pas comptes.

## Partage des agents et surcharge

Un modele lance avec `-np 4` sert quatre requetes a la fois. Au-dela, elles
s'empilent dans la file de llama.cpp **sans que personne ne le sache** : le
client attend, sans savoir s'il attend une seconde ou trois minutes.

**Combien d'agents par cle**, selon son role :

| role | agents simultanes |
|---|---|
| administrateur | autant qu'il veut |
| de confiance | deux, quand le modele en offre plus de deux ; sinon un |
| utilisateur | un |

Le but n'est pas d'economiser : c'est d'empecher qu'une seule session - une
nuee de sous-agents opencode, par exemple - avale tous les agents et laisse les
autres devant une porte fermee.

Au-dela, la reponse est un **429 avec `Retry-After`** : opencode et la plupart
des clients reessaient tout seuls. Le message dit combien d'agents sont pris et
combien de temps ca devrait durer, calcule sur la **duree mediane des dernieres
reponses** - pas un chiffre invente.

**Reglages > Partage des agents** regle la file toleree (`requetes en attente
par agent`, 1 par defaut) et peut couper tout le mecanisme : tout le monde
attend alors dans la file de llama.cpp, comme avant.

Chaque reponse porte l'etat de la maison, pour un client qui veut se reguler :

```
x-agents-total: 4      x-agents-busy: 3
x-queue-depth: 2       x-key-slots: 1/2
```

La meme information s'affiche dans le portail - agents pris, file, et la part
de ta cle - et dans la barre haute de la console des qu'une file existe.

## Poser une question aux utilisateurs

**Reglages > Poser une question** : une question, jusqu'a quatre reponses, et
un mot libre si tu le laisses. Elle apparait dans le portail, **une fois par
personne**. Changer la question fait un nouveau sondage : tout le monde est
re-interroge, et les reponses ne se melangent pas.

Le depouillement s'affiche sous la question : repartition, nombre de reponses,
et les mots tels qu'ils ont ete ecrits. Les reponses vivent dans
`poll-answers.jsonl`.

## Ce qu'ils en pensent

Le portail pose une question, une seule : cinq etoiles, et un mot si l'envie
vient. Elle arrive **des la premiere visite** — quelqu'un qui vient de recevoir
sa cle a un avis sur l'accueil qu'on lui fait — et pas plus d'**une fois par
mois** ensuite. Fermer la boite la repousse d'une semaine : refuser de repondre
est une reponse.

La note part au clic sur l'etoile, le mot peut suivre : pendant un quart
d'heure le meme avis reste modifiable, ensuite il faut attendre le lendemain.
Les reponses s'empilent dans `ratings.jsonl` et s'affichent dans **Admin > Ce
qu'ils en disent** : moyenne, repartition par etoile, et les derniers mots tels
qu'ils ont ete ecrits.

## Le modele demande est le modele servi

Un client compatible OpenAI envoie un nom de modele. Longtemps la console
servait de toute facon celui qui etait charge — pratique, mais le client
affichait alors le tarif du modele qu'il croyait utiliser, pendant qu'un autre
repondait.

Desormais, **si le nom figure au catalogue, c'est ce modele-la qui sert** :

| Situation | Ce qui se passe |
|---|---|
| Le modele demande tourne deja | la requete part, comme avant |
| Rien n'est charge | la console charge le modele demande, la requete attend puis part |
| Un autre modele tourne, inactif | il laisse la place au modele demande |
| Un autre modele tourne et travaille | `409`, avec le nom de celui qui tourne |
| Nom inconnu du catalogue | le modele en service repond, comme avant |

Deux garde-fous. Le **delai de calme** (60 s par defaut) : un modele qui vient
de servir n'est pas remplace tout de suite, sinon deux personnes qui demandent
chacune le leur feraient des allers-retours sans fin. L'**attente maximale**
(180 s) : au-dela, la requete repart en erreur plutot que de rester pendue.

Les deux se reglent dans **Reglages > Chargement a la demande**, et toute la regle
se coupe d'un interrupteur — les clients doivent alors demander le modele deja
en service.

**opencode est un cas a part.** Il ne lit pas `usage.cost` : il calcule la
depense lui-meme, a partir du bloc `cost` de sa propre configuration. Sans ce
bloc il affiche `$0.00 spent`, quoi que renvoie la passerelle. L'onglet
*opencode* de la page Cles API — et du portail — genere la configuration
complete, tarifs de tous les modeles compris, a coller dans
`~/.config/opencode/opencode.jsonc`.

Chaque entree doit designer un vrai modele du catalogue, jamais un alias : le
nom sert maintenant a choisir *et* a facturer, c'est ce qui garantit que le
prix affiche est celui du modele qui repond.

## L'espace utilisateur

`http://<adresse>/portal` — une page separee, sans droits d'administration. On
y colle sa cle, elle reste dans le navigateur, et on voit :

- son solde et ce qu'il en reste, ses plafonds du jour ;
- le modele en service ;
- ses propres requetes, avec leur cout ;
- de quoi se connecter, cle deja remplie.

**Ajouter des fonds est volontairement coupe.** Le bouton est la, desactive :
les fonds passent uniquement par les enveloppes que l'admin attribue aux cles.

**Ce qu'une personne peut faire depend de sa cle**, pas d'un interrupteur
global : chaque cle porte un role, choisi dans **Cles API > droits et limites**.

| role | ce qu'il autorise |
| --- | --- |
| **utilisateur** | se servir du modele charge, et rien d'autre |
| **de confiance** | en plus : charger, remplacer, arreter un modele, et regler agents et contexte |
| **administrateur** | tout, y compris charger un modele trop gros en deportant une partie hors du GPU |

Une cle neuve nait *utilisateur*. Les cles creees avant les roles sont passees
en *de confiance*, pour ne rien retirer a personne.

**Demander un modele.** Une cle de confiance peut demander un chargement, ou
faire changer de modele quand plus personne ne travaille. Le modele part avec
les reglages enregistres par l'admin, et **sans aucun deport hors GPU** : les
couches sont forcees sur la carte, la vision sur CPU repasse sur GPU, et un
reglage dont l'estimation depasse la VRAM libre est refuse en disant de
combien. La meme barriere vaut sur l'API : choisir un modele depuis opencode ne
permet pas ce qu'un clic sur le portail refuserait.

Un modele n'est ecarte que s'il ne rentre **meme au minimum** - un agent, le
plus petit contexte. Si seul le reglage enregistre deborde, le modele reste
proposable : il s'affiche *a regler pour tenir*, et le panneau s'ouvre sur un
reglage deja reduit pour rentrer. Un delai d'une minute separe deux demandes.

Les variantes d'un meme reseau — cinq quantifications de Gemma 4 12B — sont
**regroupees en famille**, dans la console comme dans le portail : une ligne,
qui s'ouvre sur ses variantes. Le regroupement se deduit de l'identifiant
(`gemma4-12b-google`, `gemma4-12b-lora`...) ; un champ `family` dans
`models.json` l'emporte si tu veux regrouper autrement.

**Regler agents et contexte.** Pour une cle de confiance, deux
curseurs remplacent le lancement direct : nombre d'agents et contexte par
agent, avec l'estimation VRAM qui suit en direct et le bouton qui se bloque des
que ca deborde. Les bornes sont le contexte natif du modele et 16 agents ; le
serveur refait le calcul avant de lancer, l'estimation du navigateur ne fait
qu'informer. Sur un modele qui fixe lui-meme son contexte — draft dspark, ou
contexte automatique enregistre — le curseur de contexte est verrouille.

**Rendre la carte.** Une cle de confiance peut arreter un modele que **plus
personne n'utilise**. Refuse si un agent travaille ou si une requete est en
vol : personne ne perd sa reponse en cours.

**Reglages > Espace utilisateur** ne garde que l'ouverture du portail et son
adresse : les droits sont sur les cles.

## Dechargement automatique

**Reglages > Dechargement automatique**, en minutes, **3 par defaut**. Passe le
champ a `0` pour ne jamais decharger.

Un modele oublie garde dix gigaoctets de VRAM pour rien. Passe ce delai sans la
moindre requete, la console arrete llama-server et rend la carte ; n'importe
qui peut alors en demander un autre depuis le portail. Le compteur repart a
zero a chaque requete, et ne tourne pas tant qu'un agent travaille ou qu'une
reponse est en cours — le compte des requetes en vol est tenu par la
passerelle, pas deduit d'un sondage. Le chargement compte comme une activite :
un modele qui vient d'arriver a son delai complet devant lui.

Le compte a rebours s'affiche sur la page Serveur et dans le portail. Un arret
de ce type se lit *libere, faute d'activite*, pas comme un plantage.

---

## Ouvrir l'acces a des gens qui ne sont pas sur ton wifi

Panneau **Admin > Acces hors du reseau local**. Tant que l'interrupteur est
sur *desactive*, une requete venue d'ailleurs est refusee meme avec une cle
valide. L'activer exige d'abord un mot de passe admin.

Trois chemins, au choix :

**Tailscale** — deja installe sur cette machine, il suffit de s'y connecter.
Tes potes installent Tailscale, tu les invites depuis `login.tailscale.com`,
et ils utilisent `http://100.x.y.z:3939/v1`. Le trafic est chiffre de bout en
bout, rien n'est publie sur Internet, et l'adresse ne change jamais. C'est
l'option a preferer.

A savoir : la plage Tailscale `100.64/10` est traitee comme un reseau prive,
au meme titre que le wifi de la maison. Une fois Tailscale connecte, tes potes
passent **sans** avoir a activer l'interrupteur d'acces distant — c'est
Tailscale qui fait le controle d'acces, et rien n'est expose a Internet.
L'interrupteur ne concerne que le tunnel public et la redirection de port.

Des que Tailscale est connecte, son adresse apparait en bas a gauche, en tete
de liste et marquee *recommandee*. Les exemples de la page Cles API basculent
dessus automatiquement.

**Tunnel Cloudflare** — un bouton telecharge `cloudflared.exe` (~70 Mo depuis
github.com/cloudflare), un autre ouvre le tunnel et affiche une adresse
`https://xxx.trycloudflare.com`. Tes potes n'installent rien, et c'est du
HTTPS. En echange l'adresse est publique : n'importe qui tombant dessus voit
un serveur, seule la cle API l'arrete. L'adresse change a chaque ouverture.

**Redirection de port** — tu ouvres le port sur ta box. Le plus direct, le
moins protege : pas de HTTPS, donc les cles circulent en clair.

Chaque cle porte un interrupteur *hors reseau* : tu peux donner une cle
utilisable de partout a un pote, et une cle limitee au salon pour la tablette.
Les requetes venues de l'exterieur sont marquees `↗` dans Activite.

## Tarifs et cout evite

Panneau **Admin > Tarifs**. Chaque modele a un prix d'entree et de sortie par
million de tokens, comme chez OpenRouter. Ces prix servent a deux choses : la
console additionne ce que chaque requete **aurait coute** chez un fournisseur
— la balance a l'envers, par cle, par modele et par jour — et ce sont eux qui
debitent les enveloppes des cles.

Les prix non renseignes sont suggeres d'apres le nombre de parametres lu dans
le nom du modele, et marques *suggere* — a corriger a la main, ce ne sont que
des ordres de grandeur. Une fois enregistres ils vont dans `models.json`, sous
`price_in` et `price_out` ; le `.bat` ignore ces cles.

Le cout est fige au moment de la requete : changer un tarif ne reecrit pas
l'historique.

## Consulter la console depuis un telephone

Par defaut la console n'est pilotable que depuis cette machine ; le reseau n'a
acces qu'a l'API par cle. Pour l'ouvrir ailleurs, mets un mot de passe dans
**Reglages > Console > Mot de passe admin**. La page demandera alors ce mot de
passe aux appareils distants.

---

## Fichiers

| Fichier | Role |
|---|---|
| `CONSOLE.bat` | lance la console et ouvre le navigateur |
| `server.js` | serveur : lancement de llama-server, passerelle API, cles |
| `public/` | l'interface : `index.html` la console, `portal.html` l'espace utilisateur |
| `config.json` | ports, chemin du models.json, mot de passe admin |
| `keys.json` | les cles API, **en clair** — garde ce dossier prive |
| `stats.json` | compteurs par jour, 30 jours glissants |
| `activity.jsonl` | journal des requetes |

`config.json`, `keys.json`, `stats.json` et `activity.jsonl` se creent tout
seuls. Supprimer `keys.json` revoque tout.

---
