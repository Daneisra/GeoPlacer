import { colorHex, PUBLIC_BASE_COLORS, type AccountPalette } from '../../lib/account-palette';
import { COMMUNITY_GEOPIXELS_PALETTE } from '../../lib/ghost-palettes';

function Swatches({ label, colors }: { label: string; colors: readonly string[] }) {
  return <div className="space-y-1">
    <p>{label} ({colors.length})</p>
    {colors.length > 0 && <ul className="flex flex-wrap gap-1.5" aria-label={label}>
      {colors.map(hex => <li key={hex} aria-label={hex.toUpperCase()} title={hex.toUpperCase()}
        className="size-5 rounded-sm border border-white/30" style={{ backgroundColor: hex }} />)}
    </ul>}
  </div>;
}

export function AccountPaletteStatus({ sample, manual = false, details = false }: {
  sample?: AccountPalette | null;
  manual?: boolean;
  details?: boolean;
}) {
  const fresh = sample?.state === 'fresh';
  const colors = fresh ? sample.colors.map(colorHex) : [];
  const stamp = sample?.capturedAt == null ? null : new Date(sample.capturedAt);
  const source = manual || !colors.length ? 'Palette locale' : 'Compte GeoPixels';
  return <div className="space-y-2 text-sm">
    <p><strong>Source de préparation</strong> · {source}.</p>
    <p className="text-muted-foreground">{fresh ? <>{colors.length} couleurs disponibles sur le compte.</>
      : sample?.state === 'stale' ? 'Palette du compte périmée. Disponibilité actuelle inconnue.' : 'Palette du compte en attente d’une observation native.'}
        {stamp && <> Dernière synchronisation à <time dateTime={stamp.toISOString()}>{stamp.toLocaleString('fr-FR')}</time>.</>}
    </p>
    {details && fresh && <details className="drawing-option-advanced">
      <summary>Couleurs du compte</summary>
      <div className="space-y-2">
        <Swatches label="Base gratuite du client, disponible sur le compte" colors={colors.filter(hex => PUBLIC_BASE_COLORS.has(hex))} />
        <Swatches label="Couleurs supplémentaires disponibles" colors={colors.filter(hex => !PUBLIC_BASE_COLORS.has(hex))} />
        <Swatches label="Couleurs du préréglage communautaire indisponibles sur le compte"
          colors={COMMUNITY_GEOPIXELS_PALETTE.filter(hex => !colors.includes(hex))} />
        <p className="text-muted-foreground">Source native · {sample.source === 'native-worker-response' ? 'synchronisation de la carte' : 'réponse de profil'}. L’origine des couleurs supplémentaires n’est pas précisée par la liste du compte.</p>
      </div>
    </details>}
  </div>;
}
