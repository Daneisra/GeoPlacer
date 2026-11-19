import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { STRATEGY_LABELS } from '../lib/engine';

const descriptions: Record<string, string> = {
    'top-to-bottom': 'Commence par les rangées du haut.',
    'bottom-to-top': 'Commence par les rangées du bas.',
    'left-to-right': 'Parcourt les colonnes depuis la gauche.',
    'right-to-left': 'Parcourt les colonnes depuis la droite.',
    'color-by-color': 'Regroupe les pixels par couleur.',
    'outline-first': 'Trace les contours avant de remplir.',
    'center-out': 'Part du centre et progresse vers les bords.',
    random: 'Répartit les premiers pixels sur toute l’image.',
};
const palette = ['#8073f2', '#beadfc', '#67c8dd', '#e3d9ff'];
const diagram = Array.from({ length: 19 * 9 }, (_, i) => {
    const x = (i % 19) - 9;
    const y = Math.floor(i / 19) - 4;
    const distance = Math.hypot(x / 2.25, y);
    const ring = Math.abs(y - x / 4) < 0.65 && Math.abs(x) < 9;
    return { x, y, distance, ring, color: ring ? 2 : distance < 2 && x < 0 ? 3 : x + y < 0 ? 1 : 0 };
});

function highlighted(strategy: string, point: (typeof diagram)[number]) {
    const { x, y, distance, ring, color } = point;
    switch (strategy) {
        case 'top-to-bottom':
            return y <= 0;
        case 'bottom-to-top':
            return y >= 0;
        case 'left-to-right':
            return x <= 0;
        case 'right-to-left':
            return x >= 0;
        case 'center-out':
            return distance < 2.6;
        case 'outline-first':
            return distance > 2.7 || ring;
        case 'color-by-color':
            return color === 1 || color === 3;
        default:
            return ((x * 13 + y * 23) & 7) < 4;
    }
}

export function DrawingModes() {
    return (
        <>
            <div className="studio-page-heading">
                <div>
                    <h1>Modes de dessin</h1>
                    <p>
                        Choisissez une stratégie lors de l’import d’un PNG en simulation. Le mode autonome GeoPixels
                        utilise son propre parcours.
                    </p>
                </div>
            </div>
            <div className="studio-gallery">
                {Object.entries(STRATEGY_LABELS).map(([id, label]) => (
                    <article className="studio-tile" key={id}>
                        <div className="studio-strategy-art" aria-hidden="true">
                            {diagram.map((point, i) => (
                                <span
                                    key={i}
                                    style={
                                        point.distance <= 3.8 || point.ring
                                            ? {
                                                  backgroundColor: palette[point.color],
                                                  opacity: highlighted(id, point) ? 1 : 0.18,
                                              }
                                            : undefined
                                    }
                                />
                            ))}
                        </div>
                        <div className="studio-tile-body">
                            <h2>{label}</h2>
                            <p>{descriptions[id]}</p>
                            <Link className="studio-link" to={`/dessins?strategie=${id}#simulation-import`}>
                                Utiliser en simulation <ArrowRight size={15} aria-hidden="true" />
                            </Link>
                        </div>
                    </article>
                ))}
            </div>
        </>
    );
}
