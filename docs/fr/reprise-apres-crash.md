# Reprise après crash (Phase 1B.9)

Ce qui est garanti, comment c'est vérifié, et ce qui ne l'est pas.

## 1. Deux états durables, indépendants

| État | Où | Rôle |
|---|---|---|
| **Journal des tentatives** | `data\engine\journal\` | Ce que le moteur a réservé, envoyé, obtenu (voir [journal.md](journal.md)) |
| **Toile simulée** (le « monde ») | `data\engine\world\` | Ce que la toile simulée contient : pixels et ressources de l'agent. Elle joue le rôle du service distant |

La toile simulée est sauvegardée **pour elle-même**, comme le serait une
vraie toile distante. Reprendre le journal sans la toile ne serait pas
une reprise complète. Si la toile sauvegardée manque ou est endommagée, le
moteur le dit (`WORLD_UNAVAILABLE`) et attend une réinitialisation
explicite. Il ne repart jamais en silence d'une toile vide.

## 2. Ordre des écritures de la toile simulée

Pour chaque changement (écriture d'un lot, acteur extérieur, agent) :

1. le changement est préparé à part, sans toucher la toile ;
2. il est ajouté au log `world-<n>.log`, avec une somme de contrôle, puis
   **fsync** ;
3. il devient visible ;
4. l'écriture répond au moteur.

Conséquences d'un arrêt brutal :

| Arrêt | Toile au redémarrage | Moteur |
|---|---|---|
| Avant le fsync du changement | Changement absent ; une dernière ligne déchirée est coupée | L'écriture n'a pas répondu : la tentative est **réconciliée** par une lecture, qui ne voit pas les pixels, puis replanifiée. Énergie non dépensée |
| Après le fsync, avant la réponse | Changement présent | Réconciliation : pixels observés corrects, **jamais renvoyés**. Énergie dépensée une seule fois, observée sur la toile |
| Pendant un checkpoint | Génération précédente ou nouvelle, entière ; les fichiers orphelins sont supprimés | Rien à faire |

**Confirmé** et **incertain** sont distingués :

- confirmé : une tentative close, avec sa réponse ;
- incertain : une tentative démarrée sans réponse. Elle reste ouverte,
  ses points restent réservés, et elle n'est close que par une lecture de
  la toile qui couvre **tous** ses pixels.

## 3. Ce qui est vérifié par les tests

| Test | Contrôle |
|---|---|
| Toile durable (`world-store.test.ts`) : processus réels tués à 9 étapes nommées (ajout, checkpoint écrit, log créé, pointeur écrit et renommé, ancienne génération supprimée), sans minuteur | Toutes les écritures acquittées sont retrouvées, au plus une de plus, dans l'ordre. L'énergie est dépensée exactement une fois. La suite reprend et se termine |
| Service (`crash.test.ts`) : un vrai processus tué après le 1er, le 4e puis le 9e changement durable, en pleine simulation | Le service rouvert annonce la tentative à réconcilier, termine le modèle, sans double consommation |
| Serveur réel (`server-engine.test.ts`) : processus tué pendant une simulation, puis redémarré | Même résultat, par l'API |
| Monde endommagé (ligne au milieu, checkpoint, pointeur manquant) ou d'une autre configuration | Refus explicite |

## 4. Procédure

1. **Redémarrer** le serveur (`npm start`). Le journal (log
   `[engine] … attempt(s) interrupted …`) et le tableau de bord indiquent
   les tentatives interrompues.
2. **Démarrer**. Le moteur relit la toile, réconcilie les tentatives
   interrompues, puis continue. Aucune écriture n'est renvoyée à
   l'aveugle.
3. Si le tableau de bord affiche « Toile simulée indisponible » :
   1. lire le code ;
   2. faire un diagnostic (voir [diagnostic.md](diagnostic.md)) ;
   3. en dernier recours, « Réinitialiser le monde… » (taper `RESET`).
      L'ancien monde est conservé dans `data\engine\world-reset-<date>\`.
4. Si le serveur refuse de démarrer (« already used by another GeoPlacer
   instance ») : arrêter l'autre instance. Si aucune autre ne tourne,
   vérifier qu'aucun processus `node` ne garde le dossier.

## 5. Limites

- **Coupure électrique** : non testée. Les fsync sont faits, mais Windows
  ne permet pas de fsync sur un répertoire : un renommage repose sur la
  journalisation des métadonnées de NTFS. Aucune garantie n'est donc
  donnée après une coupure de courant. Seuls les arrêts brutaux de
  processus sont testés.
- Une dernière ligne entièrement écrite puis abîmée sur le disque serait
  coupée comme une ligne déchirée. Le moteur verrait alors des pixels
  manquants et les repeindrait.
- Observer la bonne couleur ne prouve pas **quelle** opération l'a posée
  (voir [ordonnanceur.md](ordonnanceur.md) § 6).
- Le garde par canal nommé n'existe que sous Windows ; ailleurs, le verrou
  dans le répertoire s'applique seul. Le test Linux n'a pas pu être fait
  (aucun environnement Linux isolé disponible).
