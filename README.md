# GeoPlacer 6.0.0-rc.1

**Développement suspendu.** GeoPlacer prépare des PNG à importer manuellement dans
l’outil d’image fantôme de GeoPixels et permet de simuler un dessin sur une toile locale.

## Choisir une branche

| Branche | Contenu |
| --- | --- |
| [`main`](https://github.com/Daneisra/GeoPlacer/tree/main) | Démonstration stable avec simulation locale et préparation/export PNG |
| [`final/geoplacer`](https://github.com/Daneisra/GeoPlacer/tree/final/geoplacer) | Dernier état expérimental, avec tableau de bord, lecteur HTTP 1.1.4 et historique de développement |

### Limites du dernier état expérimental

Le lecteur observe le cache de l’onglet GeoPixels. L’heure de capture locale
et la fraîcheur des tuiles côté serveur sont deux informations distinctes.
Les zones non chargées restent inconnues. Le changement de modèle, de position,
de palette ou de session peut imposer un nouveau couplage. Un rechargement de
l’onglet, un redémarrage du serveur ou une révocation exige une nouvelle
approbation.

Le lecteur 1.1.4 a été vérifié sur une page factice locale. La fréquence des
coupures sur le site réel reste à confirmer. Les anciens parcours d’écriture
restent des expérimentations historiques. GeoPixels interdit le placement
automatisé dans ses [conditions d’utilisation](https://www.geopixels.net/TOS.html).

## Installation Windows

Prérequis vérifiés sur Windows 10 64 bits : Git, Node.js 22.12 ou supérieur,
npm 10 ou supérieur et une connexion Internet pour installer les dépendances.

```powershell
git clone --branch main https://github.com/Daneisra/GeoPlacer.git
cd GeoPlacer
npm.cmd run setup:windows
npm.cmd start
```

Ouvre ensuite `http://127.0.0.1:3000`. Sous Windows, `setup.bat` et
`start.bat` donnent accès aux mêmes opérations. Le mode `npm.cmd run demo`
utilise un dossier de données séparé.

## Documentation

- [Installation Windows](docs/fr/installation-windows.md)
- [Guide utilisateur](docs/fr/guide-utilisateur.md)
- [Préparation et export des PNG](docs/fr/geopixels.md)
- [Sauvegarde et restauration](docs/fr/sauvegarde-restauration.md)
- [Sécurité du serveur local](docs/fr/securite.md)
- [Index de la documentation et rapports historiques](docs/fr/README.md)

## Licence et crédits

GeoPlacer dérive de [wplacer-dev](https://github.com/Arknight38/wplacer-dev),
maintenu à l’origine par [Arknight](https://github.com/Arknight38), et de
[wplacer](https://github.com/luluwaffless/wplacer), créé par
[JinxTheCatto](https://github.com/JinxTheCatto) et
[luluwaffless](https://github.com/luluwaffless), avec leurs contributeurs.

Licence [GNU AGPL-3.0-only](LICENSE). Les modifications sont décrites dans
[MODIFICATIONS.md](MODIFICATIONS.md).
