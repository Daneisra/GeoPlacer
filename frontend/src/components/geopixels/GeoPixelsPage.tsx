import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui';
import { engineHttp } from '../../lib/engine';
import { MAX_GHOST_COLORS, exportUrl, imageColors, parsePaletteText, type GhostInfo } from '../../lib/geopixels';
import { useCommand } from '../simulation/useCommand';

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
  const [paletteText, setPaletteText] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [alpha, setAlpha] = useState('128');
  const [zoom, setZoom] = useState(4);
  const [fileColors, setFileColors] = useState<string[] | null | undefined>(undefined);

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

  const palette = parsePaletteText(paletteText);
  const current = ghosts.find((g) => g.templateId === selected) ?? null;

  const chooseFile = (f: File | null) => {
    setFile(f);
    setFileColors(undefined);
    if (f !== null) {
      if (name.trim() === '') setName(f.name.replace(/\.png$/i, ''));
      void imageColors(f).then(
        (colors) => setFileColors(colors),
        () => setFileColors(null)
      );
    }
  };

  const importGhost = () =>
    run(
      'Préparation de l’image fantôme',
      async () => {
        if (file === null) throw new Error('no file');
        const body = {
          name: name.trim() || file.name.replace(/\.png$/i, ''),
          pngBase64: await toBase64(file),
          palette: palette.colors,
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

  const canImport = file !== null && palette.colors.length > 0 && palette.colors.length <= MAX_GHOST_COLORS && palette.invalid.length === 0 && pending === null;
  return (
    <div className="space-y-4" id="geopixelsPage">
      <div className="rounded-md border border-sky-700 bg-sky-950/40 px-4 py-2 text-sm">
        <b>Préparer une image fantôme pour GeoPixels</b> : GeoPlacer convertit votre image avec <b>vos</b> couleurs et produit un PNG standard. Vous l’importez
        ensuite <b>vous-même</b> dans l’outil « image fantôme » de GeoPixels et vous placez les pixels à la main. GeoPlacer ne se connecte jamais à GeoPixels.
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
            <span className="text-muted-foreground">
              Vos couleurs GeoPixels (codes hexadécimaux, par exemple <code>#ff0000</code>, séparés par des espaces ou des lignes ; {MAX_GHOST_COLORS} au plus)
            </span>
            <textarea id="ghostPalette" className={`${field} h-24 font-mono`} value={paletteText} onChange={(e) => setPaletteText(e.target.value)} />
          </label>
          <div className="text-muted-foreground md:col-span-2" id="ghostPaletteState">
            {palette.colors.length} couleur(s) valide(s)
            {palette.invalid.length > 0 ? ` ; non reconnues : ${palette.invalid.slice(0, 5).join(', ')}` : ''}
            {palette.colors.length > MAX_GHOST_COLORS ? ` ; trop de couleurs (${MAX_GHOST_COLORS} au plus)` : ''}
            {fileColors !== undefined && fileColors !== null && (
              <Button size="sm" variant="secondary" className="ml-3" id="ghostUseImageColors" onClick={() => setPaletteText(fileColors.join('\n'))}>
                Reprendre les {fileColors.length} couleurs de l’image
              </Button>
            )}
            {fileColors === null && ' ; l’image a plus de 256 couleurs : saisissez vos couleurs.'}
          </div>
          <div className="flex flex-wrap gap-3 md:col-span-2">
            {palette.colors.slice(0, 64).map((c) => (
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
                <div>
                  Pixels à placer : <b>{current.paintablePixels.toLocaleString('fr-FR')}</b> ; transparents : {current.transparentPixels.toLocaleString('fr-FR')}
                </div>
                <div>
                  Coin haut-gauche saisi : <b>({current.topLeft.x}, {current.topLeft.y})</b> (non converti)
                </div>
                <div>
                  Fichier : <code>{current.filename}</code>
                </div>
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
            Non vérifié par GeoPlacer (GeoPixels ne le documente pas) : formats et taille maximale acceptés, orientation, rendu exact des couleurs et de la
            transparence dans l’outil. Vérifiez sur une petite image d’abord (voir le guide <code>docs/fr/geopixels.md</code>). Conditions d’utilisation de
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
