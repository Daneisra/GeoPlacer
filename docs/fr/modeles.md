# Modèles : gestion, révisions et persistance

État : **Phase 1B.3** (corrections A, B, C). Le gestionnaire de modèles (`TemplateManager`) est
implémenté dans `@geoplacer/core`, sans aucune entrée/sortie. Les accès aux
fichiers, le décodage PNG et le calcul SHA-256 passent par des ports,
implémentés pour Node.js dans `@geoplacer/adapters-node`. Le serveur hérité
n'utilise pas encore ce gestionnaire.

## 1. Fonctions

```ts
import { openNodeTemplateManager } from '@geoplacer/adapters-node';

// Prend le verrou du répertoire de données (§ 5) : une seule instance à la fois.
const { manager: modeles, close } = await openNodeTemplateManager('data/engine');
const t = await modeles.create({ projectId, name, sourcePng, palette, placement, coordinateSystem });
await close();
```

| Opération | Effet | Nouvelle révision ? |
|---|---|---|
| `create` | Importe le PNG, le quantifie et enregistre la révision 1 | oui (`created`) |
| `load(ref)` | Charge la révision courante, vérifiée | — |
| `load(ref, { revision })` | Charge **exactement** cette révision (erreur si elle ne se vérifie pas) | — |
| `load(ref, { recover: true })` | Récupération en lecture seule (§ 5) | — |
| `manifest(ref)` | Métadonnées validées, sans décodage d'image | — |
| `list(projectId)` | `{ templates, failures }` : modèles lisibles d'un projet (supprimés exclus), et modèles illisibles à part | — |
| `revise(ref, changement)` | Image source, palette, seuil alpha, quantification, placement ou repère | oui, si quelque chose change |
| `restoreRevision(ref, n)` | Nouvelle révision qui reprend le contenu de la révision `n` | oui (`restored`) |
| `updateSettings(ref, …)` | Nom, stratégie, priorité | **non** |
| `setStatus(ref, statut)` | `active`, `paused`, `completed`, `archived` | **non** |
| `duplicate(ref, { name, projectId? })` | Copie de la révision courante, nouvel identifiant, statut `paused` | révision 1 (`duplicated`) |
| `delete(ref, { confirmName })` | Suppression contrôlée : exige le nom exact ; pierre tombale, fichiers conservés | — |
| `verify(ref)` | Relit et revérifie chaque révision (lecture seule) | — |
| `repair(ref, { apply })` | Réparation explicite d'un manifeste courant absent ou malformé (§ 5) | — |

Projets : chaque modèle appartient à un projet (`projectId`). Les
manifestes et les blobs sont rangés par projet ; un manifeste placé sous un
autre projet que le sien est refusé.

## 2. Règles d'import

1. **En-tête PNG lu avant tout décodage** : signature, bloc IHDR et son
   CRC, combinaison type de couleur / profondeur valide.
2. **Limites vérifiées avant toute allocation** : 4096 × 4096 et
   16 777 216 pixels par défaut (configurables). Un PNG qui annonce
   100 000 × 100 000 pixels est refusé sur son seul en-tête.
3. Décodage par l'adaptateur (pngjs : niveaux de gris, RVB, palette avec
   tRNS, alpha, 1 à 16 bits, entrelacé), puis **revérification** : les
   dimensions rendues doivent correspondre à l'en-tête (`DECODE_MISMATCH`).
4. **Transparence** : alpha < seuil → transparent ; alpha ≥ seuil → couleur
   opaque. Seuil par défaut : 128, enregistré dans la révision. Le noir
   n'est jamais confondu avec le transparent.
5. **Quantification** : plus proche couleur en OKLab (par défaut) ou en RVB
   euclidien ; égalité : la première couleur de la palette gagne. La
   méthode (`algorithm`, `distance`, `version`) est enregistrée.
6. L'image quantifiée est stockée en PNG RVBA canonique (couleur opaque
   ou `0,0,0,0`), puis **redécodée** : elle doit redonner exactement les
   mêmes pixels, sinon la création échoue.

Une image entièrement transparente est acceptée (0 pixel à peindre).

**Placement partiellement hors toile** : accepté, avec un avertissement
explicite (`warnings` du modèle chargé et du résumé de `list`) :
`PLACEMENT_PARTIALLY_OUTSIDE`, avec le nombre de pixels hors des limites.
Ces pixels ne seront jamais peints (les stratégies les ignorent). L'avertissement est
recalculé à chaque chargement, jamais stocké. Un placement entièrement
hors toile reste refusé (`PLACEMENT_OUTSIDE_BOUNDS`).
Codes d'erreur : `INVALID_PNG`, `IMAGE_TOO_LARGE`, `DECODE_MISMATCH`,
`INVALID_INPUT`, `UNSUPPORTED_QUANTIZATION`, `INVALID_NAME`, `INVALID_ID`,
et les erreurs de géométrie (`PLACEMENT_OUTSIDE_BOUNDS`, coordonnées non
entières…).

## 3. Stockage

```
<racine>/projects/<projectId>/templates/<templateId>/manifest.json
<racine>/projects/<projectId>/templates/<templateId>/manifest.json.bak
<racine>/projects/<projectId>/blobs/<sha256>.png
```

- **Blobs immuables, adressés par leur contenu** : le nom d'un fichier est
  le SHA-256 de ses octets. Deux révisions qui ont les mêmes pixels
  partagent le même fichier. Un blob n'est jamais modifié ni supprimé ; un
  blob trouvé corrompu à son adresse est remplacé par le bon contenu.
- **Un manifeste JSON par modèle** : réglages modifiables (nom, stratégie,
  priorité, statut) et liste des révisions, qui ne fait que s'allonger.
- **Identifiants** : 1 à 64 caractères `[a-z0-9-]`, sans point, sans
  majuscule, sans nom de périphérique Windows (`con`, `nul`, `com1`…).
  L'adaptateur revérifie chaque identifiant et chaque adresse, et refuse
  tout chemin qui sortirait de la racine.

### Manifeste (schéma 1)

Champs principaux : `schemaVersion`, `projectId`, `templateId`,
`generation`, `name`, `drawingStrategy`, `priority`, `status`, `createdAt`,
`updatedAt`, `deletedAt`, `currentRevision`, `revisions`, `extensions`.

Chaque révision enregistre : `revision`, `createdAt`, `reasons`, `basedOn`,
`width`, `height`, `placement`, `coordinateSystem`, `palette` (copie
complète), `alphaThreshold`, `quantizationMethod`, `sourceImageHash`,
`quantizedImageHash`, `quantizedFileHash`, `stats`, `extensions`.

| Empreinte | Calculée sur |
|---|---|
| `sourceImageHash` | Octets du PNG source (adresse du blob source) |
| `quantizedImageHash` | Sérialisation canonique des pixels quantifiés : `GPQ1`, largeur, hauteur, puis chaque pixel en u32 petit-boutiste. Indépendante de l'encodeur PNG |
| `quantizedFileHash` | Octets du PNG quantifié stocké (adresse du blob) |

**Compatibilité** : un code futur de schéma 1 ajoute ses données
facultatives dans `extensions` (manifeste ou révision), conservé tel quel
mais **validé** :
- noms de premier niveau : une lettre, puis lettres, chiffres, `.`, `_`
  ou `-` (64 caractères au plus) ; 64 entrées au plus ;
- valeurs JSON simples (objets ordinaires, tableaux, chaînes de 10 000
  caractères au plus, nombres finis, booléens, `null`) ;
- clés `__proto__`, `constructor` et `prototype` refusées ;
- profondeur 8 et 64 Kio au plus.

La stratégie est validée elle aussi : graine entière dans [0, 2^32),
`colorOrder` sans doublon.
Tout autre champ inconnu est refusé (`INVALID_MANIFEST`) : un changement
incompatible exige `schemaVersion: 2` et une migration. Un manifeste d'un
schéma plus récent est refusé (`UNSUPPORTED_SCHEMA`), jamais remplacé par
une sauvegarde plus ancienne.

## 4. Révisions

| Changement | Révision | Requantification |
|---|---|---|
| Image source (empreinte différente) | oui | oui |
| Couleurs de la palette (liste ordonnée : l'ordre départage les égalités) | oui | oui |
| Noms ou coûts des couleurs seulement | oui | **non** (mêmes pixels) |
| Seuil alpha | oui | oui |
| Méthode de quantification | oui | oui |
| Placement | oui | **non** |
| Repère | oui | **non** |
| Nom, stratégie, priorité, statut | **non** | — |
| Valeurs identiques aux actuelles | **non** (`created: false`, rien n'est écrit) | — |

Le placement et le repère créent une révision parce que les tâches sont
identifiées par des coordonnées d'image : une révision doit correspondre à
un seul ensemble de pixels sur la toile.

- Une révision publiée n'est **jamais** réécrite ; les anciennes restent
  chargeables (`load(ref, { revision: n })`) et ne sont jamais supprimées
  automatiquement.
- `restoreRevision` crée une **nouvelle** révision (`basedOn` indique la
  source) : l'historique n'est jamais réécrit.
- Sans requantification, les blobs existants sont réutilisés après une
  vérification complète (relecture, empreintes, décodage). L'image n'est
  jamais requantifiée.
- **Au chargement, rien n'est recalculé** : l'image quantifiée enregistrée
  est relue et vérifiée, jamais requantifiée (même si l'algorithme évolue).

## 5. Intégrité et reprise après interruption

**Ordre d'écriture** de chaque opération :

1. écriture des blobs (fichier temporaire unique, `fsync`, renommage) ;
2. relecture de chaque blob référencé et vérification de son SHA-256 ;
3. **publication du manifeste en une seule opération** : la version
   courante est d'abord **copiée** en `manifest.json.bak`, puis le nouveau
   manifeste remplace `manifest.json` par un seul renommage. C'est le seul
   point de validation.

Il n'y a donc jamais deux renommages à considérer comme une transaction :
une interruption avant l'étape 3 laisse l'ancien manifeste intact (au pire
des blobs orphelins) ; après l'étape 3, la nouvelle révision est complète.
Le manifeste courant n'est jamais déplacé : il en existe toujours un
lisible.

**Comparaison-échange** : chaque écriture indique la `generation` qu'elle
remplace ; si elle a changé entre-temps, l'écriture est refusée
(`CONFLICT`). Les opérations sur un même modèle sont sérialisées dans le
processus.

**Verrou du répertoire de données** (correction C) : la
comparaison-échange lit puis remplace le manifeste. Deux processus
pourraient donc la passer tous les deux. `openNodeTemplateManager` prend
d'abord un verrou exclusif sur le répertoire ; une seconde instance
échoue au démarrage (`DataDirectoryLockedError`, avec le pid et l'heure de
démarrage du détenteur), avant toute écriture. Le stockage refuse toute
écriture si le verrou a été rendu (`close`).
- **Windows** (mécanisme par défaut) : `<racine>/.geoplacer.lock` reste
  ouvert en partage exclusif (`UV_FS_O_EXLOCK` de libuv). Le noyau refuse
  toute autre ouverture et libère le verrou à la fin du processus, même
  tué : aucun verrou périmé n'est possible.
- **Autres systèmes** : fichier pid (pid, machine, jeton aléatoire), écrit
  dans un fichier temporaire puis publié par `link()`, qui échoue s'il
  existe déjà : le verrou n'est jamais visible vide. Un verrou dont le
  processus n'existe plus sur cette machine est repris.
  Cette reprise n'est pas atomique face à une autre instance qui la
  tenterait au même instant. Ce mécanisme est testé sous Windows en le
  forçant ; il n'a jamais été exécuté sous Linux ni macOS.

Le propriétaire (pid, heure de démarrage) est écrit dans
`.geoplacer.lock.owner`, uniquement pour le message d'erreur.

**Vérification au chargement** : présence et SHA-256 des deux blobs,
en-tête et limites, décodage, forme canonique des pixels,
`quantizedImageHash`, cohérence avec les statistiques. Tout écart donne
`INTEGRITY_ERROR`.

**Récupération** (`recover: true`), en lecture seule :

- si le manifeste courant manque ou est malformé, le `.bak` est utilisé
  (`manifestSource: 'backup'`) ;
- si la révision courante ne se vérifie pas, la révision valide la plus
  récente est chargée ;
- le rapport (`LoadReport.problems`) indique tout ce qui a échoué ;
- rien n'est réécrit ; une révision **demandée explicitement** qui ne se
  vérifie pas reste une erreur.

**Réparation explicite** (`repair(ref, { apply })`, correction B) :

| Situation | Résultat |
|---|---|
| Manifeste courant valide | `action: 'none'`, rien n'est écrit |
| Manifeste courant absent ou malformé, sauvegarde valide dont la révision courante se vérifie | `action: 'restore-backup'` : la sauvegarde redevient le manifeste courant, avec `generation` = génération de la sauvegarde + 2 |
| Manifeste d'un **schéma plus récent** | `UNSUPPORTED_SCHEMA` : jamais remplacé, rien n'est écrit |
| Sauvegarde absente ou invalide | `INVALID_MANIFEST`, rien n'est écrit |
| Révision courante de la sauvegarde qui ne se vérifie pas | `INTEGRITY_ERROR`, rien n'est écrit |

- `apply: false` : diagnostic seul, rien n'est écrit.
- Le fichier corrompu est conservé **octet pour octet** sous
  `manifest.json.corrupt-<date>-<id>` (nom renvoyé dans `preservedAs`).
- La sauvegarde `manifest.json.bak` n'est pas touchée.
- La publication est un seul renommage, conditionné au contenu brut lu au
  diagnostic (`CONFLICT` si le fichier a changé entre-temps).
- Ce qui n'était que dans le manifeste corrompu (au plus la dernière
  écriture) est perdu. Ses blobs restent sur le disque.
- L'historique valide n'est jamais réécrit. Une révision corrompue dans
  un manifeste valide se contourne par `restoreRevision` vers une révision
  qui se vérifie.

**Pourquoi « génération de la sauvegarde + 2 »** (vérifié en Phase 1B.4) :

- Toute publication normale copie le manifeste courant en sauvegarde, puis
  publie la génération suivante : courant = sauvegarde + 1.
- Un manifeste corrompu issu d'une publication normale portait donc
  sauvegarde + 1. Réparer en sauvegarde + 1 donnerait le même numéro à deux
  contenus différents : le manifeste perdu et le manifeste réparé.
- Sauvegarde + 2 évite cette collision et reste supérieur à toutes les
  générations connues.

| Scénario (tests de non-régression) | Résultat |
|---|---|
| Réparation simple | génération = sauvegarde + 2, supérieure à celle du manifeste perdu |
| Réparation, écriture, corruption, réparation | générations 2 → 4 → 5 → 6 : toujours croissantes |
| Réparation interrompue puis relancée | même résultat que sans interruption ; l'état reste corrompu, sauvegarde intacte, jusqu'à la réussite |
| **Limite** : manifeste réparé corrompu de nouveau avant toute écriture | même génération (sauvegarde + 2) pour deux manifestes qui ne diffèrent que par `updatedAt` |
| **Limite** : la révision perdue (présente seulement dans le manifeste corrompu) | son numéro est réutilisé par la révision suivante, avec un autre contenu |

Ce que la règle garantit :
- **Comparaison-échange** : aucun écrivain ne peut publier sur la base
  d'un manifeste perdu. Dans le processus, les opérations sur un modèle
  sont sérialisées et relisent le manifeste ; entre processus, le
  répertoire est verrouillé.
- **Historique** : il ne recule jamais au-delà de la sauvegarde.

Ce qu'elle ne garantit pas :
- **Unicité des générations** après une seconde corruption du manifeste
  réparé, sans écriture entre les deux. C'est sans effet pratique, car les
  deux contenus ont les mêmes révisions.
- **Unicité des numéros de révision** après la perte d'une révision. Le
  journal des tentatives (Phase 1B.6) identifie les tâches par
  `(modèle, révision, x, y, couleur)` : une tentative enregistrée sur la
  révision perdue deviendrait ambiguë.

Proposition, à décider avant la Phase 1B.6 :
- Tenir par modèle un fichier de **plus hautes valeurs atteintes**
  (génération et révision), mis à jour **avant** chaque publication.
- Il ne fait qu'augmenter. Une interruption entre sa mise à jour et la
  publication laisse donc seulement une valeur trop haute, ce qui est sans
  danger.
- La réparation reprendrait au-dessus de ces valeurs, et le numéro d'une
  révision perdue ne serait jamais réutilisé.
- Le mécanisme actuel n'est pas modifié dans cette phase.

**Listage isolé** (correction A) : `list` renvoie les modèles lisibles dans
`templates`, et les autres dans `failures`, avec l'identifiant, un code et
un message fixe :

| Code | Message |
|---|---|
| `INVALID_MANIFEST` | the manifest and its backup are missing or invalid |
| `UNSUPPORTED_SCHEMA` | the manifest was written by a newer version of GeoPlacer |
| `READ_ERROR` | the storage could not read the manifest |

Ni contenu du manifeste ni chemin de fichier n'y apparaissent.

**Tests** :

- une panne est injectée à **chaque** appel au stockage de chaque
  opération (création, placement, requantification, nouvelle source,
  restauration, réglages). L'appel est soit omis, soit effectué puis
  signalé en échec ;
- après chaque panne, un nouveau gestionnaire rouvre le stockage : le
  modèle est exactement dans l'ancien ou le nouvel état, entièrement
  vérifié ;
- la suite tourne sur le stockage mémoire **et** sur le stockage fichiers ;
- la réparation est soumise aux mêmes pannes injectées : il reste soit
  l'état corrompu (avec la sauvegarde intacte), soit l'état réparé ;
- en plus, un vrai processus est tué brutalement 8 fois pendant qu'il
  écrit des révisions ;
- verrou : deux processus indépendants, puis quatre lancés en même temps
  (3 tours), avec les deux mécanismes. Un seul entre ; les autres sont
  refusés avant d'écrire ; le verrou est rendu après une sortie propre et
  après un arrêt brutal.

**Limites connues** :

- le verrou protège un répertoire de données **local** ; un répertoire
  réseau partagé entre machines n'est pas pris en charge ;
- il ne couvre que le répertoire du nouveau moteur, ouvert par
  `openNodeTemplateManager` : le serveur hérité et ses fichiers ne sont pas
  concernés, et le serveur ne prend pas encore ce verrou au démarrage ;
- sous Windows, il repose sur un indicateur de libuv (`UV_FS_O_EXLOCK`,
  `0x10000000`) que Node.js n'exporte pas : à revérifier à chaque mise à
  jour majeure de Node ;
- les blobs orphelins et les fichiers `.tmp` d'une écriture interrompue ne
  sont pas encore nettoyés ;
- une coupure d'alimentation n'a pas été testée : la garantie repose sur
  `fsync` et le renommage atomique de NTFS.

## 6. Performances (`npm run bench:templates`)

Mesures sur la machine de développement (Windows 10, Node 22.23.2,
stockage fichiers et pngjs réels, un processus par scénario, palette de
32 couleurs). « Bruit » : couleurs aléatoires, cas le plus défavorable.
« Pixel art » : aplats de couleurs de la palette.

| Taille | Image | Création | Chargement | Révision de placement | Vérification (2 révisions) | Pic mémoire (RSS) |
|---|---|---|---|---|---|---|
| 2000 × 2000 | pixel art | 0,9 s | 0,29 s | 0,29 s | 0,49 s | 213 Mo |
| 2000 × 2000 | bruit | 2,6 s | 0,45 s | 0,48 s | 0,85 s | 241 Mo |
| 4096 × 4096 | pixel art | 3,3 s | 1,1 s | 1,2 s | 1,9 s | 628 Mo |
| 4096 × 4096 | bruit | 10,4 s | 1,8 s | 1,8 s | 3,3 s | 681 Mo |

Le pic mémoire inclut la génération de l'image de test (environ 64 Mo
de pixels et le PNG encodé). Le chargement ne requantifie rien : il relit,
hache et décode. À 4096², l'import garde plusieurs tampons de 64 Mo en
mémoire en même temps.
