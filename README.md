# GeoPlacer 6.0.0-rc.1

**Développement suspendu.** Cette branche fournit la démonstration stable de
GeoPlacer. Elle prépare des PNG pour l’outil d’image fantôme de GeoPixels et
simule des dessins sur une toile locale. L’import dans GeoPixels se fait à la main.

Le dernier état expérimental, son lecteur HTTP et ses limites de couplage
sont documentés sur la [branche finale](https://github.com/Daneisra/GeoPlacer/tree/final/geoplacer).

## Installation sous Windows

Prérequis vérifiés sur Windows 10 64 bits : Git, Node.js 22.12 ou supérieur,
npm 10 ou supérieur et une connexion Internet pour installer les dépendances.

```powershell
git clone --branch main https://github.com/Daneisra/GeoPlacer.git
cd GeoPlacer
npm.cmd run setup:windows
npm.cmd start
```

Ouvre ensuite `http://127.0.0.1:3000`. Les scripts `setup.bat` et
`start.bat` proposent le même parcours. `npm.cmd run demo` lance la
démonstration avec ses propres données.

## Documentation

- [Installation Windows](docs/fr/installation-windows.md)
- [Guide de démonstration](docs/fr/demonstration.md)
- [Préparation et export PNG](docs/fr/geopixels.md)
- [Sauvegarde et restauration](docs/fr/sauvegarde-restauration.md)
- [Sécurité et isolation](docs/fr/securite.md)

## Licence et crédits

GeoPlacer dérive de [wplacer-dev](https://github.com/Arknight38/wplacer-dev),
maintenu à l’origine par [Arknight](https://github.com/Arknight38), et de
[wplacer](https://github.com/luluwaffless/wplacer), créé par
[JinxTheCatto](https://github.com/JinxTheCatto) et
[luluwaffless](https://github.com/luluwaffless), avec leurs contributeurs.

Licence [GNU AGPL-3.0-only](LICENSE). Voir [MODIFICATIONS.md](MODIFICATIONS.md).
