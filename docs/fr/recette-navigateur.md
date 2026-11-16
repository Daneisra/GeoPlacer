# Recette utilisateur — GeoPlacer 6.0.0-rc.1 consolidée

Cette recette concerne la préparation d’images et la simulation locale.
Utiliser un dossier de test séparé ; conserver les données et sauvegardes de
production. Ne pas démarrer de bot ni automatiser le site GeoPixels.

## Installer et démarrer

Extraire l’archive candidate identifiée par le commit final (pas 4a62e5d),
puis `npm run setup:windows` ou setup.bat. Lancer start.bat et ouvrir
l’adresse locale affichée. Vérifier la bannière **GeoPlacer 6.0.0-rc.1**, le
titre de page et la barre latérale GeoPlacer.

## Simulation

Tableau de bord : préparer la démonstration, démarrer, observer une hausse
réelle de pixels corrects, mettre en pause puis reprendre. Arrêter la
simulation avant une sauvegarde. Noter les états, erreurs éventuelles et
la version du navigateur. Aucune identité de compte réel n’est demandée.

## Préparer pour GeoPixels

1. Importer un petit PNG asymétrique avec une bande transparente.
2. Vérifier les 28 couleurs du premier préréglage (blanc #ffffff, noir en
   dernier), puis les 30 de la liste communautaire distincte.
3. Choisir Palette personnalisée, saisir #fffff : erreur à six chiffres et
   préparation indisponible. Ajouter des doublons : ils sont signalés et
   ne créent pas de couleur supplémentaire.
4. Saisir une palette valide, passer à un préréglage puis revenir et
   recharger : le texte personnalisé doit être conservé. Vérifier aussi
   le mode couleurs originales et un seuil alpha différent.
5. Préparer et vérifier dimensions, damier, surface totale, pixels retenus,
   transparents, couleurs utilisées/inutilisées, puis télécharger le PNG.
6. Préparer à nouveau avec une autre palette. Le nouveau modèle utilise
   cette palette ; l’ancien garde ses couleurs et son export.
7. Ne suivre les liens externes que volontairement ; l’import dans l’outil
   natif GeoPixels est manuel et indépendant de la recette locale.

## Sauvegarde, arrêt et reprise

Simulation arrêtée : sauvegarder, noter le dossier. Fermer le serveur.
Restaurer avec la procédure de sauvegarde-restauration.md dans un dossier
de test distinct puis redémarrer : modèles simulés et images préparées
GeoPixels doivent être retrouvés, avec leurs palettes et leurs PNG.

**Validation utilisateur réalisée le 16 novembre 2026 :** l’utilisateur
confirme que le **Ctrl+C physique au clavier sous Windows fonctionne**.
Codex n’a pas effectué ce geste. Les tests automatiques de processus et de
reprise restent complémentaires. Un Ctrl+C doit arrêter proprement le
serveur ; s’il est lancé par un .bat, répondre à la question de cmd une
fois le serveur arrêté. Noter la sortie réelle, puis redémarrer et vérifier
la progression enregistrée. Ne pas attribuer à l’utilisateur des messages
précis qu’il n’a pas fournis.

## Import manuel validé par l’utilisateur

Le 16 novembre 2026, PNG 595 × 894 préparé avec 28 couleurs, accepté,
affiché et positionné dans GeoPixels, sans inversion évidente. Surface
531 930 ; pixels retenus 294 647 ; transparents 237 283. Le compteur du site
porte sur 531 930 : définition potentiellement différente, pas un bug déduit.
Détails et limites : geopixels.md. Cette observation ne certifie pas toutes
les images et aucun placement automatique n’a été validé.

## Recettes automatisées locales

Avec Playwright installé séparément et GEOPLACER_PLAYWRIGHT_CORE défini :
`node scripts/recette-geopixels.mjs <sortie>` et
`node scripts/recette-simulation.mjs <sortie>`.
GEOPLACER_BROWSER_ENGINE=firefox sélectionne le Firefox Playwright ; sinon
Edge installé. Ces recettes utilisent des données temporaires. Conserver
les journaux, captures, commit et version navigateur. Les tests de
quantification, PNG et reprise s’exécutent aussi dans npm run check:logged.
