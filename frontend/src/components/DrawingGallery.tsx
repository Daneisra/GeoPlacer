import { ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { STRATEGY_LABELS, type TemplateInfo } from '../lib/engine';

export type DrawingInfo = TemplateInfo & {
    lastObservation?: { capturedAt: number; total: number; correct: number; incorrect: number; unknown: number } | null;
    receipts?: { real: number; fake: number };
};
const number = (value: number) => value.toLocaleString('fr-FR');

export function DrawingGallery({
    templates,
    selected,
    pending,
    disabled,
    onSelect,
    onResume,
    onRemove,
}: {
    templates: DrawingInfo[] | null;
    selected?: string;
    pending: boolean;
    disabled: boolean;
    onSelect: (id: string) => void;
    onResume?: (id: string) => void;
    onRemove?: (id: string, confirmName: string) => void;
}) {
    const [removal, setRemoval] = useState<{ id: string; name: string } | null>(null);
    if (templates === null) return <p role="status">Chargement de la galerie…</p>;
    if (templates.length === 0)
        return (
            <div className="studio-empty">
                <ImageIcon aria-hidden="true" />
                <h2>Aucun dessin enregistré</h2>
                <p>Importez un PNG pour l’ajouter à votre galerie.</p>
            </div>
        );
    return (
        <div className="studio-gallery">
            {templates.map((t) => (
                <article key={t.templateId} className="studio-tile" data-selected={selected === t.templateId}>
                    <div className="studio-image-stage">
                        <img
                            src={`/api/v1/connector/drawing/${encodeURIComponent(t.templateId)}/image?rev=${t.revision}&thumbnail=1`}
                            loading="lazy"
                            alt={`Aperçu de ${t.name}`}
                        />
                    </div>
                    <div className="studio-tile-body">
                        <h2>{t.name}</h2>
                        <p>
                            {t.width} × {t.height} px · {STRATEGY_LABELS[t.strategy] ?? t.strategy}
                        </p>
                        {t.lastObservation && <div className="space-y-1">
                            <p>{number(t.lastObservation.correct)} conformes · {number(t.lastObservation.incorrect)} à corriger · {number(t.lastObservation.unknown)} inconnues</p>
                            <p className="text-muted-foreground">Capture conservée du {new Date(t.lastObservation.capturedAt).toLocaleString('fr-FR')}</p>
                        </div>}
                        {!!t.receipts?.real && <p>{number(t.receipts.real)} cibles acquittées dans le journal GeoPixels</p>}
                        {!!t.receipts?.fake && <p>{number(t.receipts.fake)} cibles acquittées sur le fournisseur factice</p>}
                        <div className="flex flex-wrap items-center gap-2">
                        {selected === t.templateId ? (
                            <Link className="studio-link" to="/">
                                Ouvrir le dessin actif
                            </Link>
                        ) : (
                            <button disabled={disabled || pending} onClick={() => onSelect(t.templateId)}>
                                Sélectionner
                            </button>
                        )}
                        {onResume && selected !== t.templateId && (t.lastObservation || t.receipts?.real || t.receipts?.fake) ? (
                            <button disabled={disabled || pending} onClick={() => onResume(t.templateId)}>Préparer la reprise</button>
                        ) : null}
                        {onRemove && <button disabled={disabled || pending} onClick={() => setRemoval({ id: t.templateId, name: '' })}>Retirer</button>}
                        </div>
                        {onRemove && removal?.id === t.templateId && (
                            <form className="space-y-2" onSubmit={(event) => {
                                event.preventDefault();
                                if (removal.name === t.name && !disabled && !pending) onRemove(t.templateId, removal.name);
                            }}>
                                <label>Nom exact du dessin<input value={removal.name} onChange={(event) => setRemoval({ id: t.templateId, name: event.target.value })} /></label>
                                <p>Le dessin disparaît de la galerie. Ses révisions et le journal sont conservés.</p>
                                <div className="flex flex-wrap gap-2">
                                    <button type="submit" className="studio-stop" disabled={disabled || pending || removal.name !== t.name}>Confirmer le retrait</button>
                                    <button type="button" onClick={() => setRemoval(null)}>Annuler</button>
                                </div>
                            </form>
                        )}
                    </div>
                </article>
            ))}
        </div>
    );
}
