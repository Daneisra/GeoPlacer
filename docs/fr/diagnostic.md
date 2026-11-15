# Guide de diagnostic (Phase 1B.9)

## 1. Depuis le tableau de bord

| Symptôme | Où regarder | Que faire |
|---|---|---|
| « Déconnecté — reconnexion… » | Serveur arrêté ou injoignable | Relancer le serveur ; la page se reconnecte seule |
| « Démarrer » grisé | Survol du bouton ; « Aucun modèle sélectionné » | Sélectionner un modèle ; arrêter la simulation en cours |
| État « Attente ressources » | Énergie, prochaine disponibilité | Attendre la régénération, ou appliquer une amélioration (en pause) |
| État « Attente réconciliation » | Tâches et tentatives > « À réconcilier » | Le moteur relit la toile ; rien à faire |
| État « Erreur » et `BLOCKED` | Erreurs récentes | Pixels dans des couleurs verrouillées : débloquer la couleur (amélioration simulée) |
| « Toile simulée indisponible » | Code `WORLD_DAMAGED` ou `WORLD_IDENTITY_MISMATCH` | Voir [reprise-apres-crash.md](reprise-apres-crash.md) § 4 |
| Notification « … refusé » | Code entre parenthèses | Voir [api-v1.md](api-v1.md) § 2 |

« Diagnostic du journal » (panneau Simulateur) :

- **à l'arrêt** : verdict complet (`healthy`, `damaged`…), sans
  modification ;
- **pendant l'exécution** : statistiques seulement, pour ne pas lire des
  fichiers en cours d'écriture.

## 2. En ligne de commande

Serveur arrêté :

```powershell
npm run journal:diagnose -- data\engine          # lecture seule
npm run journal:repair -- data\engine            # plan seulement
npm run journal:repair -- data\engine --apply <id du plan>
```

Voir [journal.md](journal.md) pour le détail de la réparation (sauvegarde,
trace, confirmation).

## 3. Fichiers du moteur (`data\engine\`)

| Fichier | Contenu |
|---|---|
| `.geoplacer.lock`, `.geoplacer.lock.owner` | Verrou de l'instance (pid et date du détenteur) |
| `engine.json` | Réglages de la simulation, modèle sélectionné |
| `journal\` | Journal des tentatives et historique |
| `world\CURRENT`, `world-<n>.ckpt`, `world-<n>.log` | Toile simulée : pointeur, checkpoint, changements |
| `world-reset-<date>\` | Ancien monde, conservé après une réinitialisation |
| `projects\…` | Modèles et révisions (voir [modeles.md](modeles.md)) |

Aucun de ces fichiers ne contient de secret.

## 4. Journaux du serveur

- Les lignes `[engine]` décrivent l'ouverture du monde, les tentatives
  interrompues, la fin d'une simulation et les erreurs.
- Au démarrage, les lignes « Engine ready: local simulation only » et
  « Inherited keep-alive disabled » confirment qu'aucun service réel n'est
  contacté.

## 5. Mesures

- `npm run bench:responsiveness [côté] [secondes]` : réactivité du serveur
  pendant une simulation (voir [qualite.md](qualite.md)).
- `npm run bench:scheduler` : l'ordonnanceur seul.
