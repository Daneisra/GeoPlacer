# Persistance des données

Toutes les données sont stockées en JSON dans `data/` (dossier ignoré par
Git) :

| Fichier | Contenu |
|---|---|
| `users.json` | Comptes, **cookies de session en clair** |
| `templates.json` | Modèles |
| `settings.json` | Paramètres |
| `color_ordering.json` | Ordre des couleurs |
| `logs.log`, `errors.log` | Journaux (secrets masqués) |

## Écriture atomique

Toutes les écritures JSON passent par `writeJsonAtomic()`
(`src/utils/json-store.ts`) :

1. écriture dans un fichier temporaire du même dossier
   (`<fichier>.<pid>.<horodatage>.<aléa>.tmp`) ;
2. `fsync` sur ce fichier ;
3. copie de la version actuelle en `<fichier>.bak`, **seulement si elle est
   un JSON valide** ;
4. renommage du temporaire sur le fichier cible (réessayé si Windows renvoie
   `EPERM`, `EBUSY` ou `EACCES`, par exemple à cause d'un antivirus).

Un arrêt brutal du processus à n'importe quelle étape laisse l'ancienne ou
la nouvelle version complète, jamais un fichier tronqué. Vérification : 8
arrêts brutaux d'un processus écrivain dans les tests, et une expérience
comparative de 20 arrêts sur 20 Mo (écriture directe : 1 fichier corrompu ;
écriture atomique : 0).

Ces vérifications portent sur l'arrêt du **processus**. Une coupure
d'alimentation ou un plantage du système n'a pas été testé : la garantie
repose alors sur `fsync` et sur le renommage atomique de NTFS.

## Lecture avec récupération

`readJsonWithRecovery()` :

- supprime les `.tmp` orphelins laissés par une écriture interrompue ;
- si le fichier est illisible, le **déplace** en
  `<fichier>.corrupt-<horodatage>` (il n'est jamais écrasé) puis restaure
  `<fichier>.bak` s'il existe ;
- si le fichier manque mais qu'un `.bak` existe, restaure le `.bak` ;
- journalise chaque récupération (avertissement, ou erreur sans sauvegarde).

Avant la Phase 1A, un fichier illisible était remplacé par `{}` à la
sauvegarde suivante : les données disparaissaient sans trace.

Les paramètres sont en plus validés champ par champ au chargement : une
valeur invalide est remplacée par sa valeur par défaut, avec un
avertissement.

## Sauvegarde et restauration manuelles

- **Sauvegarder** : serveur arrêté, copier tout le dossier `data/`. Il
  contient des cookies de session : ne jamais le partager ni le versionner.
- **Restaurer une version précédente** : serveur arrêté, remplacer
  `<fichier>.json` par `<fichier>.json.bak` (ou par une copie de `data/`).
- **Récupérer un fichier mis en quarantaine** : le contenu d'origine est
  intact dans `<fichier>.corrupt-<horodatage>`. Il peut être réparé à la
  main puis remis en place, serveur arrêté.
- **Réinitialiser un fichier** : supprimer `<fichier>.json` ne suffit pas,
  car le `.bak` est restauré au démarrage suivant. Supprimer aussi
  `<fichier>.json.bak`, serveur arrêté.

## Limites connues

- Un seul niveau de sauvegarde (`.bak`) : pas d'historique horodaté.
- Les cookies en clair sont aussi copiés dans `users.json.bak` et, le cas
  échéant, dans `users.json.corrupt-*`, qui ne sont jamais nettoyés
  automatiquement.
- Aucun verrou d'instance unique : deux serveurs lancés en même temps (le
  second sur un port de repli, sans avertissement) partageraient `data/`.
- Les modèles créés via l'API ne sont ni sauvegardés ni rechargés (bug F4/F5
  hérité de `wplacer-dev`, voir `docs/decisions/0001-fork-et-perimetre.md`).
  Ce point sera traité avec le nouveau moteur, qui aura sa propre file de
  tâches persistante.
