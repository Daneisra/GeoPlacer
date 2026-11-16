<h1 align="center"><p style="display: inline-flex; align-items: center; gap: 0.25em"><img style="width: 1.5em; height: 1.5em;" src="frontend/public/icons/favicon.svg">wplacer</p></h1>

<p align="center"><img src="https://img.shields.io/github/package-json/v/wplacer/wplacer">
<a href="LICENSE"><img src="https://img.shields.io/github/license/wplacer/wplacer"></a>
<a href="https://discord.gg/wplacerbot"><img src="https://img.shields.io/badge/Support-gray?style=flat&logo=Discord&logoColor=white&logoSize=auto&labelColor=5562ea"></a>
<a href="LEIAME.md"><img src="https://img.shields.io/badge/tradução-português_(brasil)-green"></a>
<a href="LISEZMOI.md"><img src="https://img.shields.io/badge/traduction-français-blue"></a>
<a href="README_zh-cn.md"><img src="https://img.shields.io/badge/翻译-简体中文-red"></a></p>

## GeoPlacer

**GeoPlacer** place les pixels d'une image sur une toile, pixel par pixel,
en respectant des ressources limitées (énergie qui se régénère, couleurs
débloquées), avec une stratégie de dessin, et reprend là où il s'était
arrêté. **GeoPlacer V1 est un environnement de simulation local** : la
toile, l'agent et ses ressources sont **simulés** sur votre machine, et un
tableau de bord dans le navigateur pilote le moteur. Aucune connexion à
GeoPixels, à Wplace ou à un autre service ; aucun compte, aucune session,
aucun jeton.

**Origine** : GeoPlacer est un fork de wplacer (`Arknight38/wplacer-dev`,
issu de `luluwaffless/wplacer`), œuvre de JinxTheCatto, luluwaffless,
Arknight38 et de leurs contributeurs (voir « Credits » plus bas), sous
licence **AGPL-3.0-only**. Les modifications sont listées dans
[MODIFICATIONS.md](MODIFICATIONS.md).

### Installer (Windows)

Prérequis : Windows 10 ou 11 (64 bits), [Node.js 22 LTS](https://nodejs.org)
(22.12 au minimum ; fournit npm 10) et Git (ou le téléchargement ZIP du
dépôt), une connexion Internet pour l'installation. Aucun compilateur,
aucun droit administrateur.

```powershell
git clone https://github.com/Daneisra/GeoPlacer.git
cd GeoPlacer
npm run setup:windows      # ou double-clic sur setup.bat
```

Tant que la version candidate n'est pas fusionnée dans `main`, se placer
d'abord sur sa branche : `git checkout feat/phase1c0-release-candidate`.

Une seule commande : dépendances exactes, binaire `canvas` précompilé (sans
compilateur), compilation, configuration sans secret, démarrage de
contrôle. Rien n'est modifié globalement sur Windows.
Détails : [installation Windows](docs/fr/installation-windows.md).

### Utiliser

```powershell
npm start                  # ou start.bat ; puis ouvrir http://127.0.0.1:3000
npm run demo               # ou start.bat --demo : démonstration, dossier séparé data\demo
```

`start.bat` vérifie d'abord l'installation et la complète si besoin
(première fois, installation interrompue, mise à jour du code).

- **Démonstration** : sur un projet vide, la carte « Découvrir GeoPlacer »
  prépare un modèle d'exemple et un agent simulé rapide ; « Démarrer »,
  puis environ deux minutes ([guide](docs/fr/demonstration.md)).
- **Votre image** : panneau « Modèle » > « Importer un PNG » (8 Mio au
  plus, jusqu'à 4096 × 4096 pixels) ; choisir un nom, la position (x, y)
  sur la toile simulée et une stratégie. Les couleurs sont ramenées à la
  palette de la simulation. Un modèle qui dépasse la toile est refusé :
  agrandir la toile (panneau « Simulateur ») ou changer la position.
- **Stratégies de dessin** : haut vers bas, bas vers haut, gauche vers
  droite, droite vers gauche, couleur par couleur, contours d'abord, du
  centre vers l'extérieur, aléatoire.
- **Ressources simulées** : énergie (un pixel coûte une unité), capacité,
  régénération, monnaie, couleurs débloquées ; les améliorations proposées
  s'appliquent seulement après confirmation, jamais automatiquement
  (panneau « Ressources de l’agent simulé »).
- **Pause et reprise** : « Pause » s'arrête après l'écriture en cours,
  « Reprendre » repart là où le moteur s'était arrêté ; « Arrêter » aussi.
- **Arrêter le serveur** : Ctrl+C, une fois, dans sa fenêtre ; Windows
  demande ensuite « Terminer le programme de commandes (O/N) ? » : le
  serveur est déjà arrêté, répondre O. La progression est retrouvée au
  démarrage suivant.
- **Sauvegarder** : bouton « Sauvegarder » (simulation arrêtée) ou
  `npm run backup` ; **restaurer** : `npm run restore -- <dossier>`,
  GeoPlacer arrêté ([guide](docs/fr/sauvegarde-restauration.md)).
- **Mettre à jour** : `git pull`, puis `start.bat` (ou
  `npm run setup:windows`).

### Dépannage courant

| Symptôme | Que faire |
|---|---|
| « ÉCHEC à l'étape … » pendant l'installation | Lire la ligne « Que faire », puis le journal `test-logs\<date>-setup.log` ; relancer ne casse rien |
| « Node.js est introuvable » | Installer Node.js 22 LTS depuis https://nodejs.org, puis rouvrir le terminal |
| La page ne s'ouvre pas | Utiliser l'adresse affichée « Server listening on … » (le port peut ne pas être 3000) |
| « already used by another GeoPlacer instance » | Un GeoPlacer tourne déjà sur ce dossier : utiliser celui-là, ou l'arrêter |
| « GeoPlacer cannot start on this data directory » | Une restauration a été interrompue : `npm run restore -- --resume` |
| « Démarrer » reste grisé | Aucun modèle sélectionné, ou la simulation tourne déjà |
| 403 dans le navigateur | Ouvrir `http://127.0.0.1:<port>` ou `http://localhost:<port>`, pas un autre nom |

Plus de détails : [problèmes connus](docs/fr/problemes-connus.md).

### Documentation (en français)

| Document | Contenu |
|---|---|
| [Guide de démonstration](docs/fr/demonstration.md) | Découvrir GeoPlacer en deux minutes |
| [Guide utilisateur](docs/fr/guide-utilisateur.md) | Tableau de bord, modèles, simulation, grands modèles |
| [Installation Windows](docs/fr/installation-windows.md) | Installation, `start.bat`, configuration, dépannage |
| [Sauvegarde et restauration](docs/fr/sauvegarde-restauration.md) | Sauvegarder, vérifier, restaurer, reprendre une restauration interrompue |
| [Sécurité et isolation](docs/fr/securite.md) | Protections du serveur local, neutralisation du code hérité |
| [Simulateur](docs/fr/simulateur.md) | Toile simulée locale |
| [Commandes](docs/fr/commandes.md) | Toutes les commandes |
| [Problèmes connus](docs/fr/problemes-connus.md) | Limites de la V1 |
| [Index complet](docs/fr/README.md) | Architecture, moteur, API, qualité, décisions |
| [MODIFICATIONS.md](MODIFICATIONS.md) | Historique des modifications apportées au projet d'origine (AGPL §5a) |

### Limites de la V1

- Simulation locale uniquement : aucune connexion automatisée à GeoPixels
  ou à Wplace.
- Un seul agent simulé actif.
- Vérifié sous Windows 10 (64 bits) ; Linux et macOS non vérifiés.
- Navigateurs : Edge vérifié de bout en bout ; Firefox vérifié avec la
  version fournie par Playwright (132), pas avec une version officielle
  installée.
- Reprise vérifiée après l'arrêt brutal du **processus** ; la tenue après
  une coupure de courant n'est pas garantie (non testée).
- Le code hérité de wplacer (comptes réels, ancien moteur, jetons, proxys)
  reste dans le dépôt pour la traçabilité, mais il est **désactivé** :
  routes refusées par le serveur, client réseau fermé.

<details>
<summary><b>README du projet d'origine (wplacer)</b> : fonctions héritées, <b>désactivées dans GeoPlacer V1</b></summary>

> Le texte ci-dessous est celui du projet d'origine, conservé pour
> l'attribution et l'historique. Les fonctions qu'il décrit (comptes,
> extension, jetons Turnstile, proxys, achats automatiques) ne sont **pas**
> disponibles dans GeoPlacer V1. Ne suivez pas ces instructions pour
> GeoPlacer.

A massively updated auto-drawing bot for [wplace.live](https://wplace.live/).

## Features

-   **Simple and easy-to-use web UI:** For managing users and templates with a modern React-based interface
-   **Advanced Multi-Account System:** Run templates with multiple users simultaneously. The system intelligently prioritizes users with the most charges available to maximize efficiency.
-   **Multiple Drawing Modes:** Choose from several drawing strategies (Top to Bottom, Bottom to Top, Left to Right, Right to Left, Center Out, Random) to optimize your approach for different templates
-   **Color-By-Color Drawing:** Alternative drawing strategy that paints all pixels of one color before moving to the next
-   **Automatic Upgrade Purchasing:** If enabled, the bot will automatically purchase max charge upgrades or extra charges when running out for your accounts whenever they have enough droplets
-   **Account Status Checker:** A tool in the "Manage Users" tab allows you to quickly check if your accounts' cookies are still valid with parallel status checks
-   **Advanced Template Controls:** Options such as restarting, replacing a template's image, or pausing on the fly make management more flexible as well as providing you with real time updates on the template's status
-   **Template Share Codes:** Import/export templates using share codes with RLE compression for easy sharing
-   **Automatic Captcha (Turnstile) Token Handling:** Turnstile handling with WebSocket support for real-time token requests and adaptive polling
-   **Desktop Notifications:** The program will now send a desktop notification when it needs a new Turnstile token, so you don't have to constantly check the console
-   **Proxy Support:** Configure proxies for each account with sequential or random rotation modes
-   **Graceful Shutdown:** Proper cleanup of resources and state persistence when stopping the server

## Installation and Usage

[Video Tutorial](https://www.youtube.com/watch?v=YR978U84LSY)

### Requirements

- Node.js >= 22.0.0
- NPM >= 10.0.0
- [Tampermonkey](https://www.tampermonkey.net/)
- [git](https://git-scm.com/downloads) (optional, but recommended)

### Installation

1. Download the repository using [git](https://git-scm.com/downloads) (`git clone https://github.com/luluwaffless/wplacer.git`) or download the ZIP directly from GitHub (not recommended).
2. In the terminal, navigate to the project directory and install the dependencies with `npm i`.
3. Install the extension on each browser window with an account you want to be used by wplacer and to automatically solve Turnstiles (CAPTCHAs) by going to the extensions page of your browser, turning on developer mode, pressing load unpacked, and then selecting the LOAD_UNPACKED folder included with wplacer.
   - If you'd like, you can change the host and port of the local server by changing the `.env` file.

### Usage

1. To start the bot, run `npm start` in the terminal.
2. Open the URL printed in the console (usually `http://127.0.0.1/`) in your browser.
3. In each browser window with the extension installed, log into your account on wplace.live. If your account does not show up in the manager after refreshing it, you can press on the extension to manually send it to wplacer.
4. Go to the "Add Template" page to create your drawing templates.
   - The coordinates (`Tile X/Y`, `Pixel X/Y`) are for the top-left corner of your image. You can find these by clicking a pixel on wplace.live and inspecting the `pixel` request in the Network tab of DevTools. You can also use the [Blue Marble](https://github.com/SwingTheVine/Wplace-BlueMarble) userscript (user TamperMonkey) to see a pixel's coordinates.
   - You can assign multiple users to a single template.
5. Finally, go to "Manage Templates" and click "Start" on any template to begin drawing.
   - The script will occasionally refresh one of the active bot windows on [wplace.live](https://wplace.live/). This is required to refresh the Turnstile token needed for painting.

### Development

For development, you can run the backend and frontend separately with hot-reload:

```bash
# Run both backend and frontend in development mode
npm run dev

# Or run them separately
npm run dev:backend  # Backend with node --watch (TypeScript loaded by tsx)
npm run dev:frontend # Frontend with Vite
```

Other useful commands:

```bash
npm run build        # Build TypeScript to dist/
npm run lint         # Run ESLint
npm run format       # Format code with Prettier
npm test             # Run tests
npm test:coverage    # Run tests with coverage
```

For detailed development documentation, see [docs/development.md](docs/development.md).

## FAQ and Common Errors
### Browser:
- **The best supported browser is Brave, which you can get here: <https://brave.com/download/>**
- Chrome works, but is not reccomended. (zero fingerprint protection - high ban chance)
- Firefox is not supported.
  
### How to get your JWT token:
Go to [wplace.live](<https://wplace.live>), login, click anywhere on the map, then press `Ctrl` + `Shift` + `i`, go to `Application`, find the `j` column, then copy the value inside

### How to install the extension:
Go to the manage extensions tab, enable Developer mode, then click load unpacked, select the `LOAD_UNPACKED` folder.
After that, make sure to click on the extension in wplace.live, and configure your port if you changed it in `.env`

### How to run the bot:
1. Simply open `start.bat`.
2. Open a command prompt in the wplacer folder. You can type `cmd` in the address bar in the file explorer to do this. Run `npm i` in the command prompt, then after run `npm start`.
  - If you get any errors while running `npm i`, run this: `Set-ExecutionPolicy -Scope CurrentUser Bypass` then you can run `npm i`

### How to add proxies:
You need to find your own proxy provider, and once you do you must follow this format: `protocol://ip:port` or `protocol://user:pass:ip:port`
Example: `socks5://127.0.0.1:9050`
Example: `socks5://user:admin:127.0.0.1:9050`

### Why is it stuck on waiting for a token?
You must have at least one tab open to [wplace](<https://wplace.live>). You need a macro or something else that will automatically click the turnstile checkboxes.

### I keep getting error 500:
Two things will cause this, [wplace.live](<https://wplace.live>) being down, or your token is expired.
- To check if wplace is down, go here: <https://status.wplace.lol/>
- If its up, re-add your token by doing the first step.
- If NEITHER are an issue, then its probably something in the code is wrong. Open an issue or tell them in the support server and it should be fixed in future updates.

### ERR_MODULE_NOT_FOUND:
One of your modules are missing. To install them, simply use `npm i`.

**We will NOT provide support for other forks of this project. Ask the respective developers.**

## Notes

> [!CAUTION]
> This bot is not affiliated with [wplace.live](https://wplace.live/) and its use may be against the site's rules. The developers are not responsible for any punishments against your accounts. Use at your own risk.

### Recent Improvements (v5.6.2)

- **Backend Refactoring:** Server now uses structured state management with graceful shutdown
- **Token Manager:** Complete rewrite with thread-safe locking, validation, and promise cleanup
- **Template Manager:** Dependency injection context for better testability
- **Extension:** Reduced from 1176 to 616 lines (47% reduction) with modular content scripts
- **Security:** TLS verification enabled, excessive browser permissions removed
- **Performance:** Parallel user status checks, adaptive polling, WebSocket support
- **Frontend:** Secure cookie inputs, better settings organization, type safety improvements

### Documentation

For more detailed information, see:

- [Architecture Documentation](docs/architecture.md) - System design and component overview
- [API Documentation](docs/api.md) - API endpoints and usage
- [Development Guide](docs/development.md) - Development setup and contribution
- [Contributing Guidelines](docs/CONTRIBUTING.md) - How to contribute
- [Codebase Review](docs/codebase-review.md) - Detailed code analysis

### Completed Features
- [x] Proxy support
- [x] Add support for paid colors
- [x] Support for painting between multiple tiles
- [x] Easier multi-account support for one template
- [x] Queueing system for multi-accounts
- [x] Template share codes with RLE compression
- [x] WebSocket support for real-time token requests
- [x] Graceful shutdown with state persistence

</details>

### Credits

**Original Creators:**
-   [Jinx](https://github.com/JinxTheCatto)
-   [Lulu](https://github.com/luluwaffless)

**Current Maintainer:**
-   [Arknight](https://github.com/Arknight38) [(Donate here to help us develop the project)](https://ko-fi.com/ark38)

**Original Repository:** https://github.com/luluwaffless/wplacer

And to our amazing contributors!
<p align="center"><img src="https://contrib.rocks/image?repo=wplacer/wplacer"></p>

### License

[GNU AGPL v3](LICENSE)
