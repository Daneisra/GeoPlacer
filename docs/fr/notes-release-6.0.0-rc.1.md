# GeoPlacer 6.0.0-rc.1 — V1 de démonstration (simulation locale)

> **Version candidate destinée à des testeurs.** GeoPlacer V1 est un
> environnement de **simulation locale** : la toile, l'agent et ses
> ressources sont simulés sur votre machine. Il ne se connecte à aucun
> service (ni GeoPixels, ni Wplace) et ne demande aucun compte.

## Ce que vous pouvez faire

- Installer GeoPlacer sous Windows en une commande.
- Lancer une **démonstration** de deux minutes, sans rien préparer.
- Importer votre propre image (PNG jusqu'à 4096 × 4096), choisir sa
  position et l'une des 8 stratégies de dessin, et regarder le moteur la
  dessiner sur la toile simulée, avec une énergie qui se régénère.
- Mettre en pause, reprendre, arrêter (Ctrl+C) et **retrouver la
  progression** au démarrage suivant.
- **Sauvegarder** et **restaurer** vos données.

## Installer (Windows 10, 64 bits ; Windows 11 non vérifié)

1. Installez [Node.js 22 LTS](https://nodejs.org).
2. Téléchargez l'archive `geoplacer-6.0.0-rc.1-windows-<commit>.zip`
   ci-dessous et vérifiez son empreinte avec celle du fichier `.sha256`
   publié à côté :
   ```powershell
   Get-FileHash .\geoplacer-6.0.0-rc.1-windows-<commit>.zip -Algorithm SHA256
   ```
   Extrayez-la (ou utilisez `git clone`), puis, dans son dossier :
   ```powershell
   npm run setup:windows
   ```
   ou double-cliquez sur `setup.bat`. Aucun droit administrateur, aucun
   compilateur ; rien n'est modifié globalement sur Windows.
3. Lancez `start.bat` (ou `npm start`) et ouvrez l'adresse affichée
   (par défaut `http://127.0.0.1:3000`). Pour la démonstration :
   `start.bat --demo`.

Guide complet : `docs/fr/installation-windows.md` et
`docs/fr/demonstration.md`.

## Nouveautés de cette version candidate

- **Serveur réactif** sur les grands modèles : le calcul est découpé et
  laisse passer les requêtes ; sur un modèle de 4096 × 4096, la latence
  d'une requête passe d'environ 230 ms (médiane) à 3 ms, sans différence
  de débit mesurable (mesures au calme, voir `docs/fr/progression.md`).
- **Installation fiabilisée** : fonctionne avec Node.js installé dans
  `C:\Program Files`, reprend une installation interrompue, recompile après
  une mise à jour du code, vérifie l'empreinte du binaire `canvas`.
- **Sauvegardes** : la démonstration et votre projet ne peuvent plus être
  mélangés par erreur.
- Documentation française complète.

## Limites connues

- Simulation locale uniquement ; un seul agent simulé.
- Vérifié sous Windows 10 ; Linux et macOS non vérifiés.
- Navigateurs vérifiés : Edge ; Firefox dans la version fournie par
  Playwright (une version officielle de Firefox n'a pas été testée).
- La reprise est vérifiée après l'arrêt brutal du programme ; la tenue
  après une coupure de courant n'est pas garantie.
- Le débit de dessin baisse sur les très grands modèles (environ 2 000
  pixels par seconde à 4096 × 4096).

Liste complète : `docs/fr/problemes-connus.md`.

## Signaler un problème

Joignez le journal d'installation (`test-logs\<date>-setup.log`) ou la
sortie de la console du serveur. N'y mettez aucune information
personnelle.

## Licence et origine

GeoPlacer est un fork de wplacer (JinxTheCatto, luluwaffless, Arknight38
et contributeurs), distribué sous **AGPL-3.0-only**. Les modifications sont
décrites dans `MODIFICATIONS.md`.
