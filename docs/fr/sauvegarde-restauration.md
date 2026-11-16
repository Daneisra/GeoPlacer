# Sauvegarde et restauration (Phase 1B.10)

Ce document concerne les données du **moteur** : `data\engine` (ou
`GEOPLACER_ENGINE_DIR`), et `data\demo` pour la démonstration. On y trouve
la toile simulée, les modèles et leurs révisions, le journal des
tentatives et ses checkpoints, l'historique et les réglages
(`engine.json`). Les fichiers hérités de `data\` (`users.json`,
`templates.json`…) ne font pas partie de la sauvegarde ; voir
[persistance.md](persistance.md).

## 1. Sauvegarder

**GeoPlacer doit être arrêté, ou la simulation à l'arrêt** : rien ne doit
écrire pendant la copie. La sauvegarde est donc cohérente.

Depuis l'interface : panneau « Simulateur », bouton **« Sauvegarder »**.
Il est refusé pendant une simulation, même en pause (`ENGINE_BUSY`) :
arrêter d'abord. Le serveur choisit seul le dossier de destination ;
aucun chemin n'est accepté du navigateur.

En ligne de commande, GeoPlacer arrêté :

```powershell
npm run backup                                  # data\engine -> sauvegardes\
npm run backup -- --data data\demo              # la démonstration
npm run backup -- --out D:\MesSauvegardes       # autre destination
```

Si GeoPlacer tourne sur ce dossier, la commande refuse avec une
explication (`ENGINE_RUNNING`) : le dossier est verrouillé.

Chaque sauvegarde est un dossier daté
`sauvegardes\geoplacer-sauvegarde-<date>\` :

| Élément | Contenu |
|---|---|
| `donnees\` | Tous les fichiers du dossier du moteur, sauf les verrous, les fichiers temporaires et les anciens mondes mis de côté après une réinitialisation (`world-reset-*`) |
| `MANIFEST.json` | Chaque fichier avec sa taille et son empreinte SHA-256, les versions des formats, un résumé (nombre de fichiers, taille, modèle sélectionné) |
| `MANIFEST.sha256` | L'empreinte du manifeste lui-même |

La sauvegarde est d'abord écrite dans `<nom>.partial`, relue et vérifiée,
puis renommée : **elle est complète, ou absente**. Un dossier `.partial`
qui reste après un échec ou une coupure n'est jamais pris pour une
sauvegarde ; il peut être supprimé à la main.

Le dossier des sauvegardes vaut `sauvegardes\`, à la racine du projet (ignoré
par Git). On peut le changer avec `GEOPLACER_BACKUP_DIR` dans `.env` ; le
serveur et la ligne de commande utilisent alors le même dossier.

Une sauvegarde ne contient **aucun secret** : la V1 ne manipule ni
compte, ni session, ni jeton.

## 2. Vérifier une sauvegarde

```powershell
npm run backup:verify -- sauvegardes\geoplacer-sauvegarde-<date>
```

Lecture seule : le manifeste, puis la taille et l'empreinte de chaque
fichier. Aucune donnée n'est modifiée.

## 3. Restaurer

GeoPlacer **arrêté** :

```powershell
npm run restore -- sauvegardes\geoplacer-sauvegarde-<date>
npm run restore -- sauvegardes\geoplacer-sauvegarde-<date> --data data\demo
```

Étapes :

1. **Vérification complète** de la sauvegarde : manifeste, tailles,
   empreintes, aucun chemin hors de `donnees\`. Les formats doivent être
   connus de cette version de GeoPlacer.
2. **Verrouillage** du dossier cible : refus si GeoPlacer tourne dessus.
3. **Copie** dans un dossier voisin temporaire, nouvelle vérification des
   empreintes, puis du contenu : réglages lisibles, toile simulée
   ouvrable, diagnostic du journal.
4. **Échange** : le dossier actuel est **renommé**
   `<dossier>.avant-restauration-<date>` (il est conservé, jamais
   supprimé), puis la copie vérifiée prend sa place.

Au démarrage suivant, le moteur relit le journal et réconcilie les
tentatives qui étaient en cours au moment de la sauvegarde, sans peindre
deux fois.

**Une sauvegarde corrompue ne touche jamais aux données actuelles** : elle
est refusée à l'étape 1, ou à l'étape 3 avant tout déplacement. Les refus
possibles :

| Code | Signification |
|---|---|
| `BACKUP_CORRUPT` | Fichier manquant, modifié ou tronqué, manifeste altéré |
| `BACKUP_INCOMPATIBLE` | Sauvegarde d'une version plus récente ou inconnue |
| `BACKUP_INCONSISTENT` | Empreintes justes mais contenu incohérent (toile simulée endommagée par exemple) |
| `ENGINE_RUNNING` | GeoPlacer tourne sur le dossier cible |
| `RESTORE_IN_PROGRESS` | Une restauration précédente a été interrompue (voir § 4) |
| `NOT_FOUND` | Dossier de sauvegarde introuvable |

Codes de sortie : 0 succès, 1 erreur inattendue, 2 commande mal formée,
3 refus expliqué ci-dessus.

## 4. Restauration interrompue

Le fichier `<dossier>.restauration.json`, posé à côté du dossier du
moteur, enregistre l'étape atteinte. Tant qu'il existe :

- **GeoPlacer refuse de démarrer** sur ce dossier : « GeoPlacer cannot
  start on this data directory: … » ;
- la commande suivante termine la restauration, ou remet les données
  précédentes en place :

```powershell
npm run restore -- --resume
```

Réponses possibles : « Restauration interrompue terminée. »,
« Restauration interrompue annulée : les données précédentes sont remises
en place. » ou « La restauration était déjà terminée. ».

Vérifié par des **processus réellement tués** à chaque étape nommée
(`staged`, `state-written`, `previous-moved`, `restored-moved`) : il ne
manque jamais de données, le moteur refuse d'ouvrir le dossier tant que la
reprise n'a pas eu lieu, et la reprise termine ou annule proprement
(`packages/engine-service/test/backup.test.ts`).

## 5. Revenir en arrière après une restauration

Les données d'avant la restauration sont dans
`<dossier>.avant-restauration-<date>`. Pour les retrouver, GeoPlacer
arrêté : renommer le dossier actuel, puis renommer ce dossier en
`engine` (ou `demo`). On peut aussi les sauvegarder d'abord :
`npm run backup -- --data data\engine.avant-restauration-<date>`.

Ces dossiers ne sont jamais supprimés automatiquement : les effacer à la
main quand ils ne servent plus.

## 6. Limites

- Pas de sauvegarde automatique ni planifiée.
- Pas de restauration depuis l'interface : la restauration se fait
  GeoPlacer arrêté, en ligne de commande.
- Une sauvegarde sur le même disque ne protège pas d'une panne de ce
  disque : copier le dossier de sauvegarde ailleurs.
- Durabilité : chaque fichier copié est écrit puis synchronisé (`fsync`),
  mais la tenue après une coupure de courant n'a pas été testée.
