export const upgrades = {
    'energy-pack': { name: 'Recharge d’énergie', effect: '+20 énergie', cost: '10' },
    'max-energy': { name: 'Capacité énergétique', effect: '+5 capacité', cost: '50' },
    'regen-speed': { name: 'Vitesse de recharge', effect: '−1 s par unité, minimum 15 s', cost: '500' },
    'color-unlock': { name: 'Déblocage de couleur', effect: 'Ajoute une couleur à la palette', cost: '0 ou 100' },
};

export type UpgradeKind = keyof typeof upgrades;
export const upgradeKinds = Object.keys(upgrades) as UpgradeKind[];
