# Modèles : gestion, révisions et persistance

État : **Phase 1B.2**. Le gestionnaire de modèles (`TemplateManager`) est
implémenté dans `@geoplacer/core`, sans aucune entrée/sortie. Les accès aux
fichiers, le décodage PNG et le calcul SHA-256 passent par des ports,
implémentés pour Node.js dans `@geoplacer/adapters-node`. Le serveur hérité
n'utilise pas encore ce gestionnaire.

## 1. Fonctions

```ts
import { createNodeTemplateManager } from '@geoplacer/adapters-node';

const modeles = createNodeTemplateManager('data/engine');
const t = await modeles.create({ projectId, name, sourcePng, palette, placement, coordinateSystem });
```

| Opération | Effet | Nouvelle révision ? |
|---|---|---|
| `create` | Importe le PNG, le quantifie et enregistre la révision 1 | oui (`created`) |
| `load(ref)` | Charge la révision courante, vérifiée | — |
| `load(ref, { revision })` | Charge **exactement** cette révision (erreur si elle ne se vérifie pas) | — |
| `load(ref, { recover: true })` | Récupération en lecture seule (§ 5) | — |
| `manifest(ref)` | Métadonnées validées, sans décodage d'image | — |
| `list(projectId)` | Modèles d'un projet (supprimés exclus) | — |
| `revise(ref, changement)` | Image source, palette, seuil alpha, quantification, placement ou repère | oui, si quelque chose change |
| `restoreRevision(ref, n)` | Nouvelle révision qui reprend le contenu de la révision `n` | oui (`restored`) |
| `updateSettings(ref, …)` | Nom, stratégie, priorité | **non** |
| `setStatus(ref, statut)` | `active`, `paused`, `completed`, `archived` | **non** |
| `duplicate(ref, { name, projectId? })` | Copie de la révision courante, nouvel identifiant, statut `paused` | révision 1 (`duplicated`) |
| `delete(ref, { confirmName })` | Suppression contrôlée : exige le nom exact ; pierre tombale, fichiers conservés | — |
| `verify(ref)` | Relit et revérifie chaque révision (lecture seule) | — |

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
facultatives dans `extensions` (manifeste ou révision), conservé tel quel.
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

**Tests** :

- une panne est injectée à **chaque** appel au stockage de chaque
  opération (création, placement, requantification, nouvelle source,
  restauration, réglages). L'appel est soit omis, soit effectué puis
  signalé en échec ;
- après chaque panne, un nouveau gestionnaire rouvre le stockage : le
  modèle est exactement dans l'ancien ou le nouvel état, entièrement
  vérifié ;
- la suite tourne sur le stockage mémoire **et** sur le stockage fichiers ;
- en plus, un vrai processus est tué brutalement 8 fois pendant qu'il
  écrit des révisions.

**Limites connues** :

- deux **processus** qui écrivent le même modèle au même instant ne sont
  pas pris en charge (V1 : un seul serveur local) ;
- les blobs orphelins et les fichiers `.tmp` d'une écriture interrompue ne
  sont pas encore nettoyés ;
- une coupure d'alimentation n'a pas été testée : la garantie repose sur
  `fsync` et le renommage atomique de NTFS ;
- si le manifeste et sa sauvegarde sont tous deux illisibles, `list`
  échoue pour tout le projet.

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
