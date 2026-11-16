# Changelog

GeoPlacer changes are listed first; the inherited wplacer history is preserved below.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [6.0.0-rc.1] - non publiée (version candidate de GeoPlacer)

Première version candidate de **GeoPlacer**, fork de wplacer : un environnement de
**simulation locale** (aucune connexion à GeoPixels ni à Wplace). Version majeure :
les fonctions de wplacer (comptes, extension, ancien moteur, proxys) sont désactivées.
Entrée rédigée en français, comme la documentation de GeoPlacer.

### Ajouté

- Préparation locale et export PNG pour import manuel dans GeoPixels, redimensionnement
  et même quantification OKLab que les modèles simulés.
- Palette fournie de 28 couleurs, palette communautaire de 30 couleurs (Lospec/Manako),
  saisie personnalisée conservée et couleurs originales de l’image.
- Validation des codes, doublons, nombre de couleurs, pastilles/copie et statistiques
  séparant surface, pixels retenus, transparence et couleurs inutilisées.
- Identité visible GeoPlacer avec monogramme provisoire GP ; crédits Wplacer/AGPL conservés.
- Validation utilisateur PNG 595 × 894 et Ctrl+C Windows du 16 novembre 2026,
  documentée avec ses limites ; tests locaux supplémentaires et archive consolidée.

- Nouveau moteur mono-agent sur toile simulée durable : modèles et révisions, huit stratégies,
  progression et ETA, ressources et améliorations simulées, journal des tentatives, reprise.
- Serveur `/api/v1`, WebSocket et tableau de bord en français ; démonstration intégrée.
- Installation Windows en une commande (`npm run setup:windows`, `setup.bat`, `start.bat`).
- Sauvegarde et restauration vérifiées.
- Grands modèles (jusqu'à 4096²) ; serveur réactif pendant le calcul (ordonnanceur coopératif).

### Modifié

- Sécurité du serveur local : écoute locale, contrôles Host et Origin, limiteur, validation.

### Retiré (désactivé)

- Routes de comptes réels, ancien moteur de dessin, jetons anti-bot, pont de l'extension,
  proxys et keep-alive : refusés par le serveur (410 `LEGACY_DISABLED`).

Détail : `MODIFICATIONS.md` et `docs/fr/`.

---

## [5.6.2] - 2026-04-19

### Added

- Template share codes with RLE compression for easy template sharing
- WebSocket support for real-time token requests
- Graceful shutdown with state persistence
- Parallel user status checks for improved performance
- Adaptive polling in extension (30s active, 2min idle)
- Dependency injection context in TemplateManager
- HTTP client injection in WPlacer client for better testability
- Cancellable sleep operations for responsive settings updates
- Token wait tracking and auto-reload logic
- Proxy logging option
- Comprehensive API documentation
- Architecture documentation
- Development guide
- Contributing guidelines

### Changed

- Backend refactoring with structured server state management
- Server now uses `serverState` object instead of scattered global variables
- Template manager methods extracted into smaller, focused functions
- Extension background script reduced from 1176 to 616 lines (47% reduction)
- Content script modularized into 6 separate modules
- Frontend settings component better organized with collapsible sections
- Settings state now uses proper number types instead of strings
- Cookie inputs now use password type for security
- Validation settings schema now includes all 13 fields with proper validation
- Token manager completely rewritten with thread-safe locking
- Error classification implemented in routes/users.ts
- Retry logic with exponential backoff for transient errors
- Manifest version synchronized with package.json (5.6.2)

### Fixed

- Critical security issue: TLS verification now always enabled (was disabled)
- Extension excessive permissions removed (browsingData, scripting)
- Duplicate MS constant definitions removed from helpers.ts
- Polling inefficiency in ManageTemplates - now adaptive (10s active, 30s idle)
- Type coercion issues in Settings component
- Graceful shutdown implementation
- Keep-alive logic with cached WPlacer import
- Hardcoded constants in server.ts now use config/environment variables

### Security

- TLS verification enabled in HTTP client (critical security fix)
- Excessive browser permissions removed from extension manifest
- Cookie inputs now use password type in frontend
- Minimal required permissions: storage, cookies, alarms, tabs

### Performance

- Parallel user status checks with Promise.all()
- Adaptive polling in extension reduces unnecessary requests
- Charge prediction reduces API calls
- Token promise cleanup prevents memory leaks
- Extension code size reduced by 47%

### Documentation

- Added comprehensive architecture documentation
- Added API documentation with all endpoints
- Added development guide with setup instructions
- Added contributing guidelines
- Updated README with recent improvements
- Added documentation links in README

---

## [5.6.1] - 2026-03-XX

### Added

- Proxy support with sequential and random rotation modes
- Color-by-color drawing mode
- Template progress tracking
- Desktop notifications for token requests

### Fixed

- Token queue management
- User status check reliability
- Template execution stability

---

## [5.6.0] - 2026-02-XX

### Added

- Multi-account support for templates
- Queueing system for multi-account execution
- Advanced template controls (restart, replace, pause)
- Account status checker
- Automatic upgrade purchasing

### Changed

- Improved user management UI
- Enhanced template creation workflow

---

## [5.5.0] - 2026-01-XX

### Added

- Initial version of wplacer bot
- Basic template management
- User account management
- Turnstile token handling
- Browser extension for automation

---

## Version History

| Version | Date | Major Changes |
|---------|------|---------------|
| 5.6.2 | 2026-04-19 | Major refactoring, security fixes, documentation |
| 5.6.1 | 2026-03-XX | Proxy support, performance improvements |
| 5.6.0 | 2026-02-XX | Multi-account support, queueing system |
| 5.5.0 | 2026-01-XX | Initial release |

---

## Categories

- **Added** - New features
- **Changed** - Changes in existing functionality
- **Deprecated** - Soon-to-be removed features
- **Removed** - Removed features
- **Fixed** - Bug fixes
- **Security** - Security vulnerability fixes
- **Performance** - Performance improvements
- **Documentation** - Documentation changes

---

## Future Plans

### Planned for 5.7.0

- Complete dependency injection migration
- State management pattern for extension
- Remove remaining `any` types
- Add comprehensive test suite (50% coverage target)
- WebSocket for frontend real-time updates
- Caching layer for API calls
- Parallel pixel checking in template-manager

### Under Consideration

- Settings presets for common configurations
- Code splitting for frontend
- Pre-commit hooks
- Debug mode
- Development tools

---

## Links

- [GitHub Repository](https://github.com/luluwaffless/wplacer)
- [Issues](https://github.com/luluwaffless/wplacer/issues)
- [Discord Server](https://discord.gg/wplacerbot)

## Phase 2A — travail local non publié (16 novembre 2026)

Fournisseur navigateur expérimental, couplage local à capacités limitées, observations
partielles et datées, raccordement au scheduler existant, journal séparé et reprise,
politiques d'améliorations sur données factices, dashboard et recettes Edge/Firefox.
Aucun placement ni achat réel. Voir [le rapport](fr/RAPPORT-PHASE2A.md).
L'archive et la version RC consolidées restent distinctes de cette branche expérimentale.
