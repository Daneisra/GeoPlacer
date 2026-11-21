import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui';
import { engineHttp } from '../../lib/engine';
import { MAX_GHOST_COLORS, exportUrl, imageColors, parsePaletteText, type GhostInfo } from '../../lib/geopixels';
import { loadPalettePreferences, paletteTextFor, savePalettePreferences, type PaletteMode } from '../../lib/ghost-palettes';
import { accountColors, type AccountPalette } from '../../lib/account-palette';
import { useCommand } from '../simulation/useCommand';
import { AccountPaletteStatus } from './AccountPaletteStatus';

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

const field = 'w-full rounded-md border bg-background px-2 py-1 text-sm';
const optionalInt = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));
const readAccountPalette = (signal?: AbortSignal) => engineHttp.get<AccountPalette>('/connector/palette', { signal }).then(r => r.data, () => null);
/** A light checkerboard behind the preview: the transparent pixels stay visible as such. */
const checkerboard = {
  backgroundImage: 'linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
  backgroundColor: '#fff',
};

/**
 * Phase 1C.1: prepare a ghost image for GeoPixels. The PNG is made here, locally, then imported by
 * the user in the native ghost image tool of GeoPixels. GeoPlacer never contacts GeoPixels.
 */
export function GeoPixelsPage() {
  const { pending, run } = useCommand();
  const [ghosts, setGhosts] = useState<GhostInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [palettePreferences, setPalettePreferences] = useState(() => loadPalettePreferences({ getItem: (key) => window.localStorage.getItem(key) }));
  const [accountPalette, setAccountPalette] = useState<AccountPalette | null>(null);
  const useAccount = palettePreferences.mode === 'account';
  const [copyMessage, setCopyMessage] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [alpha, setAlpha] = useState('128');
  const [zoom, setZoom] = useState(4);
  const [analysis, setAnalysis] = useState<{ file: File; alpha: number; colors: string[] | null; error?: string } | null>(null);
  const alphaValue = Number(alpha);
  const alphaValid = alpha.trim() !== '' && Number.isInteger(alphaValue) && alphaValue >= 0 && alphaValue <= 256;
  const fileColors = analysis?.file === file && analysis?.alpha === alphaValue ? analysis.colors : undefined;
  useEffect(() => {
    savePalettePreferences({ setItem: (key, value) => window.localStorage.setItem(key, value) }, palettePreferences);
  }, [palettePreferences]);
  useEffect(() => {
    if (!useAccount) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refreshAccount() {
      const sample = await readAccountPalette(abort.signal);
      if (abort.signal.aborted) return;
      setAccountPalette(sample);
      timer = setTimeout(refreshAccount, 5000);
    }
    void refreshAccount();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [useAccount]);
  useEffect(() => {
    if (file === null || !alphaValid) return;
    let cancelled = false;
    void imageColors(file, alphaValue).then(
      (colors) => { if (!cancelled) setAnalysis({ file, alpha: alphaValue, colors }); },
      () => { if (!cancelled) setAnalysis({ file, alpha: alphaValue, colors: null, error: 'Impossible de lire les couleurs de cette image.' }); }
    );
    return () => { cancelled = true; };
  }, [file, alphaValid, alphaValue]);

  const refresh = useCallback(
    (): Promise<void> =>
      engineHttp.get<{ templates: GhostInfo[] }>('/geopixels/templates').then(
        (r) => {
          setGhosts(r.data.templates);
          setSelected((s) => (s !== null && r.data.templates.some((g) => g.templateId === s) ? s : (r.data.templates[0]?.templateId ?? null)));
        },
        () => undefined
      ),
    []
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fallbackPalette = paletteTextFor(palettePreferences, fileColors);
  const paletteText = (useAccount ? accountColors(accountPalette).join('\n') : '') || fallbackPalette;
  const palette = parsePaletteText(paletteText);
  const current = ghosts.find((g) => g.templateId === selected) ?? null;
  const usedColors = new Set(current?.colors.map((c) => c.hex));
  const unusedColors = current?.palette.filter((hex) => !usedColors.has(hex)) ?? [];

  const chooseFile = (f: File | null) => {
    setFile(f);
    setAnalysis(null);
    if (f !== null) {
      if (name.trim() === '') setName(f.name.replace(/\.png$/i, ''));
    }
  };

  const importGhost = () =>
    run(
      'Préparation de l’image fantôme',
      async () => {
        if (file === null) throw new Error('no file');
        const pngBase64 = await toBase64(file);
        const synchronized = useAccount ? accountColors(await readAccountPalette()) : [];
        const fallback = parsePaletteText(fallbackPalette);
        if (useAccount && !synchronized.length && fallback.invalid.length)
          throw new Error('Palette du compte indisponible. Corrigez les codes de la palette personnalisée de secours.');
        const body = {
          name: name.trim() || file.name.replace(/\.png$/i, ''),
          pngBase64,
          palette: synchronized.length ? synchronized : fallback.colors,
          ...(optionalInt(width) === undefined ? {} : { width: optionalInt(width) }),
          ...(optionalInt(height) === undefined ? {} : { height: optionalInt(height) }),
          ...(optionalInt(x) === undefined ? {} : { x: optionalInt(x) }),
          ...(optionalInt(y) === undefined ? {} : { y: optionalInt(y) }),
          ...(optionalInt(alpha) === undefined ? {} : { alphaThreshold: optionalInt(alpha) }),
        };
        const r = await engineHttp.post<GhostInfo>('/geopixels/templates', body);
        await refresh();
        setSelected(r.data.templateId);
      },
      'Image prête : vérifiez l’aperçu, puis téléchargez le PNG.'
    );

  const remove = (g: GhostInfo) => {
    if (!window.confirm(`Supprimer « ${g.name} » de GeoPlacer ? (Rien n’est modifié sur GeoPixels.)`)) return;
    void run('Suppression', async () => {
      await engineHttp.delete(`/geopixels/templates/${g.templateId}`, { data: {} });
      await refresh();
    });
  };

  const copyPalette = async () => {
    try {
      await navigator.clipboard.writeText(palette.colors.join('\n'));
      setCopyMessage('Palette copiée.');
    } catch { setCopyMessage('Copie indisponible : sélectionnez les codes dans le champ ci-dessous.'); }
  };
  const canImport = file !== null && alphaValid && palette.colors.length > 0 && palette.colors.length <= MAX_GHOST_COLORS && palette.invalid.length === 0 && pending === null;
  return (
    <div className="space-y-4" id="geopixelsPage">
      <div className="rounded-md border border-sky-700 bg-sky-950/40 px-4 py-2 text-sm">
        <b>Préparer une image fantôme pour GeoPixels</b> : GeoPlacer convertit votre image avec <b>vos</b> couleurs et produit un PNG standard. Vous l’importez
        ensuite <b>vous-même</b> dans l’outil « image fantôme » de GeoPixels. La préparation se fait dans GeoPlacer.
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">1. Image et couleurs</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-muted-foreground">Image PNG</span>
            <input id="ghostFile" type="file" accept="image/png" className={field} onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Nom</span>
            <input id="ghostName" className={field} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="space-y-1 md:col-span-2">
            <span>Palette de couleurs</span>
            <select id="ghostPaletteMode" className={field} value={palettePreferences.mode} onChange={(e) => {
              setCopyMessage('');
              setPalettePreferences((p) => ({ ...p, mode: e.target.value as PaletteMode }));
            }}>
              <option value="personal28">Ma palette GeoPixels (28 couleurs)</option>
              <option value="community30">Palette communautaire GeoPixels (30 couleurs)</option>
              <option value="custom">Palette personnalisée</option>
              <option value="image">Couleurs originales de l’image</option>
              <option value="account">Palette synchronisée du compte</option>
            </select>
          </label>
          {!useAccount && <p className="text-muted-foreground md:col-span-2" id="ghostPaletteProvenance">
            {palettePreferences.mode === 'personal28' && 'Liste de 28 couleurs fournie par l’utilisateur, dans son ordre original.'}
            {palettePreferences.mode === 'community30' && <>Liste communautaire de Manako sur <a className="underline" href="https://lospec.com/palette-list/geopixels-free-colors" target="_blank" rel="noopener noreferrer">Lospec</a>, consultée le 16 novembre 2026.</>}
            {palettePreferences.mode === 'custom' && 'Votre liste reste conservée lorsque vous sélectionnez un autre préréglage.'}
            {palettePreferences.mode === 'image' && 'Couleurs des pixels retenus selon le seuil de transparence, sans réduction préalable (256 au plus).'}
            {' '}Les palettes locales servent à préparer le PNG. La disponibilité des couleurs dépend du compte.
          </p>}
          {useAccount && <div className="md:col-span-2 space-y-2">
            <AccountPaletteStatus sample={accountPalette} details />
            <p className="text-muted-foreground">En secours, GeoPlacer utilise votre palette personnalisée si elle est renseignée, ou le préréglage de 28 couleurs.</p>
          </div>}
          <label className="space-y-1 md:col-span-2">
            <span className="text-muted-foreground">
              Codes hexadécimaux à six chiffres, par exemple <code>#ff0000</code>, séparés par des espaces, virgules ou lignes ; {MAX_GHOST_COLORS} couleurs au plus
            </span>
            <textarea id="ghostPalette" className={`${field} h-24 font-mono`} value={paletteText} readOnly={palettePreferences.mode !== 'custom'} onChange={(e) => setPalettePreferences((p) => ({ ...p, mode: 'custom', customText: e.target.value }))} />
          </label>
          <div className="text-muted-foreground md:col-span-2" id="ghostPaletteState" role="status">
            {palette.colors.length} couleur(s) valide(s)
            {palette.invalid.length > 0 ? ` ; codes invalides : ${palette.invalid.slice(0, 5).join(', ')} — attendu : #RRGGBB (six chiffres hexadécimaux)` : ''}
            {palette.duplicates.length > 0 ? ` ; doublons ignorés : ${palette.duplicates.join(', ')}` : ''}
            {palette.colors.length > MAX_GHOST_COLORS ? ` ; trop de couleurs (${MAX_GHOST_COLORS} au plus)` : ''}
            {palette.colors.length === 0 && ' ; une palette non vide est nécessaire pour préparer l’image.'}
            {fileColors !== undefined && fileColors !== null && (
              <Button size="sm" variant="secondary" className="ml-3" id="ghostUseImageColors" onClick={() => setPalettePreferences((p) => ({ ...p, mode: 'image' }))}>
                Reprendre les {fileColors.length} couleurs de l’image
              </Button>
            )}
            {fileColors === null && (analysis?.error ?? ' ; l’image a plus de 256 couleurs : choisissez un préréglage ou une palette personnalisée.')}
            {palettePreferences.mode === 'image' && fileColors === undefined && ' ; choisissez une image et un seuil valide, puis attendez son analyse.'}
            {!alphaValid && ' ; seuil invalide : indiquez un entier entre 0 et 256.'}
          </div>
          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <Button id="ghostCopyPalette" size="sm" variant="secondary" disabled={palette.colors.length === 0 || palette.invalid.length > 0} onClick={() => void copyPalette()}>Copier la palette</Button>
            <span role="status">{copyMessage}</span>
          </div>
          <div className="flex flex-wrap gap-3 md:col-span-2">
            {palette.colors.slice(0, MAX_GHOST_COLORS).map((c) => (
              <span key={c} title={c} className="inline-block h-4 w-4 rounded-sm border" style={{ backgroundColor: c }} />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">2. Dimensions et placement</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-5">
          <label className="space-y-1">
            <span className="text-muted-foreground">Largeur (vide : celle de l’image)</span>
            <input id="ghostWidth" className={field} inputMode="numeric" value={width} onChange={(e) => setWidth(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Hauteur (vide : proportionnelle)</span>
            <input id="ghostHeight" className={field} inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Seuil de transparence (0-256)</span>
            <input id="ghostAlpha" className={field} inputMode="numeric" value={alpha} onChange={(e) => setAlpha(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">X du coin haut-gauche (GeoPixels)</span>
            <input id="ghostX" className={field} inputMode="numeric" value={x} onChange={(e) => setX(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Y du coin haut-gauche (GeoPixels)</span>
            <input id="ghostY" className={field} inputMode="numeric" value={y} onChange={(e) => setY(e.target.value)} />
          </label>
          <p className="text-muted-foreground md:col-span-5">
            Les coordonnées sont un aide-mémoire : elles sont gardées telles que vous les saisissez (aucune conversion) et reprises dans le nom du fichier. Le
            placement se fait dans GeoPixels avec « Place on Map ».
          </p>
          <div className="md:col-span-5">
            <p className="mb-2 text-muted-foreground">La palette choisie s’applique à la prochaine préparation. Un modèle déjà enregistré conserve ses couleurs ; son export reste identique.</p>
            <Button id="ghostImport" onClick={() => void importGhost()} disabled={!canImport}>
              Préparer l’image
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">3. Aperçu et export</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {ghosts.length === 0 ? (
            <p className="text-muted-foreground">Aucune image préparée.</p>
          ) : (
            <label className="space-y-1">
              <span className="text-muted-foreground">Image préparée</span>
              <select id="ghostList" className={field} value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
                {ghosts.map((g) => (
                  <option key={g.templateId} value={g.templateId}>
                    {g.name} ({g.width} × {g.height})
                  </option>
                ))}
              </select>
            </label>
          )}
          {current !== null && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Zoom :</span>
                {[1, 2, 4, 8, 16].map((z) => (
                  <Button key={z} size="sm" variant={z === zoom ? 'default' : 'secondary'} onClick={() => setZoom(z)}>
                    ×{z}
                  </Button>
                ))}
              </div>
              <div className="max-h-[520px] overflow-auto rounded-md border" style={checkerboard}>
                <img
                  id="ghostPreview"
                  src={exportUrl(current)}
                  alt={`Aperçu de ${current.name}`}
                  width={current.width * zoom}
                  height={current.height * zoom}
                  style={{ imageRendering: 'pixelated', maxWidth: 'none' }}
                />
              </div>
              <div id="ghostInfo" className="grid gap-1 md:grid-cols-2">
                <div>
                  Dimensions : <b>{current.width} × {current.height}</b> pixels
                </div>
                <div>Surface totale : <b>{current.totalPixels.toLocaleString('fr-FR')}</b> pixels (transparence incluse)</div>
                <div>
                  Pixels opaques retenus : <b>{current.retainedPixels.toLocaleString('fr-FR')}</b> ; transparents : {current.transparentPixels.toLocaleString('fr-FR')}
                </div>
                <div>
                  Coin haut-gauche saisi : <b>({current.topLeft.x}, {current.topLeft.y})</b> (non converti)
                </div>
                <div>
                  Fichier : <code>{current.filename}</code>
                </div>
              </div>
              <p className="text-muted-foreground">Le nombre retenu applique le filtre de transparence, sans comparaison avec la carte réelle. Le compteur de GeoPixels peut inclure toute la surface.</p>
              <div id="ghostUnusedColors" className="space-y-1">
                <div className="text-muted-foreground">Palette enregistrée : {current.palette.length} couleurs ; inutilisées après conversion : {unusedColors.length}</div>
                <div className="flex flex-wrap gap-2">{unusedColors.map((hex) => <span key={hex} className="inline-flex items-center gap-1 rounded border px-1 font-mono text-xs"><span className="inline-block h-3 w-3 rounded-sm border" style={{ backgroundColor: hex }} />{hex}</span>)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Couleurs utilisées ({current.colors.length}) :</div>
                <div className="mt-1 flex flex-wrap gap-2" id="ghostColors">
                  {current.colors.map((c) => (
                    <span key={c.hex} className="inline-flex items-center gap-1 rounded border px-1 font-mono text-xs">
                      <span className="inline-block h-3 w-3 rounded-sm border" style={{ backgroundColor: c.hex }} />
                      {c.hex} × {c.pixels.toLocaleString('fr-FR')}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <a id="ghostDownload" href={exportUrl(current)} download={current.filename} className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">
                  Télécharger le PNG
                </a>
                <Button id="ghostDelete" variant="secondary" onClick={() => remove(current)} disabled={pending !== null}>
                  Supprimer de GeoPlacer
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">4. Utiliser l’image dans GeoPixels (à faire vous-même)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm" id="ghostGuide">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Ouvrez{' '}
              <a href="https://geopixels.net/" target="_blank" rel="noopener noreferrer" className="underline">
                geopixels.net
              </a>{' '}
              dans votre navigateur et connectez-vous normalement (GeoPlacer ne demande jamais vos identifiants).
            </li>
            <li>Ouvrez l’outil d’image fantôme (icône 👁) puis « Upload Image » et choisissez le PNG téléchargé.</li>
            <li>« Place on Map » : placez l’image (le coin haut-gauche noté ci-dessus est un repère pour vous).</li>
            <li>Facultatif : « Match My Palette » ou « Set Palette » dans GeoPixels, si vos couleurs ont changé.</li>
            <li>Placez les pixels vous-même. Toute automatisation est interdite par les conditions de GeoPixels.</li>
          </ol>
          <p className="text-muted-foreground">
            Validation utilisateur le 16 novembre 2026 : PNG de 595 × 894 accepté dans l’outil natif, positionnement réussi, sans inversion évidente. Cela ne
            certifie pas toutes les dimensions, palettes ou transparences. Vérifiez votre aperçu avant l’import manuel. Conditions d’utilisation de
            GeoPixels (version du 2 septembre 2026) :{' '}
            <a href="https://www.geopixels.net/TOS.html" target="_blank" rel="noopener noreferrer" className="underline">
              TOS
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
