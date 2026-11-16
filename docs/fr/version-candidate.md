# Candidate consolidée GeoPlacer 6.0.0-rc.1

État local du 16 novembre 2026 : branche **integrate/6.0.0-rc.1-geopixels**,
créée depuis release/6.0.0-rc.1 (4a62e5d), puis fusion de
feat/geopixels-ghost-export (b8fd851). Ancêtre commun : c57e478.
Les quatre commits de chaque branche sont conservés, sans conflit, sans
réécriture ni duplication par cherry-pick. Les branches d’origine, main et
backup/* restent intactes. **Aucun push, tag ou release n’est autorisé ici.**

## Périmètre réellement présent

- Simulation locale mono-agent, huit stratégies, progression, ressources,
  ordonnanceur coopératif, journal/checkpoints et reprise.
- Préparation locale de PNG, redimensionnement, quantification OKLab,
  export pour import **manuel** dans GeoPixels ; aucune connexion au service.
- Quatre modes de palette : liste utilisateur 28, communautaire 30,
  personnalisée mémorisée indépendamment, couleurs originales de l’image.
- Modèles persistants avec palette effective, sauvegarde/restauration,
  identité visible GeoPlacer ; attributions et AGPL-3.0-only conservées.

## Version et provenance

Package et lockfile : **6.0.0-rc.1**. La bannière et Swagger lisent la version
du package ; aucune nouvelle version officielle inventée. Le nom npm devient
geoplacer ; le nom des paquets internes, les formats stockés et la licence
ne changent pas. Les textes 5.6.2 dans l’historique décrivent Wplacer.

L’archive du commit **4a62e5d est ancienne** : elle ne contient pas les
fonctions intégrées ici. Seule l’archive identifiée par le commit final de
la branche consolidée et son SHA-256 doit être présentée aux testeurs.

```powershell
npm run check:logged
npm run build
node scripts/build-release-archive.mjs HEAD --verify-install
```

Le générateur construit deux fois par git archive, vérifie les fichiers,
exclusions et fins de ligne Windows, et fournit le ZIP, son .sha256 et le
manifeste dans release/ (ignoré). L’archive contient les sources suivies,
aucune donnée locale, .env, dépendance installée ou sauvegarde. L’installation
télécharge les dépendances exactes et le binaire canvas dont l’intégrité est
vérifiée. Les journaux d’installation sont conservés ; le ZIP n’est pas une
installation sans réseau ni sans prérequis Node.js.

## Validations et limites

L’utilisateur confirme le 16 novembre 2026 le vrai Ctrl+C au clavier sous
Windows et un PNG 595 × 894 importé/positionné dans l’outil natif GeoPixels,
sans inversion évidente. Ces gestes n’ont pas été faits par Codex.
Les résultats détaillés de consolidation sont dans
[consolidation-6.0.0-rc.1.md](consolidation-6.0.0-rc.1.md).
La recette d’import ne certifie pas toutes les tailles, palettes ou formats ;
les tests de reprise couvrent l’arrêt de processus, pas toute coupure matérielle.
La palette communautaire n’est pas officielle et aucun préréglage ne prouve
les droits de couleur d’un compte.

## Décisions avant publication

1. Relire le rapport, l’archive et son manifeste ; choisir les testeurs.
2. Autoriser explicitement le push de la branche consolidée si souhaité.
3. Décider séparément du sort de main : il contient encore Wplacer, et un
   clone sans branche explicite n’obtient pas la candidate. Aucune fusion
   n’est faite maintenant ; l’historique permettrait une avance rapide
   seulement après validation de cette décision.
4. Autoriser séparément un tag et une release marquée pré-version,
   rattachés au même SHA que l’archive testée. Aucun de ces actes n’a lieu
   pendant cette consolidation. Après publication, retélécharger l’artefact
   et comparer son SHA-256.

Les notes proposées sont dans notes-release-6.0.0-rc.1.md. Aucun paquet ou
script de placement réel, gestion de compte, cookie, token ou proxy n’est réactivé.
