import { ImageIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { STRATEGY_LABELS, type TemplateInfo } from '../lib/engine';

export function DrawingGallery({
    templates,
    selected,
    pending,
    disabled,
    onSelect,
}: {
    templates: TemplateInfo[] | null;
    selected?: string;
    pending: boolean;
    disabled: boolean;
    onSelect: (id: string) => void;
}) {
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
                            src={`/api/v1/connector/drawing/${encodeURIComponent(t.templateId)}/image?rev=${t.revision}`}
                            loading="lazy"
                            alt={`Aperçu de ${t.name}`}
                        />
                    </div>
                    <div className="studio-tile-body">
                        <h2>{t.name}</h2>
                        <p>
                            {t.width} × {t.height} px · {STRATEGY_LABELS[t.strategy] ?? t.strategy}
                        </p>
                        {selected === t.templateId ? (
                            <Link className="studio-link" to="/">
                                Ouvrir le dessin actif
                            </Link>
                        ) : (
                            <button disabled={disabled || pending} onClick={() => onSelect(t.templateId)}>
                                Sélectionner
                            </button>
                        )}
                    </div>
                </article>
            ))}
        </div>
    );
}
